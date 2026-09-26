import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { Router } from 'express'
import type { AuditEvent, Entity, MonthlyPlan, Project, Report, Task, User } from '../shared/types.ts'
import type { RegisterPage, WorkspaceItem, WorkspacePage, WorkspaceResource, WorkspaceShellData } from '../shared/workspace-query.ts'
import { buildWorkRegister, workRegisterToday, workRegisterViewLabels, type WorkRegisterView } from '../shared/work-register.ts'
import { HttpError, type Store } from './store.ts'
import { liveObjectActor, readScopeVersion } from './object-access.ts'
import { getOperationEpoch } from './operation-context.ts'
import { aiConfigured } from './reports.ts'
import { safeUser } from './auth.ts'
import { projectPlan, planReference, participates } from './plan-visibility.ts'
import type { WorkspaceSqlFilter } from './workspace-query-sql.ts'
import { workOriginProjector } from './work-origin.ts'
import { isManager, isObserver } from './authorization.ts'
import { PRIORITIES } from '../shared/entity-rules.ts'

type Query = Record<string, unknown>
const cursorSecret = randomBytes(32)
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
function str(value: unknown, name: string, maximum = 200) {
  if (value === undefined || value === '') return undefined
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new HttpError(400, `${name}无效`)
  return value.trim() || undefined
}
function choice<T extends string>(value: unknown, choices: readonly T[], name: string): T | undefined {
  const parsed = str(value, name)
  if (parsed && !choices.includes(parsed as T)) throw new HttpError(400, `${name}无效`)
  return parsed as T | undefined
}
function pageSize(input: Query) {
  const limit = input.limit === undefined ? 50 : Number(input.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, '分页大小须为1至100')
  return limit
}
function keys(input: Query, accepted: string[]) { if (Object.keys(input).some(key => !accepted.includes(key))) throw new HttpError(400, '存在不支持的查询条件') }
function makeCursor(binding: string, last: { createdAt: string; id: string }): string {
  const body = Buffer.from(JSON.stringify({ binding, ...last })).toString('base64url')
  return `${body}.${createHmac('sha256', cursorSecret).update(body).digest('base64url')}`
}
function parseCursor(raw: unknown, binding: string): { createdAt: string; id: string } | undefined {
  if (raw === undefined) return
  try {
    if (typeof raw !== 'string' || raw.length > 4096) throw new Error()
    const [body, signature, extra] = raw.split('.')
    const actual = Buffer.from(signature || '', 'base64url'), expected = createHmac('sha256', cursorSecret).update(body).digest()
    if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error()
    const data = JSON.parse(Buffer.from(body, 'base64url').toString())
    if (data.binding !== binding || typeof data.id !== 'string' || !data.id || typeof data.createdAt !== 'string' || !Number.isFinite(Date.parse(data.createdAt))) throw new Error()
    return { id: data.id, createdAt: data.createdAt }
  } catch { throw new HttpError(409, '数据或读取权限已更新，请刷新查看', 'WORKSPACE_CURSOR_STALE') }
}
export class WorkspaceQueryService {
  constructor(private store: Store) {}
  shell(actor: User): WorkspaceShellData {
    return this.store.readTransaction(() => {
      actor = liveObjectActor(this.store, actor)
      const business = !isObserver(actor)
      return { user: safeUser(actor), capabilities: { manage: isManager(actor), business, authorizedWork: isObserver(actor) }, accessScopeVersion: readScopeVersion(this.store, actor), operationEpoch: getOperationEpoch(this.store), aiConfigured: business && aiConfigured(this.store), counts: { openTasks: business ? this.store.workspaceCount({ resource: 'tasks', actorId: actor.id, manager: isManager(actor), scope: 'open' }) : 0 } }
    })
  }
  private context(actor: User) {
    actor = liveObjectActor(this.store, actor)
    if (isObserver(actor)) throw new HttpError(403, '观察者仅能读取明确授权的内容', 'READ_ONLY_OBSERVER')
    const accessScopeVersion = readScopeVersion(this.store, actor), epoch = getOperationEpoch(this.store), revision = this.store.workspaceRevision()
    return { actor, accessScopeVersion, epoch, revision }
  }
  page(actor: User, resource: WorkspaceResource, input: Query): WorkspacePage<WorkspaceItem> {
    return this.store.readTransaction(() => {
      const context = this.context(actor); actor = context.actor
      keys(input, ['ownerId', 'status', 'month', 'weekStart', 'taskId', 'q', 'includeCancelled', 'scope', 'kind', 'type', 'period', 'role', 'cursor', 'limit'])
      const filter: WorkspaceSqlFilter = { resource, actorId: actor.id, manager: isManager(actor), ownerId: str(input.ownerId, '负责人'), status: str(input.status, '状态'), taskId: str(input.taskId, '任务'), q: str(input.q, '搜索词', 120), scope: choice(input.scope, ['open', 'all'], '范围'), kind: choice(input.kind, ['user', 'project', 'plan'], '候选类型'), type: choice(input.type, ['weekly', 'monthly'], '报告类型'), period: str(input.period, '周期') }
      if (resource === 'candidates' && !filter.kind) throw new HttpError(400, '请指定候选类型')
      filter.role = choice(input.role, ['manager', 'member'], '角色')
      if (input.includeCancelled !== undefined && !['true', 'false'].includes(String(input.includeCancelled))) throw new HttpError(400, '作废筛选无效')
      filter.includeCancelled = String(input.includeCancelled) === 'true'
      for (const name of ['month', 'weekStart'] as const) {
        const value = str(input[name], '日期')
        if (value && !(name === 'month' ? /^\d{4}-(0[1-9]|1[0-2])$/ : /^\d{4}-\d{2}-\d{2}$/).test(value)) throw new HttpError(400, '日期格式无效')
        filter[name] = value
      }
      const limit = pageSize(input), binding = digest([filter, limit, actor.id, context.accessScopeVersion, context.epoch, context.revision])
      const after = parseCursor(input.cursor, binding)
      const total = this.store.workspaceCount(filter), selected = this.store.workspacePage<WorkspaceItem>(filter, limit + 1, after), items = selected.slice(0, limit).map(item => {
        if (resource === 'candidates' && filter.kind === 'user') return safeUser(item as User)
        if (resource === 'plans' || resource === 'candidates' && filter.kind === 'plan') return projectPlan(actor, item as MonthlyPlan, this.store)
        if (resource === 'history' && !isManager(actor)) {
          const event = item as AuditEvent
          const project = (value: unknown) => (value as Task | null)?.ownerId === actor.id ? value : null
          return { ...event, before: project(event.before), after: project(event.after), reason: '' }
        }
        return item
      })
      const last = items.at(-1)
      return { items, total, nextCursor: selected.length > limit && last ? makeCursor(binding, last) : null, revision: context.revision, accessScopeVersion: context.accessScopeVersion }
    })
  }
  report(actor: User, id: string): Report {
    actor = liveObjectActor(this.store, actor)
    if (!isManager(actor)) throw new HttpError(403, '只有管理者可以读取报告档案')
    const report = this.store.get<Report>('reports', id)
    if (!report) throw new HttpError(404, '报告不存在或当前不可访问')
    return report
  }
  register(actor: User, input: Query): RegisterPage {
    return this.store.readTransaction(() => {
      const context = this.context(actor); actor = context.actor
      keys(input, ['view', 'q', 'priority', 'kind', 'cursor', 'limit'])
      const today = workRegisterToday(), base = buildWorkRegister({ user: actor, tasks: [], weeklyRecords: [] }, { today })
      const view = choice(input.view, Object.keys(workRegisterViewLabels) as WorkRegisterView[], '工作范围') ?? 'active'
      const filter = { actorId: actor.id, manager: isManager(actor), weekStart: base.weekStart, view, q: str(input.q, '搜索词', 120), priority: choice(input.priority, PRIORITIES, '优先级'), kind: choice(input.kind, ['monthly', 'temporary', 'routine'], '工作类型') }
      const limit = pageSize(input), binding = digest(['register', filter, limit, context.accessScopeVersion, context.epoch, context.revision]), cursor = parseCursor(input.cursor, binding)
      const page = this.store.registerPage(filter, limit + 1, cursor), selected = page.rows.slice(0, limit)
      const tasks = selected.filter(row => row.kind === 'task').map(row => { const task = row.entity as Task; return task.workOrigin || task.importSource ? task : workOriginProjector(this.store.initialTaskEvents(task.id))(task, 'task') }), plans = selected.filter(row => row.kind === 'plan').map(row => row.entity as MonthlyPlan)
      const references = new Map(plans.map(plan => [plan.id, projectPlan(actor, plan, this.store)]))
      for (const task of tasks) {
        if (!task.monthlyPlanId || references.has(task.monthlyPlanId)) continue
        const plan = this.store.get<MonthlyPlan>('plans', task.monthlyPlanId)
        if (plan) {
          if (participates(plan, actor.id) || isManager(actor)) references.set(plan.id, projectPlan(actor, plan, this.store))
          else {
            const historical = this.store.registerHistoricalPlan(plan.id, actor.id)
            references.set(plan.id, historical ? { ...projectPlan(actor, historical, this.store), visibility: 'historical' } : planReference(plan))
          }
        }
      }
      const weeklyRecords = tasks.flatMap(task => this.store.registerTaskRecords(task.id, actor.id, base.weekStart))
      const users = [...new Set(tasks.flatMap(task=>task.workOrigin?.actorId?[task.workOrigin.actorId]:[]))].flatMap(id=>{const user=this.store.get<User>('users',id);return user?[safeUser(user)]:[]})
      const taskProgress = this.store.workspaceTaskProgress(tasks, actor.id, isManager(actor), today)
      const projected = buildWorkRegister({ user: actor, tasks, weeklyRecords, plans: [...references.values()], users, taskProgress }, { view, today })
      // SQL controls membership/order. The shared projector supplies the established display fields.
      const byId = new Map(projected.rows.map(row => [`${row.kind}:${row.id}`, row]))
      const items = selected.flatMap(row => { const value = byId.get(`${row.kind}:${row.entity.id}`); return value ? [{ ...value, ...(row.historicalReference ? { historicalReference: true } : {}), priority: value.priority ?? (value.kind === 'task' && value.task.monthlyPlanId ? references.get(value.task.monthlyPlanId)?.priority : undefined) }] : [] })
      const counts = Object.fromEntries(Object.keys(base.counts).map(key => [key, Number(page.summary[key])])) as typeof base.counts
      const last = selected.at(-1), projects = [...new Set([...references.values()].map(plan => plan.projectId).filter((id): id is string => !!id))].flatMap(id => { const project = this.store.get<Project>('projects', id); return project ? [project] : [] })
      return { items, total: page.total, nextCursor: page.rows.length > limit && last ? makeCursor(binding, { createdAt: last.entity.createdAt, id: `${last.kind}:${last.entity.id}` }) : null, revision: context.revision, accessScopeVersion: context.accessScopeVersion, result: { ...base, view, query: filter.q ?? '', rows: items, counts }, highCount: Number(page.summary.highCount), references: { plans: [...references.values()], projects } }
    })
  }
}
export function workspaceQueryRouter(store: Store) {
  const router = Router(), service = new WorkspaceQueryService(store)
  router.get('/workspace', (req, res) => res.json(service.shell(req.user)))
  router.get('/workspace/register', (req, res) => res.json(service.register(req.user, req.query)))
  for (const resource of ['tasks', 'weekly-records', 'plans', 'history', 'progress', 'reports', 'candidates'] as const) router.get(`/workspace/${resource}`, (req, res) => res.json(service.page(req.user, resource, req.query)))
  router.get('/workspace/reports/:id', (req, res) => res.json(service.report(req.user, String(req.params.id))))
  return router
}
