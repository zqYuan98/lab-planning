// Frozen baseline read path from 66f1cc3; benchmark only, never mounted in HTTP.
import type { AnnualGoal, AuditEvent, Bootstrap, MonthlyPlan, Project, Publication, Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { Store } from '../server/store.ts'
import { workOriginProjector } from '../server/work-origin.ts'
import { safeUser } from '../server/auth.ts'
import { registrationApproved } from '../shared/auth-policy.ts'
import { planReference, visiblePlan, visiblePublications } from '../server/plan-visibility.ts'
import { aiConfigured } from '../server/reports.ts'
import { isActiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { getOperationEpoch } from '../server/operation-context.ts'
import { liveObjectActor, observerBootstrap, readScopeVersion } from '../server/object-access.ts'
import { workProgressProjector } from '../server/work-progress.ts'
export function legacyBootstrap(store: Store, actor: User, includeLegacyOrigins = true, includeDeleted = false): Bootstrap {
    actor = liveObjectActor(store, actor)
    if (actor.role === 'observer') return { ...observerBootstrap(store, actor), operationEpoch: getOperationEpoch(store) }
    const isManager = actor.role === 'manager'
    const plans = store.list<MonthlyPlan>('plans').flatMap(plan => {
      const visible = visiblePlan(store, actor, plan)
      return visible ? [visible] : []
    })
    const storedTasks = store.list<Task>('tasks')
    const cancelledTaskIds = new Set(storedTasks.filter(task => !isActiveTask(task)).map(task => task.id))
    const tasks = storedTasks.filter(task => (includeDeleted || isActiveTask(task)) && (isManager || task.ownerId === actor.id))
    let weeklyRecords = store.list<WeeklyRecord>('weeklyRecords').filter(record => (includeDeleted || isActiveWeeklyRecord(record) && !cancelledTaskIds.has(record.taskId)) && (isManager || record.ownerId === actor.id))
    // Backfill only this member's own task snapshot when a historical record outlives its task.
    const visibleTaskIds = new Set(tasks.map(task => task.id))
    for (const record of weeklyRecords) {
      if (visibleTaskIds.has(record.taskId)) continue
      const historical = store.list<AuditEvent>('events').filter(event => event.entityType === 'task' && event.entityId === record.taskId)
        .flatMap(event => [event.before, event.after]).filter((value): value is Task => {
          const task = value as Task | null
          return !!task && task.id === record.taskId && (isManager || task.ownerId === actor.id)
        }).sort((a, b) => b.version - a.version)[0]
      if (historical) {
        if (!includeDeleted && !isActiveTask(historical)) { cancelledTaskIds.add(historical.id); continue }
        tasks.push(historical); visibleTaskIds.add(historical.id)
      }
    }
    if (!includeDeleted) weeklyRecords = weeklyRecords.filter(record => !cancelledTaskIds.has(record.taskId))
    const visiblePlanIds = new Set(plans.map(plan => plan.id))
    for (const work of [...tasks, ...weeklyRecords]) {
      if (!work.monthlyPlanId || visiblePlanIds.has(work.monthlyPlanId)) continue
      const current = store.get<MonthlyPlan>('plans', work.monthlyPlanId)
      if (current) { plans.push(planReference(current)); visiblePlanIds.add(current.id) }
    }
    const publications = visiblePublications(actor, store.list<Publication>('publications'), store)
    const users = store.list<User>('users').filter(user => isManager || registrationApproved(user)).map(user => ({ ...safeUser(user), ...(isManager && user.registrationStatus ? { registrationReviewComment: user.registrationReviewComment ?? '' } : {}) }))
    const projectOrigin = workOriginProjector(includeLegacyOrigins ? store.list<AuditEvent>('events') : [])
    const progress = workProgressProjector(store, actor)
    return { user: safeUser(actor), operationEpoch: getOperationEpoch(store), accessScopeVersion: readScopeVersion(store, actor), taskProgress: Object.fromEntries(tasks.map(task => [task.id, progress(task)])), users, projects: store.list<Project>('projects'), annualGoals: store.list<AnnualGoal>('annualGoals'), plans, tasks: tasks.map(row => projectOrigin(row, 'task')), weeklyRecords: weeklyRecords.map(row => projectOrigin(row, 'weeklyRecord')), publications, reports: isManager ? store.list<Report>('reports') : [], aiConfigured: aiConfigured(store) }
  }
