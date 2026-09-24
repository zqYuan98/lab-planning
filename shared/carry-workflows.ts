import type { Entity, MonthlyPlan, Task, WeeklyRecord } from './types'

export type CarryWorkflowStatus = 'preparing' | 'awaiting_publication' | 'ready' | 'completed' | 'cancelled'
export interface CarrySelection { selectedTaskIds: string[]; targetWeek: string; commitments: Record<string, string> }
export interface CarryWorkflow extends Entity {
  actorId: string; operationEpoch: string; sourcePlanId: string; sourceVersionAtStart: number; sourceSnapshot: MonthlyPlan
  targetMonth: string; targetPlanId: string; remainingWork: string; selectedTaskIds: string[]; targetWeek: string
  commitments?: Record<string, string>
  status: CarryWorkflowStatus; stepReceipts: { action: 'create' | 'selection' | 'apply' | 'cancel'; actorId: string; requestId: string; at: string }[]
  result?: { taskIds: string[]; relinkedDraftIds: string[]; createdRecordIds: string[]; reusedRecordIds: string[] }
}
export interface CarryManifestEntry { id: string; version: number; hash: string }
export interface CarryManifest {
  workflow: CarryManifestEntry; source: CarryManifestEntry; target: CarryManifestEntry
  tasks: CarryManifestEntry[]; records: CarryManifestEntry[]; submissionEvents: CarryManifestEntry[]; submissions: CarryManifestEntry[]
}
export interface CarryPreview {
  source: MonthlyPlan; targetMonth: string; candidates: MonthlyPlan[]; tasks: Task[]; records: WeeklyRecord[]
  taskManifest: CarryManifestEntry[]; recordManifest: CarryManifestEntry[]; previouslySubmittedIds: string[]
}
export interface CarryWorkflowView {
  workflow: CarryWorkflow; source: MonthlyPlan; target: MonthlyPlan; tasks: Task[]; records: WeeklyRecord[]
  sourceChanged: boolean; sourceChanges: string[]; canApply: boolean; blockedReason?: string
}
export interface CarryApplyPreview {
  view: CarryWorkflowView; selection: CarrySelection; manifest: CarryManifest; fingerprint: string
  impacts: { task: Task; relinkDrafts: WeeklyRecord[]; preservedRecords: WeeklyRecord[]; existingTargetRecord: WeeklyRecord | null; commitment: string }[]
}
