import type { Entity, Report } from './types.ts'
import type { DocxInspection } from './report-docx.ts'

export const REPORT_AGENT_COLLECTIONS = ['reportAssets', 'reportTemplates', 'reportAgentJobs', 'reportAgentOccurrences'] as const
export const REPORT_AGENT_VERSION = 'weekly-v1'
export type ReportAgentDataset = 'outcomes' | 'risks' | 'next_week'
export type ReportAgentField = 'title' | 'owner' | 'commitment' | 'outcome' | 'status' | 'evidence' | 'blocker' | 'next_action' | 'monthly_goal' | 'manual'
export interface ReportAgentColumn { label: string; field: ReportAgentField; required: boolean }
/** Map each paragraph and either a whole table or all its cells; keep is an explicit manager decision. */
export interface ReportAgentBinding {
  regionId: string; label: string; kind: 'keep' | 'clear' | 'meta' | 'section' | 'dataset' | 'manual'; required: boolean
  value?: string; meta?: 'period' | 'week_end' | 'week_range' | 'captured_at' | 'title' | 'author' | 'department'; section?: ReportAgentDataset
  dataset?: ReportAgentDataset; startRow?: number; endRow?: number; columns?: ReportAgentColumn[]
}
export interface ReportAsset extends Entity {
  filename: string; mimeType: string; size: number; sha256: string; contentBase64: string
  purpose: 'template' | 'example' | 'preview' | 'draft' | 'final'; uploadedBy: string
  inspection: DocxInspection | null
}
export type ReportAssetSummary = Omit<ReportAsset, 'contentBase64'>
export interface ReportTemplate extends Entity {
  name: string; type: 'weekly'; status: 'draft' | 'active' | 'archived'; sourceAssetId: string; sourceHash: string
  exampleAssetIds: string[]; bindings: ReportAgentBinding[]; rules: string[]; rulesConfirmed: boolean
  learningCandidates: string[]; learningNotes: string[]; confirmedBy: string | null
  layoutVerified: boolean; layoutNote: string; previewAssetId: string | null; previewFingerprint: string | null
  effectiveWeek: string; activatedAt: string | null; createdBy: string
}
export interface ReportFact {
  id: string; sourceType: 'weeklyRecord' | 'monthlyPlan' | 'task' | 'metric' | 'manual'; sourceId: string
  sourceVersion: number; subjectId: string; subject: string; field: string; value: string; unit: string; period: string
  status: string
}
export interface ReportAgentCell {
  text: string; factIds: string[]; manual: boolean; confirmed: boolean; source: string
}
export interface ReportAgentBlock {
  id: string; regionId: string; label: string; kind: 'text' | 'table'; required: boolean
  content: ReportAgentCell; columns: ReportAgentColumn[]; rows: ReportAgentCell[][]
}
export interface ReportAgentIssue {
  id: string; severity: 'error' | 'warning'; code: string; location: string; message: string
}
export interface ReportAgentPayload {
  schemaVersion: 'weekly-v1'; capturedAt: string; snapshotHash: string; template: ReportTemplate; templateHash: string
  facts: ReportFact[]; blocks: ReportAgentBlock[]; issues: ReportAgentIssue[]
  coverage: Array<{ sourceId: string; disposition: 'included' | 'not_displayed'; reason: string }>
  ruleBlocks: ReportAgentBlock[]; modelCandidates: Array<{ blockId: string; raw: unknown; accepted: boolean; createdAt: string }>
  promptVersion: string; validatorVersion: string; rendererVersion: string; modelIdentifier: string | null
  finalAssetId: string | null; finalHash: string | null; reviewNote: string
  migrationSourceHashes?: { snapshotHash: string; templateHash: string }
}
export type ReportAgentJobStatus = 'queued' | 'running' | 'ready' | 'needs_input' | 'failed' | 'cancelled'
export interface ReportAgentJob extends Entity {
  kind: 'generate' | 'rewrite' | 'learn'; status: ReportAgentJobStatus; requestId: string; inputHash: string
  actorId: string; reportId: string | null; templateId: string; templateVersion: number; expectedReportVersion: number | null
  blockId: string | null; useAi: boolean; completedBlockIds: string[]; progress: string; attempts: number
  leaseToken: string | null; leaseUntil: string | null; error: string; scheduledFor: string | null
  startedAt: string | null; finishedAt: string | null
}
export interface ReportAgentSchedule extends Entity {
  enabled: boolean; actorId: string; templateId: string; weekday: number; time: string
  targetWeek: 'current' | 'previous'; timezone: 'Asia/Shanghai'; effectiveAt: string; useAi: boolean
}
export interface ReportAgentOccurrence extends Entity {
  key: string; period: string; scheduledFor: string; scheduleVersion: number; jobId: string; reportId: string
}
export interface ReportAgentBootstrap {
  assets: ReportAssetSummary[]; templates: ReportTemplate[]; jobs: ReportAgentJob[]; reports: Report[]
  schedule: ReportAgentSchedule; missedPeriods: string[]; aiConfigured: boolean
}
export interface UploadReportAssetInput { filename: string; contentBase64: string; purpose: 'template' | 'example'; requestId?: string }
export interface CreateReportTemplateInput { name: string; sourceAssetId: string; exampleAssetIds?: string[]; effectiveWeek: string; requestId?: string }
export interface UpdateReportTemplateInput {
  expectedVersion: number; name: string; bindings: ReportAgentBinding[]; rules: string[]; rulesConfirmed: boolean
  exampleAssetIds: string[]; effectiveWeek: string
}
export interface ReportTemplateReviewInput { expectedVersion: number; layoutVerified: boolean; layoutNote: string }
export interface EnqueueReportAgentInput {
  requestId: string; templateId: string; period: string; useAi: boolean; sourceReportId?: string; refreshSnapshot?: boolean
}
export interface RewriteReportAgentInput { requestId: string; expectedVersion: number; blockId: string; useAi: boolean }
export interface LearnReportTemplateInput { requestId: string; expectedVersion: number; useAi: boolean }
export interface EditReportAgentInput { expectedVersion: number; title: string; blocks: ReportAgentBlock[] }
export interface FinalizeReportAgentInput { expectedVersion: number; reviewNote: string }
export interface UpdateReportAgentScheduleInput {
  expectedVersion: number; enabled: boolean; actorId: string; templateId: string; weekday: number; time: string
  targetWeek: 'current' | 'previous'; useAi: boolean
}
export interface ReportAgentDownload { bytes: Buffer; filename: string; sha256: string }
