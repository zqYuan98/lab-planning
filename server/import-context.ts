import type { AuditEvent, MonthlyPlan, Project, Task, User } from '../shared/types.ts'
import { registrationApproved } from '../shared/auth-policy.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { safeUser } from './auth.ts'
import { assertBusinessActor } from './object-access.ts'
import { projectPlan } from './plan-visibility.ts'
import type { Store } from './store.ts'
import { workOriginProjector } from './work-origin.ts'

/** Import name matching uses only the account/project directory, never work or reports. */
export function readImportDirectory(store: Store, actor: User): { users: User[]; projects: Project[] } {
  actor = assertBusinessActor(store, actor)
  const manager = actor.role === 'manager'
  const users = store.list<User>('users').filter(user => manager || registrationApproved(user))
    .map(user => ({ ...safeUser(user), ...(manager && user.registrationStatus ? { registrationReviewComment: user.registrationReviewComment ?? '' } : {}) }))
  return { users, projects: store.list<Project>('projects') }
}

/** Compatibility context for integration clients. Interactive selectors use paged queries.
 * Only link candidates are read; historical task references keep the established contract.
 */
export function readImportContext(store: Store, actor: User) {
  return store.transaction(() => {
    actor = assertBusinessActor(store, actor)
    const manager = actor.role === 'manager', directory = readImportDirectory(store, actor)
    const plans = store.selectJson<MonthlyPlan>(`SELECT p.data FROM entities p WHERE p.collection='plans'
      ${manager ? '' : `AND (json_extract(p.data,'$.ownerId')=? OR EXISTS (SELECT 1 FROM json_each(p.data,'$.collaboratorIds') c WHERE c.value=?))
      AND COALESCE(json_extract(p.data,'$.visibility'),'')<>'reference' AND json_extract(p.data,'$.status')<>'merged' AND (json_extract(p.data,'$.projectId') IS NULL OR json_extract(p.data,'$.projectId')='' OR EXISTS (
        SELECT 1 FROM entities pr WHERE pr.collection='projects' AND pr.id=json_extract(p.data,'$.projectId') AND json_extract(pr.data,'$.status')='active'))`}
      ORDER BY p.rowid`, manager ? [] : [actor.id, actor.id]).map(plan => projectPlan(actor, plan, store))
    const tasks = store.selectJson<Task>(`SELECT data FROM entities WHERE collection='tasks' AND json_extract(data,'$.cancellation') IS NULL
      ${manager ? '' : "AND json_extract(data,'$.ownerId')=?"} ORDER BY rowid`, manager ? [] : [actor.id])
    const ids = new Set(tasks.map(task => task.id))
    const referenced = store.selectRows(`SELECT json_extract(w.data,'$.taskId') AS taskId FROM entities w WHERE w.collection='weeklyRecords'
      AND json_extract(w.data,'$.deletion') IS NULL ${manager ? '' : "AND json_extract(w.data,'$.ownerId')=?"}
      AND NOT EXISTS (SELECT 1 FROM entities t WHERE t.collection='tasks' AND t.id=json_extract(w.data,'$.taskId') AND json_extract(t.data,'$.cancellation') IS NOT NULL)
      GROUP BY json_extract(w.data,'$.taskId') ORDER BY MIN(w.rowid)`, manager ? [] : [actor.id])
    const missingIds = referenced.map(row => String(row.taskId)).filter(id => !ids.has(id)), history = new Map<string, Task>()
    if (missingIds.length) for (const event of store.selectJson<AuditEvent>(`SELECT data FROM entities WHERE collection='events' AND json_extract(data,'$.entityType')='task'
      AND json_extract(data,'$.entityId') IN (SELECT value FROM json_each(?)) ORDER BY rowid`, [JSON.stringify(missingIds)])) for (const value of [event.before, event.after]) {
      const snapshot = value as Task | null, previous = history.get(event.entityId)
      if (snapshot && snapshot.id === event.entityId && (manager || snapshot.ownerId === actor.id) && (!previous || previous.version < snapshot.version)) history.set(event.entityId, snapshot)
    }
    for (const id of missingIds) {
      const historical = history.get(id)
      if (historical && isActiveTask(historical)) { tasks.push(historical); ids.add(historical.id) }
    }
    const originIds = tasks.filter(task => !task.workOrigin && !task.importSource).map(task => task.id), origins: AuditEvent[] = []
    for (let offset = 0; offset < originIds.length; offset += 200) {
      const batch = originIds.slice(offset, offset + 200)
      origins.push(...store.selectJson<AuditEvent>(`SELECT data FROM entities WHERE collection='events' AND json_extract(data,'$.entityType')='task'
        AND json_type(data,'$.before')='null' AND json_extract(data,'$.action') IN ('create','submit')
        AND json_extract(data,'$.entityId') IN (${batch.map(() => '?').join(',')}) ORDER BY rowid`, batch))
    }
    const projectOrigin = workOriginProjector(origins)
    return { ...directory, plans, tasks: tasks.map(task => projectOrigin(task, 'task')) }
  })
}
