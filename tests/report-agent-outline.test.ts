import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import type { MonthlyPlan, Task, WeeklyRecord } from '../shared/types.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { adoptReportTemplate, aiOutlineReportTemplate, createReportTemplate, downloadAgentReport, editAgentReport, enqueueReportAgent, finalizeAgentReport, getAgentReport, previewReportTemplate, updateReportTemplate, uploadReportAsset } from '../server/report-agent-service.ts'
import { runReportAgentWorker } from '../server/report-agent-jobs.ts'
import { heuristicOutline, metaTemplate } from '../server/report-agent-outline.ts'
import { inspectDocx } from '../server/report-docx.ts'
import { fixture, p } from './report-docx-fixtures.ts'

// Same shape as a company outline template: blanks, a global requirement, headed sections with
// requirement/suggestion paragraphs, and a meeting-rules appendix.
const bold = (text: string) => p(text)
const outlineBody = [
  p('______部门 月度经营汇报'), p('会议时间：每月第二周周一　｜　报告人：______　填报日期：______'), bold('总体要求： 只讲结论、偏差和根因。'),
  p('一、本月完成情况（对照月度目标回顾）'), bold('填写要求： 对照月度目标逐项回顾完成情况。'), p('职能/研发团队： 按各自月度目标回顾。'), p('建议：先一句话给总体判断。'),
  p('二、未达标 / 未完成的根因'), bold('填写要求： 按“现象 → 直接原因 → 根本原因”逐层往下挖。'),
  p('三、补救措施'), bold('填写要求： 写清责任人、完成时间节点，以及怎么算完成。'),
  p('四、下月计划'), bold('填写要求： 列出 3–5 项优先事项。'),
  p('五、需公司或跨部门支持'), bold('填写要求： 写明需要的资源；确无则写“无”。'),
  p('附：会议纪律（主持人当场纠正）'), p('发言： 只说结论和要求。'),
].join('')

