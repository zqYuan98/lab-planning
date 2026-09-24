import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { ImportService } from '../server/import-service.ts'
import { updateAiSettings } from '../server/ai-service.ts'
import type { ImportBatch } from '../shared/import-types.ts'
import type { MonthlyPlan, Task, WeeklyRecord } from '../shared/types.ts'
import type { Notification } from '../shared/notifications.ts'
import { isSilentImport, withSilentImport } from '../server/import-notification-context.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), service = new ImportService(store)
  const manager = domain.setup({ name: '临时导入管理员', email: 'temporary-manager@example.test', password: 'Synthetic-pass-2026!' })
  const member = domain.createUser(manager, { name: '临时导入成员', email: 'temporary-member@example.test', password: 'Synthetic-pass-2026!', position: '研发', role: 'member' })
  t.after(() => { service.close(); store.close() })
  return { store, domain, service, manager, member }
}

function monthly(ownerId: string, extra: Record<string, unknown> = {}) {
  return { kind: 'monthly', ownerId, title: '临时专项验证', month: '2026-09', dueDate: '2026-09-30', category: '专项研发', expectedOutcome: '完成本月专项验证', acceptanceCriteria: '提交验证报告', isTemporary: true, temporaryReason: '领导临时交办专项验证', ...extra }
}
function weekly(ownerId: string, extra: Record<string, unknown> = {}) {
  return { kind: 'weekly', ownerId, title: '临时演示支持', weekStart: '2026-09-14', dueDate: '2026-09-18', expectedOutcome: '准备演示材料', isTemporary: true, temporaryReason: '领导临时安排周五演示', ...extra }
}
function fork(f: ReturnType<typeof fixture>, before: ImportBatch, rows = before.rows): ImportBatch {
  return f.store.insert<ImportBatch>('importBatches', {
    ownerId: before.ownerId, sourceId: before.sourceId, fileName: before.fileName, kind: before.kind,
    status: 'parsed', sourceSheets: before.sourceSheets, warnings: [], rows: rows.map(row => ({ ...row, result: undefined })), mode: 'existing',
  })
}

test('manager weekly draft imports stay silent until explicit publication, including published goal links', t => {
  const f = fixture(t)
  const planBatch = f.service.structured(f.manager, { sourceKey: 'notification-published-goal', mode: 'existing', rows: [monthly(f.member.id, { isTemporary: false, temporaryReason: '' })] })
  const planId = f.service.commit(f.manager, planBatch.id, { version: planBatch.version }).rows[0].result!.id
  const records: WeeklyRecord[] = []
  for (const [index, extra] of [{}, { title: '已发布目标下的导入草稿', monthlyPlanId: planId, isTemporary: false, temporaryReason: '' }].entries()) {
    const batch = f.service.structured(f.manager, { sourceKey: `silent-weekly-draft-${index}`, mode: 'draft', rows: [weekly(f.member.id, extra)] })
    const committed = f.service.commit(f.manager, batch.id, { version: batch.version })
    const record = f.store.get<WeeklyRecord>('weeklyRecords', committed.rows[0].result!.id)!
    assert.equal(record.submitted, false)
    assert.equal(record.importSource?.notificationMode, 'silent')
    assert.equal(record.importSource?.mode, 'draft')
    const task = f.store.get<Task>('tasks', record.taskId)!
    assert.equal(task.importSource?.sourceId, batch.sourceId)
    f.domain.updateTask(f.manager, task.id, { reason: '测试场景确认承诺调整', version: task.version, description: '正式发布前修正草稿说明' })
    records.push(record)
  }
  for (const collection of ['notifications', 'notificationDeliveries', 'notificationObligations', 'notificationWorkVersions']) assert.equal(f.store.list(collection).length, 0, collection)
  const record = records[0]
  f.domain.updateWeeklyRecord(f.manager, record.id, { version: record.version, submitted: true })
  const notification = f.store.list<Notification>('notifications')[0]
  assert.equal(f.store.list('notifications').length, 1)
  assert.equal(notification.kind, 'work_assigned')
  assert.deepEqual(notification.targets, [{ type: 'weeklyRecord', id: record.id, weekStart: record.weekStart }])
  f.domain.createTask(f.manager, { title: '导入后新下达的工作', ownerId: f.member.id, dueDate: '2026-09-30', isTemporary: true, temporaryReason: '新的安排' })
  assert.equal(f.store.list('notifications').length, 2, 'import suppression does not affect subsequent live assignments')
})

