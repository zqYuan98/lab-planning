import type { CollaborationSettings, CollaborationTaskStatusSummary, FollowupRequest, TaskTracking } from './collaboration'
import type { NotificationDigest, WorkRisk } from './collaboration-notifications'
import type { MonthlyPlan, Task } from './types'
import type { DirectoryAccount } from './directory-workspace'

export interface CollaborationCounts { all: number; unfinished: number; done: number; risks: number; riskTasks: number; followup: number; active: number; paused: number }
export type CollaborationTaskRow = { task: Task; tracking: TaskTracking | null; openFollowup: FollowupRequest | null; owner: DirectoryAccount | null; plan: Pick<MonthlyPlan, 'id' | 'priority' | 'isTemporary'> | null } & CollaborationTaskStatusSummary
export type CollaborationDigestSummary = Pick<NotificationDigest, 'id' | 'generatedAt' | 'type'> & { itemCount: number }
export interface CollaborationDashboard {
  settings: CollaborationSettings; preference: { version: number; memberActionsEnabled: boolean }
  tasks: CollaborationTaskRow[]; risks: WorkRisk[]; digests: CollaborationDigestSummary[]
  counts: CollaborationCounts; total: number; nextCursor: string | null; revision: string; accessScopeVersion: string
}
