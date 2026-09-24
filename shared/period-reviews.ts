import type { Entity } from './types'

export interface CommitmentValue {
  title: string; ownerId: string; monthlyPlanId: string | null; projectId: string | null
  dueDate: string; scope: string; cancelled: boolean
}
export interface TaskCommitmentEvent extends Entity {
  taskId: string; kind: 'initial' | 'deadline' | 'owner' | 'scope' | 'association' | 'cancellation'
  oldValue: CommitmentValue | null; newValue: CommitmentValue
  effectiveAt: string; recordedAt: string; actorId: string; reason: string
  sourceType: 'audit'; sourceId: string; sourceVersion: number
}
export interface HistoricalEvidence extends Entity {
  taskId: string; ownerId: string | null; claimedAt: string; recordedAt: string; actorId: string
  statement: string; evidence: string[]; reason: string
}
export const periodReviewSourceCollections = ['tasks', 'plans', 'events', 'publications', 'taskCommitmentEvents', 'taskDeliveries', 'deliveryDecisions', 'weeklyCycles', 'weeklyDuties', 'weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments', 'historicalEvidence'] as const
export type PeriodReviewSourceCollection = typeof periodReviewSourceCollections[number]
export interface ReviewSourceRef { collection: PeriodReviewSourceCollection; id: string; version: number; hash: string }
export interface ReviewUnknown { taskId: string | null; ownerId: string | null; code: string; message: string; from: string | null; through: string }
export interface ReviewSubmission {
  id: string; revision: number; submittedAt: string; applicableDueDate: string | null; timely: boolean | null
  decision: 'pending_review' | 'accepted' | 'returned' | 'withdrawn'; decidedAt: string | null; acceptanceWaitMs: number | null
}
export interface PeriodReviewEntry {
  taskId: string; deliverableKey: string; title: string; ownerId: string | null; projectId: string | null; monthlyPlanId: string | null
  attributionKnown: boolean; originalDueDate: string | null; effectiveDueDate: string | null
  commitments: TaskCommitmentEvent[]; submissions: ReviewSubmission[]
  firstSubmittedAt: string | null; acceptedSubmittedAt: string | null; acceptedAt: string | null
  statusAtCutoff: 'unknown' | 'unsubmitted' | 'pending_review' | 'accepted' | 'returned' | 'withdrawn'
  laterStatus: ReviewSubmission['decision'] | null; laterSubmissions: ReviewSubmission[]; onTimeAccepted: boolean | null
  overdueIntervals: { from: string; through: string; dueDate: string; endedBy: 'deadline_change' | 'submission' | 'cancellation' | 'cutoff' }[]
  evidence: HistoricalEvidence[]; sourceRefs: ReviewSourceRef[]; unknowns: string[]
}
export interface PeriodWeeklyCompliance {
  dutyId: string; ownerId: string; cycleWeek: string; kind: 'plan' | 'results'; deadlineAt: string
  statusAtCutoff: 'unknown' | 'due' | 'on_time' | 'missing' | 'late' | 'exempt'
  firstSubmittedAt: string | null; missingAtDeadline: boolean; laterSubmittedAt: string | null
  sourceRefs: ReviewSourceRef[]
}
export interface ReviewCoverage { known: number; unknown: number; unfinished: number; total: number; onTimeAccepted: number; acceptedKnown: number; rate: number | null }
export interface PeriodReviewContent {
  period: string; cutoffAt: string; generatedAt: string; ruleVersion: 'historical-v1'; laterEvidenceThrough: string | null
  sourceManifest: ReviewSourceRef[]; entries: PeriodReviewEntry[]; weeklyCompliance: PeriodWeeklyCompliance[]
  unknownItems: ReviewUnknown[]; evidenceCoverage: ReviewCoverage
}
export interface PeriodReviewSnapshot extends Entity, PeriodReviewContent {
  revision: number; status: 'draft' | 'finalized'; previousSnapshotId: string | null; authorId: string
  finalizedAt: string | null; finalizedBy: string | null; contentHash: string
  differences: { key: string; before: string; after: string }[]
}
export interface PeriodReviewPreview extends PeriodReviewContent { fingerprint: string; operationEpoch: string; previousSnapshotId: string | null; revision: number; differences: PeriodReviewSnapshot['differences'] }
/** Live display-only dictionaries; deliberately excluded from frozen content and its hash. */
export interface PeriodReviewDisplayReferences { users: { id: string; name: string }[]; plans: { id: string; title: string }[]; projects: { id: string; name: string }[] }
export const reviewStatusLabels = { unknown: '待核实', unsubmitted: '未提交', pending_review: '待验收', accepted: '已通过', returned: '已退回', withdrawn: '已撤回', due: '未到截止', on_time: '按时提报', missing: '截止未交', late: '逾期提报', exempt: '已豁免' }
export function periodReviewLabel(review: Pick<PeriodReviewContent, 'period' | 'cutoffAt' | 'generatedAt' | 'ruleVersion' | 'laterEvidenceThrough'>): string {
  return `历史周期复盘 · ${review.period} · 期末 ${review.cutoffAt} · 生成 ${review.generatedAt} · 口径 ${review.ruleVersion}${review.laterEvidenceThrough ? ` · 事后核实截至 ${review.laterEvidenceThrough}` : ' · 仅期末已知事实'}`
}
