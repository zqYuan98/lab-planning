import type { Entity, Report } from './types.ts'
import type { DocxInspection } from './report-docx.ts'

export const REPORT_AGENT_COLLECTIONS = ['reportAssets', 'reportTemplates', 'reportAgentJobs', 'reportAgentOccurrences'] as const
export const REPORT_AGENT_VERSION = 'weekly-v1'
export const MONTHLY_REPORT_AGENT_VERSION = 'monthly-v1'
export type ReportAgentType = 'weekly' | 'monthly'
export type ReportAgentDataset = 'outcomes' | 'risks' | 'next_week' | 'next_month' | 'effort' | 'annual_goals'
export type ReportAgentField = 'title' | 'owner' | 'commitment' | 'outcome' | 'status' | 'evidence' | 'blocker' | 'next_action' | 'monthly_goal' | 'support' | 'due' | 'criteria' | 'manual'
export interface ReportAgentColumn { label: string; field: ReportAgentField; required: boolean }
/** Prose sections of outline templates (headings plus writing requirements). */
export type ReportAgentNarrative = 'review' | 'causes' | 'remedies' | 'plan' | 'support'
export const REPORT_AGENT_NARRATIVES = ['review', 'causes', 'remedies', 'plan', 'support'] as const
/** Map each paragraph and either a whole table or all its cells; keep is an explicit manager decision. */
export interface ReportAgentBinding {
  regionId: string; label: string; kind: 'keep' | 'clear' | 'remove' | 'meta' | 'section' | 'narrative' | 'dataset' | 'manual'; required: boolean
  /** meta 'template' fills {{department}}, {{author}}, {{date}} and {{month}} inside the original line. */
  value?: string; meta?: 'period' | 'week_end' | 'week_range' | 'captured_at' | 'title' | 'author' | 'department' | 'template'; section?: ReportAgentDataset
  /** A narrative region is written as paragraphs following the template's own requirement text. */
  narrative?: ReportAgentNarrative; instruction?: string
  dataset?: ReportAgentDataset; startRow?: number; endRow?: number; columns?: ReportAgentColumn[]
}
export interface ReportAsset extends Entity {
  filename: string; mimeType: string; size: number; sha256: string; contentBase64: string
  purpose: 'template' | 'example' | 'preview' | 'draft' | 'final'; uploadedBy: string
  inspection: DocxInspection | null
}
export type ReportAssetSummary = Omit<ReportAsset, 'contentBase64'>
export interface ReportTemplate extends Entity {
  name: string; type: ReportAgentType; status: 'draft' | 'active' | 'archived'; sourceAssetId: string; sourceHash: string
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
  /** Per-line citations for multi-subject prose, one entry per text line. */
  lineFactIds?: string[][]
}
export interface ReportAgentBlock {
  id: string; regionId: string; label: string; kind: 'text' | 'table'; required: boolean
  content: ReportAgentCell; columns: ReportAgentColumn[]; rows: ReportAgentCell[][]
}
export interface ReportAgentIssue {
  id: string; severity: 'error' | 'warning'; code: string; location: string; message: string
}
export interface ReportAgentPayload {
  schemaVersion: 'weekly-v1' | 'monthly-v1'; capturedAt: string; snapshotHash: string; template: ReportTemplate; templateHash: string
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
  type?: ReportAgentType; monthlyDay?: number; targetMonth?: 'current' | 'previous'
  enabled: boolean; actorId: string; templateId: string; weekday: number; time: string
  targetWeek: 'current' | 'previous'; timezone: 'Asia/Shanghai'; effectiveAt: string; useAi: boolean
}
export interface ReportAgentOccurrence extends Entity {
  key: string; period: string; scheduledFor: string; scheduleVersion: number; jobId: string; reportId: string
}
export interface ReportAgentBootstrap {
  assets: ReportAssetSummary[]; templates: ReportTemplate[]; jobs: ReportAgentJob[]; reports: Report[]
  schedule: ReportAgentSchedule; missedPeriods: string[]; aiConfigured: boolean
  monthlySchedule: ReportAgentSchedule; monthlyMissedPeriods: string[]; managedTypes: ReportAgentType[]
}
/** Counts from the same snapshot a report would freeze, shown before generating. */
export interface ReportAgentReadiness {
  type: ReportAgentType; period: string; current: number; accepted: number; notCompleted: number; waiting: number; done: number; support: number; next: number
}
export interface UploadReportAssetInput { filename: string; contentBase64: string; purpose: 'template' | 'example'; requestId?: string }
export interface CreateReportTemplateInput { type?: ReportAgentType; name: string; sourceAssetId: string; exampleAssetIds?: string[]; effectiveWeek: string; requestId?: string }
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
  type?: ReportAgentType; monthlyDay?: number; targetMonth?: 'current' | 'previous'
  expectedVersion: number; enabled: boolean; actorId: string; templateId: string; weekday: number; time: string
  targetWeek: 'current' | 'previous'; useAi: boolean
}
export interface ReportAgentDownload { bytes: Buffer; filename: string; sha256: string }
