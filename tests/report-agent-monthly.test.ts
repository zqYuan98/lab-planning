import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import type { AnnualGoal, MonthlyPlan, Publication, Report, Task, WeeklyRecord } from '../shared/types.ts'
import type { ReportAgentBinding, ReportAgentSchedule } from '../shared/report-agent.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { activateReportTemplate, archiveReportTemplate, createReportTemplate, downloadAgentReport, editAgentReport, enqueueReportAgent, getAgentReport, previewReportTemplate, templateFingerprint, updateReportTemplate, uploadReportAsset, finalizeAgentReport } from '../server/report-agent-service.ts'
import { buildReportFacts, buildRuleBlocks, reportAgentHash } from '../server/report-agent-evidence.ts'
import { buildReportSnapshot, editReport, finalizeReport, generateReport, polishReport } from '../server/reports.ts'
import { getReportAgentSchedule, reportAgentMissedPeriods, runReportAgentSchedule, updateReportAgentSchedule } from '../server/report-agent-schedule.ts'
import { getReportSchedule, runScheduledReports, updateReportSchedule } from '../server/scheduler.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { fixture, p, row } from './report-docx-fixtures.ts'

function account(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const manager = new Domain(store).setup({ name: '月报管理者', email: 'monthly@example.test', password: 'Fixture-password-2026!' })
  return { store, manager }
}
async function setup(t: TestContext, period = '2024-02') {
  const f = account(t)
  const bytes = await fixture(['周报', '周期', '本周成果', '下周安排', '投入', '年度'].map(p).join(''))
  const asset = await uploadReportAsset(f.store, f.manager.id, { filename: '现有周报.docx', contentBase64: bytes.toString('base64'), purpose: 'template' })
  const bindings: ReportAgentBinding[] = [
    { regionId: 'p:0', label: '标题', kind: 'meta', meta: 'title', required: true },
    { regionId: 'p:1', label: '周期', kind: 'meta', meta: 'week_range', required: true },
    ...(['outcomes', 'next_month', 'effort', 'annual_goals'] as const).map((section, i) => ({ regionId: `p:${i + 2}`, label: section, kind: 'section' as const, section, required: false })),
  ]
  const draft = createReportTemplate(f.store, f.manager.id, { type: 'monthly', name: '现有版式月度版', sourceAssetId: asset.id, effectiveWeek: '2023-01' })
  let template = updateReportTemplate(f.store, f.manager.id, draft.id, { expectedVersion: draft.version, name: draft.name, bindings, rules: ['以月度验收结论为依据'], rulesConfirmed: true, exampleAssetIds: [], effectiveWeek: draft.effectiveWeek })
  template = await previewReportTemplate(f.store, f.manager.id, template.id, template.version)
  template = activateReportTemplate(f.store, f.manager.id, template.id, { expectedVersion: template.version, layoutVerified: true, layoutNote: '合成模板试填已核对' })
  const enqueue = (requestId = 'monthly-generation') => enqueueReportAgent(f.store, f.manager.id, { requestId, templateId: template.id, period, useAi: false })
  return { ...f, asset, template, enqueue }
}
function plan(f: ReturnType<typeof account>, overrides: Partial<MonthlyPlan> = {}) {
  return f.store.insert<MonthlyPlan>('plans', { month: '2024-02', title: '本月目标', projectId: null, category: '研发', ownerId: f.manager.id, collaboratorIds: [], expectedOutcome: '交付能力', acceptanceCriteria: '核对成果', dueDate: '2024-02-29', priority: 'medium', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '已提交成果', acceptanceStatus: 'submitted', acceptanceNote: '', ...overrides })
}

