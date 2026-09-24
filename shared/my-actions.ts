export const actionKinds = ['monthly_review', 'monthly_acceptance', 'weekly_review', 'delivery_review', 'deadline_review', 'followup_response', 'support', 'decision', 'assignment', 'revisit'] as const
export type ActionKind = typeof actionKinds[number]
export interface ActionItem {
  key: string
  kind: ActionKind
  sourceId: string
  sourceVersion: number
  businessGeneration: string
  taskId?: string
  assigneeIds: string[]
  title: string
  requiredAction: string
  dueAt: string | null
  createdAt: string
  sharedQueue: boolean
  blockedReason?: string
  actionTarget: { page: 'monthly' | 'weekly' | 'task' | 'support' | 'notification-settings'; id: string; section?: 'overview' | 'weekly' | 'deliveries' | 'support' | 'followups' | 'history'; month?: string; cycleWeek?: string; ownerId?: string; kind?: 'results' | 'plan'; action?: string }
}
export interface MyActions { items: ActionItem[]; counts: Record<ActionKind, number>; totalCount: number; filteredCount: number; nextCursor: string | null; asOf: string }
