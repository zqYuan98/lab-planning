import test from 'node:test'
import assert from 'node:assert/strict'
import type { Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { ReportFact } from '../shared/report-agent.ts'
import { Store } from '../server/store.ts'
import { activateReportTemplate, createReportTemplate, editAgentReport, enqueueReportAgent, finalizeAgentReport, getAgentReport, previewReportTemplate, suggestReportBindings, updateReportTemplate, uploadReportAsset } from '../server/report-agent-service.ts'
import { getReportAgentJob, retryReportAgentJob, runReportAgentWorker } from '../server/report-agent-jobs.ts'
import { validateFactText } from '../server/report-agent-evidence.ts'
import { inspectDocx } from '../server/report-docx.ts'
import { fixture, p, row } from './report-docx-fixtures.ts'

function table(rows: string[][]) {
  return `<w:tbl><w:tblPr/><w:tblGrid>${rows[0].map(() => '<w:gridCol w:w="1600"/>').join('')}</w:tblGrid>${rows.map(row).join('')}</w:tbl>`
}
async function twoSubjectDraft(manual = false) {
  const store = new Store(':memory:')
  const actor = store.insert<User>('users', { name: '核查管理者', email: 'evidence-review@example.test', role: 'manager', position: '', active: true })
  const tasks = ['项目甲', '项目乙'].map(title => store.insert<Task>('tasks', { title, monthlyPlanId: null, ownerId: actor.id, description: '', dueDate: '', status: 'doing', isTemporary: true, temporaryReason: '事实归属测试' }))
  const records = tasks.map((task, index) => store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, monthlyPlanId: null, ownerId: actor.id, weekStart: '2026-09-07', commitment: '按计划验证', actualOutcome: `完成 ${index ? 320 : 620} 人试点`, evidenceUrl: '', blocker: '', nextAction: '', status: 'done', submitted: true }))
  const dataRows = manual ? [['工作主线 / 项目', '本周动作与可验证结果', '方案 A 及代价', '责任人'], ['旧项目', '旧成果', '旧方案', '旧负责人']] : [['工作主线 / 项目', '本周动作与可验证结果', '责任人'], ['旧项目', '旧成果', '旧负责人']]
  const bytes = await fixture(p('周报') + table(dataRows) + (manual ? table([['核心指标', '月累计', '完成率'], ['公司指标', '旧指标', '旧比率']]) : ''))
  const asset = await uploadReportAsset(store, actor.id, { filename: '事实校验模板.docx', contentBase64: bytes.toString('base64'), purpose: 'template' })
  let template = createReportTemplate(store, actor.id, { name: '事实校验', sourceAssetId: asset.id, effectiveWeek: '2026-09-07' })
  template = updateReportTemplate(store, actor.id, template.id, { expectedVersion: template.version, name: template.name, bindings: template.bindings, rules: ['忠于冻结依据'], rulesConfirmed: true, exampleAssetIds: [], effectiveWeek: template.effectiveWeek })
  template = await previewReportTemplate(store, actor.id, template.id, template.version)
  template = activateReportTemplate(store, actor.id, template.id, { expectedVersion: template.version, layoutVerified: true, layoutNote: '合成模板已核对' })
  const job = enqueueReportAgent(store, actor.id, { requestId: 'independent-evidence-regression', templateId: template.id, period: '2026-09-07', useAi: true })
  return { store, actor, records, tasks, job, report: () => getAgentReport(store, actor.id, job.reportId!) }
}
type ModelInput = { text: string; facts: ReportFact[] }

