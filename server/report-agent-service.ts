import type { Report, User } from '../shared/types.ts'
import type { DocxEdit, DocxInspection } from '../shared/report-docx.ts'
import type { CreateReportTemplateInput, EditReportAgentInput, EnqueueReportAgentInput, FinalizeReportAgentInput, LearnReportTemplateInput, ReportAgentBinding, ReportAgentBlock, ReportAgentBootstrap, ReportAgentDownload, ReportAgentJob, ReportAgentPayload, ReportAsset, ReportAssetSummary, ReportTemplate, ReportTemplateReviewInput, RewriteReportAgentInput, UpdateReportTemplateInput, UploadReportAssetInput } from '../shared/report-agent.ts'
import { REPORT_AGENT_VERSION } from '../shared/report-agent.ts'
import { HttpError, Store } from './store.ts'
import { inspectDocx, renderDocx } from './report-docx.ts'
import { aiConfigured, buildReportSnapshot, normalizeReportPeriod, requireReportManager } from './reports.ts'
import { buildReportFacts, buildRuleBlocks, reportAgentHash, reportBlocksNarrative, validateReportBlocks } from './report-agent-evidence.ts'
import { createReportTemplateSchema, editReportAgentSchema, enqueueReportAgentSchema, finalizeReportAgentSchema, learnReportTemplateSchema, parseAgentInput, reportTemplateReviewSchema, rewriteReportAgentSchema, updateReportTemplateSchema, uploadReportAssetSchema } from './report-agent-schemas.ts'
import { getReportAgentSchedule, reportAgentMissedPeriods } from './report-agent-schedule.ts'
import { recordLifecycleEvent, publishCollaborationEvents } from './collaboration-notifications.ts'
import { readCollaborationSettings } from './collaboration-policy.ts'

const MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export function reportAssetSummary(asset: ReportAsset): ReportAssetSummary { const { contentBase64: _bytes, ...summary } = asset; return summary }
export function reportAgentAsset(store: Store, id: string): ReportAsset {
  const asset = store.get<ReportAsset>('reportAssets', id)
  if (!asset) throw new HttpError(404, '报告文件不存在。')
  const bytes = Buffer.from(asset.contentBase64, 'base64')
  if (bytes.length !== asset.size || reportAgentHashBytes(bytes) !== asset.sha256) throw new HttpError(409, '报告文件校验和不一致，请恢复完整备份。')
  return asset
}
import { createHash } from 'node:crypto'
export function reportAgentHashBytes(bytes: Buffer) { return createHash('sha256').update(bytes).digest('hex') }
function template(store: Store, actorId: string, id: string, expectedVersion?: number, draft = false) {
  requireReportManager(store, actorId)
  const row = store.get<ReportTemplate>('reportTemplates', id)
  if (!row) throw new HttpError(404, '周报模板不存在。')
  if (expectedVersion !== undefined && expectedVersion !== row.version) throw new HttpError(409, '模板已更新，请重新加载。')
  if (draft && row.status !== 'draft') throw new HttpError(409, '已发布模板不可修改，请建立新的模板版本。')
  return row
}
function audit(store: Store, actorId: string, entityType: string, entityId: string, action: string, before: unknown, after: unknown) {
  store.insert('events', { entityType, entityId, actorId, action, reason: '', before, after } as never)
}
function assetInsert(store: Store, actorId: string, filename: string, bytes: Buffer, purpose: ReportAsset['purpose'], inspection: DocxInspection | null = null) {
  return store.insert<ReportAsset>('reportAssets', { filename, mimeType: MIME, size: bytes.length, sha256: reportAgentHashBytes(bytes), contentBase64: bytes.toString('base64'), purpose, uploadedBy: actorId, inspection })
}
export async function uploadReportAsset(store: Store, actorId: string, raw: UploadReportAssetInput): Promise<ReportAssetSummary> {
  requireReportManager(store, actorId)
  const input = parseAgentInput(uploadReportAssetSchema, raw)
  if (!/\.docx$/i.test(input.filename) || /[\\/\x00-\x1f]/.test(input.filename)) throw new HttpError(400, '请上传文件名有效的 DOCX 文件。')
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input.contentBase64)) throw new HttpError(400, '文件编码无效。')
  const bytes = Buffer.from(input.contentBase64, 'base64')
  if (!bytes.length || bytes.length > 12 * 1024 * 1024) throw new HttpError(400, 'DOCX 文件须小于 12 MiB。')
  const inspection = await inspectDocx(bytes)
  return store.transaction(() => {
    requireReportManager(store, actorId)
    const existing = store.list<ReportAsset>('reportAssets').find(a => a.sha256 === inspection.sha256 && a.purpose === input.purpose && a.uploadedBy === actorId)
    return reportAssetSummary(existing || assetInsert(store, actorId, input.filename, bytes, input.purpose, inspection))
  })
}
function fieldFor(label: string): import('../shared/report-agent.ts').ReportAgentField {
  if (/方案|代价|决策|截止|完成日期|恢复时间|验收标准/.test(label)) return 'manual'
  if (/措施.*责任|责任.*措施/.test(label)) return 'manual'
  if (/必须完成的结果/.test(label)) return 'commitment'
  if (/异常|风险/.test(label)) return 'blocker'
  if (/负责人|责任人/.test(label)) return 'owner'
  if (/证据|链接/.test(label)) return 'evidence'
  if (/项目|事项|任务|工作名称/.test(label)) return 'title'
  if (/月目标/.test(label)) return 'monthly_goal'
  if (/实际|成果|进展|完成情况|本周动作|可验证结果/.test(label)) return 'outcome'
  if (/原因|问题|风险|阻塞/.test(label)) return 'blocker'
  if (/措施|下一步|下一节点/.test(label)) return 'next_action'
  if (/计划|安排|预期|目标/.test(label)) return 'commitment'
  if (/状态/.test(label)) return 'status'
  return 'manual'
}
export function suggestReportBindings(inspection: DocxInspection): ReportAgentBinding[] {
  const bindings: ReportAgentBinding[] = []
  for (const region of inspection.regions.filter(r => r.kind !== 'cell')) {
    if (region.kind === 'paragraph') {
      const fixedTitle = /TOP\s*\d+/i.test(region.text) ? region.text.replace(/\s*TOP\s*\d+/ig, '') : /本周无/.test(region.text) ? region.text.replace(/[（(]?本周无[）)]?/g, '') : undefined
      bindings.push({ regionId: region.id, label: region.text.trim().slice(0, 80) || '空白段落', kind: 'keep', required: false, ...(fixedTitle !== undefined ? { value: fixedTitle } : {}) })
      continue
    }
    const header = region.rows[0] || [], headerText = header.join(' ')
    const isMetric = /月目标|月累计|完成率|达成率/.test(headerText) && !/事项|项目名称|工作名称/.test(headerText)
    const canRows = region.rows.length >= 2 && region.columnCounts.every(n => n === region.columnCounts[0]) && !isMetric && (header.some(cell => /负责人|责任人/.test(cell)) || /序号/.test(headerText) && /工作|风险|异常/.test(headerText))
    if (canRows) {
      const dataset = /风险|问题|阻塞|异常/.test(headerText) ? 'risks' : /计划|安排|预期|必须完成/.test(headerText) && !/本周完成|实际/.test(headerText) ? 'next_week' : 'outcomes'
      bindings.push({ regionId: region.id, label: `表格：${headerText.slice(0, 70)}`, kind: 'dataset', required: true, dataset, startRow: 1, endRow: region.rows.length,
        columns: header.map(label => ({ label: label.trim() || '补充信息', field: fieldFor(label), required: true })) })
    } else {
      region.rows.forEach((row, r) => row.forEach((value, c) => {
        const previous = row[c - 1] || ''
        const meta = /统计周期|汇报周期|周报周期|报告周期/.test(previous) ? 'week_range' : /汇报人|报告人|填报人/.test(previous) ? 'author' : /^部门[：:]?$/.test(previous.trim()) ? 'department' : /日期/.test(previous) ? 'captured_at' : undefined
        const label = meta ? ({ week_range: '汇报周期', author: '汇报人', department: '部门', captured_at: '汇报日期' })[meta] : `${region.id} 第${r + 1}行 · ${isMetric && r > 0 && c > 0 ? `${row[0]} · ` : ''}${header[c] || previous || '内容'}`
        const headerCell = r === 0 && isMetric || c === 0 && isMetric || /^(?:部门|汇报人|报告人|填报人|日期|汇报日期|报告日期|填报日期|统计周期|汇报周期|周报周期|报告周期)[：:]?$/.test(value.trim())
        bindings.push({ regionId: `${region.id}:r:${r}:c:${c}`, label, kind: meta ? 'meta' : headerCell ? 'keep' : 'manual', required: !headerCell, ...(meta ? { meta } : {}) })
      }))
    }
  }
  return bindings
}
function validateExamples(store: Store, ids: string[]) {
  if (new Set(ids).size !== ids.length) throw new HttpError(400, '范例文件不能重复。')
  for (const id of ids) { const asset = reportAgentAsset(store, id); if (!['example', 'template'].includes(asset.purpose) || !asset.inspection) throw new HttpError(400, '请选择已通过检查的范例文件。') }
}
export function validateTemplateBindings(inspection: DocxInspection, bindings: ReportAgentBinding[]) {
  if (new Set(bindings.map(b => b.regionId)).size !== bindings.length) throw new HttpError(400, '同一区域不能重复映射。')
  const byId = new Map(bindings.map(b => [b.regionId, b]))
  for (const region of inspection.regions.filter(r => r.kind !== 'cell')) {
    if (region.kind === 'paragraph' && !byId.has(region.id)) throw new HttpError(400, `请明确处理区域 ${region.id} 的原文。`)
    if (region.kind === 'table') {
      const cells = inspection.regions.filter(r => r.kind === 'cell' && r.tableIndex === region.tableIndex)
      if (byId.has(region.id) && cells.some(c => byId.has(c.id))) throw new HttpError(400, '整表映射与单元格映射不能重叠。')
      if (!byId.has(region.id) && cells.some(c => !byId.has(c.id))) throw new HttpError(400, `请完整处理表格 ${region.id} 的所有单元格。`)
    }
  }
  for (const binding of bindings) {
    const region = inspection.regions.find(r => r.id === binding.regionId)
    if (!region) throw new HttpError(400, '映射引用了不存在的区域。')
    if (!region.supported && binding.kind !== 'keep') throw new HttpError(400, `区域 ${region.id} 不支持自动填写，请提供简化模板。`)
    if (binding.kind === 'dataset') {
      if (region.kind !== 'table' || !binding.dataset || !binding.columns?.length || binding.startRow === undefined || binding.endRow === undefined || binding.startRow < 1 || binding.startRow >= binding.endRow || binding.endRow !== region.rows.length || binding.columns.length !== region.columnCounts[binding.startRow]) throw new HttpError(400, '重复表格须有表头、完整替换全部数据行并准确映射每列。')
      if (region.columnCounts.slice(binding.startRow).some(n => n !== binding.columns!.length)) throw new HttpError(400, '重复区域含不同单元格结构，请改为逐格填写。')
    } else if (region.kind === 'table' && !['keep', 'clear'].includes(binding.kind)) throw new HttpError(400, '固定表格请逐格映射，不能用一段文字替换整表。')
    if (binding.kind === 'meta' && !binding.meta || binding.kind === 'section' && !binding.section) throw new HttpError(400, '请选择明确的元信息或章节数据。')
  }
}
export function createReportTemplate(store: Store, actorId: string, raw: CreateReportTemplateInput): ReportTemplate {
  requireReportManager(store, actorId)
  const input = parseAgentInput(createReportTemplateSchema, raw), effectiveWeek = normalizeReportPeriod('weekly', input.effectiveWeek)
  return store.transaction(() => {
    const source = reportAgentAsset(store, input.sourceAssetId)
    if (!source.inspection || !['template', 'example'].includes(source.purpose)) throw new HttpError(400, '请选择已检查的模板文件。')
    validateExamples(store, input.exampleAssetIds || [])
    const id = input.requestId ? `template-${reportAgentHash(`${actorId}:${input.requestId}`).slice(0, 40)}` : undefined
    const existing = id && store.get<ReportTemplate>('reportTemplates', id)
    if (existing) {
      if (existing.sourceAssetId !== input.sourceAssetId || existing.name !== input.name || existing.effectiveWeek !== effectiveWeek || JSON.stringify(existing.exampleAssetIds) !== JSON.stringify(input.exampleAssetIds || [])) throw new HttpError(409, '相同请求编号已用于另一份模板。')
      return existing
    }
    return store.insert<ReportTemplate>('reportTemplates', { ...(id ? { id } : {}), name: input.name, type: 'weekly', status: 'draft', sourceAssetId: source.id, sourceHash: source.sha256, exampleAssetIds: input.exampleAssetIds || [],
      bindings: suggestReportBindings(source.inspection), rules: ['只使用本期冻结事实，先说明成果，再说明问题与下一步。', '周阶段自报完成与任务整体完成、月目标验收分开表述。'], rulesConfirmed: false,
      learningCandidates: [], learningNotes: [], confirmedBy: null, layoutVerified: false, layoutNote: '', previewAssetId: null, previewFingerprint: null, effectiveWeek, activatedAt: null, createdBy: actorId })
  })
}
export function updateReportTemplate(store: Store, actorId: string, id: string, raw: UpdateReportTemplateInput): ReportTemplate {
  const input = parseAgentInput(updateReportTemplateSchema, raw)
  return store.transaction(() => {
    const current = template(store, actorId, id, input.expectedVersion, true), asset = reportAgentAsset(store, current.sourceAssetId)
    validateTemplateBindings(asset.inspection!, input.bindings); validateExamples(store, input.exampleAssetIds)
    return store.update<ReportTemplate>('reportTemplates', id, current.version, { name: input.name, bindings: input.bindings, rules: input.rules, rulesConfirmed: input.rulesConfirmed,
      exampleAssetIds: input.exampleAssetIds, effectiveWeek: normalizeReportPeriod('weekly', input.effectiveWeek), layoutVerified: false, layoutNote: '', previewAssetId: null, previewFingerprint: null })
  })
}
export function templateFingerprint(row: ReportTemplate) { return reportAgentHash({ sourceHash: row.sourceHash, bindings: row.bindings, rules: row.rules, rulesConfirmed: row.rulesConfirmed, effectiveWeek: row.effectiveWeek }) }
function materialize(row: ReportTemplate, blocks: ReportAgentBlock[]): DocxEdit[] {
  return row.bindings.map(binding => {
    if (binding.kind === 'keep') return binding.value === undefined ? { kind: 'keep', regionId: binding.regionId } : { kind: 'text', regionId: binding.regionId, text: binding.value }
    if (binding.kind === 'clear') return { kind: 'clear', regionId: binding.regionId }
    const block = blocks.find(b => b.id === binding.regionId)
    if (!block) throw new HttpError(409, '报告内容与冻结模板不一致。')
    if (binding.kind === 'dataset') return { kind: 'rows', regionId: binding.regionId, headerRows: binding.startRow!, templateRow: binding.startRow!, startRow: binding.startRow!, endRow: binding.endRow!, rows: block.rows.map(row => row.map(cell => cell.text)) }
    return { kind: 'text', regionId: binding.regionId, text: block.content.text }
  })
}
async function renderAgent(store: Store, row: ReportTemplate, blocks: ReportAgentBlock[]) {
  const source = reportAgentAsset(store, row.sourceAssetId)
  return renderDocx(Buffer.from(source.contentBase64, 'base64'), materialize(row, blocks), { expectedSha256: row.sourceHash })
}
function ruleBlocks(store: Store, actorId: string, row: ReportTemplate, report: Pick<Report, 'snapshot' | 'period' | 'title'>, capturedAt: string) {
  const facts = buildReportFacts(report.snapshot, report.period), blocks = buildRuleBlocks(row.bindings, report.snapshot, facts, report.period, capturedAt, report.title)
  for (const block of blocks) {
    const binding = row.bindings.find(b => b.regionId === block.id)
    if (binding?.kind === 'meta' && binding.meta === 'author') block.content.text = store.get<User>('users', actorId)?.name || '汇报人待确认'
  }
  return { facts, blocks }
}
export async function previewReportTemplate(store: Store, actorId: string, id: string, expectedVersion: number): Promise<ReportTemplate> {
  const row = template(store, actorId, id, expectedVersion, true), source = reportAgentAsset(store, row.sourceAssetId)
  validateTemplateBindings(source.inspection!, row.bindings)
  const snapshot = buildReportSnapshot(store, 'weekly', row.effectiveWeek)
  const { blocks } = ruleBlocks(store, actorId, row, { snapshot, period: row.effectiveWeek, title: '周报版式试填' }, new Date().toISOString())
  for (const block of blocks) for (const cell of block.kind === 'text' ? [block.content] : block.rows.flat()) if (cell.manual && !cell.text) cell.text = '【需人工补充，请核对本区域版式】'
  const bytes = await renderAgent(store, row, blocks)
  return store.transaction(() => {
    const fresh = template(store, actorId, id, expectedVersion, true)
    const preview = assetInsert(store, actorId, `${fresh.name}-版式试填.docx`, bytes, 'preview')
    return store.update<ReportTemplate>('reportTemplates', id, fresh.version, { previewAssetId: preview.id, previewFingerprint: templateFingerprint(fresh), layoutVerified: false })
  })
}
export function activateReportTemplate(store: Store, actorId: string, id: string, raw: ReportTemplateReviewInput): ReportTemplate {
  const input = parseAgentInput(reportTemplateReviewSchema, raw)
  return store.transaction(() => {
    const current = template(store, actorId, id, input.expectedVersion, true), source = reportAgentAsset(store, current.sourceAssetId)
    validateTemplateBindings(source.inspection!, current.bindings)
    if (!current.rulesConfirmed || !input.layoutVerified || !current.previewAssetId || current.previewFingerprint !== templateFingerprint(current)) throw new HttpError(409, '请先确认映射与写法，下载当前试填文件并核验版式。')
    reportAgentAsset(store, current.previewAssetId)
    const result = store.update<ReportTemplate>('reportTemplates', id, current.version, { status: 'active', activatedAt: new Date().toISOString(), confirmedBy: actorId, layoutVerified: true, layoutNote: input.layoutNote })
    audit(store, actorId, 'reportTemplate', id, 'activate', { version: current.version }, { version: result.version, sourceHash: result.sourceHash })
    return result
  })
}
export function archiveReportTemplate(store: Store, actorId: string, id: string, expectedVersion: number): ReportTemplate {
  return store.transaction(() => { const row = template(store, actorId, id, expectedVersion); return store.update<ReportTemplate>('reportTemplates', id, row.version, { status: 'archived' }) })
}
function existingJob(store: Store, actorId: string, requestId: string, input: unknown) {
  const { requestId: _request, ...parameters } = input as Record<string, unknown>
  const inputHash = reportAgentHash(parameters), id = `job-${reportAgentHash(`${actorId}:${requestId}`).slice(0, 40)}`
  const existing = store.get<ReportAgentJob>('reportAgentJobs', id)
  if (existing && existing.inputHash !== inputHash) throw new HttpError(409, '同一请求编号不能用于不同内容。')
  return { existing, id, inputHash }
}
function insertJob(store: Store, actorId: string, input: { id: string; requestId: string; inputHash: string; kind: ReportAgentJob['kind']; row: ReportTemplate; report?: Report; blockId?: string; useAi: boolean; scheduledFor?: string }) {
  return store.insert<ReportAgentJob>('reportAgentJobs', { id: input.id, kind: input.kind, status: 'queued', requestId: input.requestId, inputHash: input.inputHash, actorId,
    reportId: input.report?.id || null, templateId: input.row.id, templateVersion: input.row.version, expectedReportVersion: input.report?.version || null, blockId: input.blockId || null,
    useAi: input.useAi, completedBlockIds: [], progress: '已入队，等待后台处理', attempts: 0, leaseToken: null, leaseUntil: null, error: '', scheduledFor: input.scheduledFor || null, startedAt: null, finishedAt: null })
}
export function enqueueTemplateLearning(store: Store, actorId: string, id: string, raw: LearnReportTemplateInput): ReportAgentJob {
  const input = parseAgentInput(learnReportTemplateSchema, raw)
  return store.transaction(() => {
    requireReportManager(store, actorId)
    const key = existingJob(store, actorId, input.requestId, { kind: 'learn', id, ...input }); if (key.existing) return key.existing
    const row = template(store, actorId, id, input.expectedVersion, true)
    validateExamples(store, row.exampleAssetIds)
    return insertJob(store, actorId, { ...key, requestId: input.requestId, kind: 'learn', row, useAi: input.useAi })
  })
}
export function enqueueReportAgent(store: Store, actorId: string, raw: EnqueueReportAgentInput): ReportAgentJob {
  const input = parseAgentInput(enqueueReportAgentSchema, raw), period = normalizeReportPeriod('weekly', input.period)
  return store.transaction(() => {
    requireReportManager(store, actorId)
    const key = existingJob(store, actorId, input.requestId, { kind: 'generate', ...input, period }); if (key.existing) return key.existing
    const row = template(store, actorId, input.templateId)
    if (row.status !== 'active' || !row.layoutVerified || row.effectiveWeek > period) throw new HttpError(409, '所选模板尚未启用或不适用于此周。')
    reportAgentAsset(store, row.sourceAssetId)
    const original = input.sourceReportId ? getAgentReport(store, actorId, input.sourceReportId) : undefined
    if (original && original.period !== period) throw new HttpError(400, '沿用快照时报告周期必须一致。')
    const running = store.list<ReportAgentJob>('reportAgentJobs').find(j => ['queued', 'running'].includes(j.status) && j.kind === 'generate' && j.inputHash === key.inputHash && j.actorId === actorId)
    if (running) return running
    const capturedAt = original && !input.refreshSnapshot ? original.agent!.capturedAt : new Date().toISOString()
    const snapshot = original && !input.refreshSnapshot ? original.snapshot : buildReportSnapshot(store, 'weekly', period)
    const revision = Math.max(0, ...store.list<Report>('reports').filter(r => r.type === 'weekly' && r.period === period).map(r => r.revision)) + 1
    const title = `人工智能实验室周报 · ${period}`, { facts, blocks } = ruleBlocks(store, actorId, row, { snapshot, period, title }, capturedAt)
    const agent: ReportAgentPayload = { schemaVersion: REPORT_AGENT_VERSION, capturedAt, snapshotHash: reportAgentHash(snapshot), template: structuredClone(row), templateHash: templateFingerprint(row), facts, blocks,
      issues: validateReportBlocks(blocks, facts), coverage: snapshot.weeklyRecords.map(r => ({ sourceId: r.id, disposition: blocks.some(b => JSON.stringify(b).includes(`weekly:${r.id}:`)) ? 'included' : 'not_displayed', reason: blocks.some(b => JSON.stringify(b).includes(`weekly:${r.id}:`)) ? '' : '未生效记录或模板未配置本类明细；保留于冻结快照' })),
      ruleBlocks: structuredClone(blocks), modelCandidates: [], promptVersion: REPORT_AGENT_VERSION, validatorVersion: REPORT_AGENT_VERSION, rendererVersion: reportAgentAsset(store, row.sourceAssetId).inspection!.rendererVersion,
      modelIdentifier: null, finalAssetId: null, finalHash: null, reviewNote: '' }
    const report = store.insert<Report>('reports', { type: 'weekly', period, title, status: 'draft', revision, narrative: reportBlocksNarrative(blocks), snapshot, authorId: actorId, finalizedAt: null, agent })
    return insertJob(store, actorId, { ...key, requestId: input.requestId, kind: 'generate', row, report, useAi: input.useAi })
  })
}
export function getAgentReport(store: Store, actorId: string, id: string): Report {
  requireReportManager(store, actorId)
  const report = store.get<Report>('reports', id)
  if (!report?.agent) throw new HttpError(404, '周报智能体报告不存在。')
  return report
}
export function editableAgentReport(store: Store, actorId: string, id: string, expectedVersion: number): Report {
  const report = getAgentReport(store, actorId, id)
  if (report.version !== expectedVersion || report.status !== 'draft') throw new HttpError(409, '报告已更新或已定稿，请重新加载。')
  return report
}
export function enqueueReportRewrite(store: Store, actorId: string, id: string, raw: RewriteReportAgentInput): ReportAgentJob {
  const input = parseAgentInput(rewriteReportAgentSchema, raw)
  return store.transaction(() => {
    requireReportManager(store, actorId)
    const key = existingJob(store, actorId, input.requestId, { kind: 'rewrite', id, ...input }); if (key.existing) return key.existing
    const report = editableAgentReport(store, actorId, id, input.expectedVersion)
    if (!report.agent!.blocks.some(b => b.id === input.blockId)) throw new HttpError(404, '章节不存在。')
    return insertJob(store, actorId, { ...key, requestId: input.requestId, kind: 'rewrite', row: report.agent!.template, report, blockId: input.blockId, useAi: input.useAi })
  })
}
function validateBlockShape(report: Report, blocks: ReportAgentBlock[]) {
  const existing = report.agent!.blocks
  if (blocks.length !== existing.length || new Set(blocks.map(b => b.id)).size !== blocks.length) throw new HttpError(400, '请保留全部报告区域。')
  for (const block of blocks) {
    const old = existing.find(b => b.id === block.id)
    if (!old || block.regionId !== old.regionId || block.kind !== old.kind || block.label !== old.label || block.required !== old.required || JSON.stringify(block.columns) !== JSON.stringify(old.columns) || block.rows.some(row => row.length !== block.columns.length)) throw new HttpError(400, '内容编辑不能更改冻结模板结构。')
    const binding = report.agent!.template.bindings.find(b => b.regionId === block.regionId)
    if (binding?.kind === 'manual' && !block.content.manual || block.kind === 'table' && block.rows.some(row => row.some((cell, index) => block.columns[index]?.field === 'manual' && !cell.manual))) throw new HttpError(400, '公司指标和人工补充字段必须保留人工来源确认。')
  }
}
export function editAgentReport(store: Store, actorId: string, id: string, raw: EditReportAgentInput): Report {
  const input = parseAgentInput(editReportAgentSchema, raw)
  return store.transaction(() => {
    const report = editableAgentReport(store, actorId, id, input.expectedVersion)
    validateBlockShape(report, input.blocks)
    const agent = { ...report.agent!, blocks: input.blocks, issues: validateReportBlocks(input.blocks, report.agent!.facts) }
    const updated = store.update<Report>('reports', id, report.version, { title: input.title, narrative: reportBlocksNarrative(input.blocks), agent })
    // A user owns every region they edited. If an in-flight model loses its CAS,
    // retry must skip those regions even when the user retained fact citations.
    const edited = input.blocks.filter(block => reportAgentHash(block) !== reportAgentHash(report.agent!.blocks.find(old => old.id === block.id))).map(block => block.id)
    for (const job of store.list<ReportAgentJob>('reportAgentJobs').filter(job => job.reportId === id && ['queued', 'running', 'needs_input', 'failed', 'cancelled'].includes(job.status))) {
      if (edited.length) store.update<ReportAgentJob>('reportAgentJobs', job.id, job.version, { completedBlockIds: [...new Set([...job.completedBlockIds, ...edited])] })
    }
    audit(store, actorId, 'report', id, 'agent_edit', { version: report.version }, { version: updated.version })
    return updated
  })
}
export async function finalizeAgentReport(store: Store, actorId: string, id: string, raw: FinalizeReportAgentInput): Promise<Report> {
  const input = parseAgentInput(finalizeReportAgentSchema, raw), report = editableAgentReport(store, actorId, id, input.expectedVersion)
  const issues = validateReportBlocks(report.agent!.blocks, report.agent!.facts)
  if (issues.some(i => i.severity === 'error') || !report.agent!.template.layoutVerified) throw new HttpError(409, '请先补齐并确认人工内容，解决事实与版式问题。')
  const bytes = await renderAgent(store, report.agent!.template, report.agent!.blocks)
  return store.transaction(() => {
    const fresh = editableAgentReport(store, actorId, id, input.expectedVersion)
    const asset = assetInsert(store, actorId, `${fresh.title}-第${fresh.revision}版-定稿.docx`, bytes, 'final')
    const updated = store.update<Report>('reports', id, fresh.version, { status: 'finalized', finalizedAt: new Date().toISOString(), agent: { ...fresh.agent!, issues, finalAssetId: asset.id, finalHash: asset.sha256, reviewNote: input.reviewNote } })
    recordLifecycleEvent(store, { kind: 'report_finalized', mutationId: `${id}:${updated.revision}`, subjectType: 'report', subjectId: id,
      taskId: null, ownerId: '', actorId, recipientIds: readCollaborationSettings(store).defaultManagerIds,
      occurredAt: updated.finalizedAt!, generation: null, sourceVersion: updated.version, facts: { title: updated.title, revision: updated.revision } })
    publishCollaborationEvents(store)
    audit(store, actorId, 'report', id, 'agent_finalize', { version: report.version }, { version: updated.version, finalHash: asset.sha256 })
    return updated
  })
}
export function downloadReportAsset(store: Store, actorId: string, id: string): ReportAgentDownload {
  requireReportManager(store, actorId)
  const asset = reportAgentAsset(store, id)
  return { bytes: Buffer.from(asset.contentBase64, 'base64'), filename: asset.filename, sha256: asset.sha256 }
}
export async function downloadAgentReport(store: Store, actorId: string, id: string, expectedVersion?: number): Promise<ReportAgentDownload> {
  const report = getAgentReport(store, actorId, id)
  if (expectedVersion !== undefined && expectedVersion !== report.version) throw new HttpError(409, '报告已更新，请重新下载。')
  if (report.status === 'finalized') {
    if (!report.agent!.finalAssetId) throw new HttpError(409, '定稿文件缺失，请恢复完整备份。')
    const result = downloadReportAsset(store, actorId, report.agent!.finalAssetId)
    if (result.sha256 !== report.agent!.finalHash) throw new HttpError(409, '定稿文件校验和不一致。')
    return result
  }
  const bytes = await renderAgent(store, report.agent!.template, report.agent!.blocks)
  requireReportManager(store, actorId)
  if (store.get<Report>('reports', id)?.version !== report.version) throw new HttpError(409, '报告已更新，请重新下载。')
  return { bytes, filename: `${report.title}-第${report.revision}版-草稿.docx`, sha256: reportAgentHashBytes(bytes) }
}
export function getReportAgentBootstrap(store: Store, actorId: string): ReportAgentBootstrap {
  requireReportManager(store, actorId)
  return { assets: store.list<ReportAsset>('reportAssets').map(reportAssetSummary), templates: store.list<ReportTemplate>('reportTemplates'), jobs: store.list<ReportAgentJob>('reportAgentJobs').sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 100),
    reports: store.list<Report>('reports').filter(r => r.agent).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), schedule: getReportAgentSchedule(store), missedPeriods: reportAgentMissedPeriods(store), aiConfigured: aiConfigured(store) }
}
