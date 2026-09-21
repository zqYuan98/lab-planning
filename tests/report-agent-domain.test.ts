import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import JSZip from 'jszip'
import type { Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { ReportAgentJob, ReportAgentSchedule, ReportTemplate } from '../shared/report-agent.ts'
import { Store } from '../server/store.ts'
import { activateReportTemplate, createReportTemplate, downloadAgentReport, editAgentReport, enqueueReportAgent, enqueueReportRewrite, enqueueTemplateLearning, finalizeAgentReport, getAgentReport, getReportAgentBootstrap, previewReportTemplate, updateReportTemplate, uploadReportAsset, validateTemplateBindings } from '../server/report-agent-service.ts'
import { cancelReportAgentJob, getReportAgentJob, retryReportAgentJob, runReportAgentWorker } from '../server/report-agent-jobs.ts'
import { buildReportFacts, reportAgentHash, validateFactText } from '../server/report-agent-evidence.ts'
import { getReportAgentSchedule, reportAgentMissedPeriods, runReportAgentSchedule, updateReportAgentSchedule } from '../server/report-agent-schedule.ts'
import { fixture, p, row } from './report-docx-fixtures.ts'

function table(rows: string[][]) { return `<w:tbl><w:tblPr/><w:tblGrid>${rows[0].map(() => '<w:gridCol w:w="1600"/>').join('')}</w:tblGrid>${rows.map(row).join('')}</w:tbl>` }
async function setup(store = new Store(':memory:'), manual = false) {
  const actor = store.insert<User>('users', { name: '管理者', email: 'agent@example.test', role: 'manager', position: '', active: true })
  const member = store.insert<User>('users', { name: '成员', email: 'member@example.test', role: 'member', position: '', active: true })
  const task = store.insert<Task>('tasks', { title: '项目甲', monthlyPlanId: null, ownerId: member.id, description: '', dueDate: '', status: 'doing', isTemporary: true, temporaryReason: '专项验证' })
  const record = store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, monthlyPlanId: null, ownerId: member.id, weekStart: '2026-09-07', commitment: '验证能力', actualOutcome: '完成 620 人试点', evidenceUrl: 'https://evidence.test/620', blocker: '', nextAction: '继续验证', status: 'done', submitted: true })
  const bytes = await fixture(p('周报 TOP3') + table([['工作主线 / 项目', '本周动作与可验证结果', '状态', '责任人'], ['历史项目', '历史成果 999', '历史状态', '历史负责人']]) + (manual ? table([['核心指标', '月度目标', '本周实际'], ['指标甲', '999', '888']]) : ''))
  const asset = await uploadReportAsset(store, actor.id, { filename: 'template.docx', contentBase64: bytes.toString('base64'), purpose: 'template' })
  let template = createReportTemplate(store, actor.id, { name: '合成周报', sourceAssetId: asset.id, effectiveWeek: '2026-01-05', requestId: 'create-template' })
  template = updateReportTemplate(store, actor.id, template.id, { expectedVersion: template.version, name: template.name, bindings: template.bindings, rules: template.rules, rulesConfirmed: true, exampleAssetIds: [], effectiveWeek: template.effectiveWeek })
  template = await previewReportTemplate(store, actor.id, template.id, template.version)
  template = activateReportTemplate(store, actor.id, template.id, { expectedVersion: template.version, layoutVerified: true, layoutNote: '在测试 Word 环境核对' })
  const enqueue = (requestId = 'generate', useAi = false) => enqueueReportAgent(store, actor.id, { requestId, templateId: template.id, period: '2026-09-07', useAi })
  return { store, actor, member, task, record, bytes, asset, template, enqueue }
}

test('uploads are authorized, bounded, deduplicated and listings never expose bytes', async () => {
  const f = await setup()
  try {
    await assert.rejects(uploadReportAsset(f.store, f.member.id, { filename: 'x.docx', contentBase64: f.bytes.toString('base64'), purpose: 'template' }), { status: 403 })
    await assert.rejects(uploadReportAsset(f.store, f.actor.id, { filename: '../x.docx', contentBase64: f.bytes.toString('base64'), purpose: 'template' }), { status: 400 })
    const repeat = await uploadReportAsset(f.store, f.actor.id, { filename: 'again.docx', contentBase64: f.bytes.toString('base64'), purpose: 'template' })
    assert.equal(repeat.id, f.asset.id)
    assert.ok(!('contentBase64' in getReportAgentBootstrap(f.store, f.actor.id).assets[0]))
    assert.throws(() => getReportAgentBootstrap(f.store, f.member.id), { status: 403 })
  } finally { f.store.close() }
})

