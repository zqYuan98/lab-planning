import { AdminService } from './domain-admin.ts'
import { DomainBase } from './domain-common.ts'
import { MonthlyService } from './domain-plans.ts'
import { WorkService } from './domain-work.ts'
import { Store } from './store.ts'

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
  userDeletionPreview = (...args: Parameters<AdminService['userDeletionPreview']>) => this.admin.userDeletionPreview(...args)
  deleteUser = (...args: Parameters<AdminService['deleteUser']>) => this.admin.deleteUser(...args)
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
  captureTasks = (...args: Parameters<WorkService['captureTasks']>) => this.work.captureTasks(...args)
  updateTask = (...args: Parameters<WorkService['updateTask']>) => this.work.updateTask(...args)
  cancelTask = (...args: Parameters<WorkService['cancelTask']>) => this.work.cancelTask(...args)
  relinkTask = (...args: Parameters<WorkService['relinkTask']>) => this.work.relinkTask(...args)
  createWeeklyRecord = (...args: Parameters<WorkService['createWeeklyRecord']>) => this.work.createWeeklyRecord(...args)
  createWeeklyAssignment = (...args: Parameters<WorkService['createWeeklyAssignment']>) => this.work.createWeeklyAssignment(...args)
  updateWeeklyRecord = (...args: Parameters<WorkService['updateWeeklyRecord']>) => this.work.updateWeeklyRecord(...args)
  deleteWeeklyRecord = (...args: Parameters<WorkService['deleteWeeklyRecord']>) => this.work.deleteWeeklyRecord(...args)
  carryWeeklyRecord = (...args: Parameters<WorkService['carryWeeklyRecord']>) => this.work.carryWeeklyRecord(...args)

}
