import { createHash } from 'node:crypto'
import type { Bootstrap, Entity, MonthlyPlan, Project, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { AuthorizedProjectSummary, AuthorizedTaskView, AuthorizedWorkResponse, ObjectCapability, ObjectGrant, ObjectType, ScopedReport, ScopeFact } from '../shared/object-access.ts'
import type { DeliveryDecision, DeliverySeries } from '../shared/deliveries.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { safeUser } from './auth.ts'
import { businessActor, currentActor } from './authorization.ts'
import { HttpError, type Store } from './store.ts'

export function liveObjectActor(store: Store, actor: User): User {
  return currentActor(store, actor)
}
export function assertBusinessActor(store: Store, actor: User): User {
  return businessActor(store, actor)
}
export function activeGrant(store: Store, actor: User, objectType: ObjectType, objectId: string, capability: ObjectCapability = 'read', now = new Date()): ObjectGrant | undefined {
  const current = store.get<User>('users', actor.id)
  if (!current || !canUseAccount(current)) return
  return store.list<ObjectGrant>('objectGrants').find(grant => grant.subjectId === current.id && grant.objectType === objectType && grant.objectId === objectId && !grant.revokedAt && (!grant.expiresAt || Date.parse(grant.expiresAt) > now.getTime()) && grant.capabilities.includes('read') && grant.capabilities.includes(capability))
}
export function readScopeVersion(store: Store, actor: User): string {
  const current = liveObjectActor(store, actor)
  const now = Date.now()
  const grants = store.list<ObjectGrant>('objectGrants').filter(grant => grant.subjectId === current.id).map(grant => [grant.id, grant.version, !grant.revokedAt && (!grant.expiresAt || Date.parse(grant.expiresAt) > now)]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))
  // Start with owned goals. Unary + on the TEXT id removes affinity so SQLite can seek
  // the JSON-expression task index; identifiers themselves remain unchanged strings.
  const derived = current.role === 'member' ? store.selectRows(`SELECT
    (SELECT json_group_array(id) FROM (SELECT id FROM entities WHERE collection='plans' AND json_extract(data,'$.ownerId')=? AND json_extract(data,'$.status')!='merged' AND json_extract(data,'$.visibility') IS NULL ORDER BY id)) AS plans,
    (SELECT json_group_array(json_array(id,goal,owner,memberAvailable)) FROM (
      SELECT t.id AS id,p.id AS goal,json_extract(t.data,'$.ownerId') AS owner,
        COALESCE(json_extract(u.data,'$.active')=1 AND json_extract(u.data,'$.role')='member' AND (json_extract(u.data,'$.registrationStatus') IS NULL OR json_extract(u.data,'$.registrationStatus')='approved'),0) AS memberAvailable
      FROM entities p CROSS JOIN entities t LEFT JOIN entities u ON u.collection='users' AND u.id=json_extract(t.data,'$.ownerId')
      WHERE p.collection='plans' AND json_extract(p.data,'$.ownerId')=? AND json_extract(p.data,'$.status')!='merged' AND json_extract(p.data,'$.visibility') IS NULL
        AND t.collection='tasks' AND json_extract(t.data,'$.monthlyPlanId')=+p.id AND json_extract(t.data,'$.cancellation') IS NULL ORDER BY t.id)) AS tasks,
    (SELECT version FROM entities WHERE collection='settings' AND id='weekly-review-delegation') AS delegation`, [current.id, current.id])[0] : null
  return createHash('sha256').update(JSON.stringify([current.id, current.version, current.role, grants, ...(derived ? [derived] : [])])).digest('hex')
}
export const scopeVersion = readScopeVersion
const collections: Record<ObjectType, string> = { task: 'tasks', project_summary: 'projects', scoped_report: 'scopedReports' }
export function historyVisible(grant: ObjectGrant, fact: { id: string; createdAt?: string; occurredAt?: string | null }, kind = 'history'): boolean {
  if (grant.historyPolicy === 'all_history') return true
  if (!Array.isArray(grant.excludedFactIds) || grant.excludedFactIds.includes(`${kind}:${fact.id}`)) return false
  const recordedAt = fact.createdAt, occurredAt = fact.occurredAt ?? recordedAt
  return !!recordedAt && !!occurredAt && Number.isFinite(Date.parse(recordedAt)) && Number.isFinite(Date.parse(occurredAt)) && recordedAt >= grant.grantedAt && occurredAt >= grant.grantedAt
}
export function factVisible(grant: ObjectGrant, fact: ScopeFact): boolean {
  if (fact.objectId !== grant.objectId || fact.objectType !== grant.objectType || !Number.isInteger(fact.objectVersion) || !Number.isInteger(fact.factVersion)) return false
  if (fact.factType === 'current') return grant.historyPolicy === 'all_history' || fact.objectVersion >= grant.objectVersion
  if (!fact.recordedAt || !fact.occurredAt || !Number.isFinite(Date.parse(fact.recordedAt)) || !Number.isFinite(Date.parse(fact.occurredAt))) return false
  return historyVisible(grant, { id: fact.factId, createdAt: fact.recordedAt, occurredAt: fact.occurredAt }, fact.factType)
}
export function reportSourcesAccessible(store: Store, actor: User, report: ScopedReport, capability: ObjectCapability = 'read'): boolean {
  return report.subjectId === actor.id && report.manifest.length > 0 && report.manifest.every(fact => {
    const grant = activeGrant(store, actor, fact.objectType, fact.objectId, capability)
    const object = store.get<Entity>(collections[fact.objectType], fact.objectId)
    if (!grant || !object || object.version < fact.objectVersion || !factVisible(grant, fact)) return false
    if (fact.factType === 'current') return fact.factId === fact.objectId && fact.factVersion === fact.objectVersion
    const collection = { weeklyRecord: 'weeklyRecords', delivery: 'taskDeliveries', history: 'events' }[fact.factType]
    if (!collection) return false
    const row = store.get<Entity & { taskId?: string; entityId?: string; entityType?: string }>(collection, fact.factId)
    return !!row && row.version >= fact.factVersion && row.createdAt === fact.recordedAt && (fact.factType === 'history' ? row.entityType === 'task' && row.entityId === fact.objectId : row.taskId === fact.objectId)
  })
}
export function canReadObject(store: Store, actor: User, type: ObjectType, id: string, capability: ObjectCapability = 'read'): boolean {
  const current = store.get<User>('users', actor.id), object = store.get<Entity & { ownerId?: string }>(collections[type], id)
  if (!current || !canUseAccount(current) || !object) return false
  if (current.role === 'manager') return true
  if (current.role === 'member' && type === 'task') return object.ownerId === current.id
  const grant = activeGrant(store, current, type, id, capability)
  if (!grant) return false
  return type !== 'scoped_report' || reportSourcesAccessible(store, current, object as ScopedReport, capability)
}
export function canPerformAction(store: Store, actor: User, action: 'read' | 'read_evidence' | 'export_summary' | 'write', type: ObjectType, id: string): boolean {
  const current = store.get<User>('users', actor.id)
  if (action !== 'write') return canReadObject(store, actor, type, id, action)
  return !!current && canUseAccount(current) && current.role !== 'observer' && canReadObject(store, current, type, id)
}
export function historicalBoundary(store: Store, type: ObjectType, id: string): string[] {
  if (type !== 'task') return []
  return [
    ...store.list<WeeklyRecord>('weeklyRecords').filter(row => row.taskId === id).map(row => `weeklyRecord:${row.id}`),
    ...store.list<Entity & { taskId: string }>('taskDeliveries').filter(row => row.taskId === id).map(row => `delivery:${row.id}`),
    ...store.entityEvents('task', id).map(row => `history:${row.id}`),
  ].sort()
}
type DeliveryRow = Entity & { taskId: string; seriesId: string; revision: number; submittedAt: string; actualOutcome: string; evidenceRefs: unknown[]; acceptanceCriteriaSnapshot: string }
export class ObjectAccessService {
  constructor(private store: Store) {}
  taskView(actor: User, id: string): AuthorizedTaskView {
    actor = liveObjectActor(this.store, actor)
    if (!canReadObject(this.store, actor, 'task', id)) throw new HttpError(404, '授权事项不存在或权限已失效', 'ACCESS_REVOKED')
    const task = this.store.get<Task>('tasks', id)!, grant = activeGrant(this.store, actor, 'task', id)
    const privileged = actor.role !== 'observer', evidence = privileged || !!activeGrant(this.store, actor, 'task', id, 'read_evidence')
    const safeTask: Task = { id: task.id, version: task.version, createdAt: task.createdAt, updatedAt: task.updatedAt, title: task.title, monthlyPlanId: task.monthlyPlanId, ownerId: task.ownerId, description: task.description, dueDate: task.dueDate, status: task.status, isTemporary: task.isTemporary, temporaryReason: '', currentProgress: task.currentProgress ?? '', requestedOutcome: task.requestedOutcome ?? '', nextAction: task.nextAction ?? '', ...(task.priority ? { priority: task.priority } : {}), ...(task.cancellation ? { cancellation: { ...task.cancellation, reason: '' } } : {}), ...(evidence && task.evidenceUrl ? { evidenceUrl: task.evidenceUrl } : {}) }
    const weeklyRecords = this.store.list<WeeklyRecord>('weeklyRecords').filter(row => row.taskId === id && row.submitted && !row.deletion && (privileged || !!grant && historyVisible(grant, row, 'weeklyRecord'))).map(row => ({ id: row.id, version: row.version, createdAt: row.createdAt, updatedAt: row.updatedAt, taskId: row.taskId, monthlyPlanId: row.monthlyPlanId, ownerId: row.ownerId, weekStart: row.weekStart, commitment: row.commitment, actualOutcome: row.actualOutcome, evidenceUrl: evidence ? row.evidenceUrl : '', blocker: row.blocker, nextAction: row.nextAction, status: row.status, submitted: true }))
    const history = this.store.entityEvents('task', id).filter(row => privileged || !!grant && historyVisible(grant, row)).map(row => ({ id: row.id, action: row.action, occurredAt: row.createdAt, actorName: this.store.get<User>('users', row.actorId)?.name ?? '成员' }))
    const deliveries = this.store.list<DeliveryRow>('taskDeliveries').filter(row => row.taskId === id && (privileged || !!grant && historyVisible(grant, { ...row, occurredAt: row.submittedAt }, 'delivery'))).map(row => {
      const decisions = this.store.list<DeliveryDecision>('deliveryDecisions').filter(decision => decision.deliveryId === row.id)
      const superseded = new Set(decisions.map(decision => decision.supersedesDecisionId))
      const decision = decisions.find(item => !superseded.has(item.id))
      return { id: row.id, seriesId: row.seriesId, revision: row.revision, submittedAt: row.submittedAt, actualOutcome: row.actualOutcome, evidenceRefs: evidence ? row.evidenceRefs : [], acceptanceCriteriaSnapshot: row.acceptanceCriteriaSnapshot, status: decision?.conclusion ?? 'pending_review' }
    })
    const deliverySummary = { pending_review: 0, accepted: 0, returned: 0, withdrawn: 0 }
    for (const series of this.store.list<DeliverySeries>('deliverySeries').filter(row => row.taskId === id)) deliverySummary[series.status]++
    const plan = task.monthlyPlanId ? this.store.get<MonthlyPlan>('plans', task.monthlyPlanId) : undefined, project = plan?.projectId ? this.store.get<Project>('projects', plan.projectId) : undefined
    return { task: safeTask, weeklyRecords, history, deliveries, deliverySummary, monthReference: plan ? { id: plan.id, title: plan.title } : null, projectReference: project ? { id: project.id, name: project.name } : null, allowedActions: [], readOnlyReason: '观察者只能读取当前授权范围' }
  }
  list(actor: User): AuthorizedWorkResponse {
    actor = liveObjectActor(this.store, actor)
    const items = this.store.list<ObjectGrant>('objectGrants').filter(grant => grant.subjectId === actor.id && canReadObject(this.store, actor, grant.objectType, grant.objectId) && activeGrant(this.store, actor, grant.objectType, grant.objectId)?.id === grant.id).map(grant => {
      const object = this.store.get<Entity & { title?: string; name?: string }>(collections[grant.objectType], grant.objectId)!
      return { id: grant.id, objectType: grant.objectType, objectId: grant.objectId, title: object.title ?? object.name ?? '授权事项', capabilities: grant.capabilities, grantId: grant.id, version: object.version }
    })
    return { items, scopeVersion: readScopeVersion(this.store, actor) }
  }
  detail(actor: User, id: string) {
    actor = liveObjectActor(this.store, actor)
    const grant = this.store.get<ObjectGrant>('objectGrants', id)
    if (!grant || grant.subjectId !== actor.id || activeGrant(this.store, actor, grant.objectType, grant.objectId)?.id !== grant.id) throw new HttpError(404, '授权事项不存在或权限已失效')
    return { objectType: grant.objectType, objectId: grant.objectId, object: projectObject(this.store, actor, grant.objectType, grant.objectId), capabilities: grant.capabilities, scopeVersion: readScopeVersion(this.store, actor) }
  }
  bootstrap(actor: User): Bootstrap {
    actor = liveObjectActor(this.store, actor)
    const scope = this.list(actor)
    return { user: actor, users: [actor], projects: [], plans: [], tasks: [], weeklyRecords: [], annualGoals: [], publications: [], reports: [], aiConfigured: false, authorizedWork: scope.items, scopeVersion: scope.scopeVersion, accessScopeVersion: scope.scopeVersion, taskProgress: {} }
  }
}
export function projectObject(store: Store, actor: User, type: ObjectType, id: string): AuthorizedTaskView | AuthorizedProjectSummary | ScopedReport {
  actor = liveObjectActor(store, actor)
  if (!canReadObject(store, actor, type, id)) throw new HttpError(404, '授权事项不存在或来源权限已失效，请管理者生成新版本', 'ACCESS_REVOKED')
  if (type === 'task') return new ObjectAccessService(store).taskView(actor, id)
  if (type === 'scoped_report') {
    const report = store.get<ScopedReport>('scopedReports', id)!
    // Evidence is an independent capability; immutable report bytes are never rewritten.
    return canReadObject(store, actor, type, id, 'read_evidence') ? report : { ...report, evidenceRefs: [] }
  }
  const project = store.get<Project>('projects', id)!
  const plans = new Set(store.list<MonthlyPlan>('plans').filter(plan => plan.projectId === id).map(plan => plan.id))
  const tasks = store.list<Task>('tasks').filter(task => !task.cancellation && !!task.monthlyPlanId && plans.has(task.monthlyPlanId) && !!activeGrant(store, actor, 'task', task.id))
  return { id, name: project.name, scopeLabel: '授权范围内', taskCount: tasks.length, completedTaskCount: tasks.filter(task => task.status === 'done').length, blockedTaskCount: tasks.filter(task => task.status === 'blocked').length }
}
export const observerBootstrap = (store: Store, actor: User): Bootstrap => new ObjectAccessService(store).bootstrap(actor)
