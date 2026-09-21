import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Bootstrap, Report } from '../shared/types.ts'
import type { EnqueueReportAgentInput, ReportAgentCell, ReportAgentJob, ReportAgentSchedule, ReportAssetSummary, ReportTemplate } from '../shared/report-agent.ts'
import ReportAgentEditor, { ReportFinalizeReview } from '../src/components/ReportAgentEditor.tsx'
import ReportAgentTemplate, { ReportTemplateActivation } from '../src/components/ReportAgentTemplate.tsx'
import ReportAgentScheduleForm from '../src/components/ReportAgentSchedule.tsx'
import { editAgentCell, readAgentReportTarget, submitAgentGeneration, type AgentPendingRequest } from '../src/components/ReportAgentHelpers.ts'

const entity = { version: 3, createdAt: '2026-09-21T02:00:00Z', updatedAt: '2026-09-21T02:00:00Z' }
const template: ReportTemplate = { ...entity, id: 'template', name: '公司正式周报', type: 'weekly', status: 'active', sourceAssetId: 'asset', sourceHash: 'hash', exampleAssetIds: [], bindings: [{ regionId: 't:0:r:1:c:1', label: 't:0 第2行 · 预算执行', kind: 'manual', required: true }], rules: ['不推算公司指标'], rulesConfirmed: true, learningCandidates: [], learningNotes: [], confirmedBy: 'manager', layoutVerified: true, layoutNote: 'Word 核对', previewAssetId: 'trial', previewFingerprint: 'hash', effectiveWeek: '2026-09-21', activatedAt: entity.createdAt, createdBy: 'manager' }
const cell: ReportAgentCell = { text: '实际预算待补', factIds: [], manual: true, confirmed: false, source: '' }
function report(finalized = false): Report {
  return { ...entity, id: 'report', type: 'weekly', period: '2026-09-21', title: '本周工作', status: finalized ? 'finalized' : 'draft', revision: 2, narrative: '', snapshot: { plans: [], weeklyRecords: [], tasks: [], projects: [], users: [], annualGoals: [], nextPlans: [], nextWeeklyRecords: [], publications: [], changes: [] }, authorId: 'manager', finalizedAt: finalized ? entity.updatedAt : null, agent: { schemaVersion: 'weekly-v1', capturedAt: entity.createdAt, snapshotHash: 'hash', template, templateHash: 'hash', facts: [], blocks: [{ id: 't:0:r:1:c:1', regionId: 't:0:r:1:c:1', label: 't:0 第2行 · 预算执行', kind: 'text', required: true, content: finalized ? { ...cell, text: '已核对预算', source: '财务台账', confirmed: true } : cell, columns: [], rows: [] }], issues: finalized ? [] : [{ id: 'manual-missing', severity: 'error', code: 'manual', location: 't:0:r:1:c:1', message: '预算执行缺少来源和人工确认' }], coverage: [], ruleBlocks: [], modelCandidates: [], promptVersion: 'v1', validatorVersion: 'v1', rendererVersion: 'v1', modelIdentifier: null, finalAssetId: finalized ? 'final' : null, finalHash: finalized ? '0123456789abcdef0123' : null, reviewNote: '' } }
}
const editorProps = { accountId: 'manager', aiConfigured: false, refresh: async () => {}, notify: () => {}, onSaved: () => {} }

test('new-version retries reuse the accepted request after a lost response even when the job already finished', async () => {
  const request: { current: AgentPendingRequest | null } = { current: null }
  const parameters = { templateId: 'template', period: '2026-09-21', sourceReportId: 'original', refreshSnapshot: true, useAi: false }
  const jobs = new Map<string, ReportAgentJob>(), ids: string[] = []
  let nextId = 0, dropResponse = true
  const send = async (input: EnqueueReportAgentInput) => {
    ids.push(input.requestId)
    if (!jobs.has(input.requestId)) jobs.set(input.requestId, { ...entity, id: `job-${jobs.size + 1}`, reportId: `revision-${jobs.size + 1}`, status: 'ready', kind: 'generate', requestId: input.requestId, inputHash: 'hash', actorId: 'manager', templateId: input.templateId, templateVersion: 3, expectedReportVersion: 10, blockId: null, useAi: false, completedBlockIds: [], progress: '完成', attempts: 1, leaseToken: null, leaseUntil: null, error: '', scheduledFor: null, startedAt: entity.createdAt, finishedAt: entity.updatedAt })
    if (dropResponse) { dropResponse = false; throw new Error('response lost after server committed') }
    return jobs.get(input.requestId)!
  }
  const createId = () => `request-${++nextId}`
  await assert.rejects(submitAgentGeneration(request, parameters, send, createId), /response lost/)
  const recovered = await submitAgentGeneration(request, { ...parameters }, send, createId)
  assert.equal(recovered.reportId, 'revision-1')
  assert.equal(recovered.status, 'ready')
  assert.equal(jobs.size, 1)
  assert.equal(ids[0], ids[1])
  assert.equal(request.current, null)
  const deliberateNext = await submitAgentGeneration(request, parameters, send, createId)
  assert.equal(deliberateNext.reportId, 'revision-2')
  assert.notEqual(ids[1], ids[2])
})

