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

/** Never split legacy merged prose by strings: the source ownership is not recoverable that way. */
export function projectPlan(actor: User, plan: MonthlyPlan): MonthlyPlan {
  if (actor.role === 'manager') return plan
  const { mergedFromIds: _merged, mergedIntoId: _target, ...safe } = plan
  return {
    ...safe, sourcePlanId: null, reviewComment: '',
    ...(plan.importSource ? { importSource: { ...plan.importSource, sourceStatus: '' } } : {}),
    ...(plan.mergedFromIds?.length ? { expectedOutcome: '团队合并目标，请按整体成果要求执行', acceptanceCriteria: '由管理者确认整体成果验收要求' } : {}),
    ...(plan.status === 'merged' && plan.ownerId !== actor.id ? {
      title: '已合并的来源提报', expectedOutcome: '来源个人内容不在当前读取范围', acceptanceCriteria: '请参照团队合并目标', actualOutcome: '', acceptanceNote: '',
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
  if (actor.role === 'manager' || participates(current, actor.id)) return projectPlan(actor, current)
  const snapshots = store.list<AuditEvent>('events')
    .filter(event => event.entityType === 'plan' && event.entityId === current.id)
    .flatMap(event => [event.before, event.after])
    .concat(store.list<Publication>('publications').flatMap(item => item.plans.filter(plan => plan.id === current.id)))
    .map(value => planSnapshot(value, current.id))
    .filter((plan): plan is MonthlyPlan => !!plan && participates(plan, actor.id))
    .sort((a, b) => b.version - a.version)
  return snapshots[0] ? projectPlan(actor, snapshots[0]) : undefined
}

export function visiblePlanHistory(actor: User, id: string, events: AuditEvent[]): AuditEvent[] {
  const selected = events.filter(event => event.entityType === 'plan' && event.entityId === id)
  if (actor.role === 'manager') return selected
  return selected.flatMap(event => {
    const project = (value: unknown) => {
      const snapshot = planSnapshot(value, id)
      return snapshot && participates(snapshot, actor.id) ? projectPlan(actor, snapshot) : null
    }
    const before = project(event.before), after = project(event.after)
    // Reason strings and merge source arrays can contain other people's individual submissions.
    return before || after ? [{ ...event, before, after, reason: '' }] : []
  })
}

export function visiblePublications(actor: User, publications: Publication[]): Publication[] {
  if (actor.role === 'manager') return publications
  return publications.map(item => ({ ...item, reason: '', plans: item.plans.filter(plan => participates(plan, actor.id)).map(plan => projectPlan(actor, plan)) }))
    .filter(item => item.plans.length)
}