test('silent import context restores on nested failure and cannot suppress a later live assignment', t => {
  const f = fixture(t)
  assert.throws(() => f.store.transaction(() => withSilentImport(f.store, () => {
    assert.equal(isSilentImport(f.store), true)
    withSilentImport(f.store, () => { assert.equal(isSilentImport(f.store), true) })
    f.domain.createTask(f.manager, { title: '将回滚的导入任务', ownerId: f.member.id, dueDate: '2026-09-30', isTemporary: true, temporaryReason: '导入静默' })
    throw new Error('rollback')
  })), /rollback/)
  assert.equal(isSilentImport(f.store), false)
  assert.equal(f.store.list('tasks').length, 0)
  f.domain.createTask(f.manager, { title: '失败后正常下达', ownerId: f.member.id, dueDate: '2026-09-30', isTemporary: true, temporaryReason: '正常下达' })
  assert.equal(f.store.list('notifications').length, 1)
})

test('historical and existing imports never create assignment notifications or obligations', t => {
  for (const mode of ['history', 'existing'] as const) {
    const f = fixture(t)
    const batch = f.service.structured(f.manager, { sourceKey: `silent-import-${mode}`, mode, rows: [monthly(f.member.id), weekly(f.member.id)] })
    f.service.commit(f.manager, batch.id, { version: batch.version })
    for (const collection of ['notifications', 'notificationDeliveries', 'notificationObligations', 'notificationWorkVersions']) assert.equal(f.store.list(collection).length, 0, `${mode}: ${collection}`)
  }
})

test('a member imports their temporary monthly goal and independent weekly task as drafts without bypassing review', t => {
  const f = fixture(t)
  const batch = f.service.structured(f.member, { sourceKey: 'member-temporary', mode: 'draft', rows: [monthly(f.member.id), weekly(f.member.id)] })
  assert.deepEqual(batch.rows.map(row => row.issues), [[], []])
  const committed = f.service.commit(f.member, batch.id, { version: batch.version })
  const plan = f.store.get<MonthlyPlan>('plans', committed.rows[0].result!.id)!
  const record = f.store.get<WeeklyRecord>('weeklyRecords', committed.rows[1].result!.id)!
  const task = f.store.get<Task>('tasks', record.taskId)!
  assert.equal(plan.isTemporary, true)
  assert.equal(plan.temporaryReason, monthly(f.member.id).temporaryReason)
  assert.equal(plan.status, 'draft')
  assert.equal(plan.acceptanceStatus, 'pending')
  assert.equal(task.isTemporary, true)
  assert.equal(task.temporaryReason, weekly(f.member.id).temporaryReason)
  assert.equal(task.monthlyPlanId, null)
  assert.equal(record.monthlyPlanId, null)
  assert.equal(record.submitted, false)
  assert.equal(f.service.history(f.member).filter(item => item.row.isTemporary).length, 2)
  const submitted = f.domain.submitPlan(f.member, plan.id, { version: plan.version })
  assert.equal(submitted.status, 'submitted')
  assert.throws(() => f.domain.reviewPlan(f.member, plan.id, { version: submitted.version, action: 'approve' }), { status: 403 })
})

