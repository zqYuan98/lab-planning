import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { ImportService, type HistoricalRecord } from '../server/import-service.ts'
import { callAiJson, updateAiSettings } from '../server/ai-service.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import type { ImportBatch } from '../shared/import-types.ts'
import type { AuditEvent, MonthlyPlan, Task, WeeklyRecord } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), service = new ImportService(store)
  const actor = domain.setup({ name: '核对管理员', email: 'completion@example.test', password: 'Synthetic-pass-2026!' })
  const member = domain.createUser(actor, { name: '执行人', email: 'completion-member@example.test', password: 'Synthetic-pass-2026!', role: 'member' })
  updateAiSettings(store, actor, { baseUrl: 'https://synthetic.invalid/v1', model: 'synthetic', apiKey: 'synthetic-only' })
  t.after(() => { service.close(); store.close() })
  return { store, domain, service, actor, member }
}
const monthly = (ownerId: string, extra: Record<string, unknown> = {}) => ({ kind: 'monthly', sourceRow: 1, sourceText: '原始事项', title: '月度事项', month: '2026-09', ownerId, ...extra })
const weekly = (ownerId: string, extra: Record<string, unknown> = {}) => ({ kind: 'weekly', sourceRow: 1, sourceText: '原始周事项', title: '周度事项', weekStart: '2026-09-14', ownerId, sourceStatus: '已完成', actualOutcome: '完成本周阶段交付', ...extra })
function response(rows: unknown[], finish_reason = 'stop') {
  return new Response(JSON.stringify({ choices: [{ finish_reason, message: { content: JSON.stringify({ rows, warnings: [] }) } }] }))
}
function review(f: ReturnType<typeof fixture>, batch: ImportBatch) {
  return f.service.edit(f.actor, batch.id, { version: batch.version, rows: batch.rows, completionReview: { confirmed: true, sourceItemCount: batch.rows.length } })
}

test('file candidates require explicit source reconciliation; exclusion keeps its reason, counts and before/after audit', async t => {
  const f = fixture(t)
  t.mock.method(globalThis, 'fetch', async () => response([1, 2, 3].map(index => monthly('', { sourceRow: index, title: `任务${index}`, ownerName: f.member.name, selected: false, taskCompleted: true, completionNote: '模型伪造', collaboratorIds: [f.actor.id] }))))
  const uploaded = await f.service.upload(f.actor, { fileName: '三项.txt', text: '任务1\n任务2\n任务3', mode: 'existing' })
  let batch = await f.service.analyze(f.actor, uploaded.id, { version: uploaded.version, kind: 'monthly', instruction: '逐项', period: '2026-09' })
  assert.deepEqual(batch.analysisOptions, { sheetNames: [], kind: 'monthly', instruction: '逐项', period: '2026-09' })
  assert.ok(batch.rows.every(row => row.selected && !row.taskCompleted && !row.completionNote && !row.collaboratorIds?.length))
  assert.throws(() => f.service.commit(f.actor, batch.id, { version: batch.version }), /逐项核对原始资料/)
  assert.equal(f.store.list('plans').length, 0)
  batch.rows[2].selected = false
  assert.throws(() => review(f, batch), /排除理由/)
  batch.rows[2].exclusionReason = '该项尚未纳入本次安排，保留待后续核对'
  batch = review(f, batch)
  assert.equal(batch.completionReview?.reviewedBy, f.actor.id)
  const event = f.store.list<AuditEvent>('events').find(event => event.entityId === batch.id && event.action === 'edit_preview')!
  assert.equal((event.before as { rows: { selected: boolean }[] }).rows[2].selected, true)
  assert.deepEqual((event.after as { rows: { selected: boolean; exclusionReason: string }[] }).rows[2].exclusionReason, batch.rows[2].exclusionReason)
  const committed = f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.equal(committed.status, 'committed')
  assert.equal(committed.committedCount, 2)
  assert.equal(committed.skippedCount, 0)
  assert.equal(committed.excludedCount, 1)
  assert.equal(committed.pendingCount, 0)
  assert.equal(committed.rows[2].result, undefined)
  assert.equal(committed.rows[0].resultDisposition, 'created')
  assert.equal(f.store.list('plans').length, 2)
  assert.deepEqual(f.service.commit(f.actor, batch.id, { version: batch.version }).rows, committed.rows)
})