test('changing new-version inputs after a failed request starts a distinct request', async () => {
  const request: { current: AgentPendingRequest | null } = { current: null }, ids: string[] = []
  const parameters = { templateId: 'template', period: '2026-09-21', sourceReportId: 'original', refreshSnapshot: false, useAi: false }
  let nextId = 0
  const fail = async (input: EnqueueReportAgentInput): Promise<ReportAgentJob> => { ids.push(input.requestId); throw new Error('offline') }
  const createId = () => `request-${++nextId}`
  await assert.rejects(submitAgentGeneration(request, parameters, fail, createId), /offline/)
  await assert.rejects(submitAgentGeneration(request, { ...parameters, refreshSnapshot: true }, fail, createId), /offline/)
  assert.notEqual(ids[0], ids[1])
  assert.equal(request.current?.id, ids[1])
})

test('reading a completed revision targets the new report and respects the unsaved-edit guard', async () => {
  let current = report(), editVersion = current.version, allowed = false, reads = 0
  const next = { ...report(), id: 'new-revision', revision: 3, version: 11, title: '新版报告' }
  const read = async (id: string) => { reads++; assert.equal(id, next.id); current = next; editVersion = next.version }
  await readAgentReportTarget(current.id, { reportId: next.id }, () => allowed, read)
  assert.equal(reads, 0)
  assert.equal(current.id, 'report')
  allowed = true
  await readAgentReportTarget(current.id, { reportId: next.id }, () => allowed, read)
  assert.equal(current.id, next.id)
  assert.equal(editVersion, 11)
  const html = renderToStaticMarkup(createElement(ReportAgentEditor, { ...editorProps, report: current }))
  assert.match(html, /reports\/new-revision\/docx\?expectedVersion=11/)
  await assert.rejects(readAgentReportTarget(current.id, { reportId: 'unreachable' }, () => true, async () => { throw new Error('offline') }), /offline/)
  assert.equal(current.id, next.id)
  assert.equal(editVersion, 11)
  let reloaded = ''
  await readAgentReportTarget(current.id, null, () => true, async id => { reloaded = id })
  assert.equal(reloaded, next.id)
})

test('finalization requires a nonblank review note even when validation has no warnings', () => {
  const props = { busy: false, reviewed: true, hasWarnings: false, onReviewed: () => {}, onReviewNote: () => {}, onConfirm: () => {}, onClose: () => {} }
  for (const reviewNote of ['', ' \n ', 'x'.repeat(2001)]) {
    const html = renderToStaticMarkup(createElement(ReportFinalizeReview, { ...props, reviewNote }))
    assert.match(html, /<button class="button primary" disabled="">确认定稿<\/button>/)
  }
  const html = renderToStaticMarkup(createElement(ReportFinalizeReview, { ...props, reviewNote: '已逐项核对事实及 Word 版式' }))
  assert.match(html, /<button class="button primary">确认定稿<\/button>/)
  assert.match(html, /审阅说明（必填）/)
  assert.match(html, /<textarea[^>]*maxLength="2000"[^>]*required=""/)
})

test('template activation requires a nonblank layout note after preview and review', () => {
  const props = { busy: false, dirty: false, layoutVerified: true, hasPreview: true, rulesConfirmed: true, onLayoutVerified: () => {}, onLayoutNote: () => {}, onActivate: () => {} }
  for (const layoutNote of ['', ' \n ', 'x'.repeat(2001)]) {
    const html = renderToStaticMarkup(createElement(ReportTemplateActivation, { ...props, layoutNote }))
    assert.match(html, /<button class="button primary" disabled="">.*?确认并启用模板<\/button>/)
  }
  const html = renderToStaticMarkup(createElement(ReportTemplateActivation, { ...props, layoutNote: 'Word 16，已核对字体、表格和分页' }))
  assert.match(html, /<button class="button primary">.*?确认并启用模板<\/button>/)
  assert.match(html, /版式核对说明（必填）/)
  assert.match(html, /<textarea[^>]*maxLength="2000"[^>]*required=""/)
})

test('manual company fields require source confirmation and cannot switch away from their manual mapping', () => {
  const html = renderToStaticMarkup(createElement(ReportAgentEditor, { ...editorProps, report: report() }))
  assert.match(html, /预算执行缺少来源和人工确认/)
  assert.match(html, /aria-label="表格 1 第2行 · 预算执行的补充来源"/)
  assert.match(html, /<input type="checkbox" disabled="" checked=""\/>这是管理者补充的事实/)
  assert.match(html, /<button type="button" class="button primary" disabled="">.*?审阅并定稿<\/button>/)
  assert.doesNotMatch(html, /管理者汇报正文|将选中的.*加入正文|润色正文/)
})

