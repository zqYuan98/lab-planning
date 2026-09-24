import type { Entity } from './types'

export interface NotificationTarget { type: 'plan' | 'task' | 'weeklyRecord' | 'weeklySubmission' | 'summary' | 'followup' | 'digest' | 'deadlineRequest' | 'report' | 'feedback' | 'blocker' | 'decisionRequest'; id: string; month?: string; weekStart?: string; cycleWeek?: string; kind?: 'results' | 'plan' }
export interface NotificationContentItem {
  target: NotificationTarget; title: string; lines: string[]
  acknowledgement?: 'pending' | 'acknowledged' | 'superseded' | 'not_required'
}
export interface NotificationContent { heading: string; intro?: string; items: NotificationContentItem[]; footer?: string; totalCount?: number }
export interface NotificationChange {
  target: NotificationTarget; field: string; label: string; before?: string; after: string
  memberVisibleBefore?: boolean; memberVisibleAfter?: boolean
}
export interface NotificationSubject {
  target: NotificationTarget; title: string; ownerId: string; ownerName: string; context: string;
  requirement: string; dueDate: string; acceptance?: string; reviewComment?: string; status?: string
}
export interface NotificationFacts { subjects: NotificationSubject[]; changes: NotificationChange[]; reason?: string }
export interface Notification extends Entity {
  eventKey: string; recipientId: string; kind: string; title: string; body: string
  targets: NotificationTarget[]; actionable: boolean; openedAt: string | null; acknowledgedAt: string | null
  supersededAt: string | null
  contentSchemaVersion?: 1; actorId?: string; eventTime?: string; sourceNotificationId?: string
  contentFacts?: NotificationFacts
}
export type DeliveryStatus = 'pending' | 'sending' | 'accepted' | 'delivered' | 'failed' | 'unknown' | 'skipped'
export interface NotificationDelivery extends Entity {
  notificationId: string; recipientId: string; status: DeliveryStatus; attempts: number
  nextAttemptAt: string; leaseUntil: string | null; providerTaskId: string | null
  acceptedAt: string | null; lastError: string; deploymentId: string; activationId: string; identityId: string
}
export interface NotificationView extends Notification {
  deliveryStatus: DeliveryStatus | null; canAcknowledge: boolean; unavailable: boolean
  content?: NotificationContent; buttonText?: string; confirmationToken?: string
  sourceCanAcknowledge?: boolean; contentUpdated?: boolean
}
export interface NotificationPreview {
  recipientId: string; recipientName: string; title: string; body: string; buttonText: string; url: string
  truncated: boolean; eligible: boolean; reason: string; sendWindow: string; renderedAt: string
}
export interface NotificationDeliveryContent extends Entity {
  deliveryId: string; notificationId: string; recipientId: string; attempt: number; renderedAt: string
  templateVersion: number; title: string; body: string; buttonText: string; url: string; payloadHash: string
  payload: unknown; confirmationToken?: string
}
export interface NotificationSettings extends Entity {
  externalEnabled: boolean; pilotUserIds: string[]; sendStartHour: number; sendEndHour: number
  enabledAt: string | null; deploymentId: string; activationId: string
}
export interface NotificationSettingsView {
  settings: NotificationSettings; configured: boolean; environmentEnabled: boolean; activationRequired: boolean
  bindings: { userId: string; bound: boolean }[]; deliveries: (NotificationDelivery & { title: string; openedAt: string | null; acknowledgedAt: string | null; canAcknowledge: boolean; targets: NotificationTarget[] })[]
}
export interface DingTalkPublicConfig { configured: boolean; corpId: string; clientId: string; appLinkEnabled?: boolean; agentId?: string }
export interface DingTalkBindingStatus { bound: boolean; corpId?: string; boundAt?: string; pending?: { corpId: string; userid?: string; displayName?: string; expiresAt?: string } }