test('source omission can be supplemented with stable server IDs and reconfirmed in the same versioned edit', async t => {
  const f = fixture(t)
  t.mock.method(globalThis, 'fetch', async () => response([monthly('', { ownerName: f.member.name })]))
  let batch = await f.service.upload(f.actor, { fileName: '漏项.txt', text: '原始事项\n第二项', mode: 'existing' })
  batch = await f.service.analyze(f.actor, batch.id, { version: batch.version })
  const originalId = batch.rows[0].id
  assert.throws(() => f.service.edit(f.actor, batch.id, { version: batch.version, rows: batch.rows, completionReview: { confirmed: true, sourceItemCount: 2 } }), /数量/)
  batch = f.service.edit(f.actor, batch.id, { version: batch.version, rows: [...batch.rows, { ...monthly(f.member.id, { title: '第二项', sourceText: '第二项', sourceRow: 2 }), id: 'new:second' }], completionReview: { confirmed: true, sourceItemCount: 2 } })
  assert.equal(batch.rows[0].id, originalId)
  assert.notEqual(batch.rows[1].id, 'new:second')
  assert.equal(batch.rows[1].manuallyAdded, true)
  const savedId = batch.rows[1].id
  assert.throws(() => f.service.edit(f.actor, batch.id, { version: batch.version, rows: [batch.rows[1]] }), /保留原始/)
  const reviewedVersion = batch.version
  batch = f.service.edit(f.actor, batch.id, { version: batch.version, rows: batch.rows.map(row => ({ ...row, expectedOutcome: '人工明确交付' })) })
  assert.equal(batch.completionReview, undefined)
  assert.equal(batch.rows[1].id, savedId)
  assert.throws(() => f.service.commit(f.actor, batch.id, { version: batch.version }), /逐项核对/)
  assert.throws(() => f.service.edit(f.actor, batch.id, { version: reviewedVersion, rows: batch.rows, completionReview: { confirmed: true, sourceItemCount: 2 } }), { status: 409 })
  batch = review(f, batch)
  assert.equal(f.service.commit(f.actor, batch.id, { version: batch.version }).committedCount, 2)
})

test('failed or legacy file batches can be manually reconstructed, while unchanged structured clients remain compatible', async t => {
  const f = fixture(t)
  const uploaded = await f.service.upload(f.member, { fileName: '无需模型.txt', text: '临时月度交付', mode: 'existing' })
  const legacy = f.store.update<ImportBatch>('importBatches', uploaded.id, uploaded.version, { requiresCompletionReview: undefined })
  assert.equal(f.service.get(f.member, legacy.id).requiresCompletionReview, true)
  assert.equal(f.service.sourcePreview(f.member, legacy.id).text, '临时月度交付')
  const outsider = f.domain.createUser(f.actor, { name: '其他人', email: 'other@example.test', password: 'Synthetic-pass-2026!', role: 'member' })
  assert.throws(() => f.service.sourcePreview(outsider, legacy.id), { status: 403 })
  let batch = f.service.edit(f.member, legacy.id, { version: legacy.version, rows: [{ ...monthly(f.member.id), id: 'new:manual' }], completionReview: { confirmed: true, sourceItemCount: 1, reviewedBy: outsider.id } })
  assert.equal(batch.status, 'parsed')
  assert.equal(batch.completionReview?.reviewedBy, f.member.id)
  batch = f.service.requestConfirmation(f.member, batch.id, { version: batch.version })
  assert.equal(f.service.commit(f.actor, batch.id, { version: batch.version }).committedCount, 1)
  const structured = f.service.structured(f.actor, { sourceKey: 'legacy-api', mode: 'existing', rows: [monthly(f.member.id)] })
  assert.equal(f.service.get(f.actor, structured.id).requiresCompletionReview, false)
  assert.equal(f.service.commit(f.actor, structured.id, { version: structured.version }).committedCount, 1)
})

test('reanalysis clears source review and preserves selected worksheets and parsing options', async t => {
  const f = fixture(t)
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return response([monthly('', { ownerName: f.member.name })]) })
  let batch = await f.service.upload(f.actor, { fileName: '单表.csv', text: '月度事项', mode: 'existing' })
  const options = { sheets: ['单表.csv'], instruction: '逐项提取', period: '2026-09', kind: 'monthly' }
  batch = review(f, await f.service.analyze(f.actor, batch.id, { version: batch.version, ...options }))
  batch = await f.service.analyze(f.actor, batch.id, { version: batch.version, ...options, forceRefresh: true })
  assert.equal(calls, 2)
  assert.equal(batch.completionReview, undefined)
  assert.deepEqual(batch.analysisOptions?.sheetNames, ['单表.csv'])
  assert.throws(() => f.service.commit(f.actor, batch.id, { version: batch.version }), /逐项核对/)
})