test('temporary flags do not grant members ordinary goal creation, other ownership, or activation rights', t => {
  const f = fixture(t)
  for (const [sourceKey, row] of [
    ['ordinary', monthly(f.member.id, { isTemporary: false })],
    ['other-owner', monthly(f.manager.id)],
  ] as const) {
    const batch = f.service.structured(f.member, { sourceKey, mode: 'draft', rows: [row] })
    assert.throws(() => f.service.commit(f.member, batch.id, { version: batch.version }), { status: 403 })
  }
  const existing = f.service.structured(f.member, { sourceKey: 'needs-confirmation', mode: 'existing', rows: [monthly(f.member.id), weekly(f.member.id)] })
  const requested = f.service.requestConfirmation(f.member, existing.id, { version: existing.version })
  assert.ok(requested.reviewRequestedAt)
  assert.throws(() => f.service.commit(f.member, existing.id, { version: requested.version }), { status: 403 })
  assert.equal(f.store.list('plans').length, 0)
  const committed = f.service.commit(f.manager, existing.id, { version: requested.version })
  assert.equal(committed.committedCount, 2)
})

test('manager activation preserves both temporary classifications and original outcomes', t => {
  const f = fixture(t)
  const batch = f.service.structured(f.manager, { sourceKey: 'existing-temporary', mode: 'existing', rows: [
    monthly(f.member.id, { dueDate: '', expectedOutcome: '', acceptanceCriteria: '', actualOutcome: '已有专项结果', sourceStatus: '已完成' }),
    weekly(f.member.id, { dueDate: '', actualOutcome: '演示已完成', sourceStatus: '已完成' }),
  ] })
  assert.deepEqual(batch.rows.map(row => row.issues), [[], []])
  const committed = f.service.commit(f.manager, batch.id, { version: batch.version })
  const plan = f.store.get<MonthlyPlan>('plans', committed.rows[0].result!.id)!
  const record = f.store.get<WeeklyRecord>('weeklyRecords', committed.rows[1].result!.id)!
  const task = f.store.get<Task>('tasks', record.taskId)!
  assert.equal(plan.isTemporary, true)
  assert.equal(plan.temporaryReason, monthly(f.member.id).temporaryReason)
  assert.equal(plan.status, 'published')
  assert.equal(plan.actualOutcome, '已有专项结果')
  assert.equal(plan.acceptanceStatus, 'submitted')
  assert.equal(task.isTemporary, true)
  assert.equal(task.temporaryReason, weekly(f.member.id).temporaryReason)
  assert.equal(record.monthlyPlanId, null)
  assert.equal(record.status, 'done')
  assert.equal(record.submitted, true)
  assert.ok(task.importSource)
  assert.equal(f.service.commit(f.manager, batch.id, { version: 1 }).committedCount, 2)
  assert.equal(f.store.list('tasks').length, 1)
})

test('missing temporary reasons remain editable and archivable but block both operational import modes atomically', t => {
  const f = fixture(t)
  for (const mode of ['draft', 'existing'] as const) {
    let batch = f.service.structured(f.manager, { sourceKey: `missing-reason-${mode}`, mode, rows: [monthly(f.member.id), weekly(f.member.id, { temporaryReason: '' })] })
    assert.ok(batch.rows[1].issues.includes('请填写临时交办说明'))
    batch = f.service.edit(f.manager, batch.id, { version: batch.version, rows: batch.rows })
    assert.throws(() => f.service.commit(f.manager, batch.id, { version: batch.version }), /请填写临时交办说明/)
    assert.equal(f.store.list('plans').length, 0)
    assert.equal(f.store.list('tasks').length, 0)
  }
  const history = f.service.structured(f.manager, { sourceKey: 'archive-incomplete', mode: 'history', rows: [monthly(f.member.id, { temporaryReason: '' })] })
  const archived = f.service.commit(f.manager, history.id, { version: history.version })
  assert.equal(archived.committedCount, 1)
  assert.equal(f.service.history(f.manager)[0].row.isTemporary, true)
  assert.equal(f.service.history(f.manager)[0].row.temporaryReason, '')
  assert.throws(() => f.service.structured(f.manager, { sourceKey: 'not-boolean', rows: [weekly(f.member.id, { isTemporary: 'true' })] }), /布尔值/)
})

