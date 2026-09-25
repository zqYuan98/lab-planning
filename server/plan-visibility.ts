import type { AuditEvent, MonthlyPlan, Publication, User } from '../shared/types.ts'
import type { Store } from './store.ts'

export function participates(plan: MonthlyPlan, userId: string): boolean {
  return plan.ownerId === userId || plan.collaboratorIds.includes(userId)
}

function planSnapshot(value: unknown, id: string): MonthlyPlan | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const plan = value as MonthlyPlan
  return plan.id === id && typeof plan.ownerId === 'string' && Array.isArray(plan.collaboratorIds) ? plan : undefined
}

type PlanSourceReader = Pick<Store, 'get'>

export function planHasMergedSource(plan: MonthlyPlan, store?: PlanSourceReader): boolean {
  const visited = new Set<string>()
  let source: MonthlyPlan | undefined = plan
  while (source && !visited.has(source.id)) {
    visited.add(source.id)
    if (source.mergedFromIds?.length) return true
    source = source.sourcePlanId && store ? store.get<MonthlyPlan>('plans', source.sourcePlanId) : undefined
  }
  return false
}

/** Never split legacy merged prose by strings: the source ownership is not recoverable that way. */
export function projectPlan(actor: User, plan: MonthlyPlan, store?: PlanSourceReader): MonthlyPlan {
  if (actor.role === 'manager') return plan
  const mergedSource = planHasMergedSource(plan, store)
  const { mergedFromIds: _merged, mergedIntoId: _target, ...safe } = plan
  return {
    ...safe, sourcePlanId: null,
    reviewComment: plan.isTemporary && plan.ownerId === actor.id && plan.status === 'returned' && !mergedSource ? plan.reviewComment : '',
    ...(plan.importSource ? { importSource: { ...plan.importSource, sourceStatus: '' } } : {}),
    ...(mergedSource ? { expectedOutcome: '团队合并目标，请按整体成果要求执行', acceptanceCriteria: '由管理者确认整体成果验收要求' } : {}),
    ...(plan.status === 'merged' && plan.ownerId !== actor.id ? {
      title: '已合并的来源提报', expectedOutcome: '来源个人内容不在当前读取范围', acceptanceCriteria: '请参照团队合并目标', actualOutcome: '', acceptanceNote: '',
      ...(plan.isTemporary ? { temporaryReason: '来源临时事项的个人说明不在当前读取范围' } : {}),
    } : {}),
  }
}

/** Legacy task links may outlive all membership snapshots. Return a reference, never today's goal text. */
export function planReference(plan: MonthlyPlan): MonthlyPlan {
  return {
    id: plan.id, month: plan.month, version: 1, createdAt: plan.createdAt, updatedAt: plan.createdAt, visibility: 'reference',
    title: '历史月度目标引用', projectId: null, category: '', ownerId: plan.ownerId, collaboratorIds: [],
    expectedOutcome: '', acceptanceCriteria: '', dueDate: '', priority: 'medium', status: 'draft',
    reviewComment: '', publishedVersion: null, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '',
  }
}

/** A past membership grants only the snapshots actually visible during that membership. */
export function visiblePlan(store: Store, actor: User, current: MonthlyPlan): MonthlyPlan | undefined {
  if (actor.role === 'observer') return undefined
  if (actor.role === 'manager' || participates(current, actor.id)) return projectPlan(actor, current, store)
  const snapshots = store.entityEvents('plan', current.id)
    .flatMap(event => [event.before, event.after])
    .concat(store.selectJson<MonthlyPlan>(`SELECT p.value AS data FROM entities e,json_each(e.data,'$.plans') p WHERE e.collection='publications' AND json_extract(p.value,'$.id')=? ORDER BY e.rowid,CAST(p.key AS INTEGER)`, [current.id]))
    .map(value => planSnapshot(value, current.id))
    .filter((plan): plan is MonthlyPlan => !!plan && participates(plan, actor.id))
    .sort((a, b) => b.version - a.version)
  return snapshots[0] ? { ...projectPlan(actor, snapshots[0], store), visibility: 'historical' } : undefined
}

/** Response-local index; strict version comparison preserves the first equal-version snapshot.
 * Evidence priority stays audit rowid, before then after, then publication rowid and plan order.
 */
export function planVisibilityProjector(store: Store, actor: User, sources: { plans: MonthlyPlan[]; events: AuditEvent[]; publications: Publication[] }) {
  const currentPlans = new Map(sources.plans.map(plan => [plan.id, plan]))
  const reader: PlanSourceReader = { get: <T>(collection: string, id: string): T | undefined => collection === 'plans' ? currentPlans.get(id) as T | undefined : store.get<T>(collection, id) }
  const historical = new Map<string, MonthlyPlan>()
  const candidates = new Map<string, MonthlyPlan[]>(), legacyVersions = new Set<string>()
  const add = (value: unknown, id: string) => {
    const plan = planSnapshot(value, id)
    if (!plan || !participates(plan, actor.id)) return
    const rows = candidates.get(id)
    if (rows) rows.push(plan); else candidates.set(id, [plan])
    if (typeof plan.version !== 'number' || !Number.isFinite(plan.version)) legacyVersions.add(id)
    const previous = historical.get(id)
    if (!previous || plan.version > previous.version) historical.set(id, plan)
  }
  if (actor.role === 'member') {
    for (const event of sources.events) if (event.entityType === 'plan') { add(event.before, event.entityId); add(event.after, event.entityId) }
    for (const publication of sources.publications) for (const plan of publication.plans) add(plan, plan.id)
    // Old nested snapshots were not version-validated. Preserve the original
    // numeric stable-sort behavior (including NaN comparisons) for those rows.
    for (const id of legacyVersions) historical.set(id, candidates.get(id)!.sort((a, b) => b.version - a.version)[0])
  }
  return {
    visible: (current: MonthlyPlan): MonthlyPlan | undefined => {
      if (actor.role === 'observer') return undefined
      if (actor.role === 'manager' || participates(current, actor.id)) return projectPlan(actor, current, reader)
      const snapshot = historical.get(current.id)
      return snapshot ? { ...projectPlan(actor, snapshot, reader), visibility: 'historical' } : undefined
    },
    publications: () => visiblePublications(actor, sources.publications, reader),
  }
}

export function visiblePlanHistory(actor: User, id: string, events: AuditEvent[], store?: Store): AuditEvent[] {
  if (actor.role === 'observer') return []
  const selected = events.filter(event => event.entityType === 'plan' && event.entityId === id)
  if (actor.role === 'manager') return selected
  return selected.flatMap(event => {
    const project = (value: unknown) => {
      const snapshot = planSnapshot(value, id)
      return snapshot && participates(snapshot, actor.id) ? projectPlan(actor, snapshot, store) : null
    }
    const before = project(event.before), after = project(event.after)
    // Reason strings and merge source arrays can contain other people's individual submissions.
    return before || after ? [{ ...event, before, after, reason: '' }] : []
  })
}

export function visiblePublications(actor: User, publications: Publication[], store?: PlanSourceReader): Publication[] {
  if (actor.role === 'observer') return []
  if (actor.role === 'manager') return publications
  return publications.map(item => ({ ...item, reason: '', plans: item.plans.filter(plan => participates(plan, actor.id)).map(plan => projectPlan(actor, plan, store)) }))
    .filter(item => item.plans.length)
}