test('collaborators and explicit assignment source persist through activation, export, and remapped restore', t => {
  const f = fixture(t)
  let batch = f.service.structured(f.actor, { sourceKey: 'metadata', mode: 'existing', rows: [monthly(f.member.id, { collaboratorNames: [f.actor.name], workSource: 'leader', assignedBy: '领导甲', assignedOn: '2026-09-15' })] })
  assert.deepEqual(batch.rows[0].collaboratorIds, [f.actor.id])
  batch = f.service.commit(f.actor, batch.id, { version: batch.version })
  const plan = f.store.get<MonthlyPlan>('plans', batch.rows[0].result!.id)!
  assert.deepEqual(plan.collaboratorIds, [f.actor.id])
  assert.equal(plan.workSource, 'leader')
  assert.equal(plan.assignedBy, '领导甲')
  const packet = exportBusinessData(f.store, f.actor)
  const target = fixture(t)
  const preview = previewRestore(target.store, target.actor, packet)
  assert.equal(preview.canRestore, true, preview.issues.join(';'))
  restoreBusinessData(target.store, target.actor, packet, {}, preview.fingerprint)
  const restored = target.store.get<MonthlyPlan>('plans', plan.id)!
  assert.deepEqual(restored.collaboratorIds, [target.actor.id])
  assert.equal(restored.assignedOn, '2026-09-15')
  const history = target.store.list<HistoricalRecord>('historicalRecords')[0]
  assert.deepEqual(history.row.collaboratorIds, [target.actor.id])
  const ambiguous = f.service.structured(f.actor, { sourceKey: 'missing-collaborator', mode: 'existing', rows: [monthly(f.member.id, { collaboratorNames: [f.actor.name, '不存在的同事'] })] })
  assert.match(ambiguous.rows[0].issues.join(';'), /尚未全部匹配/)
  assert.throws(() => f.service.commit(f.actor, ambiguous.id, { version: ambiguous.version }), /尚未全部匹配/)
})

test('weekly completion stays a stage result; only human whole-task confirmation closes newly imported tasks', t => {
  const f = fixture(t)
  const batch = f.service.structured(f.actor, { sourceKey: 'stage-completion', mode: 'existing', rows: [weekly(f.member.id, { workSource: 'leader', assignedBy: '领导乙', assignedOn: '2026-09-15' }), weekly(f.member.id, { title: '全部结束', sourceRow: 2, taskCompleted: true, completionNote: '全部交付完成，无后续事项' })] })
  const committed = f.service.commit(f.actor, batch.id, { version: batch.version })
  const weeks = committed.rows.map(row => f.store.get<WeeklyRecord>('weeklyRecords', row.result!.id)!)
  assert.ok(weeks.every(week => week.status === 'done'))
  const tasks = weeks.map(week => f.store.get<Task>('tasks', week.taskId)!)
  assert.equal(tasks[0].status, 'doing')
  assert.equal(tasks[0].completionNote, undefined)
  assert.equal(tasks[0].workSource, 'leader')
  assert.equal(tasks[1].status, 'done')
  assert.equal(tasks[1].completionNote, '全部交付完成，无后续事项')
  assert.equal(f.store.list('notifications').length, 0)
  const invalid = f.service.structured(f.actor, { sourceKey: 'missing-completion-evidence', mode: 'existing', rows: [weekly(f.member.id, { taskCompleted: true })] })
  assert.throws(() => f.service.commit(f.actor, invalid.id, { version: invalid.version }), /整体完成说明/)
  assert.equal(f.store.list('tasks').length, 2)
})

test('truncated, refused or multiple AI choices are rejected even with valid JSON and never poison import caches', async t => {
  const f = fixture(t)
  let content: unknown = { choices: [{ finish_reason: 'length', message: { content: '{"rows":[]}' } }] }
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify(content)))
  for (const reason of ['length', 'content_filter', 'tool_calls']) {
    content = { choices: [{ finish_reason: reason, message: { content: '{"rows":[]}' } }] }
    await assert.rejects(callAiJson(f.store, [{ role: 'user', content: '{}' }]), { status: 502 })
  }
  content = { choices: [{ message: { content: '{}', refusal: 'refused' } }] }
  await assert.rejects(callAiJson(f.store, [{ role: 'user', content: '{}' }]), { status: 502 })
  content = { choices: [{ message: { content: '{}' } }, { message: { content: '{}' } }] }
  await assert.rejects(callAiJson(f.store, [{ role: 'user', content: '{}' }]), { status: 502 })
  content = { choices: [{ finish_reason: 'length', message: { content: JSON.stringify({ rows: [monthly('', { ownerName: f.member.name })] }) } }] }
  const batch = await f.service.upload(f.actor, { fileName: '截断.txt', text: '月度事项' })
  await assert.rejects(f.service.analyze(f.actor, batch.id, { version: batch.version }), { status: 502 })
  assert.equal(f.store.list('importParsedChunks').length, 0)
  assert.equal(f.store.list('plans').length, 0)
})