test('monthly facts use published goals and acceptance; next month uses nextPlans and real leap-month boundaries', async t => {
  const f = await setup(t), current = plan(f), next = plan(f, { month: '2024-03', title: '下月目标', expectedOutcome: '交付两项能力', dueDate: '2024-03-31' })
  const nextDraft = plan(f, { month: '2024-03', title: '下月草稿目标', status: 'draft', dueDate: '2024-03-31' })
  plan(f, { title: '未发布本月目标', status: 'draft' })
  const task = f.store.insert<Task>('tasks', { title: '周自报任务', monthlyPlanId: current.id, ownerId: f.manager.id, description: '', dueDate: '', status: 'done', isTemporary: false, temporaryReason: '', remainingEffortDays: 99 })
  for (const [weekStart, actualEffortDays] of [['2024-01-29', 5], ['2024-02-05', 1.5], ['2024-02-26', null]] as const) f.store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, monthlyPlanId: current.id, ownerId: f.manager.id, weekStart, commitment: '周承诺', actualOutcome: '周已完成', evidenceUrl: '', blocker: '', nextAction: '', status: 'done', submitted: true, plannedEffortDays: 2, actualEffortDays })
  f.store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, monthlyPlanId: current.id, ownerId: f.manager.id, weekStart: '2024-02-12', commitment: '尚无实际投入', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'doing', submitted: true, plannedEffortDays: null, actualEffortDays: 0 })
  const annual = f.store.insert<AnnualGoal>('annualGoals', { year: 2024, title: '年度能力', target: '形成能力', ownerId: f.manager.id, progress: 40, progressMode: 'linked', description: '', status: 'active' })
  f.store.update<MonthlyPlan>('plans', current.id, current.version, { annualGoalId: annual.id })
  const report = getAgentReport(f.store, f.manager.id, f.enqueue().reportId!)
  assert.equal(report.type, 'monthly'); assert.equal(report.agent!.schemaVersion, 'monthly-v1')
  assert.match(report.narrative, /2024-02-01—2024-02-29/)
  assert.match(report.narrative, /下月目标/); assert.match(report.narrative, /已发布计划/)
  assert.ok(report.agent!.facts.some(fact => fact.id === `plan:${next.id}:commitment`))
  // Drafts and returned plans never enter the company report.
  assert.ok(!report.narrative.includes('下月草稿目标')); assert.ok(!report.agent!.facts.some(fact => fact.sourceId === nextDraft.id))
  assert.ok(!report.agent!.facts.some(fact => fact.sourceType === 'weeklyRecord'))
  assert.ok(!report.narrative.includes('周已完成')); assert.ok(!report.narrative.includes('未发布本月目标'))
  assert.equal(report.agent!.facts.find(fact => fact.id === 'metric:monthly_accepted')!.value, '0')
  assert.equal(report.snapshot.effortSummary!.actualEffortDays, 1.5)
  assert.equal(report.snapshot.effortSummary!.plannedEffortDays, 4)
  assert.equal(report.snapshot.effortSummary!.missingActualCount, 1)
  assert.equal(report.snapshot.effortSummary!.missingPlannedCount, 1)
  assert.equal(report.snapshot.effortSummary!.recordCount, 3)
  assert.match(report.snapshot.effortSummary!.basis, /周一所属月份/)
  assert.equal(buildReportSnapshot(f.store, 'monthly', '2024-03').effortSummary!.recordCount, 0)
  const changed = f.store.get<MonthlyPlan>('plans', current.id)!
  f.store.update<MonthlyPlan>('plans', current.id, changed.version, { acceptanceStatus: 'accepted' })
  assert.equal(report.snapshot.annualGoalSummaries![0].autoProgress, 0)
  assert.equal(buildReportSnapshot(f.store, 'monthly', '2024-02').annualGoalSummaries![0].autoProgress, 100)
  assert.equal(buildReportFacts(report.snapshot, report.period).find(fact => fact.id === 'metric:monthly_accepted')!.value, '0')
  assert.equal(report.agent!.issues.filter(issue => issue.severity === 'error').length, 0, JSON.stringify(report.agent!.issues))
  plan(f, { title: '已验收且附说明', acceptanceStatus: 'accepted', acceptanceNote: '通过评审', actualOutcome: '已验收成果' })
  plan(f, { title: '尚未完成目标', acceptanceStatus: 'not_completed', acceptanceNote: '外部条件未到位' })
  const riskSnapshot = buildReportSnapshot(f.store, 'monthly', '2024-02'), riskFacts = buildReportFacts(riskSnapshot, '2024-02')
  const risks = buildRuleBlocks([{ regionId: 'risk', label: '月风险', kind: 'section', section: 'risks', required: false }], riskSnapshot, riskFacts, '2024-02', new Date().toISOString(), '月报')
  assert.match(risks[0].content.text, /尚未完成目标/); assert.ok(!risks[0].content.text.includes('已验收且附说明'))
  assert.ok(!riskFacts.some(fact => fact.field === 'blocker' && fact.value === '通过评审'))
})

