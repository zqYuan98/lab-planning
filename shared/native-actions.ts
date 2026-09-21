import type { Entity } from './types'
import type { ProgressContent } from './collaboration'

export type NativeCapability = 'identity' | 'todo' | 'card' | 'robot' | 'orgEvents' | 'leaveSync'
export type NativeChannel = 'todo' | 'card'
export interface NativeSettings extends Entity {
  todoEnabled: boolean; cardEnabled: boolean; robotEnabled: boolean; orgEventsEnabled: boolean; leaveSyncEnabled: boolean
  primaryChannel: 'work_notification' | NativeChannel
  pilotUserIds: string[]; verifiedCapabilities: NativeCapability[]; verificationNote: string
  enabledAt: string | null; activationId: string; deploymentId: string; fallbackEnabled: boolean
}
export interface NativeCapabilityState { configured: boolean; verified: boolean; enabled: boolean; reason: string }
export interface NativeVerifiedIdentity extends Entity {
  userId: string; identityId: string; bindingVersion: number; corpId: string; appId: string; developerScope: string
  userid: string; unionId: string; verifiedAt: string; suspendedAt: string | null; suspensionReason: string
}
export type NativeActionKind = 'acknowledge' | 'followup' | 'progress' | 'review' | 'acceptance' | 'weekly' | 'blocker' | 'view'
export interface NativeActionRef { kind: NativeActionKind; id: string; notificationId: string; taskId?: string }
export interface NativeDesiredState {
  title: string; summary: string; url: string; done: boolean; dueTime?: number; revision: string
}
export type NativeLinkState = 'pending' | 'created' | 'pending_update' | 'closed' | 'unknown' | 'external_missing' | 'mismatch' | 'failed' | 'isolated'
export interface ExternalObjectLink extends Entity {
  action: NativeActionRef; channel: NativeChannel; recipientId: string; bindingId: string; bindingVersion: number
  corpId: string; appId: string; unionId: string; userid: string; generation: number; deploymentId: string; activationId: string
  sourceId: string; providerId: string | null; carrierId: string | null; userIdType: 1; templateId: string | null
  desired: NativeDesiredState; observedDone: boolean | null; state: NativeLinkState; lastSyncedAt: string | null
  reconcileAt: string | null; lastError: string
}
export type NativeOperationKind = 'todo_create' | 'todo_update' | 'todo_delete' | 'card_create' | 'card_deliver' | 'card_update' | 'robot_reply'
export interface ChannelOperation extends Entity {
  linkId: string | null; kind: NativeOperationKind; uniqueKey: string; desiredRevision: string; deploymentId: string; activationId: string
  recipientId: string; status: 'pending' | 'sending' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'
  attempts: number; nextAttemptAt: string; leaseUntil: string | null; lastError: string
  reply?: { userid?: string; webhook?: string; expiresAt?: number; text: string }
  cardIntentId?: string
  cardResult?: string
}
export interface NativeDeliveryAttempt extends Entity {
  operationId: string; attempt: number; renderedAt: string; payloadHash: string; payload: unknown
  outcome: 'sending' | 'succeeded' | 'failed' | 'unknown'; completedAt: string | null
}
export interface CallbackInbox extends Entity {
  appId: string; corpId: string; eventType: string; eventId: string; occurredAt: string; receivedAt: string
  deploymentId: string; payloadHash: string; status: 'pending' | 'processed' | 'rejected'; result: string
  data: Record<string, unknown>
}
export interface NativeActionInput { kind: 'acknowledge' | 'progress' | 'respond'; targetId: string; progress?: ProgressContent; requestId: string }
export interface ActionIntent extends Entity {
  recipientId: string; bindingId: string; bindingVersion: number; deploymentId: string; activationId: string
  kind: NativeActionInput['kind']; targetId: string; tokenHash: string; expiresAt: string; requestId: string
  targetVersion: number; taskVersion: number | null; confirmationToken: string | null; progress: ProgressContent | null
  summary: string; status: 'pending' | 'succeeded' | 'rejected'; result: string; outTrackId: string | null
}
export interface NativeIntentView { id: string; token: string; summary: string; expiresAt: string; kind: ActionIntent['kind']; targetId: string }
export interface NativeSettingsView {
  settings: NativeSettings
  capabilities: Record<NativeCapability, NativeCapabilityState>
  identities: { userId: string; verified: boolean; suspended: boolean; verifiedAt: string | null }[]
  counts: { pending: number; failed: number; unknown: number; mismatches: number; inboxPending: number }
  stream: { connected: boolean; updatedAt: string | null; reason: string }
}