test('independent temporary weekly rows reject both explicit and in-batch monthly links in both modes', t => {
  const f = fixture(t)
  for (const mode of ['draft', 'existing'] as const) {
    let batch = f.service.structured(f.manager, { sourceKey: `conflicting-links-${mode}`, mode, rows: [monthly(f.member.id), weekly(f.member.id)] })
    batch.rows[1].linkedRowId = batch.rows[0].id
    batch = f.service.edit(f.manager, batch.id, { version: batch.version, rows: batch.rows })
    assert.throws(() => f.service.commit(f.manager, batch.id, { version: batch.version }), /临时周任务不能同时关联/)
    batch.rows[1].linkedRowId = ''
    batch.rows[1].monthlyPlanId = 'invalid-plan-still-conflicts'
    batch = f.service.edit(f.manager, batch.id, { version: batch.version, rows: batch.rows })
    assert.ok(batch.rows[1].issues.some(issue => issue.includes('临时周任务不能同时关联')))
    assert.equal(f.store.list('plans').length, 0)
  }
})

test('a weekly task under a temporary monthly goal remains ordinary and observes monthly publication gates', t => {
  const f = fixture(t)
  let batch = f.service.structured(f.member, { sourceKey: 'linked-temporary-monthly', mode: 'draft', rows: [monthly(f.member.id), weekly(f.member.id, { isTemporary: false, temporaryReason: '' })] })
  batch.rows[1].linkedRowId = batch.rows[0].id
  batch = f.service.edit(f.member, batch.id, { version: batch.version, rows: batch.rows })
  assert.deepEqual(batch.rows.map(row => row.issues), [[], []])
  const committed = f.service.commit(f.member, batch.id, { version: batch.version })
  const record = f.store.get<WeeklyRecord>('weeklyRecords', committed.rows[1].result!.id)!
  const task = f.store.get<Task>('tasks', record.taskId)!
  assert.equal(task.isTemporary, false)
  assert.equal(task.monthlyPlanId, committed.rows[0].result!.id)
  assert.throws(() => f.domain.updateWeeklyRecord(f.member, record.id, { version: record.version, submitted: true }), /尚未发布/)
})

test('temporary drafts activate in place with unchanged monthly, task and weekly IDs and deduplicate retries', t => {
  const f = fixture(t)
  const prepared = f.service.structured(f.manager, { sourceKey: 'temporary-activation', mode: 'draft', rows: [monthly(f.member.id), weekly(f.member.id)] })
  const drafted = f.service.commit(f.manager, prepared.id, { version: prepared.version })
  const planId = drafted.rows[0].result!.id, recordId = drafted.rows[1].result!.id
  const taskId = f.store.get<WeeklyRecord>('weeklyRecords', recordId)!.taskId
  const activation = fork(f, drafted)
  const activated = f.service.commit(f.manager, activation.id, { version: activation.version })
  assert.equal(activated.activatedCount, 2)
  assert.equal(activated.committedCount, 0)
  assert.equal(activated.rows[0].result!.id, planId)
  assert.equal(activated.rows[1].result!.id, recordId)
  assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', recordId)!.taskId, taskId)
  assert.equal(f.store.get<Task>('tasks', taskId)!.isTemporary, true)
  assert.equal(f.store.get<MonthlyPlan>('plans', planId)!.temporaryReason, monthly(f.member.id).temporaryReason)
  const duplicate = fork(f, drafted)
  assert.equal(f.service.commit(f.manager, duplicate.id, { version: duplicate.version }).skippedCount, 2)
  assert.equal(f.store.list('historicalRecords').length, 2)
  const changed = fork(f, drafted, drafted.rows.map(row => ({ ...row, temporaryReason: '新的临时原因' })))
  assert.throws(() => f.service.commit(f.manager, changed.id, { version: changed.version }), /本次内容有变化/)
  assert.equal(f.store.list('plans').length, 1)
  assert.equal(f.store.list('tasks').length, 1)
})

