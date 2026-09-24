import { HttpError } from './store.ts'
import type { WorkspaceResource } from '../shared/workspace-query.ts'

export interface WorkspaceSqlFilter {
  resource: WorkspaceResource; actorId: string; manager: boolean; ownerId?: string; status?: string; month?: string; weekStart?: string; taskId?: string; q?: string; includeCancelled?: boolean; scope?: 'open' | 'all'; kind?: 'user' | 'project' | 'plan'; type?: 'weekly' | 'monthly'; period?: string; role?: 'manager' | 'member'
}
export const field = (name: string, alias = 'e') => `json_extract(${alias}.data,'$.${name}')`
export function workspaceWhere(f: WorkspaceSqlFilter) {
  const collection = { tasks: 'tasks', 'weekly-records': 'weeklyRecords', plans: 'plans', history: 'events', progress: 'progressEvents', reports: 'reports', candidates: f.kind === 'user' ? 'users' : f.kind === 'project' ? 'projects' : 'plans' }[f.resource]
  if (!collection) throw new HttpError(400, '查询集合无效')
  const clauses = ['e.collection=?'], values: (string | number)[] = [collection]
  const add = (sql: string, ...parameters: (string | number)[]) => { clauses.push(sql); values.push(...parameters) }
  if (collection === 'tasks' || collection === 'weeklyRecords') {
    if (!f.manager) add(`${field('ownerId')}=?`, f.actorId)
    if (f.ownerId) add(`${field('ownerId')}=?`, f.ownerId)
    if (!f.includeCancelled) {
      if (collection === 'tasks') add(`${field('cancellation')} IS NULL`)
      else add(`${field('deletion')} IS NULL AND NOT EXISTS (SELECT 1 FROM entities t WHERE t.collection='tasks' AND t.id=${field('taskId')} AND ${field('cancellation','t')} IS NOT NULL)`)
    }
    if (f.scope === 'open') add(collection === 'tasks' ? `(${field('status')}<>'done' OR (${field('importSource')} IS NOT NULL AND trim(COALESCE(${field('completionNote')},''))=''))` : `${field('status')}<>'done'`)
    if (f.taskId) add(collection === 'tasks' ? 'e.id=?' : `${field('taskId')}=?`, f.taskId)
    if (f.weekStart && collection === 'weeklyRecords') add(`${field('weekStart')}=?`, f.weekStart)
    // An open task belongs to the current workload regardless of its creation month.
    if (f.month && f.scope !== 'open') add(collection === 'weeklyRecords' ? `substr(${field('weekStart')},1,7)=?` : `EXISTS (SELECT 1 FROM entities p WHERE p.collection='plans' AND p.id=${field('monthlyPlanId')} AND ${field('month','p')}=?)`, f.month)
  }
  if (collection === 'plans') {
    if (!f.manager) add(`(${field('ownerId')}=? OR EXISTS (SELECT 1 FROM json_each(${field('collaboratorIds')}) c WHERE c.value=?))`, f.actorId, f.actorId)
    if (f.ownerId) add(`${field('ownerId')}=?`, f.ownerId)
    if (f.month) add(`${field('month')}=?`, f.month)
    if (f.scope === 'open') add(`${field('status')}<>'merged' AND ${field('acceptanceStatus')}<>'accepted'`)
  }
  if (collection === 'events') {
    if (!f.taskId) throw new HttpError(400, '历史查询必须指定任务')
    add(`${field('entityType')}='task' AND ${field('entityId')}=?`, f.taskId)
    if (!f.manager) add(`EXISTS (SELECT 1 FROM entities t WHERE t.collection='tasks' AND t.id=? AND ${field('ownerId','t')}=?) AND (${field('before.ownerId')}=? OR ${field('after.ownerId')}=?)`, f.taskId, f.actorId, f.actorId, f.actorId)
  }
  if (collection === 'progressEvents') {
    if (!f.taskId) throw new HttpError(400, '进展查询必须指定任务')
    add(`${field('taskId')}=?`, f.taskId)
    if (!f.manager) add(`${field('ownerId')}=? AND EXISTS(SELECT 1 FROM entities t WHERE t.collection='tasks' AND t.id=? AND ${field('ownerId','t')}=?)`, f.actorId, f.taskId, f.actorId)
  }
  if (collection === 'reports' && !f.manager) throw new HttpError(403, '只有管理者可以读取报告档案')
  if (collection === 'users') add(`${field('active')}=1 AND (${field('registrationStatus')} IS NULL OR ${field('registrationStatus')}='approved') AND ${field('role')}<>'observer'`)
  if (collection === 'users' && f.role) add(`${field('role')}=?`, f.role)
  if (collection === 'projects' && !f.manager) add(`EXISTS (SELECT 1 FROM entities p WHERE p.collection='plans' AND ${field('projectId','p')}=e.id AND (${field('ownerId','p')}=? OR EXISTS (SELECT 1 FROM json_each(${field('collaboratorIds','p')}) c WHERE c.value=?)))`, f.actorId, f.actorId)
  if (f.status) add(`${field('status')}=?`, f.status)
  if (f.type) add(`${field('type')}=?`, f.type)
  if (f.period) add(`${field('period')}=?`, f.period)
  if (f.q) {
    const names = collection === 'users' || collection === 'projects' ? ['name'] : collection === 'weeklyRecords' ? ['commitment', 'actualOutcome'] : ['title', 'description', 'currentProgress', 'assignedBy', 'requestedOutcome']
    add(`(${names.map(name => `instr(lower(COALESCE(${field(name)},'')),lower(?))>0`).join(' OR ')})`, ...names.map(() => f.q!))
  }
  return { sql: clauses.join(' AND '), values, collection }
}
export function reportMetadataProjection() {
  const fields = ['id', 'version', 'createdAt', 'updatedAt', 'type', 'period', 'title', 'status', 'revision', 'authorId', 'finalizedAt']
  return `json_object(${fields.map(name => `'${name}',${field(name)}`).join(',')})`
}