test('types and periods cannot be mixed; old weekly fingerprint keys are unchanged', async t => {
  const f = await setup(t)
  const weekly = createReportTemplate(f.store, f.manager.id, { name: '原周报', sourceAssetId: f.asset.id, effectiveWeek: '2024-02-05' })
  assert.equal(weekly.type, 'weekly')
  assert.equal(templateFingerprint(weekly), reportAgentHash({ sourceHash: weekly.sourceHash, bindings: weekly.bindings, rules: weekly.rules, rulesConfirmed: weekly.rulesConfirmed, effectiveWeek: weekly.effectiveWeek }))
  assert.throws(() => createReportTemplate(f.store, f.manager.id, { type: 'monthly', name: 'bad', sourceAssetId: f.asset.id, effectiveWeek: '2024-02-05' }), /YYYY-MM/)
  assert.throws(() => enqueueReportAgent(f.store, f.manager.id, { requestId: 'bad', templateId: f.template.id, period: '2024-02-29', useAi: false }), /YYYY-MM/)
  assert.throws(() => updateReportTemplate(f.store, f.manager.id, weekly.id, { expectedVersion: weekly.version, name: weekly.name, effectiveWeek: weekly.effectiveWeek, bindings: weekly.bindings, exampleAssetIds: [], rules: [], rulesConfirmed: false, type: 'monthly' } as never), { status: 400 })
  const original = getAgentReport(f.store, f.manager.id, f.enqueue().reportId!)
  f.store.update<Report>('reports', original.id, original.version, { type: 'weekly' })
  assert.throws(() => getAgentReport(f.store, f.manager.id, original.id), { status: 409 })
})

test('monthly schedule is independent, clamps month end, handles leap years and previous year, and never cascades backlog', async t => {
  const f = await setup(t)
  const initial = getReportAgentSchedule(f.store, 'monthly')
  const payload = { type: 'monthly' as const, expectedVersion: initial.version, enabled: true, actorId: f.manager.id, templateId: f.template.id, weekday: 5, time: '18:00', targetWeek: 'current' as const, monthlyDay: 31, targetMonth: 'current' as const, useAi: false }
  let schedule = updateReportAgentSchedule(f.store, f.manager.id, payload, new Date('2023-01-01T00:00:00Z'))
  assert.equal(getReportAgentSchedule(f.store).enabled, false)
  assert.equal(runReportAgentSchedule(f.store, new Date('2024-02-29T10:00:00Z'), 'monthly').length, 1)
  assert.equal(runReportAgentSchedule(f.store, new Date('2024-02-29T10:01:00Z'), 'monthly').length, 0)
  assert.deepEqual(f.store.list<Report>('reports').map(r => r.period), ['2024-02'])
  assert.ok(reportAgentMissedPeriods(f.store, new Date('2024-02-29T10:01:00Z'), 'monthly').includes('2024-01'))
  assert.equal(f.store.list<{ key: string }>('reportAgentOccurrences')[0].key, 'department:monthly:2024-02')
  schedule = updateReportAgentSchedule(f.store, f.manager.id, { ...payload, expectedVersion: schedule.version, monthlyDay: 1, targetMonth: 'previous' }, new Date('2024-12-31T00:00:00Z'))
  assert.equal(runReportAgentSchedule(f.store, new Date('2025-01-01T10:00:00Z'), 'monthly').length, 1)
  assert.ok(f.store.list<Report>('reports').some(r => r.period === '2024-12'))
  updateReportAgentSchedule(f.store, f.manager.id, { ...payload, expectedVersion: schedule.version, monthlyDay: 0 }, new Date('2025-02-01T00:00:00Z'))
  assert.equal(runReportAgentSchedule(f.store, new Date('2025-02-28T10:00:00Z'), 'monthly').length, 1)
})