test('legacy ordinary fingerprints are byte-compatible even when new clients explicitly send false and an empty reason', t => {
  const f = fixture(t)
  const row = monthly(f.member.id)
  delete (row as Partial<typeof row>).isTemporary
  delete (row as Partial<typeof row>).temporaryReason
  const batch = f.service.structured(f.manager, { sourceKey: 'legacy-fingerprint', mode: 'draft', rows: [row] })
  const committed = f.service.commit(f.manager, batch.id, { version: batch.version })
  const oldFields = ['ownerName', 'ownerId', 'projectName', 'projectId', 'category', 'title', 'month', 'weekStart', 'dueDate', 'expectedOutcome', 'acceptanceCriteria', 'actualOutcome', 'blocker', 'nextAction', 'sourceStatus', 'monthlyPlanId', 'linkedRowId', 'taskId'] as const
  const source = committed.rows[0]
  const oldFingerprint = createHash('sha256').update(JSON.stringify({ kind: source.kind, sourceSheet: source.sourceSheet, sourceRow: source.sourceRow, sourceText: source.sourceText, ...Object.fromEntries(oldFields.map(key => [key, source[key]])) })).digest('hex')
  const link = f.store.list<{ rowFingerprint: string }>('importLinks')[0]
  assert.equal(link.rowFingerprint, oldFingerprint)
  const next = fork(f, committed, committed.rows.map(item => ({ ...item, isTemporary: false, temporaryReason: '' })))
  const activated = f.service.commit(f.manager, next.id, { version: next.version })
  assert.equal(activated.rows[0].result!.id, source.result!.id)
  assert.equal(activated.activatedCount, 1)
})

test('existing task reuse preserves temporary metadata, accepts absent legacy fields and rejects explicit reclassification', t => {
  const f = fixture(t)
  const task = f.domain.createTask(f.member, { title: '长期跟进的临时支持', ownerId: f.member.id, dueDate: '2026-09-30', isTemporary: true, temporaryReason: '临时交办支持' })
  for (const [index, mode] of (['draft', 'existing'] as const).entries()) {
    const input = weekly(f.member.id, { taskId: task.id, weekStart: index ? '2026-09-21' : '2026-09-14' })
    delete (input as Partial<typeof input>).isTemporary
    delete (input as Partial<typeof input>).temporaryReason
    const batch = f.service.structured(f.member, { sourceKey: `legacy-reuse-${mode}`, mode, rows: [input] })
    assert.deepEqual(batch.rows[0].issues, [])
    const committed = f.service.commit(mode === 'existing' ? f.manager : f.member, batch.id, { version: batch.version })
    assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', committed.rows[0].result!.id)!.taskId, task.id)
    for (const [suffix, extra] of [['type', { isTemporary: false }], ['reason', { temporaryReason: '试图重写原因' }]] as const) {
      const bad = f.service.structured(f.manager, { sourceKey: `bad-reuse-${mode}-${suffix}`, mode, rows: [{ ...input, weekStart: '2026-09-28', ...extra }] })
      assert.throws(() => f.service.commit(f.manager, bad.id, { version: bad.version }), /不能通过导入修改已有任务/)
    }
  }
  assert.deepEqual(f.store.get<Task>('tasks', task.id), task)
})

test('unchanged task reasons beyond the new editor limit remain reusable without changing legacy domain limits', t => {
  const f = fixture(t), longReason = '临'.repeat(2001)
  const task = f.domain.createTask(f.member, { title: '历史临时支持', ownerId: f.member.id, dueDate: '2026-09-30', isTemporary: true, temporaryReason: longReason })
  let batch = f.service.structured(f.member, { sourceKey: 'preserve-long-reason', mode: 'draft', rows: [weekly(f.member.id, { taskId: task.id, temporaryReason: longReason })] })
  batch = f.service.edit(f.member, batch.id, { version: batch.version, rows: batch.rows })
  const committed = f.service.commit(f.member, batch.id, { version: batch.version })
  assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', committed.rows[0].result!.id)!.taskId, task.id)
  assert.equal(f.store.get<Task>('tasks', task.id)!.temporaryReason, longReason)
})

