import type { Entity, Task, WeeklyRecord, WeeklyStatus } from './types'

/** Missing settings are represented by version 0 and never persisted by a read. */
export interface CollaborationSettings extends Entity {
  enabled: boolean
  autoRulesEnabled: boolean
  deadlineApprovalEnabled: boolean
  dailyManagerEnabled: boolean
  weeklyManagerEnabled: boolean
  memberActionsEnabled: boolean
  pilotUserIds: string[]
  defaultManagerIds: string[]
  calendarOverrides: Record<string, boolean>
  staleWorkdays: number
  blockerWorkdays: number
  enabledAt: string | null
}

export type TrackingState = 'active' | 'paused' | 'closed'
export interface TaskTracking extends Entity {
  taskId: string
  ownerId: string
  generation: number
  state: TrackingState
  enrolledAt: string
  activeFrom: string
  reminderBaselineAt: string
  enrolledBy: string
  source: 'assignment' | 'manual' | 'restore'
  managerRecipientIds: string[]
  ruleVersion: number
  dueDateVersion: number
  currentDueDate: string
  lastMeaningfulOwnerProgressAt: string | null
  lastRecordedProgressAt: string | null
  pauseReason: string
  reviewAt: string | null
  closedAt: string | null
  closedReason: string
}

export type ProgressNoteType = 'progress' | 'no_change'
export interface ProgressFieldChange { field: string; before: string; after: string }
export interface ProgressEvent extends Entity {
  mutationId: string
  taskId: string
  weeklyRecordId: string | null
  actorId: string
  ownerId: string
  source: 'task' | 'weeklyRecord' | 'progress' | 'followup'
  noteType: ProgressNoteType
  note: string
  noChangeReason: string
  nextAction: string
  proxyReason: string
  changes: ProgressFieldChange[]
  meaningfulOwnerProgress: boolean
  occurredAt: string
  auditEventIds: string[]
}

export type FollowupStatus = 'open' | 'responded' | 'cancelled' | 'superseded'
export interface FollowupRequest extends Entity {
  taskId: string
  weeklyRecordId: string | null
  ownerId: string
  requestedBy: string
  managerRecipientIds: string[]
  generation: number
  requirement: string
  dueAt: string
  status: FollowupStatus
  respondedAt: string | null
  closedAt: string | null
  closedBy: string | null
  closeReason: string
  lastChangedBy: string
  changeReason: string
}
export interface FollowupResponse extends Entity {
  followupRequestId: string
  requestVersion: number
  taskId: string
  weeklyRecordId: string | null
  ownerId: string
  actorId: string
  progressEventId: string
  respondedAt: string
  dueAt: string
  late: boolean
  mutationId: string
}

export interface BlockerEpisode extends Entity {
  sourceType: 'task' | 'weeklyRecord'
  sourceId: string
  parentTaskId: string
  ownerId: string
  generation: number
  openedAt: string
  openedBy: string
  resolvedAt: string | null
  resolvedBy: string | null
  reason: string
  impact: string
  supportNeeded: string
  reviewAt: string | null
  closureReason: string
  managementClosedAt?: string | null
  managementNote?: string
}
export interface BlockerAction extends Entity {
  episodeId: string; taskId: string; ownerId: string; actorId: string
  action: 'record' | 'defer' | 'close'; note: string; reviewAt: string | null; occurredAt: string
}

export interface DeadlineChangeRequest extends Entity {
  taskId: string
  ownerId: string
  requestedBy: string
  generation: number
  dueDateVersion: number
  originalDueDate: string
  requestedDueDate: string
  reason: string
  status: 'open' | 'approved' | 'returned' | 'cancelled' | 'superseded'
  decidedBy: string | null
  decidedAt: string | null
  decisionNote: string
}

export type BusinessNotificationKind =
  | 'followup_requested' | 'followup_changed' | 'followup_responded' | 'followup_closed'
  | 'progress_recorded' | 'work_completed' | 'work_reopened' | 'work_blocked' | 'work_unblocked'
  | 'deadline_changed' | 'deadline_requested' | 'deadline_decided'
  | 'tracking_changed' | 'plan_review_requested' | 'plan_review_decided'
  | 'plan_result_submitted' | 'plan_result_decided' | 'weekly_submitted' | 'report_finalized'