test('a duplicate or header candidate can be excluded honestly without inflating the source item count', async t => {
  const f = fixture(t)
  const uploaded = await f.service.upload(f.actor, { fileName: '三事项含标题.txt', text: '标题\n事项1\n事项2\n事项3', mode: 'existing' })
  let batch = f.service.edit(f.actor, uploaded.id, { version: uploaded.version, rows: [1, 2, 3, 4].map(index => ({ ...monthly(f.member.id, { title: `候选${index}`, sourceRow: index }), id: `new:row-${index}` })) })
  const excluded = { ...batch.rows[3], selected: false, exclusionKind: 'duplicate', exclusionReason: '与事项1重复，原文只有三件事项' }
  batch = f.service.edit(f.actor, batch.id, { version: batch.version, rows: [...batch.rows.slice(0, 3), excluded], completionReview: { confirmed: true, sourceItemCount: 3 } })
  assert.equal(batch.completionReview?.sourceItemCount, 3)
  assert.equal(batch.rows.length, 4)
  const committed = f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.equal(committed.committedCount, 3)
  assert.equal(committed.excludedCount, 1)
  assert.equal(committed.rows[3].exclusionKind, 'duplicate')
})

test('a mixed-owner source can be handed to the manager before reconciliation without permitting an unchecked commit', async t => {
  const f = fixture(t)
  const uploaded = await f.service.upload(f.member, { fileName: '混合负责人.txt', text: '我的工作\n管理者工作', mode: 'existing' })
  const batch = f.store.update<ImportBatch>('importBatches', uploaded.id, uploaded.version, { status: 'parsed', rows: [f.service.structured(f.actor, { sourceKey: 'own', rows: [monthly(f.member.id)] }).rows[0], f.service.structured(f.actor, { sourceKey: 'other', rows: [monthly(f.actor.id)] }).rows[0]] })
  const requested = f.service.requestConfirmation(f.member, batch.id, { version: batch.version })
  assert.ok(requested.reviewRequestedAt)
  assert.equal(requested.rows.length, 1)
  assert.equal(f.service.get(f.actor, batch.id).rows.length, 2)
  assert.throws(() => f.service.commit(f.actor, batch.id, { version: requested.version }), /逐项核对/)
  const reviewed = review(f, f.service.get(f.actor, batch.id))
  assert.equal(f.service.commit(f.actor, batch.id, { version: reviewed.version }).committedCount, 2)
})

test('an explicit empty collaborator selection corrects an AI mapping without silently adding it back', t => {
  const f = fixture(t)
  let batch = f.service.structured(f.actor, { sourceKey: 'correct-collaborators', mode: 'existing', rows: [monthly(f.member.id, { collaboratorNames: [f.actor.name] })] })
  assert.deepEqual(batch.rows[0].collaboratorIds, [f.actor.id])
  batch = f.service.edit(f.actor, batch.id, { version: batch.version, rows: batch.rows.map(row => ({ ...row, collaboratorIds: [] })) })
  assert.deepEqual(batch.rows[0].collaboratorIds, [])
  assert.deepEqual(batch.rows[0].collaboratorNames, [f.actor.name], 'source names stay available for traceability')
  assert.deepEqual(batch.rows[0].issues, [])
  const committed = f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.deepEqual(f.store.get<MonthlyPlan>('plans', committed.rows[0].result!.id)!.collaboratorIds, [])
})

test('empty assignment fields equal absent legacy metadata when reusing a task, while nonempty changes remain blocked', t => {
  const f = fixture(t)
  const task = f.domain.createTask(f.member, { title: '已有临时事项', ownerId: f.member.id, dueDate: '2026-09-30', isTemporary: true, temporaryReason: '临时支持' })
  const batch = f.service.structured(f.actor, { sourceKey: 'reuse-empty-metadata', mode: 'existing', rows: [weekly(f.member.id, { taskId: task.id, assignedBy: '', assignedOn: '' })] })
  assert.deepEqual(batch.rows[0].issues, [])
  const committed = f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', committed.rows[0].result!.id)!.taskId, task.id)
  assert.deepEqual(f.store.get<Task>('tasks', task.id), task)
  for (const fields of [{ assignedBy: '其他领导' }, { assignedOn: '2026-09-15' }, { workSource: 'leader' }]) {
    const changed = f.service.structured(f.actor, { sourceKey: `different-metadata-${Object.keys(fields)[0]}`, mode: 'existing', rows: [weekly(f.member.id, { taskId: task.id, ...fields })] })
    assert.match(changed.rows[0].issues.join(';'), /不改变已有任务的交办来源/)
    assert.throws(() => f.service.commit(f.actor, changed.id, { version: changed.version }), /不改变已有任务的交办来源/)
  }
  assert.deepEqual(f.store.get<Task>('tasks', task.id), task)
})