test('activation locks same-type legacy mutations even with paused schedules; other type keeps legacy compatibility', async t => {
  const f = account(t), original = generateReport(f.store, 'monthly', '2024-02', f.manager.id)
  const asset = await uploadReportAsset(f.store, f.manager.id, { filename: 'existing.docx', contentBase64: (await fixture(p('周报'))).toString('base64'), purpose: 'template' })
  let template = createReportTemplate(f.store, f.manager.id, { type: 'monthly', name: '月度', sourceAssetId: asset.id, effectiveWeek: '2024-01' })
  template = updateReportTemplate(f.store, f.manager.id, template.id, { expectedVersion: template.version, name: template.name, effectiveWeek: template.effectiveWeek, bindings: template.bindings, rules: [], rulesConfirmed: true, exampleAssetIds: [] })
  template = await previewReportTemplate(f.store, f.manager.id, template.id, template.version)
  template = activateReportTemplate(f.store, f.manager.id, template.id, { expectedVersion: template.version, layoutVerified: true, layoutNote: '核对' })
  assert.equal(getReportAgentSchedule(f.store, 'monthly').enabled, false)
  assert.throws(() => generateReport(f.store, 'monthly', '2024-02', f.manager.id), { status: 409 })
  assert.throws(() => editReport(f.store, original.id, original.version, f.manager.id, 'rewrite'), { status: 409 })
  assert.throws(() => finalizeReport(f.store, original.id, original.version, f.manager.id), { status: 409 })
  await assert.rejects(polishReport(f.store, original.id, original.version, f.manager.id), { status: 409 })
  assert.equal(generateReport(f.store, 'weekly', '2024-02-26', f.manager.id).type, 'weekly')
  archiveReportTemplate(f.store, f.manager.id, template.id, template.version)
  assert.throws(() => generateReport(f.store, 'monthly', '2024-02', f.manager.id), { status: 409 })
  const oldSchedule = getReportSchedule(f.store)
  updateReportSchedule(f.store, { ...oldSchedule, enabled: true, weeklyDay: 4, weeklyTime: '00:00', monthlyDay: 0, monthlyTime: '00:00' })
  const ids = runScheduledReports(f.store, new Date('2024-02-29T10:00:00Z'))
  assert.ok(ids.every(id => f.store.get<Report>('reports', id)!.type === 'weekly'))
})

test('monthly final Word and frozen summaries survive migration; mismatched type/version/period are rejected without replay', async t => {
  const f = await setup(t, '2024-12'), target = account(t)
  const crossYear = plan(f, { month: '2025-01', title: '跨年下月安排', dueDate: '2025-01-31' })
  f.store.insert<Publication>('publications', { month: crossYear.month, revision: 1, actorId: f.manager.id, reason: '发布下月计划', plans: [crossYear] })
  let report = getAgentReport(f.store, f.manager.id, f.enqueue().reportId!)
  report = editAgentReport(f.store, f.manager.id, report.id, { expectedVersion: report.version, title: report.title, blocks: report.agent!.blocks })
  report = await finalizeAgentReport(f.store, f.manager.id, report.id, { expectedVersion: report.version, reviewNote: '月报合成验收' })
  const before = await downloadAgentReport(f.store, f.manager.id, report.id)
  assert.match(await (await JSZip.loadAsync(before.bytes)).file('word/document.xml')!.async('string'), /2024-12-31/)
  assert.match(report.narrative, /跨年下月安排/)
  const packet = exportBusinessData(f.store, f.manager)
  for (const change of ['type', 'schema', 'period'] as const) {
    const corrupt = structuredClone(packet), row = corrupt.collections.reports[0]
    if (change === 'type') row.type = 'weekly'
    if (change === 'schema') row.agent!.schemaVersion = 'weekly-v1'
    if (change === 'period') row.period = '2024-12-02'
    assert.equal(previewRestore(target.store, target.manager, corrupt).canRestore, false)
  }
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  assert.deepEqual((await downloadAgentReport(target.store, target.manager.id, report.id)).bytes, before.bytes)
  assert.equal(target.store.get<Report>('reports', report.id)!.snapshot.effortSummary!.actualEffortDays, 0)
  assert.equal(target.store.list('reportAgentJobs').length, 0)
  assert.equal(target.store.get<ReportAgentSchedule>('settings', 'report-agent-monthly-schedule'), undefined)
})

