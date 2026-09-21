import type { Entity, MonthlyPlan, Task, WeeklyRecord } from './types'
import type { ProgressEvent } from './collaboration'

export type SubmissionKind = 'results' | 'plan'
export type SubmissionStatus = 'due' | 'on_time' | 'missing' | 'late' | 'exempt'
export interface WeeklyRule extends Entity {
  enabled: boolean; effectiveWeek: string; timezone: 'Asia/Shanghai'
  windows: { fromWeek: string; toWeek: string | null }[]
  /** First submission cycle requiring review of the following week's member plans. */
  planReviewEffectiveWeek?: string
}
export interface WeeklyCycle extends Entity {
  week: string; deadlineAt: string; rosterIds: string[]; needsReview: boolean
  confirmedBy: string | null; confirmationReason: string; frozenAt: string
}
export interface WeeklyDuty extends Entity {
  ownerId: string; cycleWeek: string; kind: SubmissionKind; contentWeek: string; deadlineAt: string
}
export interface WeeklySubmission extends Entity {
  dutyId: string; ownerId: string; cycleWeek: string; kind: SubmissionKind
  submittedAt: string; actorId: string; reason: string; note: string; requestId: string
  records: WeeklyRecord[]; retainedDraftIds: string[]; retainedDraftManifest: SubmissionManifest[]
  /** Task/weekly progress explicitly present in the reviewed submission snapshot. */
  progressEventIds?: string[]
  planManifest?: WeeklyPlanManifestItem[]
  planTaskSnapshots?: Pick<Task, 'id' | 'title' | 'dueDate' | 'description'>[]
  planGoalSnapshots?: Pick<MonthlyPlan, 'id' | 'month' | 'title'>[]
}
export interface WeeklyPlanManifestItem { id: string; fingerprint: string; submitted: boolean }
export interface WeeklyPlanReview extends Entity {
  dutyId: string; ownerId: string; cycleWeek: string; submissionId: string;
  decision: 'approved' | 'returned'; reviewedBy: string; reviewedAt: string; reason: string; requestId: string;
}
export type WeeklyPlanReviewStatus = 'not_required' | 'unsubmitted' | 'pending' | 'approved' | 'returned' | 'changed'
export interface WeeklyMissing extends Entity {
  dutyId: string; ownerId: string; cycleWeek: string; kind: SubmissionKind
  deadlineAt: string; detectedAt: string
}
export interface WeeklyAdjustment extends Entity {
  dutyId: string; ownerId: string; cycleWeek: string; kind: SubmissionKind
  action: 'exempt' | 'revoke_exemption' | 'invalidate' | 'restore'
  submissionId: string | null; actorId: string; reason: string; occurredAt: string
}
export interface SubmissionManifest { id: string; version: number }
export interface WeeklyDutyView extends WeeklyDuty {
  status: SubmissionStatus; firstSubmittedAt: string | null; latestSubmittedAt: string | null
  latestSubmission: WeeklySubmission | null; missingAtDeadline: boolean; exemptionReason: string
  changedSinceSubmission: boolean; records: WeeklyRecord[]; manifest: SubmissionManifest[]
  submissions: WeeklySubmission[]; adjustments: WeeklyAdjustment[]
  progressEventIds?: string[]
  progressEvents?: ProgressEvent[]
  planReviewRequired?: boolean; planReviewStatus?: WeeklyPlanReviewStatus;
  latestPlanReview?: WeeklyPlanReview | null; planReviews?: WeeklyPlanReview[];
}
export interface WeeklySubmissionView {
  rule: WeeklyRule; week: string; nextWeek: string; deadlineAt: string; serverNow: string
  cycle: WeeklyCycle | null; duties: WeeklyDutyView[]
}
export interface WeeklyReportSubmission {
  ownerId: string; cycleWeek: string; kind: SubmissionKind; status: SubmissionStatus
  deadlineAt: string; firstSubmittedAt: string | null; missingAtDeadline: boolean; exemptionReason: string
}
