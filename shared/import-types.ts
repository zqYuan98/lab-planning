export type ImportKind = 'monthly' | 'weekly'
export type ImportMode = 'history' | 'draft' | 'existing'
export interface ImportRow {
  id: string
  kind: ImportKind
  selected: boolean
  sourceSheet: string
  sourceRow: number
  sourceText: string
  ownerName: string
  ownerId: string
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
  issues: string[]
  monthlyResult?: 'pending' | 'submitted' | 'accepted' | 'not_completed'
  weeklyStatus?: 'planned' | 'doing' | 'blocked' | 'done' | 'not_done'
  result?: { collection: string; id: string }
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
