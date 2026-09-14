import type { AnnualGoal, AuditEvent, Bootstrap, MonthlyPlan, Project, Publication, Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import { workOriginProjector } from './work-origin.ts'
import { safeUser } from './auth.ts'
import { registrationApproved } from '../shared/auth-policy.ts'
import { AdminService } from './domain-admin.ts'
import { DomainBase } from './domain-common.ts'
import { MonthlyService } from './domain-plans.ts'
import { WorkService } from './domain-work.ts'
import { Store } from './store.ts'
import { planReference, visiblePlan, visiblePublications } from './plan-visibility.ts'
import { aiConfigured } from './reports.ts'

/** Facade shared by HTTP routes and domain integration tests. */
export class Domain extends DomainBase {
  private admin: AdminService
  private monthly: MonthlyService
  private work: WorkService
  constructor(store: Store) {
    super(store)
    this.admin = new AdminService(store)
    this.monthly = new MonthlyService(store)
    this.work = new WorkService(store)
  }
  setup = (...args: Parameters<AdminService['setup']>) => this.admin.setup(...args)
  login = (...args: Parameters<AdminService['login']>) => this.admin.login(...args)
  register = (...args: Parameters<AdminService['register']>) => this.admin.register(...args)
  reviewRegistration = (...args: Parameters<AdminService['reviewRegistration']>) => this.admin.reviewRegistration(...args)
  createUser = (...args: Parameters<AdminService['createUser']>) => this.admin.createUser(...args)
  updateUser = (...args: Parameters<AdminService['updateUser']>) => this.admin.updateUser(...args)
  createProject = (...args: Parameters<AdminService['createProject']>) => this.admin.createProject(...args)
  updateProject = (...args: Parameters<AdminService['updateProject']>) => this.admin.updateProject(...args)
  createAnnualGoal = (...args: Parameters<AdminService['createAnnualGoal']>) => this.admin.createAnnualGoal(...args)
  updateAnnualGoal = (...args: Parameters<AdminService['updateAnnualGoal']>) => this.admin.updateAnnualGoal(...args)
  createPlan = (...args: Parameters<MonthlyService['create']>) => this.monthly.create(...args)
  updatePlan = (...args: Parameters<MonthlyService['update']>) => this.monthly.update(...args)
  submitPlan = (...args: Parameters<MonthlyService['submit']>) => this.monthly.submit(...args)
  reviewPlan = (...args: Parameters<MonthlyService['review']>) => this.monthly.review(...args)
  publishMonth = (...args: Parameters<MonthlyService['publish']>) => this.monthly.publish(...args)
  mergePlans = (...args: Parameters<MonthlyService['merge']>) => this.monthly.merge(...args)
  planResult = (...args: Parameters<MonthlyService['result']>) => this.monthly.result(...args)
  planHistory = (...args: Parameters<MonthlyService['history']>) => this.monthly.history(...args)
  carryPlan = (...args: Parameters<MonthlyService['carry']>) => this.monthly.carry(...args)
  createTask = (...args: Parameters<WorkService['createTask']>) => this.work.createTask(...args)
  updateTask = (...args: Parameters<WorkService['updateTask']>) => this.work.updateTask(...args)
  relinkTask = (...args: Parameters<WorkService['relinkTask']>) => this.work.relinkTask(...args)
  createWeeklyRecord = (...args: Parameters<WorkService['createWeeklyRecord']>) => this.work.createWeeklyRecord(...args)
  updateWeeklyRecord = (...args: Parameters<WorkService['updateWeeklyRecord']>) => this.work.updateWeeklyRecord(...args)
  carryWeeklyRecord = (...args: Parameters<WorkService['carryWeeklyRecord']>) => this.work.carryWeeklyRecord(...args)

  bootstrap(actor: User, includeLegacyOrigins = true): Bootstrap {
    const isManager = actor.role === 'manager'
    const plans = this.store.list<MonthlyPlan>('plans').flatMap(plan => {
      const visible = visiblePlan(this.store, actor, plan)
      return visible ? [visible] : []
    })
    const tasks = this.store.list<Task>('tasks').filter(task => isManager || task.ownerId === actor.id)
    const weeklyRecords = this.store.list<WeeklyRecord>('weeklyRecords').filter(record => isManager || record.ownerId === actor.id)
    // Backfill only this member's own task snapshot when a historical record outlives its task.
    const visibleTaskIds = new Set(tasks.map(task => task.id))
    for (const record of weeklyRecords) {
      if (visibleTaskIds.has(record.taskId)) continue
      const historical = this.store.list<AuditEvent>('events').filter(event => event.entityType === 'task' && event.entityId === record.taskId)
        .flatMap(event => [event.before, event.after]).filter((value): value is Task => {
          const task = value as Task | null
          return !!task && task.id === record.taskId && (isManager || task.ownerId === actor.id)
        }).sort((a, b) => b.version - a.version)[0]
      if (historical) { tasks.push(historical); visibleTaskIds.add(historical.id) }
    }
    const visiblePlanIds = new Set(plans.map(plan => plan.id))
    for (const work of [...tasks, ...weeklyRecords]) {
      if (!work.monthlyPlanId || visiblePlanIds.has(work.monthlyPlanId)) continue
      const current = this.store.get<MonthlyPlan>('plans', work.monthlyPlanId)
      if (current) { plans.push(planReference(current)); visiblePlanIds.add(current.id) }
    }
    const publications = visiblePublications(actor, this.store.list<Publication>('publications'), this.store)
    const users = this.store.list<User>('users').filter(user => isManager || registrationApproved(user)).map(user => ({ ...safeUser(user), ...(isManager && user.registrationStatus ? { registrationReviewComment: user.registrationReviewComment ?? '' } : {}) }))
    const projectOrigin = workOriginProjector(includeLegacyOrigins ? this.store.list<AuditEvent>('events') : [])
    return { user: safeUser(actor), users, projects: this.store.list<Project>('projects'), annualGoals: this.store.list<AnnualGoal>('annualGoals'), plans, tasks: tasks.map(row => projectOrigin(row, 'task')), weeklyRecords: weeklyRecords.map(row => projectOrigin(row, 'weeklyRecord')), publications, reports: isManager ? this.store.list<Report>('reports') : [], aiConfigured: aiConfigured(this.store) }
  }
}