test('omitting the imported flag cannot attach an existing independent temporary task to a monthly goal', t => {
  const f = fixture(t)
  const task = f.domain.createTask(f.member, { title: '原独立临时任务', ownerId: f.member.id, dueDate: '2026-09-30', isTemporary: true, temporaryReason: '原临时交办' })
  const planBatch = f.service.structured(f.manager, { sourceKey: 'published-goal', mode: 'existing', rows: [monthly(f.member.id, { isTemporary: false, temporaryReason: '' })] })
  const planId = f.service.commit(f.manager, planBatch.id, { version: planBatch.version }).rows[0].result!.id
  for (const mode of ['draft', 'existing'] as const) {
    for (const link of [{ monthlyPlanId: planId }, { linkedRowId: 'missing-monthly-row' }]) {
      const input = weekly(f.member.id, { taskId: task.id, ...link })
      delete (input as Partial<typeof input>).isTemporary
      delete (input as Partial<typeof input>).temporaryReason
      const batch = f.service.structured(f.manager, { sourceKey: `hidden-temporary-${mode}-${Object.keys(link)[0]}`, mode, rows: [input] })
      assert.throws(() => f.service.commit(f.manager, batch.id, { version: batch.version }), /临时周任务不能同时关联/)
    }
    const ordinary = f.domain.createTask(f.member, { title: `普通任务-${mode}`, ownerId: f.member.id, dueDate: '2026-09-30', monthlyPlanId: planId })
    const wrongType = f.service.structured(f.manager, { sourceKey: `ordinary-to-temporary-${mode}`, mode, rows: [weekly(f.member.id, { taskId: ordinary.id })] })
    assert.throws(() => f.service.commit(f.manager, wrongType.id, { version: wrongType.version }), /不能通过导入修改已有任务的临时类型/)
    assert.equal(f.store.get<Task>('tasks', ordinary.id)!.isTemporary, false)
  }
  assert.equal(f.store.list('weeklyRecords').length, 0)
  assert.deepEqual(f.store.get<Task>('tasks', task.id), task)
})

test('AI extraction keeps explicit temporary evidence without inferring it from leadership or missing projects', async t => {
  const f = fixture(t)
  updateAiSettings(f.store, f.manager, { baseUrl: 'https://synthetic-temporary.example.test/v1', model: 'synthetic-test', apiKey: 'synthetic-only' })
  let systemInstruction = ''
  t.mock.method(globalThis, 'fetch', async (_url: unknown, options: RequestInit) => {
    const request = JSON.parse(String(options.body)) as { messages: { role: string; content: string }[] }
    systemInstruction = request.messages.find(message => message.role === 'system')!.content
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rows: [
      { ...weekly(f.member.id), sourceRow: 2, ownerName: f.member.name, temporaryReason: '原文：领导临时安排周五演示', monthlyResult: 'accepted' },
      { kind: 'monthly', sourceRow: 3, title: '领导安排的常规验证', ownerName: f.manager.name, month: '2026-09', isTemporary: false, temporaryReason: '' },
    ], warnings: [] }) } }] }), { headers: { 'content-type': 'application/json' } })
  })
  const uploaded = await f.service.upload(f.manager, { fileName: '临时事项.csv', mimeType: 'text/csv', base64: Buffer.from('事项,原文\n临时演示,领导临时安排周五演示\n常规验证,领导安排验证\n').toString('base64') })
  const parsed = await f.service.analyze(f.manager, uploaded.id, { version: uploaded.version })
  assert.match(systemInstruction, /只有原文明示/)
  assert.match(systemInstruction, /不得因为负责人是领导/)
  assert.equal(parsed.rows[0].isTemporary, true)
  assert.equal(parsed.rows[0].temporaryReason, '原文：领导临时安排周五演示')
  assert.equal(parsed.rows[0].monthlyResult, undefined)
  assert.equal(parsed.rows[1].isTemporary, false)
  assert.equal(parsed.rows[1].temporaryReason, '')
  assert.equal(parsed.rows[1].projectId, '')
  assert.equal(f.store.list('tasks').length, 0)
})