test('table business sections expose rewrite while purely manual cells do not', () => {
  const source = report()
  source.agent!.blocks = [{ id: 't:2', regionId: 't:2', label: '本周工作', kind: 'table', required: true, content: { ...cell, text: '' }, columns: [{ label: '本周动作与可验证结果', field: 'outcome', required: true }], rows: [[{ text: '完成接口联调', factIds: ['weekly:record:outcome'], manual: false, confirmed: false, source: '' }]] }]
  const html = renderToStaticMarkup(createElement(ReportAgentEditor, { ...editorProps, aiConfigured: true, report: source }))
  assert.match(html, /<button type="button" class="button secondary">.*?只改写本节<\/button>/)
  const manual = renderToStaticMarkup(createElement(ReportAgentEditor, { ...editorProps, aiConfigured: true, report: report() }))
  assert.doesNotMatch(manual, /只改写本节/)
  source.agent!.blocks[0].rows[0][0].factIds = []
  const noFacts = renderToStaticMarkup(createElement(ReportAgentEditor, { ...editorProps, aiConfigured: true, report: source }))
  assert.doesNotMatch(noFacts, /只改写本节/)
})

test('archived report is read-only and downloads its version while hiding draft save and finalize actions', () => {
  const html = renderToStaticMarkup(createElement(ReportAgentEditor, { ...editorProps, report: report(true) }))
  assert.match(html, /已定稿 · 文件已归档/)
  assert.match(html, /reports\/report\/docx\?expectedVersion=3/)
  assert.match(html, /下载定稿 Word/)
  assert.match(html, /<textarea[^>]*disabled=""/)
  assert.doesNotMatch(html, /保存并校验|审阅并定稿|只改写本节/)
})

test('editing a confirmed manual supplement invalidates its confirmation without losing its evidence', () => {
  const original = { ...cell, confirmed: true, source: '财务已确认', factIds: ['evidence'] }
  const changed = editAgentCell(original, '修正后的预算')
  assert.equal(changed.confirmed, false)
  assert.equal(changed.source, original.source)
  assert.deepEqual(changed.factIds, original.factIds)
  assert.equal(original.text, '实际预算待补')
})

test('template inspection exposes original historical values beside manual company mappings', () => {
  const asset: ReportAssetSummary = { ...entity, id: 'asset', filename: '样本.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: 100, sha256: 'hash', purpose: 'template', uploadedBy: 'manager', inspection: { sha256: 'hash', rendererVersion: 'v1', warnings: [], fonts: [], partNames: [], regions: [{ id: 't:0', kind: 'table', tableIndex: 0, text: '预算执行 620 人', supported: true, reasons: [], rows: [['项目', '预算执行'], ['旧项目', '620 人']], columnCounts: [2, 2], headerRows: 1 }, { id: 't:0:r:1:c:1', kind: 'cell', tableIndex: 0, rowIndex: 1, cellIndex: 1, text: '620 人', supported: true, reasons: [] }] } }
  const html = renderToStaticMarkup(createElement(ReportAgentTemplate, { initial: { ...template, status: 'draft' }, assets: [asset], accountId: 'manager', aiConfigured: false, notify: () => {}, onSaved: () => {}, onJob: () => {} }))
  assert.match(html, /上传文件原文/)
  assert.match(html, /620 人/)
  assert.match(html, /系统不会用工作条数猜测公司指标/)
  assert.match(html, /需替换的历史内容和公司指标口径/)
  assert.doesNotMatch(html, />t:0 /)
})

test('weekly scheduler Sunday selection uses the server ISO weekday 7', () => {
  const manager = { ...entity, id: 'manager', name: '管理员', email: 'manager@example.test', role: 'manager' as const, position: '', active: true }
  const data: Bootstrap = { user: manager, users: [manager], projects: [], plans: [], tasks: [], weeklyRecords: [], annualGoals: [], publications: [], reports: [], aiConfigured: false }
  const schedule: ReportAgentSchedule = { ...entity, id: 'schedule', enabled: false, actorId: manager.id, templateId: template.id, weekday: 7, time: '17:30', targetWeek: 'previous', timezone: 'Asia/Shanghai', effectiveAt: entity.createdAt, useAi: false }
  const html = renderToStaticMarkup(createElement(ReportAgentScheduleForm, { initial: schedule, templates: [template], data, missedPeriods: [], notify: () => {}, onSaved: () => {} }))
  assert.match(html, /<option value="7" selected="">周日<\/option>/)
  assert.doesNotMatch(html, /<option value="0">周日/)
  assert.match(html, /<option value="previous" selected="">触发时的上一周<\/option>/)
})