test('generation freezes facts, locks published templates, replays request IDs and rejects changed payload', async () => {
  const f = await setup()
  try {
    const first = f.enqueue(), same = f.enqueue(), concurrent = f.enqueue('different-click')
    assert.equal(first.id, same.id); assert.equal(concurrent.id, first.id)
    assert.throws(() => enqueueReportAgent(f.store, f.actor.id, { requestId: 'generate', templateId: f.template.id, period: '2026-09-14', useAi: false }), { status: 409 })
    f.store.update<WeeklyRecord>('weeklyRecords', f.record.id, f.record.version, { actualOutcome: '新的业务数据 777' })
    assert.match(getAgentReport(f.store, f.actor.id, first.reportId!).narrative, /620/)
    assert.throws(() => updateReportTemplate(f.store, f.actor.id, f.template.id, { expectedVersion: f.template.version, name: '不允许', bindings: f.template.bindings, rules: [], rulesConfirmed: true, exampleAssetIds: [], effectiveWeek: f.template.effectiveWeek }), { status: 409 })
    await runReportAgentWorker(f.store)
    assert.equal(getReportAgentJob(f.store, f.actor.id, first.id).status, 'ready')
    assert.equal(f.store.list('reports').length, 1)
  } finally { f.store.close() }
})

test('manual company metrics require source confirmation and archived DOCX remains byte identical', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-archive-')), path = join(directory, 'db.sqlite')
  const f = await setup(new Store(path), true)
  try {
    const job = f.enqueue(); await runReportAgentWorker(f.store)
    assert.equal(getReportAgentJob(f.store, f.actor.id, job.id).status, 'needs_input')
    let report = getAgentReport(f.store, f.actor.id, job.reportId!)
    await assert.rejects(finalizeAgentReport(f.store, f.actor.id, report.id, { expectedVersion: report.version, reviewNote: '未填写' }), { status: 409 })
    const blocks = structuredClone(report.agent!.blocks)
    for (const block of blocks) if (block.content.manual && !block.content.text) block.content = { text: '20', manual: true, confirmed: true, source: '管理者核对公司指标台账', factIds: [] }
    report = editAgentReport(f.store, f.actor.id, report.id, { expectedVersion: report.version, title: report.title, blocks })
    const finalized = await finalizeAgentReport(f.store, f.actor.id, report.id, { expectedVersion: report.version, reviewNote: '已核对事实、人工指标与版式' })
    const downloaded = await downloadAgentReport(f.store, f.actor.id, report.id)
    const xml = await (await JSZip.loadAsync(downloaded.bytes)).file('word/document.xml')!.async('string')
    assert.match(xml, /620/); assert.ok(!/历史成果|999|888|TOP3/.test(xml))
    assert.equal(finalized.agent!.finalHash, downloaded.sha256)
    assert.throws(() => editAgentReport(f.store, f.actor.id, report.id, { expectedVersion: finalized.version, title: 'change', blocks }), { status: 409 })
    f.store.close()
    const restored = new Store(path)
    try { assert.deepEqual((await downloadAgentReport(restored, f.actor.id, report.id)).bytes, downloaded.bytes) } finally { restored.close() }
  } finally { try { f.store.close() } catch { /* closed above */ } rmSync(directory, { recursive: true, force: true }) }
})

test('fact validation checks subject, numeric attribution and monthly acceptance separately', async () => {
  const f = await setup()
  try {
    const job = f.enqueue(), report = getAgentReport(f.store, f.actor.id, job.reportId!), facts = buildReportFacts(report.snapshot, report.period)
    const own = `weekly:${f.record.id}:outcome`
    assert.equal(validateFactText('完成 620 人试点', [own], facts).length, 0)
    assert.ok(validateFactText('完成 999 人试点', [own], facts).some(i => i.code === 'unsupported_number'))
    assert.ok(validateFactText('月目标已验收', [own], facts).some(i => i.code === 'acceptance_overstatement'))
    assert.ok(validateFactText('任务整体完成', [own], facts).some(i => i.code === 'completion_overstatement'))
    assert.ok(validateFactText('完成', ['not-a-fact'], facts).some(i => i.code === 'unknown_reference'))
    const other = { ...facts[0], id: 'other', subjectId: 'other', subject: '项目乙', value: '项目乙' }
    assert.ok(validateFactText('项目乙完成 620 人试点', [own], [...facts, other]).some(i => i.code === 'subject_mismatch'))
    assert.equal(reportAgentHash({ b: 2, a: 1 }), reportAgentHash({ a: 1, b: 2 }))
  } finally { f.store.close() }
})

