import type { AnnualGoal, AuditEvent, Bootstrap, MonthlyPlan, Project, Publication, Report, Task, User, WeeklyRecord } from '../../shared/types.ts'
import { workOriginProjector } from '../../server/work-origin.ts'
import { safeUser } from '../../server/auth.ts'
import { registrationApproved } from '../../shared/auth-policy.ts'
import { AdminService } from '../../server/domain-admin.ts'
import { DomainBase } from '../../server/domain-common.ts'
import { MonthlyService } from '../../server/domain-plans.ts'
import { WorkService } from '../../server/domain-work.ts'
import { Store } from '../../server/store.ts'
import { planReference, planVisibilityProjector } from '../../server/plan-visibility.ts'
import { aiConfigured } from '../../server/reports.ts'
import { isActiveWeeklyRecord } from '../../shared/weekly-record-state.ts'
import { isActiveTask } from '../../shared/task-state.ts'
import { getOperationEpoch } from '../../server/operation-context.ts'
import { liveObjectActor, observerBootstrap } from '../../server/object-access.ts'
// This retired R2 envelope must retain its original scope token for the frozen baseline comparison.
import { readScopeVersion } from './r2-baseline/object-access.ts'
import { workProgressProjector } from '../../server/work-progress.ts'
import type { ProgressEvent } from '../../shared/collaboration.ts'

import { Domain } from '../../server/domain.ts'

/** Retired R2 snapshot, test-only. Runtime callers must use dedicated reads. */
export class TestDomain extends Domain {
  bootstrap(actor: User, includeLegacyOrigins = true, includeDeleted = false, now = new Date()): Bootstrap {
    actor = liveObjectActor(this.store, actor)
    if (actor.role === 'observer') return { ...observerBootstrap(this.store, actor), operationEpoch: getOperationEpoch(this.store) }
    const isManager = actor.role === 'manager'
    const storedPlans = this.store.list<MonthlyPlan>('plans'), planMap = new Map(storedPlans.map(plan => [plan.id, plan]))
    const events = this.store.list<AuditEvent>('events'), storedPublications = this.store.list<Publication>('publications')
    const storedRecords = this.store.list<WeeklyRecord>('weeklyRecords'), progressEvents = this.store.list<ProgressEvent>('progressEvents')
    const projectPlan = planVisibilityProjector(this.store, actor, { plans: storedPlans, events, publications: storedPublications })
    const plans = storedPlans.flatMap(plan => {
      const visible = projectPlan.visible(plan)
      return visible ? [visible] : []
    })
    const storedTasks = this.store.list<Task>('tasks')
    const cancelledTaskIds = new Set(storedTasks.filter(task => !isActiveTask(task)).map(task => task.id))
    const tasks = storedTasks.filter(task => (includeDeleted || isActiveTask(task)) && (isManager || task.ownerId === actor.id))
    let weeklyRecords = storedRecords.filter(record => (includeDeleted || isActiveWeeklyRecord(record) && !cancelledTaskIds.has(record.taskId)) && (isManager || record.ownerId === actor.id))
    // Backfill only this member's own task snapshot when a historical record outlives its task.
    const visibleTaskIds = new Set(tasks.map(task => task.id))
    const taskHistory = new Map<string, Task>()
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
      const current = planMap.get(work.monthlyPlanId)
      if (current) { plans.push(planReference(current)); visiblePlanIds.add(current.id) }
    }
    const publications = projectPlan.publications()
    const users = this.store.list<User>('users').filter(user => isManager || registrationApproved(user)).map(user => ({ ...safeUser(user), ...(isManager && user.registrationStatus ? { registrationReviewComment: user.registrationReviewComment ?? '' } : {}) }))
    const projectOrigin = workOriginProjector(includeLegacyOrigins ? events : [])
    const progress = workProgressProjector(this.store, actor, now, { records: storedRecords, progressEvents, audits: events })
    return { user: safeUser(actor), operationEpoch: getOperationEpoch(this.store), accessScopeVersion: readScopeVersion(this.store, actor), taskProgress: Object.fromEntries(tasks.map(task => [task.id, progress(task)])), users, projects: this.store.list<Project>('projects'), annualGoals: this.store.list<AnnualGoal>('annualGoals'), plans, tasks: tasks.map(row => projectOrigin(row, 'task')), weeklyRecords: weeklyRecords.map(row => projectOrigin(row, 'weeklyRecord')), publications, reports: isManager ? this.store.list<Report>('reports') : [], aiConfigured: aiConfigured(this.store) }
  }
}
