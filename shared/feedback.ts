import type { Entity } from './types.ts'

export const feedbackStatuses = ['new', 'in_progress', 'verification', 'closed'] as const
export type FeedbackStatus = typeof feedbackStatuses[number]
export type FeedbackKind = 'bug' | 'usability' | 'suggestion'
export type FeedbackImpact = 'blocking' | 'normal'
export type FeedbackAction = 'comment' | 'assign' | 'start' | 'request_info' | 'defer' | 'ready' | 'confirm' | 'reopen' | 'close' | 'duplicate'
export const feedbackStatusLabels: Record<FeedbackStatus, string> = { new: '待受理', in_progress: '处理中', verification: '待验证', closed: '已关闭' }
export const feedbackAttachmentLimits = { count: 3, bytes: 2 * 1024 * 1024 } as const
export interface FeedbackContext { path?: string; appVersion?: string; userAgent?: string; viewport?: string; errorRequestId?: string }
export interface FeedbackAttachmentInput { name: string; mimeType: 'image/png' | 'image/jpeg' | 'image/webp'; dataBase64: string }
export interface FeedbackAttachment extends Entity { feedbackId: string; eventId: string; actorId: string; name: string; mimeType: FeedbackAttachmentInput['mimeType']; size: number }
export interface FeedbackWaiting { kind: 'request_info' | 'defer'; reason: string; reviewAt: string | null }
export interface FeedbackClosure { kind: 'confirmed' | 'manager'; reason: string; actorId: string; closedAt: string }
export interface Feedback extends Entity {
  reporterId: string; assigneeId: string; description: string; kind: FeedbackKind; impact: FeedbackImpact; context: FeedbackContext
  status: FeedbackStatus; waiting: FeedbackWaiting | null; resolution: string; releaseVersion: string; releasedAt: string | null
  closure: FeedbackClosure | null; duplicateLinked: boolean; duplicateOfId?: string; attachmentCount: number
}
export interface FeedbackView extends Feedback { reporterName: string; assigneeName: string; assigneeAvailable?: boolean }
export interface FeedbackEvent extends Entity {
  feedbackId: string; actorId: string; actorName: string; action: FeedbackAction | 'created' | 'duplicate_update'
  text: string; status: FeedbackStatus; attachmentIds: string[]; assigneeId?: string; assigneeName?: string
  releaseVersion?: string; reviewAt?: string; duplicateOfId?: string; closureKind?: FeedbackClosure['kind']
}
export interface FeedbackManager { id: string; name: string }
export interface FeedbackMetaResponse { managers: FeedbackManager[]; defaultAssigneeId: string | null }
export interface FeedbackListQuery { scope?: 'mine' | 'all'; status?: FeedbackStatus; assigneeId?: string; cursor?: string; limit?: number }
export interface FeedbackListResponse { items: FeedbackView[]; counts: Record<FeedbackStatus | 'all', number>; nextCursor: string | null }
export interface FeedbackDetailResponse { feedback: FeedbackView; events: FeedbackEvent[]; attachments: FeedbackAttachment[]; allowedActions: FeedbackAction[] }
export interface FeedbackCreateInput { requestId: string; description: string; kind?: FeedbackKind; impact?: FeedbackImpact; context?: FeedbackContext; attachments?: FeedbackAttachmentInput[] }
/** text is a comment; reason is required for request_info/defer/reopen/close/duplicate.
 * ready requires resolution, releaseVersion and released === true. */
export interface FeedbackActionInput {
  requestId: string; version: number; action: FeedbackAction; text?: string; attachments?: FeedbackAttachmentInput[]
  assigneeId?: string; reason?: string; reviewAt?: string; resolution?: string; releaseVersion?: string; released?: boolean; duplicateOfId?: string
}
export type FeedbackMutationResponse = FeedbackDetailResponse
