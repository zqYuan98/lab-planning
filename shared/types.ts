export type Role = 'manager' | 'member'
export interface Entity { id: string; version: number; createdAt: string; updatedAt: string }
export interface ImportProvenance { batchId: string; sourceId: string; rowId: string; sourceStatus: string }
export interface User extends Entity { name: string; email: string; role: Role; position: string; active: boolean; registrationStatus?: 'pending' | 'approved' | 'rejected'; registrationReviewComment?: string }
export interface Project extends Entity { name: string; code: string; description: string; ownerId: string; status: 'active' | 'archived' }
export interface AnnualGoal extends Entity { title: string; year: number; target: string; progress: number; description: string; ownerId: string; status: 'active' | 'completed' }
export type PlanStatus = 'draft' | 'submitted' | 'returned' | 'approved' | 'published' | 'merged'
export interface MonthlyPlan extends Entity {
  /** Member-only historical reference projection; never a selectable current goal. */
  visibility?: 'reference';
  month: string; title: string; projectId: string | null; category: string; ownerId: string;
  collaboratorIds: string[]; expectedOutcome: string; acceptanceCriteria: string; dueDate: string;
  priority: 'high' | 'medium' | 'low'; status: PlanStatus; reviewComment: string;
  publishedVersion: number | null; sourcePlanId: string | null; actualOutcome: string;
  acceptanceStatus: 'pending' | 'submitted' | 'accepted' | 'not_completed'; acceptanceNote: string;
  mergedFromIds?: string[]; mergedIntoId?: string;
  importSource?: ImportProvenance;
}
export interface Task extends Entity { title: string; monthlyPlanId: string | null; ownerId: string; description: string; dueDate: string; status: 'todo' | 'doing' | 'blocked' | 'done'; isTemporary: boolean; temporaryReason: string; importSource?: ImportProvenance }
export type WeeklyStatus = 'planned' | 'doing' | 'blocked' | 'done' | 'not_done'
export interface WeeklyRecord extends Entity { taskId: string; monthlyPlanId: string | null; ownerId: string; weekStart: string; commitment: string; actualOutcome: string; evidenceUrl: string; blocker: string; nextAction: string; status: WeeklyStatus; submitted: boolean; importSource?: ImportProvenance }
export interface AuditEvent extends Entity { entityType: string; entityId: string; actorId: string; action: string; reason: string; before: unknown; after: unknown }
export interface Publication extends Entity { month: string; revision: number; actorId: string; reason: string; plans: MonthlyPlan[] }
export interface ReportSnapshot { plans: MonthlyPlan[]; contextPlans?: MonthlyPlan[]; weeklyRecords: WeeklyRecord[]; tasks: Task[]; projects: Project[]; users: User[]; annualGoals: AnnualGoal[]; nextPlans: MonthlyPlan[]; nextWeeklyRecords: WeeklyRecord[]; publications: Publication[]; changes: AuditEvent[] }
export interface Report extends Entity { type: 'weekly' | 'monthly'; period: string; title: string; status: 'draft' | 'finalized'; revision: number; narrative: string; snapshot: ReportSnapshot; authorId: string; finalizedAt: string | null }
export interface ReportSchedule extends Entity { enabled: boolean; weeklyDay: number; weeklyTime: string; monthlyDay: number; monthlyTime: string; timezone: 'Asia/Shanghai' }
export interface Bootstrap { user: User; users: User[]; projects: Project[]; plans: MonthlyPlan[]; tasks: Task[]; weeklyRecords: WeeklyRecord[]; annualGoals: AnnualGoal[]; publications: Publication[]; reports: Report[]; aiConfigured: boolean }