test('monthly table output changes period labels while reusing original Word bytes and preserving weekly fingerprints', async t => {
  const f = account(t)
  const table = `<w:tbl><w:tblPr/><w:tblGrid>${Array.from({ length: 4 }, () => '<w:gridCol w:w="1600"/>').join('')}</w:tblGrid>${row(['工作主线 / 项目', '本周动作与可验证结果', '状态', '责任人'])}${row(['历史工作', '旧值', '旧状态', '旧人'])}</w:tbl>`
  const bytes = await fixture(p('周报') + table)
  const source = await uploadReportAsset(f.store, f.manager.id, { filename: '复用结构.docx', contentBase64: bytes.toString('base64'), purpose: 'template' })
  const weekly = createReportTemplate(f.store, f.manager.id, { name: '周版', sourceAssetId: source.id, effectiveWeek: '2024-02-05' }), oldHash = templateFingerprint(weekly)
  let monthly = createReportTemplate(f.store, f.manager.id, { type: 'monthly', name: '月版', sourceAssetId: source.id, effectiveWeek: '2024-02' })
  monthly = updateReportTemplate(f.store, f.manager.id, monthly.id, { expectedVersion: monthly.version, name: monthly.name, bindings: monthly.bindings, rules: monthly.rules, rulesConfirmed: true, effectiveWeek: monthly.effectiveWeek, exampleAssetIds: [] })
  monthly = await previewReportTemplate(f.store, f.manager.id, monthly.id, monthly.version)
  monthly = activateReportTemplate(f.store, f.manager.id, monthly.id, { expectedVersion: monthly.version, layoutVerified: true, layoutNote: '表头与排版已核对' })
  const job = enqueueReportAgent(f.store, f.manager.id, { requestId: 'table-monthly', templateId: monthly.id, period: '2024-02', useAi: false })
  const rendered = await downloadAgentReport(f.store, f.manager.id, job.reportId!)
  const xml = await (await JSZip.loadAsync(rendered.bytes)).file('word/document.xml')!.async('string')
  assert.match(xml, /本月动作与可验证结果/); assert.ok(!xml.includes('本周'))
  assert.equal(templateFingerprint(weekly), oldHash)
  assert.deepEqual(Buffer.from(f.store.get<{ contentBase64: string }>('reportAssets', source.id)!.contentBase64, 'base64'), bytes)
})


test('monthly reuse leaves unchanged complex fixed regions as keep and preserves their original XML', async t => {
  const f = account(t)
  const fixed = '<w:p><w:sdt><w:sdtContent><w:r><w:t>固定版式说明</w:t></w:r></w:sdtContent></w:sdt></w:p>'
  const bytes = await fixture(p('周报') + fixed)
  const asset = await uploadReportAsset(f.store, f.manager.id, { filename: '复杂固定区域.docx', contentBase64: bytes.toString('base64'), purpose: 'template' })
  assert.equal(asset.inspection!.regions.find(region => region.id === 'p:1')!.supported, false)
  const template = createReportTemplate(f.store, f.manager.id, { type: 'monthly', name: '保留固定结构月报', sourceAssetId: asset.id, effectiveWeek: '2024-02' })
  assert.equal(template.bindings.find(binding => binding.regionId === 'p:1')!.kind, 'keep')
  assert.equal(template.bindings.find(binding => binding.regionId === 'p:1')!.value, undefined)
  const preview = await previewReportTemplate(f.store, f.manager.id, template.id, template.version)
  const rendered = f.store.get<{ contentBase64: string }>('reportAssets', preview.previewAssetId!)!
  const xml = await (await JSZip.loadAsync(Buffer.from(rendered.contentBase64, 'base64'))).file('word/document.xml')!.async('string')
  assert.match(xml, /月报/); assert.ok(xml.includes(fixed))
  assert.deepEqual(Buffer.from(f.store.get<{ contentBase64: string }>('reportAssets', asset.id)!.contentBase64, 'base64'), bytes)
})

