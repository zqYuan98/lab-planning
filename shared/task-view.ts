import type { CollaborationTaskView } from './collaboration'
import type { WeeklyRecord } from './types'
import type { WorkProgress } from './work-progress'
import type { AuthorizedTaskView } from './object-access'

export const taskSections = ['overview', 'weekly', 'deliveries', 'support', 'followups', 'history'] as const
export type TaskSection = typeof taskSections[number]
export interface TaskHistoryItem { id: string; kind: string; at: string | null; actorId: string; title: string; detail: string }
export interface TaskHistoryPage { items: TaskHistoryItem[]; nextCursor: string | null }
export interface TaskView extends CollaborationTaskView {
  ownerName: string
  weeklyRecords: WeeklyRecord[]
  monthlyPlan: { id: string; title: string; month: string } | null
  progress: WorkProgress
  allowedActions: string[]
  readOnlyReason: string | null
  taskHistory: TaskHistoryPage
  authorizedDeliveries?: AuthorizedTaskView['deliveries']
  authorizedDeliverySummary?: AuthorizedTaskView['deliverySummary']
}
export interface EditableObject {
  version: number
  values: Record<string, unknown>
  operationEpoch: string
  relatedTask?: { id: string; version: number; status: import('./types').Task['status']; completionNote: string }
}
