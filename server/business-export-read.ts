import type { AuditEvent, MonthlyPlan, Publication, Task, User, WeeklyRecord } from '../shared/types.ts'
import { registrationApproved } from '../shared/auth-policy.ts'
import { safeUser } from './auth.ts'
import type { BusinessCollections } from './data-transfer-schema.ts'
import { assertBusinessActor } from './object-access.ts'
import { planReference, planVisibilityProjector } from './plan-visibility.ts'
import type { Store } from './store.ts'
import { isManager } from './authorization.ts'

export type BusinessExportSources = Pick<BusinessCollections, 'users' | 'projects' | 'annualGoals' | 'plans' | 'tasks' | 'weeklyRecords' | 'publications' | 'reports'>

/** Complete authorized migration sources, including tombstones and historical dependencies.
 * This intentionally has no page limit. Progress displays, AI state and command context
 * are not migration records and are never read here.
 */
export function readBusinessExportSources(store: Store, actor: User): BusinessExportSources {
  actor = assertBusinessActor(store, actor)
  const manager = isManager(actor)
  const storedPlans = store.list<MonthlyPlan>('plans'), storedPublications = store.list<Publication>('publications')
  const projector = planVisibilityProjector(store, actor, {
    plans: storedPlans, publications: storedPublications, events: manager ? [] : store.entityTypeEvents(['plan']),
  })
  const plans = storedPlans.flatMap(plan => { const visible = projector.visible(plan); return visible ? [visible] : [] })
  const tasks = store.selectJson<Task>(`SELECT data FROM entities WHERE collection='tasks' ${manager ? '' : "AND json_extract(data,'$.ownerId')=?"} ORDER BY rowid`, manager ? [] : [actor.id])
  const weeklyRecords = store.selectJson<WeeklyRecord>(`SELECT data FROM entities WHERE collection='weeklyRecords' ${manager ? '' : "AND json_extract(data,'$.ownerId')=?"} ORDER BY rowid`, manager ? [] : [actor.id])
  const taskIds = new Set(tasks.map(task => task.id)), missingIds = [...new Set(weeklyRecords.map(record => record.taskId))].filter(id => !taskIds.has(id)), history = new Map<string, Task>()
  if (missingIds.length) for (const event of store.selectJson<AuditEvent>(`SELECT data FROM entities WHERE collection='events' AND json_extract(data,'$.entityType')='task'
    AND json_extract(data,'$.entityId') IN (SELECT value FROM json_each(?)) ORDER BY rowid`, [JSON.stringify(missingIds)])) for (const value of [event.before, event.after]) {
    const snapshot = value as Task | null, previous = history.get(event.entityId)
    if (snapshot && snapshot.id === event.entityId && (manager || snapshot.ownerId === actor.id) && (!previous || previous.version < snapshot.version)) history.set(event.entityId, snapshot)
  }
  for (const id of missingIds) { const historical = history.get(id); if (historical) tasks.push(historical) }
  const planIds = new Set(plans.map(plan => plan.id)), storedById = new Map(storedPlans.map(plan => [plan.id, plan]))
  for (const work of [...tasks, ...weeklyRecords]) {
    if (!work.monthlyPlanId || planIds.has(work.monthlyPlanId)) continue
    const current = storedById.get(work.monthlyPlanId)
    if (current) { plans.push(planReference(current)); planIds.add(current.id) }
  }
  const users = store.list<User>('users').filter(user => manager || registrationApproved(user))
    .map(user => ({ ...safeUser(user), ...(manager && user.registrationStatus ? { registrationReviewComment: user.registrationReviewComment ?? '' } : {}) }))
  return {
    users, projects: store.list('projects'), annualGoals: store.list('annualGoals'), plans, tasks, weeklyRecords,
    publications: projector.publications(), reports: manager ? store.list('reports') : [],
  }
}