test('AI invalid values retry once and preserve deterministic text', async () => {
  const f = await setup()
  try {
    const job = f.enqueue('ai', true); let calls = 0
    await runReportAgentWorker(f.store, { callModel: async (_store, messages) => { calls++; const input = JSON.parse(messages[1].content as string); return { text: '完成 999 人试点', factIds: input.facts.map((fact: { id: string }) => fact.id) } } })
    assert.equal(calls, 2)
    const report = getAgentReport(f.store, f.actor.id, job.reportId!)
    assert.match(report.narrative, /620/); assert.ok(!report.narrative.includes('999'))
    assert.equal(report.agent!.modelCandidates.length, 2)
    assert.equal(getReportAgentJob(f.store, f.actor.id, job.id).status, 'needs_input')
  } finally { f.store.close() }
})

test('manual edits while AI waits are not overwritten; retry preserves confirmed manual cells', async () => {
  const f = await setup()
  try {
    const job = f.enqueue('ai', true)
    await runReportAgentWorker(f.store, { callModel: async (_store, messages) => {
      const report = getAgentReport(f.store, f.actor.id, job.reportId!), blocks = structuredClone(report.agent!.blocks)
      blocks[0].rows[0][1] = { text: '人工更正 610 人', factIds: [], manual: true, confirmed: true, source: '核对签字台账' }
      editAgentReport(f.store, f.actor.id, report.id, { expectedVersion: report.version, title: report.title, blocks })
      const input = JSON.parse(messages[1].content as string); return { text: input.text, factIds: input.facts.map((fact: { id: string }) => fact.id) }
    } })
    let current = getReportAgentJob(f.store, f.actor.id, job.id)
    assert.equal(current.status, 'needs_input'); assert.match(current.error, /人工修改/)
    retryReportAgentJob(f.store, f.actor.id, current.id, current.version)
    let calls = 0; await runReportAgentWorker(f.store, { callModel: async () => { calls++; throw new Error('should not call for manual') } })
    assert.equal(calls, 0)
    assert.match(getAgentReport(f.store, f.actor.id, job.reportId!).narrative, /人工更正 610/)
  } finally { f.store.close() }
})

test('cancellation, permission revocation, expired lease and stopping all fence late writes', async () => {
  for (const action of ['cancel', 'revoke', 'expire', 'stop'] as const) {
    const f = await setup()
    try {
      const job = f.enqueue('ai', true), originalVersion = getAgentReport(f.store, f.actor.id, job.reportId!).version
      let stopped = false
      await runReportAgentWorker(f.store, { shouldStop: () => stopped, callModel: async (_store, messages) => {
        const current = getReportAgentJob(f.store, f.actor.id, job.id)
        if (action === 'cancel') cancelReportAgentJob(f.store, f.actor.id, job.id, current.version)
        if (action === 'revoke') f.store.update<User>('users', f.actor.id, f.actor.version, { active: false })
        if (action === 'expire') f.store.update<ReportAgentJob>('reportAgentJobs', job.id, current.version, { leaseUntil: '2000-01-01T00:00:00.000Z' })
        if (action === 'stop') stopped = true
        const input = JSON.parse(messages[1].content as string); return { text: input.text, factIds: input.facts.map((fact: { id: string }) => fact.id) }
      } })
      assert.equal(f.store.get<Report>('reports', job.reportId!)!.version, originalVersion, action)
      if (action === 'expire') { await runReportAgentWorker(f.store, { callModel: async (_s, messages) => { const input = JSON.parse(messages[1].content as string); return { text: input.text, factIds: input.facts.map((fact: { id: string }) => fact.id) } } }); assert.equal(f.store.list('reports').length, 1) }
    } finally { f.store.close() }
  }
})

