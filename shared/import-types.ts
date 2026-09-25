export type ImportKind = 'monthly' | 'weekly'
export type ImportMode = 'history' | 'draft' | 'existing'
export interface ImportRow {
  annualGoalId?: string | null
  remainingEffortDays?: number | null
  plannedEffortDays?: number | null
  actualEffortDays?: number | null
  id: string
  kind: ImportKind
  selected: boolean
  exclusionReason?: string
  exclusionKind?: 'task' | 'duplicate' | 'not_task'
  /** Server-assigned provenance for candidates added during human source review. */
  manuallyAdded?: boolean
  sourceSheet: string
  sourceRow: number
  sourceText: string
  ownerName: string
  ownerId: string
  collaboratorNames?: string[]
  collaboratorIds?: string[]
  workSource?: 'leader' | 'self' | 'coordination'
  assignedBy?: string
  assignedOn?: string
  /** Human confirmation that the whole task ended, independent of this week's result. */
  taskCompleted?: boolean
  completionNote?: string
  projectName: string
  projectId: string
  category: string
  title: string
  month: string
  weekStart: string
  dueDate: string
  expectedOutcome: string
  acceptanceCriteria: string
  actualOutcome: string
  blocker: string
  nextAction: string
  sourceStatus: string
  monthlyPlanId: string
  linkedRowId: string
  taskId: string
  /** Missing on legacy rows. Temporary weekly work is independent of monthly goals. */
  isTemporary?: boolean
  temporaryReason?: string
  issues: string[]
  monthlyResult?: 'pending' | 'submitted' | 'accepted' | 'not_completed'
  weeklyStatus?: 'planned' | 'doing' | 'blocked' | 'done' | 'not_done'
  result?: { collection: string; id: string }
  resultDisposition?: 'created' | 'existing'
}
export interface ImportBatch {
  id: string
  version: number
  createdAt: string
  updatedAt: string
  ownerId: string
  sourceId: string
  fileName: string
  kind: 'table' | 'image' | 'text'
  status: 'uploaded' | 'parsed' | 'committed'
  sourceSheets: { name: string; rowCount: number }[]
  warnings: string[]
  rows: ImportRow[]
  mode: ImportMode
  reviewRequestedAt?: string
  committedAt?: string
  committedCount?: number
  activatedCount?: number
  skippedCount?: number
  excludedCount?: number
  pendingCount?: number
  requiresCompletionReview?: boolean
  analysisOptions?: { sheetNames: string[]; instruction: string; period: string; kind?: string }
  completionReview?: { sourceItemCount: number; reviewedAt: string; reviewedBy: string; reviewedVersion: number; contentFingerprint: string }
  analysis?: { status: 'running' | 'failed' | 'completed'; completedChunks: number; totalChunks: number; error?: string }
}
export type ImportBatchSummary = Omit<ImportBatch, 'rows'> & { rowCount: number }
export interface AiSettingsView {
  baseUrl: string
  model: string
  visionModel: string
  configured: boolean
  hasApiKey: boolean
  source: 'environment' | 'settings' | 'none'
}
export interface IntegrationTokenView {
  id: string
  name: string
  createdAt: string
  expiresAt: string
  revokedAt: string | null
  scopes: string[]
}
