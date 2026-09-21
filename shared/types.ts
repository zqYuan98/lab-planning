export type Role = 'manager' | 'member'
export interface Entity { id: string; version: number; createdAt: string; updatedAt: string }
export interface ImportProvenance { batchId: string; sourceId: string; rowId: string; sourceStatus: string; mode?: 'draft' | 'existing'; notificationMode?: 'silent' }
export interface WorkOrigin { kind: 'self' | 'assigned' | 'proxy'; actorId: string; reason: string }
export interface User extends Entity { name: string; email: string; role: Role; position: string; active: boolean; registrationStatus?: 'pending' | 'approved' | 'rejected'; registrationReviewComment?: string }
export interface Project extends Entity { name: string; code: string; description: string; ownerId: string; status: 'active' | 'archived' }
export interface AnnualGoal extends Entity { title: string; year: number; target: string; progress: number; description: string; ownerId: string; status: 'active' | 'completed' }
export type PlanStatus = 'draft' | 'submitted' | 'returned' | 'approved' | 'published' | 'merged'
export interface MonthlyPlan extends Entity {
  /** Member-only historical reference projection; never a selectable current goal. */
  visibility?: 'reference' | 'historical';
  month: string; title: string; projectId: string | null; category: string; ownerId: string;
  collaboratorIds: string[]; expectedOutcome: string; acceptanceCriteria: string; dueDate: string;
  priority: 'high' | 'medium' | 'low'; status: PlanStatus; reviewComment: string;
  publishedVersion: number | null; sourcePlanId: string | null; actualOutcome: string;
  acceptanceStatus: 'pending' | 'submitted' | 'accepted' | 'not_completed'; acceptanceNote: string;
  mergedFromIds?: string[]; mergedIntoId?: string;
  /** Absent on legacy goals; temporary goals still use monthly review and publication. */
  isTemporary?: boolean; temporaryReason?: string;
  workSource?: WorkSource; assignedBy?: string; assignedOn?: string;
  importSource?: ImportProvenance;
}
export type WorkSource = 'leader' | 'self' | 'coordination'
export interface Task extends Entity {
  title: string; monthlyPlanId: string | null; ownerId: string; description: string; dueDate: string;
  status: 'todo' | 'doing' | 'blocked' | 'done'; isTemporary: boolean; temporaryReason: string;
  importSource?: ImportProvenance; workOrigin?: WorkOrigin; completionNote?: string; evidenceUrl?: string;
  blockerReason?: string; blockerImpact?: string; supportNeeded?: string; nextAction?: string;
  /** Personal work context, independent of the audited identity that created the task. */
  workSource?: WorkSource; assignedBy?: string; assignedOn?: string; requestedOutcome?: string;
  priority?: 'high' | 'medium' | 'low'; estimatedEffort?: string; currentProgress?: string;
  decisionNeeded?: string; waitingForFeedback?: boolean;
}
export type WeeklyStatus = 'planned' | 'doing' | 'blocked' | 'done' | 'not_done'
export interface WeeklyRecord extends Entity {
  taskId: string; monthlyPlanId: string | null; ownerId: string; weekStart: string; commitment: string;
  actualOutcome: string; evidenceUrl: string; blocker: string; nextAction: string; status: WeeklyStatus; submitted: boolean;
  importSource?: ImportProvenance; workOrigin?: WorkOrigin; blockerImpact?: string; supportNeeded?: string;
  deletion?: { deletedAt: string; deletedBy: string; reason: string };
  /** Absent for historical records outside the review policy. Execution updates do not change this approval. */
  planApproval?: { required: true; approvedSubmissionId: string | null; approvedFingerprint: string | null; suspended?: true };
}
export interface AuditEvent extends Entity { entityType: string; entityId: string; actorId: string; action: string; reason: string; before: unknown; after: unknown }
export interface Publication extends Entity { month: string; revision: number; actorId: string; reason: string; plans: MonthlyPlan[] }
export interface ReportSnapshot { plans: MonthlyPlan[]; contextPlans?: MonthlyPlan[]; weeklyRecords: WeeklyRecord[]; tasks: Task[]; projects: Project[]; users: User[]; annualGoals: AnnualGoal[]; nextPlans: MonthlyPlan[]; nextWeeklyRecords: WeeklyRecord[]; publications: Publication[]; changes: AuditEvent[]; weeklySubmissions?: import('./weekly-submissions').WeeklyReportSubmission[] }
export interface Report extends Entity { type: 'weekly' | 'monthly'; period: string; title: string; status: 'draft' | 'finalized'; revision: number; narrative: string; snapshot: ReportSnapshot; authorId: string; finalizedAt: string | null; agent?: import('./report-agent.ts').ReportAgentPayload }
export interface ReportSchedule extends Entity { enabled: boolean; weeklyDay: number; weeklyTime: string; monthlyDay: number; monthlyTime: string; timezone: 'Asia/Shanghai' }
export interface Bootstrap { user: User; users: User[]; projects: Project[]; plans: MonthlyPlan[]; tasks: Task[]; weeklyRecords: WeeklyRecord[]; annualGoals: AnnualGoal[]; publications: Publication[]; reports: Report[]; aiConfigured: boolean }
