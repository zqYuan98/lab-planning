// Frozen bootstrap body from git show 65317c6:server/domain.ts.
// Only adaptation besides imports: free Store argument and injectable progress clock.
import type { AnnualGoal, AuditEvent, Bootstrap, MonthlyPlan, Project, Publication, Report, Task, User, WeeklyRecord } from '../../../shared/types.ts'
import type { Store } from '../../../server/store.ts'
import { workOriginProjector } from './work-origin.ts'
import { safeUser } from './helpers.ts'
import { registrationApproved } from './auth-policy.ts'
import { planReference, visiblePlan, visiblePublications } from './plan-visibility.ts'
import { aiConfigured } from '../../../server/reports.ts'
import { isActiveWeeklyRecord } from './weekly-record-state.ts'
import { isActiveTask } from './task-state.ts'
import { getOperationEpoch } from '../../../server/operation-context.ts'
import { liveObjectActor, observerBootstrap, readScopeVersion } from './object-access.ts'
import { workProgressProjector } from './work-progress.ts'

export function legacyBootstrap(store: Store, actor: User, includeLegacyOrigins = true, includeDeleted = false, now = new Date()): Bootstrap {
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
    const taskHistory = new Map<string, Task>()
    const events = store.list<AuditEvent>('events')
    for (const event of events) {
      if (event.entityType !== 'task') continue
      for (const value of [event.before, event.after]) {
        const task = value as Task | null
        if (task && task.id === event.entityId && (isManager || task.ownerId === actor.id) && (!taskHistory.has(task.id) || taskHistory.get(task.id)!.version < task.version)) taskHistory.set(task.id, task)
      }
    }
    for (const record of weeklyRecords) {
      if (visibleTaskIds.has(record.taskId)) continue
      const historical = taskHistory.get(record.taskId)
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
    const projectOrigin = workOriginProjector(includeLegacyOrigins ? events : [])
    const progress = workProgressProjector(store, actor, now)
    return { user: safeUser(actor), operationEpoch: getOperationEpoch(store), accessScopeVersion: readScopeVersion(store, actor), taskProgress: Object.fromEntries(tasks.map(task => [task.id, progress(task)])), users, projects: store.list<Project>('projects'), annualGoals: store.list<AnnualGoal>('annualGoals'), plans, tasks: tasks.map(row => projectOrigin(row, 'task')), weeklyRecords: weeklyRecords.map(row => projectOrigin(row, 'weeklyRecord')), publications, reports: isManager ? store.list<Report>('reports') : [], aiConfigured: aiConfigured(store) }
  }
