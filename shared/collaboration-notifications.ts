import type { Entity } from './types'
import type { NotificationTarget } from './notifications'

export type WorkRiskKind = 'blocker_escalation' | 'overdue' | 'followup_overdue' | 'due_today' | 'due_soon' | 'stale' | 'pause_review' | 'previous_week_blocker'
export interface WorkRisk {
  key: string; taskId: string; ownerId: string; title: string; kind: WorkRiskKind
  generation: number; ruleVersion: number; episode: string; dueAt: string
  managerIds: string[]; target: NotificationTarget; detail: string; managerOnly: boolean
}
export interface ReminderOccurrence extends Entity {
  taskId: string; recipientId: string; riskKey: string; kinds: WorkRiskKind[]
  generation: number; ruleVersion: number; day: string; slot: string
  notificationId: string | null; createdFor: 'member' | 'manager'; cancelledReason: string
}
export interface DigestItem extends Entity {
  recipientId: string; sourceId: string; sourceKind: string; target: NotificationTarget
  taskId: string | null; ownerId?: string; title: string; lines: string[]; occurredAt: string
  consumedBy: string | null; generation: number | null; actionable: boolean
}
export interface NotificationDigest extends Entity {
  recipientId: string; type: 'risk_member' | 'risk_manager' | 'critical_manager' | 'approval_manager' | 'daily_manager' | 'weekly_manager' | 'member_actions' | 'manual_followup'
  day: string; slot: string; periodStart: string; periodEnd: string
  itemIds: string[]; generatedAt: string; ruleVersion: number; notificationId: string | null
  statistics?: { label: string; value: number }[]
}
export interface CollaborationPreference extends Entity { userId: string; memberActionsEnabled: boolean }
export interface CollaborationEventConsumption extends Entity { eventId: string; consumedAt: string }
export const workRiskLabels: Record<WorkRiskKind, string> = {
  blocker_escalation: '阻塞需要支持', overdue: '任务已逾期', followup_overdue: '催办待回应', due_today: '今日到期',
  due_soon: '即将到期', stale: '需要更新进展', pause_review: '督办暂停待复查', previous_week_blocker: '上周阻塞待核对',
}