export type BusinessFactValue = string | number | boolean | null | string[]
/** Minimal business facts; never a payload, external address, binding, or delivery receipt. */
export interface BusinessNotificationEvent extends Entity {
  kind: BusinessNotificationKind
  mutationId: string
  subjectType: 'task' | 'weeklyRecord' | 'plan' | 'weeklySubmission' | 'report'
  subjectId: string
  taskId: string | null
  ownerId: string
  actorId: string
  recipientIds: string[]
  occurredAt: string
  generation: number | null
  sourceVersion: number
  facts: Record<string, BusinessFactValue>
}

export interface CollaborationCommand { requestId: string }
export interface TrackingInput extends CollaborationCommand {
  /** 0 creates a tracking record; otherwise optimistic tracking entity version. */
  version: number
  taskVersion: number
  state: TrackingState
  reason?: string
  reviewAt?: string | null
  managerRecipientIds?: string[]
}
export interface WeeklyProgressInput {
  status?: WeeklyStatus
  actualOutcome?: string
  evidenceUrl?: string
  blocker?: string
  nextAction?: string
}
export interface ProgressContent {
  weeklyRecordId?: string
  weeklyRecordVersion?: number
  taskStatus?: Task['status']
  weekly?: WeeklyProgressInput
  noteType?: ProgressNoteType
  note?: string
  noChangeReason?: string
  nextAction?: string
  completionNote?: string
  evidenceUrl?: string
  blockerReason?: string
  blockerImpact?: string
  supportNeeded?: string
  proxyReason?: string
}
export interface ProgressInput extends CollaborationCommand, ProgressContent {
  /** Task entity version. */
  version: number
  respondTo?: { id: string; version: number }
}
export interface FollowupCreateInput extends CollaborationCommand {
  /** Task entity version. */
  version: number
  weeklyRecordId?: string
  weeklyRecordVersion?: number
  requirement: string
  dueAt?: string
  managerRecipientIds?: string[]
  /** Required when this command explicitly enrolls previously untracked work. */
  enroll?: boolean
}
export interface FollowupUpdateInput extends CollaborationCommand {
  version: number
  requirement?: string
  dueAt?: string
  reason: string
}
export interface FollowupRespondInput extends CollaborationCommand {
  /** Followup request version. */
  version: number
  taskVersion: number
  progress: ProgressContent
}
export interface FollowupCloseInput extends CollaborationCommand { version: number; reason: string }
export interface DeadlineRequestInput extends CollaborationCommand {
  /** Task entity version. */
  version: number
  dueDateVersion: number
  requestedDueDate: string
  reason: string
}
export interface DeadlineDecisionInput extends CollaborationCommand {
  /** Deadline request entity version. */
  version: number
  dueDateVersion: number
  decision: 'approved' | 'returned'
  note: string
}

export interface CollaborationWeeklySummary {
  recordId: string
  weekStart: string
  status: WeeklyStatus
  actualOutcome: string
  submitted: boolean
  isCurrentWeek: boolean
  isImported: boolean
  planReviewPending?: boolean
}
export interface CollaborationTaskStatusSummary {
  weeklySummary: CollaborationWeeklySummary | null
  /** A display prompt only; weekly completion never changes the overall task status. */
  overallStatusNeedsConfirmation: boolean
}
export interface CollaborationTaskView extends CollaborationTaskStatusSummary {
  task: Task
  tracking: TaskTracking | null
  progressEvents: ProgressEvent[]
  followups: FollowupRequest[]
  responses: FollowupResponse[]
  blockerEpisodes: BlockerEpisode[]
  blockerActions: BlockerAction[]
  deadlineRequests: DeadlineChangeRequest[]
  effectiveManagerIds: string[]
  enabled: boolean
  eligible: boolean
}
export interface TrackingPreview {
  taskId: string
  taskVersion: number
  trackingVersion: number
  eligible: boolean
  reasons: string[]
  activeFrom: string
  effectiveManagerIds: string[]
  risks: string[]
}
export interface ProgressResult {
  task: Task
  weeklyRecord: WeeklyRecord | null
  tracking: TaskTracking | null
  progressEvent: ProgressEvent | null
  followup: FollowupRequest | null
  response: FollowupResponse | null
}
export interface FollowupResult { request: FollowupRequest; tracking: TaskTracking; existing: boolean }
export interface DeadlineDecisionResult { request: DeadlineChangeRequest; task: Task; tracking: TaskTracking }
