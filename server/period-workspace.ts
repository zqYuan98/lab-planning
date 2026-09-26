import { summarizeEffort } from '../shared/effort.ts'
import { Router } from 'express'
import type { AuditEvent, MonthlyPlan, Project, Publication, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { MonthlyWorkspace, PeriodCandidates, PeriodReferences, PublicationSummary, WeeklyWorkspace } from '../shared/period-workspace.ts'
import { canUseAccount, registrationApproved } from '../shared/auth-policy.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { safeUser } from './auth.ts'
import { HttpError, type Store } from './store.ts'
import { pageContext, pageWindow, queryKeys, queryText, readPage } from './page-read-common.ts'
import { participates, planReference, planVisibilityProjector, projectPlan, visiblePublications } from './plan-visibility.ts'
import { workOriginProjector } from './work-origin.ts'

type Query = Record<string, unknown>
const emptyReferences = (): PeriodReferences => ({ users: [], projects: [], plans: [], tasks: [], weeklyRecords: [] })
const compactPlan = (plan: MonthlyPlan): MonthlyPlan => ({ ...plan, expectedOutcome: plan.expectedOutcome.slice(0, 240), acceptanceCriteria: plan.acceptanceCriteria.slice(0, 240), actualOutcome: '', acceptanceNote: '', reviewComment: '', temporaryReason: plan.temporaryReason?.slice(0, 160) })
const compactRecord = (record: WeeklyRecord): WeeklyRecord => ({ ...record, commitment: record.commitment, actualOutcome: record.actualOutcome.slice(0, 240), blocker: record.blocker.slice(0, 160), nextAction: record.nextAction.slice(0, 160), evidenceUrl: '', blockerImpact: record.blockerImpact?.slice(0, 160), supportNeeded: record.supportNeeded?.slice(0, 160) })
const compactTask = (task: Task): Task => ({ ...task, description: task.description.slice(0, 240), temporaryReason: task.temporaryReason.slice(0, 160), currentProgress: task.currentProgress?.slice(0, 160), completionNote: '', blockerReason: '', blockerImpact: '', supportNeeded: '', nextAction: '', requestedOutcome: '', estimatedEffort: '', decisionNeeded: '' })
function date(value: unknown, month = false) {
  const parsed = queryText(value)
  if (!(month ? /^\d{4}-(0[1-9]|1[0-2])$/ : /^\d{4}-\d{2}-\d{2}$/).test(parsed) || !month && (!Number.isFinite(Date.parse(`${parsed}T00:00:00Z`)) || new Date(`${parsed}T00:00:00Z`).toISOString().slice(0, 10) !== parsed)) throw new HttpError(400, '周期日期无效')
  return parsed
}
function flag(value: unknown) { if (value !== undefined && !['true', 'false'].includes(String(value))) throw new HttpError(400, '筛选条件无效'); return String(value) === 'true' }
function source(row: WeeklyRecord) { return row.importSource ? 'imported' : row.workOrigin?.kind ?? 'unknown' }

/** Period reads never consult the retired workspace-wide response. */
export class PeriodWorkspaceService {
  constructor(private store: Store) {}
  private entities<T>(collection: string, ids: string[]): T[] {
    if (!ids.length) return []
    return this.store.selectJson<T>("SELECT data FROM entities WHERE collection=? AND id IN (SELECT value FROM json_each(?)) ORDER BY rowid", [collection, JSON.stringify([...new Set(ids)])])
  }
  private accounts(ids: string[]) { return this.entities<User>('users', ids).map(safeUser) }
  private planVisibility(actor: User, plans: MonthlyPlan[]) {
    if (!plans.length) return []
    if (actor.role === 'manager') return plans
    const ids = JSON.stringify(plans.map(plan => plan.id))
    const events = this.store.selectJson<AuditEvent>("SELECT data FROM entities WHERE collection='events' AND json_extract(data,'$.entityType')='plan' AND json_extract(data,'$.entityId') IN (SELECT value FROM json_each(?)) ORDER BY rowid", [ids])
    const publications = this.store.selectJson<Publication>("SELECT json_set(data,'$.plans',json((SELECT json_group_array(json(p.value)) FROM json_each(entities.data,'$.plans') p WHERE json_extract(p.value,'$.id') IN (SELECT value FROM json_each(?))))) AS data FROM entities WHERE collection='publications' AND EXISTS(SELECT 1 FROM json_each(data,'$.plans') p WHERE json_extract(p.value,'$.id') IN (SELECT value FROM json_each(?))) ORDER BY rowid", [ids, ids])
    // Include source-chain rows so redaction is identical to the live projection.
    const sourcePlans = [...plans], seen = new Set(plans.map(plan => plan.id))
    for (const plan of sourcePlans) if (plan.sourcePlanId && !seen.has(plan.sourcePlanId)) { seen.add(plan.sourcePlanId); const parent = this.store.get<MonthlyPlan>('plans', plan.sourcePlanId); if (parent) sourcePlans.push(parent) }
    const projector = planVisibilityProjector(this.store, actor, { plans: sourcePlans, events, publications })
    return plans.flatMap(plan => { const visible = projector.visible(plan); return visible ? [visible] : [] })
  }
  private planRows(actor: User, month?: string): MonthlyPlan[] {
    // A union of id sets (not OR) lets each branch use its own index. A historical snapshot can
    // only match the month when the event's before/after month equals it, so those indexed
    // branches avoid parsing every plan event ever recorded. INDEXED BY keeps the plan stable
    // on databases that have never been ANALYZEd.
    const snapshots = (side: 'before' | 'after') => `SELECT json_extract(s.value,'$.id') FROM entities e INDEXED BY plan_event_${side}_month,json_each(json_array(json_extract(e.data,'$.before'),json_extract(e.data,'$.after'))) s WHERE e.collection='events' AND json_extract(e.data,'$.entityType')='plan' AND json_extract(e.data,'$.${side}.month')=? AND json_extract(s.value,'$.month')=? AND (json_extract(s.value,'$.ownerId')=? OR EXISTS(SELECT 1 FROM json_each(s.value,'$.collaboratorIds') c WHERE c.value=?))`
    const plans = month ? this.store.selectJson<MonthlyPlan>(`SELECT data FROM entities p WHERE collection='plans' AND id IN (SELECT id FROM entities INDEXED BY plan_month WHERE collection='plans' AND json_extract(data,'$.month')=? UNION ${snapshots('before')} UNION ${snapshots('after')} UNION SELECT json_extract(s.value,'$.id') FROM entities e,json_each(e.data,'$.plans') s WHERE e.collection='publications' AND json_extract(s.value,'$.month')=? AND (json_extract(s.value,'$.ownerId')=? OR EXISTS(SELECT 1 FROM json_each(s.value,'$.collaboratorIds') c WHERE c.value=?))) ORDER BY rowid`, [month, month, month, actor.id, actor.id, month, month, actor.id, actor.id, month, actor.id, actor.id]) : this.store.selectJson<MonthlyPlan>("SELECT data FROM entities WHERE collection='plans' AND (?=1 OR json_extract(data,'$.ownerId')=? OR EXISTS(SELECT 1 FROM json_each(data,'$.collaboratorIds') c WHERE c.value=?)) ORDER BY rowid", [Number(actor.role === 'manager'), actor.id, actor.id])
    const visible = this.planVisibility(actor, plans), shown = new Set(visible.map(plan => plan.id))
    if (actor.role === 'member' && month) {
      const linked = new Set(this.store.selectRows("SELECT DISTINCT json_extract(w.data,'$.monthlyPlanId') AS id FROM entities w LEFT JOIN entities t ON t.collection='tasks' AND t.id=json_extract(w.data,'$.taskId') WHERE w.collection IN ('tasks','weeklyRecords') AND json_extract(w.data,'$.ownerId')=? AND json_extract(w.data,'$.cancellation') IS NULL AND json_extract(w.data,'$.deletion') IS NULL AND json_extract(t.data,'$.cancellation') IS NULL", [actor.id]).map(row => String(row.id)))
      for (const plan of plans) if (!shown.has(plan.id) && linked.has(plan.id)) visible.push(planReference(plan))
    }
    return visible.filter(plan => !month || plan.month === month)
  }
  private task(actor: User, id: string): Task | undefined {
    const current = this.store.get<Task>('tasks', id)
    if (current && !isActiveTask(current)) return undefined
    if (current && (actor.role === 'manager' || current.ownerId === actor.id)) return current
    const snapshots = this.store.entityEvents('task', id).flatMap(event => [event.before, event.after]).filter((row): row is Task => !!row && (row as Task).id === id && (actor.role === 'manager' || (row as Task).ownerId === actor.id)).sort((a, b) => b.version - a.version)
    return snapshots[0] && isActiveTask(snapshots[0]) ? snapshots[0] : undefined
  }
  references(actor: User, records: WeeklyRecord[] = [], plans: MonthlyPlan[] = [], tasks: Task[] = []): PeriodReferences {
    const taskMap = new Map(tasks.map(task => [task.id, task]))
    const taskIds = [...new Set(records.map(record => record.taskId))], currentTasks = new Map(this.entities<Task>('tasks', taskIds).map(task => [task.id, task]))
    for (const id of taskIds) if (!taskMap.has(id)) { const current = currentTasks.get(id), task = current && (actor.role === 'manager' || current.ownerId === actor.id) ? isActiveTask(current) ? current : undefined : this.task(actor, id); if (task) taskMap.set(task.id, task) }
    const planMap = new Map(plans.map(plan => [plan.id, plan]))
    const ids = [...records, ...taskMap.values()].flatMap(row => row.monthlyPlanId && !planMap.has(row.monthlyPlanId) ? [row.monthlyPlanId] : [])
    const current = this.entities<MonthlyPlan>('plans', ids), visible = new Map(this.planVisibility(actor, current).map(plan => [plan.id, plan]))
    for (const plan of current) planMap.set(plan.id, visible.get(plan.id) ?? planReference(plan))
    const projects = this.entities<Project>('projects', [...planMap.values()].flatMap(plan => plan.projectId ? [plan.projectId] : []))
    const users = this.accounts([...records, ...taskMap.values(), ...planMap.values()].flatMap(row => [row.ownerId, ...('collaboratorIds' in row ? row.collaboratorIds : []), ...('workOrigin' in row && row.workOrigin ? [row.workOrigin.actorId] : [])]))
    return { users, projects, plans: [...planMap.values()], tasks: [...taskMap.values()], weeklyRecords: records }
  }
  weekly(actor: User, input: Query): WeeklyWorkspace {
    return this.store.readTransaction(() => {
      const ctx = pageContext(this.store, actor); actor = ctx.actor
      queryKeys(input, ['weekStart', 'ownerId', 'includeInactive', 'status', 'q', 'source', 'cursor', 'limit', 'id'])
      const week = date(input.weekStart), owner = queryText(input.ownerId), inactive = flag(input.includeInactive), status = queryText(input.status), q = queryText(input.q).toLocaleLowerCase(), origin = queryText(input.source)
      let rows = this.store.selectJson<WeeklyRecord>("SELECT w.data FROM entities w LEFT JOIN entities t ON t.collection='tasks' AND t.id=json_extract(w.data,'$.taskId') JOIN entities u ON u.collection='users' AND u.id=json_extract(w.data,'$.ownerId') WHERE w.collection='weeklyRecords' AND json_extract(w.data,'$.weekStart')=? AND json_extract(w.data,'$.deletion') IS NULL AND json_extract(t.data,'$.cancellation') IS NULL AND (?=1 OR json_extract(w.data,'$.ownerId')=?) AND (?='' OR json_extract(w.data,'$.ownerId')=?) AND (json_extract(u.data,'$.registrationStatus') IS NULL OR json_extract(u.data,'$.registrationStatus')='approved') AND (?=1 OR json_extract(u.data,'$.active')=1) ORDER BY w.rowid", [week, Number(actor.role === 'manager'), actor.id, owner, owner, Number(inactive)])
      const knownTasks = new Map(this.entities<Task>('tasks', rows.map(row => row.taskId)).map(task => [task.id, task]))
      rows = rows.filter(row => { if (knownTasks.has(row.taskId)) return true; const history = this.store.entityEvents('task', row.taskId).flatMap(event => [event.before, event.after]).filter((value): value is Task => !!value && (value as Task).id === row.taskId && (actor.role === 'manager' || (value as Task).ownerId === actor.id)).sort((a, b) => b.version - a.version); return !history[0] || isActiveTask(history[0]) })
      const events = rows.length ? this.store.selectJson<AuditEvent>("SELECT data FROM entities WHERE collection='events' AND json_extract(data,'$.entityType')='weeklyRecord' AND json_extract(data,'$.entityId') IN (SELECT value FROM json_each(?)) ORDER BY rowid", [JSON.stringify(rows.map(row => row.id))]) : []
      const projectOrigin = workOriginProjector(events); rows = rows.map(row => projectOrigin(row, 'weeklyRecord'))
      const official = rows.filter(isEffectiveWeeklyRecord)
      const effortPlans = this.entities<MonthlyPlan>('plans', rows.flatMap(row => row.monthlyPlanId ? [row.monthlyPlanId] : [])).filter(plan => actor.role === 'manager' || participates(plan, actor.id))
      const effortProjects = this.entities<Project>('projects', effortPlans.flatMap(plan => plan.projectId ? [plan.projectId] : []))
      const effortSummary = summarizeEffort(rows, effortPlans, effortProjects)
      const summary = { total: rows.length, official: official.length, pending: rows.filter(row => row.submitted && !isEffectiveWeeklyRecord(row)).length, done: official.filter(row => row.status === 'done').length, blocked: official.filter(row => row.status === 'blocked').length }
      const names = new Map(this.accounts(rows.map(row => row.ownerId)).map(user => [user.id, user.name]))
      const filtered = rows.filter(row => (!origin || origin === 'all' || source(row) === origin) && (!status || status === 'all' || (status === 'draft' ? !row.submitted : status === 'pending' ? row.submitted && !isEffectiveWeeklyRecord(row) : row.submitted && row.status === status)) && (!q || `${row.commitment} ${(knownTasks.get(row.taskId)?.ownerId === actor.id || actor.role === 'manager' ? knownTasks.get(row.taskId) : this.task(actor, row.taskId))?.title ?? ''} ${names.get(row.ownerId) ?? ''}`.toLocaleLowerCase().includes(q)))
      const page = readPage(input, filtered, ctx, 'weekly'), references = this.references(actor, page.items)
      const id = queryText(input.id), direct = id ? this.store.get<WeeklyRecord>('weeklyRecords', id) : undefined, record = direct && isActiveWeeklyRecord(direct) && direct.weekStart === week && (actor.role === 'manager' || direct.ownerId === actor.id) ? direct : id ? rows.find(row => row.taskId === id) : undefined, directTask = id && !record ? this.store.get<Task>('tasks', id) : undefined, task = record ? this.task(actor, record.taskId) : directTask && isActiveTask(directTask) && (actor.role === 'manager' || directTask.ownerId === actor.id) ? directTask : undefined
      const detail = id ? { ...(record ? { record } : {}), ...(task ? { task } : {}) } : undefined
      if (id && !record && !task) throw new HttpError(404, '任务或周记录不存在或当前不可访问')
      if (detail) { const extra = this.references(actor, record ? [record] : [], [], task ? [task] : []); for (const key of ['users', 'projects', 'plans', 'tasks'] as const) references[key] = [...new Map([...references[key], ...extra[key]].map(row => [row.id, row])).values()] as never }
      references.weeklyRecords = page.items.map(compactRecord)
      references.plans = references.plans.map(compactPlan)
      references.tasks = references.tasks.map(compactTask)
      return { ...page, items: references.weeklyRecords, references, summary, effortSummary, detail }
    })
  }
  monthly(actor: User, input: Query): MonthlyWorkspace {
    return this.store.readTransaction(() => {
      const ctx = pageContext(this.store, actor); actor = ctx.actor
      queryKeys(input, ['month', 'includeInactive', 'scope', 'status', 'q', 'cursor', 'limit', 'id'])
      const month = date(input.month, true), inactive = flag(input.includeInactive), status = queryText(input.status), q = queryText(input.q), scope = queryText(input.scope) || 'current'
      if (!['current', 'historical'].includes(scope)) throw new HttpError(400, '月度目标范围无效')
      const all = this.planRows(actor, month), refs = this.references(actor, [], all), users = new Map(refs.users.map(user => [user.id, user])), projects = new Map(refs.projects.map(project => [project.id, project]))
      const visible = all.filter(plan => { const owner = users.get(plan.ownerId); return !!owner && (canUseAccount(owner) || inactive && registrationApproved(owner)) || plan.collaboratorIds.some(id => { const user = users.get(id); return !!user && canUseAccount(user) }) })
      const currentPlans = visible.filter(plan => !plan.visibility), historical = visible.filter(plan => !!plan.visibility)
      const statuses = Object.fromEntries(['all', 'draft', 'submitted', 'returned', 'approved', 'published', 'merged'].map(status => [status, status === 'all' ? currentPlans.length : currentPlans.filter(plan => plan.status === status).length]))
      const publishable = all.filter(plan => !plan.visibility && plan.status === 'approved' && (!plan.projectId || projects.get(plan.projectId)?.status !== 'archived')).length
      const publications = this.publicationCount(actor, month)
      const filtered = (scope === 'historical' ? historical : currentPlans).filter(plan => (!status || status === 'all' || plan.status === status) && (!q || `${plan.title}${users.get(plan.ownerId)?.name ?? '未指定'}${plan.projectId ? projects.get(plan.projectId)?.name ?? '历史项目' : '部门工作'}`.includes(q)))
      const page = readPage(input, filtered, ctx, 'monthly'), references = this.references(actor, [], page.items)
      const id = queryText(input.id), current = id ? this.store.get<MonthlyPlan>('plans', id) : undefined
      const detail = current ? this.planVisibility(actor, [current])[0] ?? this.planRows(actor, current.month).find(plan => plan.id === current.id) : undefined
      if (id && !detail) throw new HttpError(404, '月度目标不存在或当前不可访问')
      if (detail) { const extra = this.references(actor, [], [detail]); for (const key of ['users', 'projects', 'plans'] as const) references[key] = [...new Map([...references[key], ...extra[key]].map(row => [row.id, row])).values()] as never }
      references.plans = references.plans.map(plan => plan.id === detail?.id ? plan : compactPlan(plan))
      return { ...page, items: page.items.map(compactPlan), references, summary: { statuses, historical: historical.length, publishable, publications }, detail }
    })
  }
  private publicationPredicate(actor: User, month: string) { return { sql: "collection='publications' AND json_extract(data,'$.month')=? AND (?=1 OR EXISTS(SELECT 1 FROM json_each(data,'$.plans') p WHERE json_extract(p.value,'$.ownerId')=? OR EXISTS(SELECT 1 FROM json_each(p.value,'$.collaboratorIds') c WHERE c.value=?)))", values: [month, Number(actor.role === 'manager'), actor.id, actor.id] } }
  private publicationCount(actor: User, month: string) { const filter = this.publicationPredicate(actor, month); return Number(this.store.selectRows(`SELECT COUNT(*) AS n FROM entities WHERE ${filter.sql}`, filter.values)[0].n) }
  publications(actor: User, input: Query) { return this.store.readTransaction(() => {
    const ctx = pageContext(this.store, actor); queryKeys(input, ['month', 'cursor', 'limit']); actor = ctx.actor
    const month = date(input.month, true), filter = this.publicationPredicate(actor, month), window = pageWindow(input, ctx, 'publications'), total = this.publicationCount(actor, month)
    const fields = ['id', 'version', 'createdAt', 'updatedAt', 'month', 'revision', 'actorId'].map(key => `'${key}',json_extract(data,'$.${key}')`).join(',')
    const items = this.store.selectJson<PublicationSummary>(`SELECT json_object(${fields},'reason',CASE WHEN ?=1 THEN substr(json_extract(data,'$.reason'),1,240) ELSE '' END,'planCount',(SELECT COUNT(*) FROM json_each(data,'$.plans') p WHERE ?=1 OR json_extract(p.value,'$.ownerId')=? OR EXISTS(SELECT 1 FROM json_each(p.value,'$.collaboratorIds') c WHERE c.value=?))) AS data FROM entities WHERE ${filter.sql} ORDER BY json_extract(data,'$.revision') DESC,rowid LIMIT ? OFFSET ?`, [Number(actor.role === 'manager'), Number(actor.role === 'manager'), actor.id, actor.id, ...filter.values, window.limit, window.offset])
    return { items, total, nextCursor: window.offset + items.length < total ? window.cursor(window.offset + items.length) : null, revision: ctx.revision, accessScopeVersion: ctx.accessScopeVersion }
  }) }
  publication(actor: User, id: string) { const ctx = pageContext(this.store, actor), row = this.store.get<Publication>('publications', id), publication = row && visiblePublications(ctx.actor, [row], this.store)[0]; if (!publication) throw new HttpError(404, '发布版本不存在或当前不可访问'); return { publication, references: this.references(ctx.actor, [], publication.plans) } }
  plan(actor: User, id: string) { const ctx = pageContext(this.store, actor), current = this.store.get<MonthlyPlan>('plans', id), plan = current && (this.planVisibility(ctx.actor, [current])[0] ?? this.planRows(ctx.actor, current.month).find(plan => plan.id === current.id)); if (!plan) throw new HttpError(404, '月度目标不存在或当前不可访问'); return { plan, references: this.references(ctx.actor, [], [plan]) } }
  record(actor: User, id: string) { const ctx = pageContext(this.store, actor), record = this.store.get<WeeklyRecord>('weeklyRecords', id); if (!record || !isActiveWeeklyRecord(record) || ctx.actor.role !== 'manager' && record.ownerId !== ctx.actor.id || !this.task(ctx.actor, record.taskId)) throw new HttpError(404, '周记录不存在或当前不可访问'); return { record, references: this.references(ctx.actor, [record]) } }
  candidates(actor: User, input: Query): PeriodCandidates {
    return this.store.readTransaction(() => {
      const ctx = pageContext(this.store, actor); actor = ctx.actor
      queryKeys(input, ['kind', 'ownerId', 'month', 'purpose', 'q', 'cursor', 'limit'])
      const kind = queryText(input.kind), purpose = queryText(input.purpose), owner = queryText(input.ownerId) || actor.id, q = queryText(input.q).toLocaleLowerCase()
      if (!['plans', 'tasks'].includes(kind) || !['weekly', 'relink', 'publish', 'merge'].includes(purpose)) throw new HttpError(400, '候选条件无效')
      if (actor.role !== 'manager' && owner !== actor.id || ['publish', 'merge', 'relink'].includes(purpose) && actor.role !== 'manager') throw new HttpError(403, '无权读取该候选范围')
      const values: (string | number)[] = [], planClauses = ["p.collection='plans'", "json_extract(p.data,'$.visibility') IS NULL", "json_extract(p.data,'$.status')<>'merged'", "(json_extract(p.data,'$.projectId') IS NULL OR EXISTS(SELECT 1 FROM entities pr WHERE pr.collection='projects' AND pr.id=json_extract(p.data,'$.projectId') AND json_extract(pr.data,'$.status')='active'))"]
      if (!['publish', 'merge'].includes(purpose)) { planClauses.push("(json_extract(p.data,'$.ownerId')=? OR EXISTS(SELECT 1 FROM json_each(p.data,'$.collaboratorIds') c WHERE c.value=?))"); values.push(owner, owner) }
      if (input.month) { planClauses.push("json_extract(p.data,'$.month')=?"); values.push(date(input.month, true)) }
      if (purpose === 'publish') planClauses.push("json_extract(p.data,'$.status')='approved'")
      if (purpose === 'relink') planClauses.push("json_extract(p.data,'$.status')='published'")
      if (purpose === 'merge') planClauses.push("json_extract(p.data,'$.status') IN ('submitted','approved') AND NOT EXISTS(SELECT 1 FROM entities t WHERE t.collection='tasks' AND json_extract(t.data,'$.monthlyPlanId')=p.id)")
      let alias = 'p', predicate = planClauses.join(' AND ')
      if (kind === 'tasks') { alias = 't'; predicate = `t.collection='tasks' AND json_extract(t.data,'$.ownerId')=? AND json_extract(t.data,'$.cancellation') IS NULL AND (json_extract(t.data,'$.monthlyPlanId') IS NULL OR EXISTS(SELECT 1 FROM entities p WHERE p.id=json_extract(t.data,'$.monthlyPlanId') AND ${predicate}))`; values.unshift(owner) }
      if (q) { predicate += ` AND instr(lower(json_extract(${alias}.data,'$.title')),lower(?))>0`; values.push(q) }
      const window = pageWindow(input, ctx, ['period-candidates', purpose, kind]), total = Number(this.store.selectRows(`SELECT COUNT(*) AS n FROM entities ${alias} WHERE ${predicate}`, values)[0].n)
      const selected = this.store.selectJson<MonthlyPlan | Task>(`SELECT ${alias}.data FROM entities ${alias} WHERE ${predicate} ORDER BY ${alias}.rowid LIMIT ? OFFSET ?`, [...values, window.limit, window.offset])
      const items = kind === 'plans' ? (selected as MonthlyPlan[]).map(plan => compactPlan(projectPlan(actor, plan, this.store))) : (selected as Task[]).map(compactTask)
      const references = this.references(actor, [], kind === 'plans' ? items as MonthlyPlan[] : [], kind === 'tasks' ? items as Task[] : [])
      references.plans = references.plans.map(compactPlan); references.tasks = references.tasks.map(compactTask)
      return { items, total, nextCursor: window.offset + items.length < total ? window.cursor(window.offset + items.length) : null, revision: ctx.revision, accessScopeVersion: ctx.accessScopeVersion, references }
    })
  }
  submissionReferences(actor: User, input: Query) {
    const ctx = pageContext(this.store, actor); queryKeys(input, ['weekStart'])
    const week = date(input.weekStart), end = new Date(`${week}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 7)
    let rows = this.store.selectJson<WeeklyRecord>("SELECT data FROM entities WHERE collection='weeklyRecords' AND json_extract(data,'$.weekStart') IN (?,?) AND (?=1 OR json_extract(data,'$.ownerId')=?) ORDER BY rowid", [week, end.toISOString().slice(0, 10), Number(ctx.actor.role === 'manager'), ctx.actor.id])
    const events = rows.length ? this.store.selectJson<AuditEvent>("SELECT data FROM entities WHERE collection='events' AND json_extract(data,'$.entityType')='weeklyRecord' AND json_extract(data,'$.entityId') IN (SELECT value FROM json_each(?)) ORDER BY rowid", [JSON.stringify(rows.map(row => row.id))]) : []
    const origin = workOriginProjector(events); rows = rows.map(row => origin(row, 'weeklyRecord'))
    const references = this.references(ctx.actor, rows)
    references.weeklyRecords = rows.map(row => ({ ...compactRecord(row), commitment: '', actualOutcome: '', blocker: '', nextAction: '' }))
    references.tasks = references.tasks.map(task => ({ ...compactTask(task), description: '', temporaryReason: '', currentProgress: '' }))
    references.plans = references.plans.map(plan => ({ ...compactPlan(plan), expectedOutcome: '', acceptanceCriteria: '', temporaryReason: '' }))
    const userData = "json_object('id',id,'name',json_extract(data,'$.name'),'role',json_extract(data,'$.role'),'active',json_extract(data,'$.active'),'position',json_extract(data,'$.position'),'registrationStatus',json_extract(data,'$.registrationStatus'),'email','','createdAt','','updatedAt','','version',0)"
    references.users = this.store.selectJson<User>(`SELECT ${userData} AS data FROM entities WHERE collection='users' AND (json_extract(data,'$.registrationStatus') IS NULL OR json_extract(data,'$.registrationStatus')='approved') ORDER BY rowid`).map(user => ({ ...user, active: Boolean(user.active) }))
    return references
  }
}
export function periodWorkspaceRouter(store: Store) {
  const router = Router(), service = new PeriodWorkspaceService(store)
  router.get('/workspace/weekly', (req, res) => res.json(service.weekly(req.user, req.query)))
  router.get('/workspace/monthly', (req, res) => res.json(service.monthly(req.user, req.query)))
  router.get('/workspace/weekly/records/:id', (req, res) => res.json(service.record(req.user, String(req.params.id))))
  router.get('/workspace/monthly/plans/:id', (req, res) => res.json(service.plan(req.user, String(req.params.id))))
  router.get('/workspace/monthly/publications', (req, res) => res.json(service.publications(req.user, req.query)))
  router.get('/workspace/monthly/publications/:id', (req, res) => res.json(service.publication(req.user, String(req.params.id))))
  router.get('/workspace/weekly/candidates', (req, res) => res.json(service.candidates(req.user, req.query)))
  router.get('/workspace/monthly/candidates', (req, res) => res.json(service.candidates(req.user, req.query)))
  router.get('/workspace/weekly/submission-references', (req, res) => res.json(service.submissionReferences(req.user, req.query)))
  return router
}