test('worker rejects another known project borrowing the cited project headcount and preserves both rows', async () => {
  const f = await twoSubjectDraft()
  try {
    let rejectedAttempts = 0
    await runReportAgentWorker(f.store, { callModel: async (_store, messages) => {
      const input = JSON.parse(messages[1].content as string) as ModelInput
      const isA = input.facts[0].sourceId === f.records[0].id
      if (isA) rejectedAttempts++
      return { text: isA ? '项目乙完成 620 人试点' : '项目乙完成 320 人试点', factIds: input.facts.map(fact => fact.id) }
    } })
    assert.equal(rejectedAttempts, 2, 'the rejected cell retries once only')
    const report = f.report(), outcomes = report.agent!.blocks.find(block => block.kind === 'table')!
    assert.equal(outcomes.rows[0][1].text, '完成 620 人试点')
    assert.equal(outcomes.rows[1][1].text, '项目乙完成 320 人试点')
    assert.ok(report.agent!.issues.some(issue => issue.code === 'writing_fallback' && issue.message.includes('主体')))
    assert.equal(getReportAgentJob(f.store, f.actor.id, f.job.id).status, 'needs_input')
    assert.equal(report.agent!.modelCandidates.filter(candidate => !candidate.accepted).length, 2)
  } finally { f.store.close() }
})

test('worker rejects unchanged digits when headcount becomes money', async () => {
  const f = await twoSubjectDraft()
  try {
    await runReportAgentWorker(f.store, { callModel: async (_store, messages) => {
      const input = JSON.parse(messages[1].content as string) as ModelInput
      return { text: input.facts[0].sourceId === f.records[0].id ? '完成 620 万元收入' : input.text, factIds: input.facts.map(fact => fact.id) }
    } })
    assert.ok(!f.report().narrative.includes('万元'))
    assert.equal(f.report().agent!.blocks[0].rows[0][1].text, '完成 620 人试点')
    assert.ok(f.report().agent!.issues.some(issue => issue.code === 'writing_fallback' && issue.message.includes('单位')))
  } finally { f.store.close() }
})

test('a frozen reporting year never authorizes a newly invented quantity', async () => {
  const f = await twoSubjectDraft()
  try {
    const report = f.report(), outcome = report.agent!.facts.find(fact => fact.id === `weekly:${f.records[0].id}:outcome`)!
    assert.ok(outcome.period.includes('2026'))
    assert.ok(validateFactText('完成 2026 项工作', [outcome.id], report.agent!.facts).some(issue => issue.code === 'unsupported_number'))
    await runReportAgentWorker(f.store, { callModel: async (_store, messages) => {
      const input = JSON.parse(messages[1].content as string) as ModelInput
      return { text: '完成 2026 项工作', factIds: input.facts.map(fact => fact.id) }
    } })
    assert.ok(!f.report().agent!.blocks[0].rows.flat().some(cell => cell.text.includes('2026 项')))
    assert.ok(f.report().agent!.modelCandidates.every(candidate => !candidate.accepted))
  } finally { f.store.close() }
})

test('same project across two frozen weeks cannot pool references to assert a combined quantity', async () => {
  const f = await twoSubjectDraft()
  try {
    const report = f.report(), first = report.agent!.facts.find(fact => fact.id === `weekly:${f.records[0].id}:outcome`)!
    const next: ReportFact = { ...first, id: 'weekly:following-week:outcome', sourceId: 'following-week', sourceVersion: 2, period: '2026-09-14', value: '完成 320 人试点' }
    const facts = [...report.agent!.facts, next]
    // Both digits are individually valid somewhere. Attribution still fails.
    assert.ok(validateFactText('两周累计完成 620 人试点', [first.id, next.id], facts).some(issue => issue.code === 'ambiguous_record'))
    const summed = validateFactText('两周累计完成 940 人试点', [first.id, next.id], facts)
    assert.ok(summed.some(issue => issue.code === 'ambiguous_record'))
    assert.ok(summed.some(issue => issue.code === 'unsupported_number'))
    assert.deepEqual(validateFactText('本周完成 620 人试点', [first.id], facts), [])
  } finally { f.store.close() }
})

