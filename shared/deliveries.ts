import type { Entity, Task } from './types'

export type DeliveryStatus = 'pending_review' | 'accepted' | 'returned' | 'withdrawn'
export interface DeliverySeries extends Entity {
  taskId: string; title: string; reviewerId: string | null; headSubmissionId: string; status: DeliveryStatus
}
export interface TaskDelivery extends Entity {
  seriesId: string; taskId: string; revision: number; supersedesId: string | null; taskVersion: number
  ownerId: string; submittedBy: string; proxyReason: string; submittedAt: string
  actualOutcome: string; evidenceRefs: string[]; acceptanceCriteriaSnapshot: string
  reviewerIdSnapshot: string | null; dueDateSnapshot: string; deadlineBasisRefs: string[]
}
export interface DeliveryDecision extends Entity {
  seriesId: string; deliveryId: string; conclusion: Exclude<DeliveryStatus, 'pending_review'>
  action: 'review' | 'withdraw' | 'correct'; note: string; decidedBy: string; decidedAt: string
  supersedesDecisionId: string | null
}
export interface DeliverySubmitInput {
  requestId: string; taskVersion: number; seriesId?: string; seriesVersion?: number
  previousRevision: number; previousSubmissionId?: string; title?: string; newSeries?: boolean
  actualOutcome: string; evidenceRefs: string[]; acceptanceCriteria: string; reviewerId: string | null
  proxyReason?: string; replaceAccepted?: boolean; markTaskDone?: boolean; completionNote?: string
}
export interface DeliveryDecisionInput {
  requestId: string; seriesVersion: number; action: DeliveryDecision['action']
  conclusion?: 'accepted' | 'returned'; note: string; supersedesDecisionId?: string
}
export interface DeliveryReassignInput { requestId: string; seriesVersion: number; reviewerId: string; reason: string }
export interface DeliverySubmissionView { delivery: TaskDelivery; effectiveDecision: DeliveryDecision | null; decisions: DeliveryDecision[] }
export interface DeliverySeriesView {
  series: DeliverySeries; current: DeliverySubmissionView; reviewerAvailable: boolean; allowedActions: string[]
  firstSubmittedAt: string; acceptedSubmittedAt: string | null; acceptedAt: string | null
}
export interface TaskDeliveriesView { items: DeliverySeriesView[]; eligibleReviewers: { id: string; name: string }[]; canSubmit: boolean }
export interface DeliveryMutationResult { series: DeliverySeries; delivery: TaskDelivery; decision?: DeliveryDecision; task: Task }