async function setup(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const manager = new Domain(store).setup({ name: '袁经理', email: 'outline@example.test', password: 'Fixture-password-2026!' })
  const asset = await uploadReportAsset(store, manager.id, { filename: '月度经营汇报.docx', contentBase64: (await fixture(outlineBody)).toString('base64'), purpose: 'template' })
  const plan = (overrides: Partial<MonthlyPlan>) => store.insert<MonthlyPlan>('plans', { month: '2026-09', title: '目标', projectId: null, category: '研发', ownerId: manager.id, collaboratorIds: [], expectedOutcome: '交付', acceptanceCriteria: '通过评审', dueDate: '2026-09-30', priority: 'medium', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', ...overrides })
  return { store, manager, asset, plan }
}
async function adopted(f: Awaited<ReturnType<typeof setup>>) {
  let row = createReportTemplate(f.store, f.manager.id, { type: 'monthly', name: '月度经营汇报', sourceAssetId: f.asset.id, effectiveWeek: '2000-01' })
  row = updateReportTemplate(f.store, f.manager.id, row.id, { expectedVersion: row.version, name: row.name, bindings: row.bindings, rules: row.rules, rulesConfirmed: true, exampleAssetIds: [], effectiveWeek: row.effectiveWeek })
  row = await previewReportTemplate(f.store, f.manager.id, row.id, row.version, '2026-09')
  return adoptReportTemplate(f.store, f.manager.id, row.id, { expectedVersion: row.version, layoutVerified: true, layoutNote: '已查看试填' })
}
async function paragraphs(bytes: Buffer) {
  const xml = await (await JSZip.loadAsync(bytes)).file('word/document.xml')!.async('string')
  return [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(match => ({ bold: /<w:b\/>|<w:b /.test(match[0]), text: [...match[0].matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map(item => item[1]).join('') }))
}

test('outline templates turn headings and requirements into generated sections, blanks into tokens and drop the appendix', async t => {
  const f = await setup(t)
  assert.equal(metaTemplate('报告人：______　填报日期：______'), '报告人：{{author}}　填报日期：{{date}}')
  assert.equal(metaTemplate('无空白的标题'), null)
  assert.equal(heuristicOutline((await inspectDocx(await fixture(p('周报') + p('本周成果')))).regions), null)
  const row = createReportTemplate(f.store, f.manager.id, { type: 'monthly', name: '月度经营汇报', sourceAssetId: f.asset.id, effectiveWeek: '2000-01' })
  const kinds = row.bindings.map(binding => binding.kind === 'narrative' ? `narrative:${binding.narrative}` : binding.kind === 'meta' ? `meta:${binding.value}` : binding.kind)
  assert.deepEqual(kinds, ['meta:{{department}} 月度经营汇报', 'meta:会议时间：每月第二周周一　｜　报告人：{{author}}　填报日期：{{date}}', 'remove',
    'keep', 'narrative:review', 'remove', 'remove', 'keep', 'narrative:causes', 'keep', 'narrative:remedies', 'keep', 'narrative:plan', 'keep', 'narrative:support', 'remove', 'remove'])
  const review = row.bindings.find(binding => binding.narrative === 'review')!
  assert.equal(review.label, '一、本月完成情况（对照月度目标回顾）')
  assert.match(review.instruction!, /对照月度目标逐项回顾/); assert.match(review.instruction!, /先一句话给总体判断/)
  assert.ok(row.rules.some(rule => rule.includes('只讲结论、偏差和根因')))
})

test('a monthly outline report is written from system data, keeps gaps visible and renders plain paragraphs in the original document', async t => {
  const f = await setup(t)
  const done = f.plan({ title: '机具OCR模型迭代', actualOutcome: '识别准确率提升至 96%\r\n线上误报率下降至 1%', acceptanceStatus: 'accepted' })
  const missed = f.plan({ title: '输电线路变焦摄像头', acceptanceStatus: 'not_completed', acceptanceNote: '设备到货延迟\n现场条件不足' })
  f.plan({ month: '2026-10', title: '输电线路变焦摄像头', sourcePlanId: missed.id, expectedOutcome: '完成安装调试', acceptanceCriteria: '现场联调报告通过', dueDate: '2026-10-25', priority: 'high' })
  const edge = f.plan({ month: '2026-10', title: '边缘代理多端功能优化', expectedOutcome: '完成三端适配', dueDate: '2026-10-31', priority: 'low' })
  const task = f.store.insert<Task>('tasks', { title: '多端适配', monthlyPlanId: edge.id, ownerId: f.manager.id, description: '', dueDate: '', status: 'blocked', isTemporary: false, temporaryReason: '', blockerReason: '缺少测试终端', supportNeeded: '申请 3 台测试终端' })
  const ocrTask = f.store.insert<Task>('tasks', { title: '数据清洗', monthlyPlanId: done.id, ownerId: f.manager.id, description: '', dueDate: '', status: 'done', isTemporary: false, temporaryReason: '' })
  // A blocker recorded mid-month on a goal that was then accepted is not a shortfall.
  f.store.insert<WeeklyRecord>('weeklyRecords', { taskId: ocrTask.id, monthlyPlanId: done.id, ownerId: f.manager.id, weekStart: '2026-09-07', commitment: '清洗', actualOutcome: '完成', evidenceUrl: '', blocker: '标注人手不足', nextAction: '', status: 'blocked', submitted: true })
  const row = await adopted(f)
  let report = getAgentReport(f.store, f.manager.id, enqueueReportAgent(f.store, f.manager.id, { requestId: 'outline', templateId: row.id, period: '2026-09', useAi: false }).reportId!)
  const text = (narrative: string) => report.agent!.blocks.find(block => block.regionId === row.bindings.find(binding => binding.narrative === narrative)!.regionId)!.content.text
  assert.match(text('review'), /^本月目标共 2 项：确认完成 1 项，确认未完成 1 项。/)
  assert.match(text('review'), /机具OCR模型迭代：确认完成。实际结果：识别准确率提升至 96% 线上误报率下降至 1%/)
  assert.equal(text('causes'), '输电线路变焦摄像头：现象：目标确认未完成；直接原因：设备到货延迟 现场条件不足；根本原因：【待补充】。')
  assert.equal(text('remedies'), '输电线路变焦摄像头：措施：【待补充】；责任人：袁经理；完成时间：2026-10-25；完成标准：现场联调报告通过。')
  assert.deepEqual(text('plan').split('\n').map(line => line.split('：')[0]), ['输电线路变焦摄像头', '边缘代理多端功能优化'])
  assert.equal(text('support'), `边缘代理多端功能优化：${task.title}：申请 3 台测试终端`)
  for (const block of report.agent!.blocks.filter(block => block.content.lineFactIds)) assert.equal(block.content.lineFactIds!.length, block.content.text.split('\n').length)
  const review = report.agent!.blocks.find(block => block.regionId === row.bindings.find(binding => binding.narrative === 'review')!.regionId)!.content
  assert.equal(review.text.split('\n').length, 3); assert.equal(review.lineFactIds?.length, 3)
  assert.deepEqual(report.agent!.issues.map(issue => issue.code), ['pending_content', 'pending_content'])
  await assert.rejects(finalizeAgentReport(f.store, f.manager.id, report.id, { expectedVersion: report.version, reviewNote: '核对' }), { status: 409 })

  const word = await paragraphs((await downloadAgentReport(f.store, f.manager.id, report.id)).bytes)
  const lines = word.map(item => item.text)
  assert.equal(lines[0], '人工智能实验室 月度经营汇报'); assert.match(lines[1], /报告人：袁经理　填报日期：\d{4}\/\d{1,2}\/\d{1,2}/)
  assert.ok(!lines.some(line => /填写要求|建议：|总体要求|会议纪律|发言：/.test(line)))
  assert.ok(lines.indexOf('二、未达标 / 未完成的根因') > lines.findIndex(line => line.startsWith('机具OCR模型迭代：确认完成')))
  assert.ok(word.filter(item => item.text.startsWith('输电线路变焦摄像头：')).every(item => !item.bold))

  const blocks = report.agent!.blocks.map(block => block.regionId === row.bindings.find(binding => binding.narrative === 'causes')!.regionId || block.regionId === row.bindings.find(binding => binding.narrative === 'remedies')!.regionId
    ? { ...block, content: { text: block.content.text.replaceAll('【待补充】', '供应商备货未锁定'), factIds: [], manual: true, confirmed: true, source: '管理者修改' } } : block)
  report = editAgentReport(f.store, f.manager.id, report.id, { expectedVersion: report.version, title: report.title, blocks })
  assert.equal(report.agent!.issues.filter(issue => issue.severity === 'error').length, 0)
  report = await finalizeAgentReport(f.store, f.manager.id, report.id, { expectedVersion: report.version, reviewNote: '核对' })
  assert.equal(report.status, 'finalized')
})

test('root cause and remedy recorded at acceptance flow into the report; AI rewrites may not fill a gap', async t => {
  const f = await setup(t)
  const domain = new Domain(f.store)
  const missed = f.plan({ title: '输电线路变焦摄像头' })
  const saved = domain.planResult(f.manager, missed.id, { version: missed.version, actualOutcome: '', acceptanceStatus: 'not_completed', acceptanceNote: '设备到货延迟', rootCause: '采购未提前锁定供应商', remedy: '10月20日前完成安装调试' })
  assert.equal(saved.rootCause, '采购未提前锁定供应商')
  const accepted = f.plan({ title: '其他目标', rootCause: '历史分析' })
  assert.equal(domain.planResult(f.manager, accepted.id, { version: accepted.version, actualOutcome: '已交付', acceptanceStatus: 'accepted', acceptanceNote: '', rootCause: '不应写入' }).rootCause, '历史分析')
  const row = await adopted(f)
  const job = enqueueReportAgent(f.store, f.manager.id, { requestId: 'ai-outline', templateId: row.id, period: '2026-09', useAi: true })
  const causes = () => getAgentReport(f.store, f.manager.id, job.reportId!).agent!.blocks.find(block => block.regionId === row.bindings.find(binding => binding.narrative === 'causes')!.regionId)!.content
  assert.match(causes().text, /根本原因：采购未提前锁定供应商/)
  const requirements: unknown[] = []
  await runReportAgentWorker(f.store, { callModel: async (_store, messages) => {
    const input = JSON.parse(messages[1].content as string) as { text: string; factIds?: string[]; requirement?: string }
    requirements.push(input.requirement)
    // Model tries to replace the 【待补充】 in the next-month plan line with an invented action.
    return { text: input.text.replace('【待补充】', '加强推进'), factIds: (JSON.parse(messages[1].content as string) as { facts: Array<{ id: string }> }).facts.map(fact => fact.id) }
  } })
  assert.ok(requirements.some(value => typeof value === 'string' && /现象 → 直接原因 → 根本原因/.test(value)))
  const report = getAgentReport(f.store, f.manager.id, job.reportId!)
  assert.ok(!JSON.stringify(report.agent!.blocks).includes('加强推进'))
  await assert.rejects(aiOutlineReportTemplate(f.store, f.manager.id, createReportTemplate(f.store, f.manager.id, { type: 'monthly', name: '再识别', sourceAssetId: f.asset.id, effectiveWeek: '2000-01' }).id, 1), { status: 503 })
})
