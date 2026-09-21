import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Entity, Report } from '../shared/types.ts'
import type { ReportAgentPayload, ReportAsset, ReportTemplate } from '../shared/report-agent.ts'
import type { BusinessCollections, DataReference, TransferCollection } from './data-transfer-schema.ts'
import { reportAgentBindingSchema, reportAgentBlockSchema } from './report-agent-schemas.ts'
import { inspectDocxSync } from './report-docx.ts'
import { templateFingerprint, validateTemplateBindings } from './report-agent-service.ts'

/** Runtime leases, requests and schedules stay out of business migration packets. */
export const reportAgentTransferCollections = ['reportAssets', 'reportTemplates'] as const
export interface ReportAgentCollections { reportAssets: ReportAsset[]; reportTemplates: ReportTemplate[] }
const id = z.string().min(1).max(200), text = z.string().max(20000), hash = z.string().regex(/^[a-f0-9]{64}$/)
const timestamp = z.string().max(40).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value)
const week = day.refine(value => new Date(`${value}T00:00:00Z`).getUTCDay() === 1)
const entity = { id, version: z.number().int().positive(), createdAt: timestamp, updatedAt: timestamp }
const regionBase = { id, text: z.string().max(1200000), supported: z.boolean(), reasons: z.array(text).max(100) }
const index = z.number().int().nonnegative().max(10000)
export const reportDocxInspectionSchema = z.object({ sha256: hash, rendererVersion: id,
  regions: z.array(z.discriminatedUnion('kind', [
    z.object({ ...regionBase, kind: z.literal('paragraph'), paragraphIndex: index }).strict(),
    z.object({ ...regionBase, kind: z.literal('cell'), tableIndex: index, rowIndex: index, cellIndex: index }).strict(),
    z.object({ ...regionBase, kind: z.literal('table'), tableIndex: index, rows: z.array(z.array(text).max(256)).max(10000), columnCounts: z.array(index).max(10000), headerRows: index }).strict(),
  ])).max(20000), warnings: z.array(text).max(1000), fonts: z.array(z.string().max(500)).max(1000), partNames: z.array(z.string().max(1000)).max(3000),
}).strict()
export const reportAssetTransferSchema = z.object({ ...entity, filename: z.string().min(1).max(255), mimeType: z.literal('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
  size: z.number().int().positive().max(12 * 1024 * 1024), sha256: hash, contentBase64: z.string().min(1).max(16 * 1024 * 1024),
  purpose: z.enum(['template', 'example', 'preview', 'draft', 'final']), uploadedBy: id, inspection: reportDocxInspectionSchema.nullable(),
}).strict()
export const reportTemplateTransferSchema = z.object({ ...entity, name: z.string().min(1).max(200), type: z.literal('weekly'), status: z.enum(['draft', 'active', 'archived']),
  sourceAssetId: id, sourceHash: hash, exampleAssetIds: z.array(id).max(10), bindings: z.array(reportAgentBindingSchema).max(1000),
  rules: z.array(z.string().max(2000)).max(30), rulesConfirmed: z.boolean(), learningCandidates: z.array(text).max(100), learningNotes: z.array(text).max(100),
  confirmedBy: id.nullable(), layoutVerified: z.boolean(), layoutNote: z.string().max(2000), previewAssetId: id.nullable(), previewFingerprint: hash.nullable(),
  effectiveWeek: week, activatedAt: timestamp.nullable(), createdBy: id,
}).strict()
const factSchema = z.object({ id, sourceType: z.enum(['weeklyRecord', 'monthlyPlan', 'task', 'metric', 'manual']), sourceId: z.string().max(200), sourceVersion: z.number().int().nonnegative(),
  subjectId: z.string().max(200), subject: text, field: id, value: text, unit: z.string().max(100), period: z.string().max(40), status: z.string().max(200),
}).strict()
export const reportAgentPayloadSchema = z.object({ schemaVersion: z.literal('weekly-v1'), capturedAt: timestamp, snapshotHash: hash, template: reportTemplateTransferSchema, templateHash: hash,
  facts: z.array(factSchema).max(100000), blocks: z.array(reportAgentBlockSchema).max(1000),
  issues: z.array(z.object({ id, severity: z.enum(['error', 'warning']), code: id, location: z.string().max(500), message: text }).strict()).max(20000),
  coverage: z.array(z.object({ sourceId: id, disposition: z.enum(['included', 'not_displayed']), reason: text }).strict()).max(50000),
  ruleBlocks: z.array(reportAgentBlockSchema).max(1000), modelCandidates: z.array(z.object({ blockId: id, raw: z.unknown(), accepted: z.boolean(), createdAt: timestamp }).strict()).max(3000),
  promptVersion: id, validatorVersion: id, rendererVersion: id, modelIdentifier: z.string().max(300).nullable(), finalAssetId: id.nullable(), finalHash: hash.nullable(), reviewNote: z.string().max(2000),
  migrationSourceHashes: z.object({ snapshotHash: hash, templateHash: hash }).strict().optional(),
}).strict()
export const reportAgentTransferSchemas = { reportAssets: reportAssetTransferSchema, reportTemplates: reportTemplateTransferSchema }
export const reportAgentCollectionsShape = { reportAssets: z.array(reportAssetTransferSchema).max(50000), reportTemplates: z.array(reportTemplateTransferSchema).max(50000) }
export const emptyReportAgentCollectionsShape = { reportAssets: z.array(z.never()).max(0).optional(), reportTemplates: z.array(z.never()).max(0).optional() }
export const emptyReportAgentCollections = (): ReportAgentCollections => ({ reportAssets: [], reportTemplates: [] })

export function reportAgentReferences(name: string, row: Record<string, unknown>): DataReference[] {
  const refs: DataReference[] = []
  const add = (collection: TransferCollection, value: unknown) => { if (typeof value === 'string' && value) refs.push({ collection, id: value }) }
  const template = (value: ReportTemplate) => {
    add('reportAssets', value.sourceAssetId); add('reportAssets', value.previewAssetId)
    for (const assetId of value.exampleAssetIds) add('reportAssets', assetId)
    add('users', value.createdBy); add('users', value.confirmedBy)
  }
  if (name === 'reportAssets') add('users', row.uploadedBy)
  if (name === 'reportTemplates') template(row as unknown as ReportTemplate)
  if (name === 'reports' && row.agent) {
    const agent = row.agent as ReportAgentPayload
    add('reportTemplates', agent.template.id); template(agent.template); add('reportAssets', agent.finalAssetId)
  }
  return refs
}

/** Same stable ordering as the business packet; recomputed after typed account mapping. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(',')}}`
  return JSON.stringify(value)
}
export const reportTransferHash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')
export function remapReportAgentUsers(name: string, row: Record<string, unknown>, mapping: Record<string, string>) {
  if (name === 'reportAssets' && typeof row.uploadedBy === 'string') row.uploadedBy = mapping[row.uploadedBy] ?? row.uploadedBy
  const template = (value: ReportTemplate) => {
    value.createdBy = mapping[value.createdBy] ?? value.createdBy
    if (value.confirmedBy) value.confirmedBy = mapping[value.confirmedBy] ?? value.confirmedBy
  }
  if (name === 'reportTemplates') template(row as unknown as ReportTemplate)
  if (name === 'reports' && row.agent) {
    const agent = row.agent as ReportAgentPayload & { migrationSourceHashes?: { snapshotHash: string; templateHash: string } }
    const original = { snapshotHash: agent.snapshotHash, templateHash: agent.templateHash }
    template(agent.template)
    agent.snapshotHash = reportTransferHash(row.snapshot)
    agent.templateHash = templateFingerprint(agent.template)
    if (agent.snapshotHash !== original.snapshotHash || agent.templateHash !== original.templateHash) agent.migrationSourceHashes ??= original
  }
}

export function reportAgentTransferIssues(rows: BusinessCollections, available: Record<TransferCollection, Map<string, Entity>>, issue: (message: string) => void) {
  for (const asset of rows.reportAssets) {
    const bytes = Buffer.from(asset.contentBase64, 'base64')
    if (bytes.toString('base64') !== asset.contentBase64 || bytes.length !== asset.size || createHash('sha256').update(bytes).digest('hex') !== asset.sha256) issue(`reportAssets/${asset.id}：Word 文件内容与大小或校验和不一致`)
    if (bytes.length < 4 || bytes.readUInt32LE(0) !== 0x04034b50) issue(`reportAssets/${asset.id}：不是有效的 DOCX 文件`)
    else try {
      const actual = inspectDocxSync(bytes)
      if (asset.inspection && stable(actual) !== stable(asset.inspection)) issue(`reportAssets/${asset.id}：解析记录与 Word 原件结构不一致`)
    } catch { issue(`reportAssets/${asset.id}：Word 文件未通过结构与安全检查`) }
    if (asset.inspection && asset.inspection.sha256 !== asset.sha256) issue(`reportAssets/${asset.id}：解析结果不属于该文件`)
  }
  const assets = available.reportAssets as Map<string, ReportAsset>
  const inspectTemplate = (template: ReportTemplate, label: string) => {
    const source = assets.get(template.sourceAssetId)
    if (source?.sha256 !== template.sourceHash || !['template', 'example'].includes(source?.purpose ?? '') || !source?.inspection) issue(`${label}：模板原件缺失、类型或哈希不一致`)
    if (template.status === 'active' && (!template.rulesConfirmed || !template.layoutVerified || !template.confirmedBy || !template.activatedAt || !template.previewAssetId || !template.previewFingerprint)) issue(`${label}：生效模板缺少人工确认或试填记录`)
    if (template.status === 'active' && template.previewFingerprint !== templateFingerprint(template)) issue(`${label}：生效模板映射与已核验试填版本不一致`)
    if (source?.inspection) try { validateTemplateBindings(source.inspection, template.bindings) } catch { issue(`${label}：模板映射不完整或引用无效区域`) }
    if (template.previewAssetId && assets.get(template.previewAssetId)?.purpose !== 'preview') issue(`${label}：试填文件类型无效`)
    for (const example of template.exampleAssetIds) if (!['example', 'template'].includes(assets.get(example)?.purpose ?? '')) issue(`${label}：学习范例缺失或类型无效`)
  }
  for (const template of rows.reportTemplates) inspectTemplate(template, `reportTemplates/${template.id}`)
  for (const report of rows.reports.filter((row: Report) => row.agent)) {
    const agent = report.agent!
    if (report.type !== 'weekly') issue(`reports/${report.id}：当前智能体只支持周报`)
    reportAgentHashIssues(report, issue)
    inspectTemplate(agent.template, `reports/${report.id}`)
    if (report.status === 'finalized') {
      const final = agent.finalAssetId ? assets.get(agent.finalAssetId) : undefined
      if (!final || final.purpose !== 'final' || final.sha256 !== agent.finalHash) issue(`reports/${report.id}：定稿 Word 文件缺失或校验和不一致`)
    } else if (agent.finalAssetId || agent.finalHash) issue(`reports/${report.id}：草稿不能携带定稿文件`)
  }
}

export function reportAgentHashIssues(report: Report, issue: (message: string) => void) {
  if (report.agent && (report.agent.snapshotHash !== reportTransferHash(report.snapshot) || report.agent.templateHash !== templateFingerprint(report.agent.template))) issue(`reports/${report.id}：冻结事实或模板哈希不一致`)
}