test('learning is explicitly queued, yields candidate rules, and never auto-activates', async () => {
  const f = await setup()
  try {
    let template = createReportTemplate(f.store, f.actor.id, { name: '学习候选', sourceAssetId: f.asset.id, effectiveWeek: '2026-01-05', requestId: 'learning-template' })
    const job = enqueueTemplateLearning(f.store, f.actor.id, template.id, { requestId: 'learn', expectedVersion: template.version, useAi: false })
    let calls = 0; await runReportAgentWorker(f.store, { callModel: async () => { calls++; return {} } })
    template = f.store.get<ReportTemplate>('reportTemplates', template.id)!
    assert.equal(calls, 0); assert.equal(template.status, 'draft'); assert.equal(template.rulesConfirmed, false)
    assert.ok(template.learningCandidates.length > 0); assert.equal(getReportAgentJob(f.store, f.actor.id, job.id).status, 'ready')
  } finally { f.store.close() }
})

test('mapping requires every original cell; preview invalidates on edit and whole-table overlaps are refused', async () => {
  const f = await setup()
  try {
    const inspection = f.asset.inspection!
    assert.throws(() => validateTemplateBindings(inspection, []), { status: 400 })
    assert.throws(() => validateTemplateBindings(inspection, [...f.template.bindings, { regionId: 't:0:r:1:c:0', label: '重复', kind: 'manual', required: true }]), { status: 400 })
    let template = createReportTemplate(f.store, f.actor.id, { name: '待核验', sourceAssetId: f.asset.id, effectiveWeek: '2026-01-05' })
    await assert.rejects(Promise.resolve().then(() => activateReportTemplate(f.store, f.actor.id, template.id, { expectedVersion: template.version, layoutVerified: true, layoutNote: '没有预览' })), { status: 409 })
    template = await previewReportTemplate(f.store, f.actor.id, template.id, template.version)
    template = updateReportTemplate(f.store, f.actor.id, template.id, { expectedVersion: template.version, name: template.name, bindings: template.bindings, rules: ['新的写法'], rulesConfirmed: true, exampleAssetIds: [], effectiveWeek: template.effectiveWeek })
    assert.equal(template.previewAssetId, null)
  } finally { f.store.close() }
})

test('schedule catches up only latest period, survives repeated ticks/settings changes and supports Monday previous week', async () => {
  const f = await setup()
  try {
    let schedule = getReportAgentSchedule(f.store)
    assert.equal(schedule.enabled, false)
    schedule = updateReportAgentSchedule(f.store, f.actor.id, { expectedVersion: schedule.version, enabled: true, actorId: f.actor.id, templateId: f.template.id, weekday: 5, time: '17:30', targetWeek: 'current', useAi: false })
    schedule = f.store.update<ReportAgentSchedule>('settings', schedule.id, schedule.version, { effectiveAt: '2026-08-01T00:00:00.000Z' })
    assert.equal(runReportAgentSchedule(f.store, new Date('2026-09-21T03:00:00Z')).length, 1)
    assert.equal(runReportAgentSchedule(f.store, new Date('2026-09-21T03:01:00Z')).length, 0)
    assert.equal(f.store.list<Report>('reports')[0].period, '2026-09-14')
    assert.ok(reportAgentMissedPeriods(f.store, new Date('2026-09-21T03:00:00Z')).includes('2026-09-07'))
    schedule = f.store.update<ReportAgentSchedule>('settings', schedule.id, schedule.version, { weekday: 1, time: '09:00', targetWeek: 'previous' })
    assert.equal(runReportAgentSchedule(f.store, new Date('2026-09-21T03:00:00Z')).length, 0)
    assert.equal(runReportAgentSchedule(f.store, new Date('2026-09-28T03:00:00Z')).length, 1)
    assert.equal(f.store.list<Report>('reports')[1].period, '2026-09-21')
  } finally { f.store.close() }
})

test('single section rewrite reuses frozen snapshot and refuses stale report versions', async () => {
  const f = await setup()
  try {
    const job = f.enqueue(); await runReportAgentWorker(f.store)
    const report = getAgentReport(f.store, f.actor.id, job.reportId!)
    const rewrite = enqueueReportRewrite(f.store, f.actor.id, report.id, { expectedVersion: report.version, requestId: 'rewrite', blockId: report.agent!.blocks[0].id, useAi: false })
    await runReportAgentWorker(f.store)
    assert.equal(getReportAgentJob(f.store, f.actor.id, rewrite.id).status, 'ready')
    assert.equal(getAgentReport(f.store, f.actor.id, report.id).agent!.snapshotHash, report.agent!.snapshotHash)
    assert.throws(() => enqueueReportRewrite(f.store, f.actor.id, report.id, { expectedVersion: report.version, requestId: 'stale', blockId: report.agent!.blocks[0].id, useAi: false }), { status: 409 })
  } finally { f.store.close() }
})
