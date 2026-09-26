import { Router } from 'express'
import type { AuditEvent, Bootstrap, MonthlyPlan, Project, Publication, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { DepartmentOverviewResponse, OverviewGroup, OverviewMember, OverviewRow, OverviewSummary, PersonalCount, PersonalOverviewResponse } from '../shared/overview-workspace.ts'
import { addCalendarDays, buildOverview, shanghaiToday, shiftCalendarMonth, weekMonday } from '../shared/overview-data.ts'
import { buildWorkspace, filterWorkRows, previewWorkRows, summarizeWorkRows, type WorkFilters, type WorkPeriod, type WorkRow } from '../shared/overview-workspace-data.ts'
import { isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { taskPriority } from '../shared/task-presentation.ts'
import { HttpError, type Store } from './store.ts'
import { pageContext, queryKeys, queryText, readPage } from './page-read-common.ts'
import { planReference, planVisibilityProjector } from './plan-visibility.ts'
import { isManager } from './authorization.ts'

const metadata = ['id', 'version', 'createdAt', 'updatedAt']
/** Same ordering as localeCompare(…, 'zh-CN') without building a collator per comparison. */
const zhCollator = new Intl.Collator('zh-CN')
const taskFields = [...metadata, 'title', 'monthlyPlanId', 'ownerId', 'dueDate', 'status', 'isTemporary', 'temporaryReason', 'priority']
const planFields = [...metadata, 'month', 'title', 'projectId', 'ownerId', 'collaboratorIds', 'dueDate', 'priority', 'status', 'publishedVersion', 'sourcePlanId', 'acceptanceStatus', 'mergedFromIds', 'mergedIntoId', 'isTemporary', 'visibility']
const recordFields = [...metadata, 'taskId', 'monthlyPlanId', 'ownerId', 'weekStart', 'commitment', 'status', 'submitted', 'planApproval']
function projection(fields: string[], source = 'e.data') {
  // `->` yields each value as JSON (booleans, strings, arrays and objects intact; missing is
  // NULL), matching a json_type/json_extract CASE with one path lookup instead of two.
  return `json_object(${fields.map(key => `'${key}',${source} -> '$.${key}'`).join(',')})`
}
function snapshotProjection(fields: string[], side: 'before' | 'after') { return `CASE WHEN json_type(e.data,'$.${side}')='object' THEN ${projection(fields, `json_extract(e.data,'$.${side}')`)} ELSE NULL END` }
function rows<T>(store: Store, collection: string, fields: string[], where = '', values: (string | number)[] = []): T[] {
  return store.selectJson<Record<string, unknown>>(`SELECT ${projection(fields)} AS data FROM entities e WHERE e.collection=? ${where} ORDER BY e.rowid`, [collection, ...values])
    .map(row => Object.fromEntries(Object.entries(row).filter(([key, value]) => value !== null || ['monthlyPlanId', 'projectId', 'publishedVersion', 'sourcePlanId'].includes(key))) as T)
}
const summary = (work: WorkRow[]): OverviewSummary => ({ ...summarizeWorkRows(work), risk: work.filter(row => row.overdue || row.status === 'blocked' || row.status === 'not_done').length })
export function overviewRow(row: WorkRow): OverviewRow {
  const { task: _task, record, records: _records, ...safe } = row
  return { ...safe, ...(record ? { weeklyRecordId: record.id } : {}) }
}
function day(value: string) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
}
function bool(value: unknown) {
  if (value === undefined || value === 'false' || value === false) return false
  if (value === 'true' || value === true) return true
  throw new HttpError(400, '筛选条件无效')
}
/** Reads only overview facts. Raw reports, audit narratives and task progress are not page data. */
function overviewFacts(store: Store, actor: User, options: { period: WorkPeriod; date: string; personal?: boolean; search?: boolean }) {
  const manager = isManager(actor), month = options.date.slice(0, 7)
  const start = options.personal ? [weekMonday(`${month}-01`), addCalendarDays(weekMonday(options.date), -21)].sort()[0]
    : options.period === 'week' ? weekMonday(options.date) : `${month}-01`
  const end = options.period === 'week' && !options.personal ? addCalendarDays(start, 6) : addCalendarDays(`${shiftCalendarMonth(month, 1)}-01`, -1)
  const ownerWhere = manager ? '' : " AND json_extract(e.data,'$.ownerId')=?", ownerValues = manager ? [] : [actor.id]
  let records = rows<WeeklyRecord>(store, 'weeklyRecords', [...recordFields, ...(options.search ? ['actualOutcome', 'blocker', 'nextAction'] : [])],
    `AND json_extract(e.data,'$.deletion') IS NULL${ownerWhere}
    AND NOT EXISTS (SELECT 1 FROM entities t WHERE t.collection='tasks' AND t.id=json_extract(e.data,'$.taskId') AND json_extract(t.data,'$.cancellation') IS NOT NULL)
    ${options.period === 'all' && !options.personal ? '' : "AND json_extract(e.data,'$.weekStart')<=? AND date(json_extract(e.data,'$.weekStart'),'+6 days')>=?"}`,
    [...ownerValues, ...(options.period === 'all' && !options.personal ? [] : [end, start])])
  const plans = rows<MonthlyPlan>(store, 'plans', planFields)
  const tasks = rows<Task>(store, 'tasks', taskFields, `AND json_extract(e.data,'$.cancellation') IS NULL${ownerWhere}
    ${options.period === 'all' && !options.personal ? '' : `AND (json_extract(e.data,'$.dueDate') BETWEEN ? AND ?
      OR EXISTS (SELECT 1 FROM entities p WHERE p.collection='plans' AND p.id=json_extract(e.data,'$.monthlyPlanId') AND json_extract(p.data,'$.month')=?)
      OR e.id IN (SELECT value FROM json_each(?)))`}`,
    [...ownerValues, ...(options.period === 'all' && !options.personal ? [] : [start, end, month, JSON.stringify([...new Set(records.map(row => row.taskId))])])])
  const known = new Set(tasks.map(task => task.id))
  const missingIds = [...new Set(records.map(row => row.taskId))].filter(id => !known.has(id)), history = new Map<string, Task>(), cancelledHistory = new Set<string>()
  if (missingIds.length) for (const event of store.selectJson<AuditEvent>(`SELECT json_object('entityId',json_extract(e.data,'$.entityId'),'before',${snapshotProjection([...taskFields, 'cancellation'], 'before')},'after',${snapshotProjection([...taskFields, 'cancellation'], 'after')}) AS data
    FROM entities e WHERE e.collection='events' AND json_extract(e.data,'$.entityType')='task'
    AND json_extract(e.data,'$.entityId') IN (SELECT value FROM json_each(?)) ORDER BY e.rowid`, [JSON.stringify(missingIds)])) {
    for (const value of [event.before, event.after]) {
      const snapshot = value as Task | null, previous = history.get(event.entityId)
      if (snapshot && snapshot.id === event.entityId && (manager || snapshot.ownerId === actor.id) && (!previous || previous.version < snapshot.version)) history.set(event.entityId, snapshot)
    }
  }
  for (const taskId of missingIds) {
    const historical = history.get(taskId)
    if (historical?.cancellation) cancelledHistory.add(taskId)
    else if (historical) tasks.push(historical)
  }
  if (cancelledHistory.size) records = records.filter(record => !cancelledHistory.has(record.taskId))
  let visiblePlans = plans, publications: Publication[] = []
  if (options.personal) {
    const rawPublications = store.selectJson<Publication>(`SELECT json_object('id',e.id,'month',json_extract(e.data,'$.month'),'revision',json_extract(e.data,'$.revision'),
      'plans',json(COALESCE((SELECT json_group_array(${projection(planFields, 'p.value')}) FROM json_each(e.data,'$.plans') p
        ${manager ? '' : "WHERE json_extract(p.value,'$.ownerId')=? OR EXISTS(SELECT 1 FROM json_each(p.value,'$.collaboratorIds') c WHERE c.value=?)"}), '[]'))) AS data
      FROM entities e WHERE e.collection='publications' ORDER BY e.rowid`, manager ? [] : [actor.id, actor.id])
    const events = manager ? [] : store.selectJson<AuditEvent>(`SELECT json_object('entityType','plan','entityId',json_extract(e.data,'$.entityId'),'before',${snapshotProjection(planFields, 'before')},'after',${snapshotProjection(planFields, 'after')}) AS data
      FROM entities e WHERE e.collection='events' AND json_extract(e.data,'$.entityType')='plan' AND (
      json_extract(e.data,'$.before.ownerId')=? OR json_extract(e.data,'$.after.ownerId')=?
      OR EXISTS(SELECT 1 FROM json_each(e.data,'$.before.collaboratorIds') c WHERE c.value=?)
      OR EXISTS(SELECT 1 FROM json_each(e.data,'$.after.collaboratorIds') c WHERE c.value=?)) ORDER BY e.rowid`, [actor.id, actor.id, actor.id, actor.id])
    const projector = planVisibilityProjector(store, actor, { plans, publications: rawPublications, events })
    visiblePlans = plans.flatMap(plan => { const visible = projector.visible(plan); return visible ? [visible] : [] })
    const visibleIds = new Set(visiblePlans.map(plan => plan.id)), current = new Map(plans.map(plan => [plan.id, plan]))
    for (const work of [...tasks, ...records]) if (work.monthlyPlanId && !visibleIds.has(work.monthlyPlanId)) {
      const plan = current.get(work.monthlyPlanId)
      if (plan) { visiblePlans.push(planReference(plan)); visibleIds.add(plan.id) }
    }
    publications = projector.publications()
  }
  const users = rows<User>(store, 'users', [...metadata, 'name', 'email', 'role', 'position', 'active', 'registrationStatus'],
    manager ? '' : "AND COALESCE(json_extract(e.data,'$.registrationStatus'),'approved')='approved'")
  const projects = rows<Project>(store, 'projects', [...metadata, 'name'])
  return { user: actor, users, projects, plans: visiblePlans, tasks, weeklyRecords: records, publications, reports: [], annualGoals: [], aiConfigured: false } satisfies Bootstrap
}

export class OverviewWorkspaceService {
  constructor(private store: Store, private clock = () => new Date()) {}
  personal(actor: User, input: Record<string, unknown> = {}): PersonalOverviewResponse {
    return this.store.readTransaction(() => {
      queryKeys(input, [])
      const context = pageContext(this.store, actor); actor = context.actor
      const today = shanghaiToday(this.clock()), data = overviewFacts(this.store, actor, { period: 'month', date: today, personal: true })
      const view = buildOverview(data, today), counts = Object.fromEntries((['plans', 'published', 'pending', 'approved', 'reviewScope', 'records', 'submitted', 'blocked', 'notDone', 'accepted', 'awaitingAcceptance', 'returned', 'drafts', 'missingMembers'] as const).map(key => [key, view[key].length])) as Record<PersonalCount, number>
      counts.done = view.submitted.filter(row => row.status === 'done').length
      const owners = new Map(data.users.map(user => [user.id, user.name])), tasks = new Map(data.tasks.map(task => [task.id, task])), plans = new Map(data.plans.map(plan => [plan.id, plan]))
      const rank = (record: WeeklyRecord) => !isEffectiveWeeklyRecord(record) ? 2 : record.status === 'blocked' ? 0 : record.status === 'not_done' ? 1 : record.status === 'doing' ? 3 : 4
      return { today, month: view.month, weekStart: view.weekStart, counts, monthChange: view.monthChange, weekChange: view.weekChange, monthTrend: view.monthTrend, weekTrend: view.weekTrend, weeks: view.weeks,
        focusPlans: view.focusPlans.slice(0, 3).map(plan => ({ id: plan.id, title: plan.title, month: plan.month, ownerId: plan.ownerId, ownerName: owners.get(plan.ownerId) || '成员', priority: plan.priority, status: plan.status, acceptanceStatus: plan.acceptanceStatus, dueDate: plan.dueDate, ...(plan.isTemporary ? { isTemporary: true } : {}) })),
        focusRecords: [...view.records].sort((a, b) => rank(a) - rank(b)).slice(0, 3).map(record => {
          const task = tasks.get(record.taskId), plan = record.monthlyPlanId ? plans.get(record.monthlyPlanId) : undefined
          return { id: record.id, taskId: record.taskId, monthlyPlanId: record.monthlyPlanId, ownerName: owners.get(record.ownerId) || '成员', title: task?.title || record.commitment, planTitle: plan?.title || (record.monthlyPlanId ? '关联月度目标' : '未关联目标'), priority: taskPriority(task, plan), isTemporary: Boolean(task?.isTemporary || task?.temporaryReason?.trim() || plan?.isTemporary), effective: isEffectiveWeeklyRecord(record), pendingLabel: !record.submitted ? '草稿 · 未纳入周统计' : record.planApproval?.approvedSubmissionId ? '计划有修改 · 待重新审核' : '计划待审核 · 未纳入周统计', status: record.status }
        }), ...(view.awaitingAcceptance[0] ? { firstAwaitingAcceptanceId: view.awaitingAcceptance[0].id } : {}), revision: context.revision, accessScopeVersion: context.accessScopeVersion, operationEpoch: context.operationEpoch }
    })
  }
  department(actor: User, input: Record<string, unknown>): DepartmentOverviewResponse {
    return this.store.readTransaction(() => {
      const context = pageContext(this.store, actor); actor = context.actor
      if (!isManager(actor)) throw new HttpError(403, '只有管理者可以读取部门概览')
      queryKeys(input, ['period', 'date', 'includeInactive', 'ownerId', 'projectId', 'status', 'q', 'riskOnly', 'sort', 'cursor', 'limit'])
      const period = queryText(input.period) || 'all', date = queryText(input.date) || shanghaiToday(this.clock())
      if (!['all', 'month', 'week'].includes(period) || !day(date)) throw new HttpError(400, '统计周期或日期无效')
      const status = queryText(input.status), sort = queryText(input.sort) || 'name'
      if (!['', 'all', 'planned', 'doing', 'blocked', 'done', 'not_done', 'draft', 'unscheduled', 'overdue', 'unplanned'].includes(status) || !['name', 'tasks', 'risk', 'due'].includes(sort)) throw new HttpError(400, '状态或排序无效')
      const query = queryText(input.q, 120), ownerId = queryText(input.ownerId), projectId = queryText(input.projectId), includeInactive = bool(input.includeInactive), riskOnly = bool(input.riskOnly)
      const ownerFilter = ownerId && ownerId !== 'all', projectFilter = projectId && projectId !== 'all', statusFilter = status && status !== 'all'
      const data = overviewFacts(this.store, actor, { period: period as WorkPeriod, date, search: !!query })
      const workspace = buildWorkspace(data, { period: period as WorkPeriod, date, includeInactive }, shanghaiToday(this.clock()))
      const work = filterWorkRows(workspace.rows, { query, ownerId, projectId, riskOnly, status: status === 'unplanned' ? '' : status as WorkFilters['status'] })
        .filter(row => status !== 'unplanned' || row.status === 'draft' || row.status === 'unscheduled')
        .sort((a, b) => (sort === 'due' ? (a.dueDate || '9999').localeCompare(b.dueDate || '9999') : sort === 'risk' ? Number(b.overdue || ['blocked', 'not_done'].includes(b.status)) - Number(a.overdue || ['blocked', 'not_done'].includes(a.status)) : 0) || zhCollator.compare(a.ownerName, b.ownerName) || zhCollator.compare(a.title, b.title) || a.id.localeCompare(b.id))
      const represented = new Set(work.map(row => row.ownerId)), members = workspace.members.filter(member => (!ownerFilter || member.id === ownerId) && (projectFilter || statusFilter || riskOnly ? represented.has(member.id) : !query || represented.has(member.id) || member.name.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
      const memberSummaries: OverviewMember[] = members.map(member => {
        const own = work.filter(row => row.ownerId === member.id)
        return { id: member.id, name: member.name, role: member.role, position: member.position, active: member.active, summary: summary(own), preview: previewWorkRows(own).map(overviewRow), projects: [...new Set(own.map(row => row.projectName))], due: own.map(row => row.dueDate || '9999').sort()[0] || '9999' }
      }).sort((a, b) => (sort === 'tasks' ? b.summary.total - a.summary.total : sort === 'risk' ? b.summary.risk - a.summary.risk : sort === 'due' ? a.due.localeCompare(b.due) : 0) || zhCollator.compare(a.name, b.name) || a.id.localeCompare(b.id))
      const groups = (kind: 'status' | 'owner' | 'project'): OverviewGroup[] => {
        const groups = new Map<string, WorkRow[]>()
        for (const row of work) { const key = kind === 'status' ? row.status : kind === 'owner' ? row.ownerId : row.projectId || '__none__'; const entries = groups.get(key); if (entries) entries.push(row); else groups.set(key, [row]) }
        return [...groups].map(([id, entries]) => ({ id, name: kind === 'status' ? id : kind === 'owner' ? entries[0].ownerName : entries[0].projectName, summary: summary(entries), ownerCount: new Set(entries.map(row => row.ownerId)).size, planCount: new Set(entries.map(row => row.planId).filter(Boolean)).size, ownerNames: [...new Set(entries.map(row => row.ownerName))] }))
      }
      return { ...readPage(input, work.map(overviewRow), context, 'overview-department'), operationEpoch: context.operationEpoch, startDate: workspace.startDate, endDate: workspace.endDate, summary: summary(work), members: memberSummaries,
        memberOptions: workspace.members.map(({ id, name, active }) => ({ id, name, active })), projectOptions: [...new Map(workspace.rows.filter(row => row.projectId).map(row => [row.projectId!, row.projectName]))].map(([id, name]) => ({ id, name })), groups: { status: groups('status'), owner: groups('owner'), project: groups('project') } }
    })
  }
}
export function overviewWorkspaceRouter(store: Store) {
  const router = Router(), service = new OverviewWorkspaceService(store)
  router.get('/workspace/overview/personal', (req, res) => res.json(service.personal(req.user, req.query)))
  router.get('/workspace/overview/department', (req, res) => res.json(service.department(req.user, req.query)))
  return router
}