test('monthly support and problems come from each goal tasks and weekly records, for both the reported and the next month', async t => {
  const f = await setup(t), current = plan(f, { acceptanceStatus: 'accepted' }), next = plan(f, { month: '2024-03', title: '下月目标', dueDate: '2024-03-31', acceptanceCriteria: '上线验收' })
  const task = (monthlyPlanId: string, overrides: Partial<Task>) => f.store.insert<Task>('tasks', { title: '任务', monthlyPlanId, ownerId: f.manager.id, description: '', dueDate: '', status: 'doing', isTemporary: false, temporaryReason: '', ...overrides })
  const work = task(current.id, { title: '数据接入' })
  f.store.insert<WeeklyRecord>('weeklyRecords', { taskId: work.id, monthlyPlanId: current.id, ownerId: f.manager.id, weekStart: '2024-02-05', commitment: '接入', actualOutcome: '', evidenceUrl: '', blocker: '接口未开放', nextAction: '', status: 'blocked', submitted: true, supportNeeded: '需要信息中心开放接口' })
  f.store.insert<WeeklyRecord>('weeklyRecords', { taskId: work.id, monthlyPlanId: current.id, ownerId: f.manager.id, weekStart: '2024-02-12', commitment: '接入', actualOutcome: '完成', evidenceUrl: '', blocker: '', nextAction: '', status: 'done', submitted: true, supportNeeded: '无' })
  task(next.id, { title: '算力准备', status: 'blocked', blockerReason: '算力不足', supportNeeded: '申请两台服务器' })
  task(next.id, { title: '已撤回', status: 'blocked', supportNeeded: '不应出现', cancellation: { cancelledAt: '2024-02-20T00:00:00Z', cancelledBy: f.manager.id, reason: '撤回' } })
  const snapshot = buildReportSnapshot(f.store, 'monthly', '2024-02'), facts = buildReportFacts(snapshot, '2024-02')
  const value = (id: string, field: string) => facts.find(fact => fact.id === `plan:${id}:${field}`)!.value
  assert.equal(value(current.id, 'support'), '数据接入（2024-02-05 周）：需要信息中心开放接口')
  assert.equal(value(current.id, 'blocker'), '数据接入（2024-02-05 周）：接口未开放')
  assert.equal(value(next.id, 'support'), '算力准备：申请两台服务器')
  assert.equal(value(next.id, 'criteria'), '上线验收'); assert.equal(value(next.id, 'due'), '2024-03-31')
  const columns = [{ label: '目标', field: 'title' as const, required: true }, { label: '所需支撑', field: 'support' as const, required: true }]
  const risk = buildRuleBlocks([{ regionId: 't:0', label: '支撑', kind: 'dataset', required: true, dataset: 'risks', startRow: 1, endRow: 2, columns }], snapshot, facts, '2024-02', new Date().toISOString(), '月报')[0]
  assert.deepEqual(risk.rows.map(row => row[1].text), ['数据接入（2024-02-05 周）：需要信息中心开放接口', '算力准备：申请两台服务器'])
  const plain = plan(f, { title: '无支持目标' }), outcome = buildRuleBlocks([{ regionId: 't:0', label: '完成', kind: 'dataset', required: true, dataset: 'outcomes', startRow: 1, endRow: 2, columns }], buildReportSnapshot(f.store, 'monthly', '2024-02'), buildReportFacts(buildReportSnapshot(f.store, 'monthly', '2024-02'), '2024-02'), '2024-02', new Date().toISOString(), '月报')[0]
  // An empty source field is stated, not left as a blocking placeholder.
  assert.equal(outcome.rows.find(row => row[0].text === plain.title)![1].text, '未提出')
})

test('monthly company templates map completion, plan and support tables to system data without manual mapping', async t => {
  const f = account(t)
  const grid = (header: string[]) => `<w:tbl><w:tblPr/><w:tblGrid>${header.map(() => '<w:gridCol w:w="1600"/>').join('')}</w:tblGrid>${row(header)}${row(header.map(() => '示例'))}</w:tbl>`
  const headers = [['序号', '上月计划目标', '完成情况', '负责人'], ['序号', '月度目标', '完成情况', '完成率', '负责人'], ['序号', '本月工作计划', '预期成果', '所需支撑', '完成时限', '负责人'], ['序号', '需协调支持事项', '责任人', '备注']]
  const bytes = await fixture(p('月报') + headers.map(grid).join(p('')))
  const asset = await uploadReportAsset(f.store, f.manager.id, { filename: '公司月报.docx', contentBase64: bytes.toString('base64'), purpose: 'template' })
  const template = createReportTemplate(f.store, f.manager.id, { type: 'monthly', name: '公司月报', sourceAssetId: asset.id, effectiveWeek: '2024-01' })
  const tables = template.bindings.filter(binding => binding.kind === 'dataset')
  assert.deepEqual(tables.map(binding => binding.dataset), ['outcomes', 'outcomes', 'next_month', 'risks'])
  assert.deepEqual(tables.map(binding => binding.columns!.map(column => column.field)), [
    ['manual', 'title', 'outcome', 'owner'], ['manual', 'title', 'outcome', 'status', 'owner'],
    ['manual', 'title', 'commitment', 'support', 'due', 'owner'], ['manual', 'support', 'owner', 'manual'],
  ])
  // Columns without a system source are optional; the template alone is enough to finalize.
  assert.equal(tables[3].columns![3].required, false)
})