test('server rejects downgrading fixed company metrics and manual proposal columns to system fact cells', async () => {
  const f = await twoSubjectDraft(true)
  try {
    const report = f.report(), firstFact = `weekly:${f.records[0].id}:outcome`
    const attempts = [
      (blocks: NonNullable<Report['agent']>['blocks']) => {
        const metric = blocks.find(block => block.kind === 'text' && block.content.manual)!
        assert.ok(metric, 'fixture has a required fixed-table manual company metric')
        metric.content = { text: '620 人', factIds: [firstFact], manual: false, confirmed: true, source: '' }
      },
      (blocks: NonNullable<Report['agent']>['blocks']) => {
        const table = blocks.find(block => block.kind === 'table')!, column = table.columns.findIndex(column => column.field === 'manual')
        assert.ok(column >= 0, 'fixture has a manual proposal/cost column')
        table.rows[0][column] = { text: '620 人', factIds: [firstFact], manual: false, confirmed: true, source: '' }
      },
    ]
    for (const mutate of attempts) {
      const blocks = structuredClone(report.agent!.blocks); mutate(blocks)
      assert.throws(() => editAgentReport(f.store, f.actor.id, report.id, { expectedVersion: report.version, title: report.title, blocks }), { status: 400 })
      assert.equal(f.report().version, report.version)
    }
  } finally { f.store.close() }
})

test('legitimate wording changes keep quantity, subject, source version and accepted candidate', async () => {
  const f = await twoSubjectDraft()
  try {
    await runReportAgentWorker(f.store, { callModel: async (_store, messages) => {
      const input = JSON.parse(messages[1].content as string) as ModelInput, fact = input.facts[0]
      const amount = fact.sourceId === f.records[0].id ? '620' : '320'
      return { text: `${fact.subject}试点已完成，覆盖 ${amount} 人。`, factIds: [fact.id] }
    } })
    const report = f.report()
    assert.equal(getReportAgentJob(f.store, f.actor.id, f.job.id).status, 'ready')
    assert.equal(report.agent!.modelCandidates.length, 2)
    assert.ok(report.agent!.modelCandidates.every(candidate => candidate.accepted))
    assert.deepEqual(report.agent!.issues, [])
    assert.match(report.narrative, /项目甲试点已完成，覆盖 620 人/)
    assert.match(report.narrative, /项目乙试点已完成，覆盖 320 人/)
    assert.equal(report.agent!.facts.find(fact => fact.id === `weekly:${f.records[0].id}:outcome`)!.sourceVersion, f.records[0].version)
  } finally { f.store.close() }
})

test('a no-data prefix does not exempt invented unreferenced claims from draft validation or finalization', async () => {
  const f = await twoSubjectDraft()
  try {
    const report = f.report(), blocks = structuredClone(report.agent!.blocks)
    blocks[0].rows[0][1] = { text: '暂无历史数据；项目乙完成999万元收入并通过验收', factIds: [], manual: false, confirmed: false, source: '' }
    const edited = editAgentReport(f.store, f.actor.id, report.id, { expectedVersion: report.version, title: report.title, blocks })
    assert.ok(edited.agent!.issues.some(issue => issue.severity === 'error' && issue.code === 'missing_reference'))
    await assert.rejects(finalizeAgentReport(f.store, f.actor.id, report.id, { expectedVersion: edited.version, reviewNote: '尝试绕过事实检查' }), { status: 409 })
    assert.equal(f.report().status, 'draft')
    assert.equal(f.report().agent!.finalAssetId, null)
  } finally { f.store.close() }
})

test('retry after a concurrent fact-cited user edit keeps that edited region and does not invoke the model again', async () => {
  const f = await twoSubjectDraft()
  try {
    const before = f.report(), editedText = '项目甲试点覆盖 620 人。'
    let calls = 0
    await runReportAgentWorker(f.store, { callModel: async (_store, messages) => {
      calls++
      const input = JSON.parse(messages[1].content as string) as ModelInput, report = f.report(), blocks = structuredClone(report.agent!.blocks)
      blocks[0].rows[0][1].text = editedText
      assert.equal(blocks[0].rows[0][1].manual, false)
      assert.ok(blocks[0].rows[0][1].factIds.length > 0)
      editAgentReport(f.store, f.actor.id, report.id, { expectedVersion: report.version, title: report.title, blocks })
      return { text: '试点已完成，覆盖 620 人。', factIds: input.facts.map(fact => fact.id) }
    } })
    assert.equal(calls, 1)
    const interrupted = getReportAgentJob(f.store, f.actor.id, f.job.id), edited = f.report()
    assert.equal(interrupted.status, 'needs_input')
    assert.equal(interrupted.expectedReportVersion, before.version, 'editing must not advance the worker CAS behind its back')
    assert.ok(interrupted.completedBlockIds.includes(edited.agent!.blocks[0].id))
    assert.equal(edited.version, before.version + 1)
    assert.equal(edited.agent!.blocks[0].rows[0][1].text, editedText)
    retryReportAgentJob(f.store, f.actor.id, interrupted.id, interrupted.version)
    await runReportAgentWorker(f.store, { callModel: async () => { calls++; throw new Error('edited region must be skipped') } })
    assert.equal(calls, 1, 'retry must not rewrite a fact-cited human edit')
    assert.equal(f.report().agent!.blocks[0].rows[0][1].text, editedText)
    assert.equal(f.report().version, edited.version)
    assert.equal(getReportAgentJob(f.store, f.actor.id, f.job.id).status, 'ready')
  } finally { f.store.close() }
})

