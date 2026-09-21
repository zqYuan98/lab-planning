import type { DeliveryStatus } from './notifications'
export interface DeliveryCursor { createdAt: string; id: string }
export interface DeliveryFilter {
  status?: DeliveryStatus; recipientId?: string; kind?: string; from?: string; to?: string
  cursor?: DeliveryCursor; limit?: number
}
export interface NotificationDiagnosticRow {
  id: string; notificationId: string; recipientId: string; recipientName: string; kind: string; status: DeliveryStatus
  createdAt: string; acceptedAt: string | null; attempts: number; nextAttemptAt: string | null; reason: string
}
export interface RuntimeHeartbeat { startedAt: string | null; completedAt: string | null; failedAt: string | null; running: boolean }
export interface NotificationDiagnostics {
  items: NotificationDiagnosticRow[]; nextCursor: DeliveryCursor | null; total: number; counts: Partial<Record<DeliveryStatus, number>>
  health: { worker: RuntimeHeartbeat; scheduler: RuntimeHeartbeat; oldestPendingAt: string | null; oldestAcceptedAt: string | null
    bindings: { usableMembers: number; boundMembers: number }; diskUsedPercent: number | null; backup: { configured: boolean; verifiedAt: string | null; offsiteVerifiedAt: string | null; restoredAt: string | null }; callbackBacklog: number; nativeOperations: Record<string, number>; ruleOccurrences: Record<string, number>; alerts: string[] }
}
