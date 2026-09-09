import type { AnnualGoal, AuditEvent, Bootstrap, MonthlyPlan, Project, Publication, Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import { safeUser } from './auth.ts'
import { registrationApproved } from '../shared/auth-policy.ts'
import { AdminService } from './domain-admin.ts'
import { DomainBase, participates } from './domain-common.ts'
import { MonthlyService } from './domain-plans.ts'
import { WorkService } from './domain-work.ts'
import { Store } from './store.ts'
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

  bootstrap(actor: User): Bootstrap {
    const isManager = actor.role === 'manager'
    const plans = this.store.list<MonthlyPlan>('plans').filter(plan => this.planVisible(actor, plan))
    const currentPlanIds = new Set(plans.filter(plan => participates(plan, actor.id)).map(plan => plan.id))
    const tasks = this.store.list<Task>('tasks').filter(task => isManager || task.ownerId === actor.id || (task.monthlyPlanId && currentPlanIds.has(task.monthlyPlanId)))
    const weeklyRecords = this.store.list<WeeklyRecord>('weeklyRecords').filter(record => isManager || record.ownerId === actor.id || (record.monthlyPlanId && currentPlanIds.has(record.monthlyPlanId)))
    // A task can move to a new month that an old collaborator cannot access. Keep the
    // old weekly records readable using an authorized task snapshot, never its new contents.
    const visibleTaskIds = new Set(tasks.map(task => task.id))
    const missingTaskIds = new Set(weeklyRecords.filter(record => !visibleTaskIds.has(record.taskId)).map(record => record.taskId))
    if (missingTaskIds.size) {
      const taskEvents = this.store.list<AuditEvent>('events').filter(event => event.entityType === 'task').reverse()
      for (const taskId of missingTaskIds) {
        const relevantPlanIds = new Set(weeklyRecords.filter(record => record.taskId === taskId && record.monthlyPlanId && currentPlanIds.has(record.monthlyPlanId)).map(record => record.monthlyPlanId))
        const historical = taskEvents.filter(event => event.entityId === taskId)
          .flatMap(event => [event.after, event.before])
          .find(snapshot => {
            const task = snapshot as Task | null
            return task?.id === taskId && task.monthlyPlanId !== null && relevantPlanIds.has(task.monthlyPlanId)
          }) as Task | undefined
        if (historical) tasks.push(historical)
      }
    }
    const publications = this.store.list<Publication>('publications').map(item => isManager ? item : { ...item, plans: item.plans.filter(plan => participates(plan, actor.id)) }).filter(item => item.plans.length)
    const users = this.store.list<User>('users').filter(user => isManager || registrationApproved(user)).map(user => ({ ...safeUser(user), ...(isManager && user.registrationStatus ? { registrationReviewComment: user.registrationReviewComment ?? '' } : {}) }))
    return { user: safeUser(actor), users, projects: this.store.list<Project>('projects'), annualGoals: this.store.list<AnnualGoal>('annualGoals'), plans, tasks, weeklyRecords, publications, reports: isManager ? this.store.list<Report>('reports') : [], aiConfigured: aiConfigured() }
  }
}