test('failed AI fallback stays retryable and a later valid model result clears the fallback warning', async () => {
  const f = await twoSubjectDraft()
  try {
    let badCalls = 0
    await runReportAgentWorker(f.store, { callModel: async (_store, messages) => {
      badCalls++
      const input = JSON.parse(messages[1].content as string) as ModelInput
      return { text: '完成999万元收入', factIds: input.facts.map(fact => fact.id) }
    } })
    const failed = getReportAgentJob(f.store, f.actor.id, f.job.id), fallback = f.report()
    assert.equal(badCalls, 4)
    assert.equal(failed.status, 'needs_input')
    assert.ok(fallback.agent!.issues.some(issue => issue.code === 'writing_fallback'))
    assert.ok(!failed.completedBlockIds.includes(fallback.agent!.blocks[0].id))
    retryReportAgentJob(f.store, f.actor.id, failed.id, failed.version)
    let goodCalls = 0
    await runReportAgentWorker(f.store, { callModel: async (_store, messages) => {
      goodCalls++
      const input = JSON.parse(messages[1].content as string) as ModelInput, fact = input.facts[0]
      return { text: `${fact.subject}：${input.text}。`, factIds: input.facts.map(fact => fact.id) }
    } })
    assert.equal(goodCalls, 2, 'retry must actually call the repaired model for both cells')
    const completed = getReportAgentJob(f.store, f.actor.id, f.job.id)
    assert.equal(completed.status, 'ready')
    assert.ok(completed.completedBlockIds.includes(fallback.agent!.blocks[0].id))
    assert.ok(!f.report().agent!.issues.some(issue => issue.code === 'writing_fallback'))
    assert.match(f.report().agent!.blocks[0].rows[0][1].text, /^项目甲：/)
  } finally { f.store.close() }
})

test('company metadata keeps the report-date heading and composite action-owner columns require manual mapping', async () => {
  const metadata = table([['汇报周期', '2026.8.17-2026.8.21', '汇报人', '历史汇报人'], ['部门', '人工智能实验室', '汇报日期', '2026.8.21']])
  const risk = table([['序号', '异常事项与影响', '主要原因', '当前措施 / 责任人', '预计恢复时间'], ['1', '历史异常', '历史原因', '历史措施及负责人', '历史日期']])
  const bindings = suggestReportBindings(await inspectDocx(await fixture(p('合成六表等价局部') + metadata + risk)))
  assert.equal(bindings.find(binding => binding.regionId === 't:0:r:1:c:2')!.kind, 'keep')
  const dateValue = bindings.find(binding => binding.regionId === 't:0:r:1:c:3')!
  assert.equal(dateValue.kind, 'meta'); assert.equal(dateValue.meta, 'captured_at')
  assert.equal(bindings.find(binding => binding.regionId === 't:0:r:0:c:1')!.meta, 'week_range')
  assert.equal(bindings.find(binding => binding.regionId === 't:0:r:0:c:3')!.meta, 'author')
  const riskBinding = bindings.find(binding => binding.regionId === 't:1')!
  assert.equal(riskBinding.kind, 'dataset')
  assert.equal(riskBinding.columns![3].field, 'manual')
})
