import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { ImportService } from '../server/import-service.ts'
import { updateAiSettings } from '../server/ai-service.ts'
import type { ImportBatch, ImportRow } from '../shared/import-types.ts'
import type { AuditEvent, Entity, MonthlyPlan, Publication, Task, User, WeeklyRecord } from '../shared/types.ts'

interface ImportedSource { batchId: string; sourceId: string; rowId: string; sourceStatus: string }
type ImportedPlan = MonthlyPlan & { importSource?: ImportedSource }
type ImportedTask = Task & { importSource?: ImportedSource }
type ImportedWeek = WeeklyRecord & { importSource?: ImportedSource }

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), service = new ImportService(store)
  const actor = domain.setup({ name: '既有计划管理员', email: 'existing-manager@example.test', password: 'Synthetic-pass-2026!' })
  const member = domain.createUser(actor, { name: '既有计划成员', email: 'existing-member@example.test', password: 'Synthetic-pass-2026!', position: '研发', role: 'member' })
  t.after(() => { service.close(); store.close() })
  return { store, domain, service, actor, member }
}

const monthly = (ownerId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'monthly', ownerId, title: '原月计划事项', month: '2026-09', sourceRow: 2,
  sourceText: '原月表已经记录的事项与成果', actualOutcome: '原表中保存的实际成果', sourceStatus: '已完成', ...extra,
})
const completeMonthly = (ownerId: string, extra: Record<string, unknown> = {}) => monthly(ownerId, {
  category: '研发', dueDate: '2026-09-30', expectedOutcome: '既有计划交付成果', acceptanceCriteria: '原表验收要求', ...extra,
})
const weekly = (ownerId: string, extra: Record<string, unknown> = {}) => ({
  kind: 'weekly', ownerId, title: '原周计划事项', sourceRow: 3, sourceSheet: '旧周计划', weekStart: '2026-09-07',
  expectedOutcome: '原周工作安排', actualOutcome: '原周成果', sourceStatus: '已完成', sourceText: '来自原周计划的内容', ...extra,
})

function fork(store: Store, owner: User, before: ImportBatch): ImportBatch {
  return store.insert<ImportBatch>('importBatches', {
    ownerId: owner.id, sourceId: before.sourceId, fileName: before.fileName, kind: before.kind,
    status: 'uploaded', sourceSheets: before.sourceSheets, warnings: [], rows: [], mode: 'existing',
  })
}

async function parsedFile(t: TestContext, f: ReturnType<typeof fixture>, row: Record<string, unknown> | Record<string, unknown>[]) {
  updateAiSettings(f.store, f.actor, { baseUrl: 'https://synthetic-existing.example.test/v1', model: 'synthetic-test', apiKey: 'synthetic-only' })
  const rows: Record<string, unknown>[] = (Array.isArray(row) ? row : [row]).map(item => ({ ...item, ownerName: f.member.name }))
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rows, warnings: [] }) } }] }), { headers: { 'content-type': 'application/json' } }))
  const bytes = Buffer.from(`工作内容,月份,完成情况\n${rows.map(item => `${item.title},2026-09,已完成`).join('\n')}`)
  const uploaded = await f.service.upload(f.actor, { fileName: '合成既有月计划.csv', mimeType: 'text/csv', base64: bytes.toString('base64') })
  const batch = await f.service.analyze(f.actor, uploaded.id, { version: uploaded.version })
  return { batch, bytes }
}

function setMode(f: ReturnType<typeof fixture>, batch: ImportBatch, mode: ImportBatch['mode']): ImportBatch {
  return f.service.edit(f.actor, batch.id, { version: batch.version, mode, rows: batch.rows })
}

test('manager activates an existing file plan directly, preserves original facts, and allows fields absent from the old form', async t => {
  const f = fixture(t)
  const parsed = await parsedFile(t, f, monthly(f.member.id))
  const batch = setMode(f, parsed.batch, 'existing')
  assert.equal(batch.mode, 'existing')
  assert.deepEqual(batch.rows[0].issues, [])
  const committed = f.service.commit(f.actor, batch.id, { version: batch.version })
  const plan = f.store.get<ImportedPlan>('plans', committed.rows[0].result!.id)!
  assert.equal(plan.status, 'published')
  assert.equal(plan.actualOutcome, '原表中保存的实际成果')
  assert.equal(plan.acceptanceStatus, 'submitted', 'source completion is not an implicit acceptance decision')
  assert.equal(plan.expectedOutcome, '')
  assert.equal(plan.acceptanceCriteria, '')
  assert.equal(plan.dueDate, '')
  assert.equal(plan.category, '')
  assert.equal(plan.ownerId, f.member.id)
  assert.deepEqual(plan.importSource, { batchId: batch.id, sourceId: batch.sourceId, rowId: batch.rows[0].id, sourceStatus: '已完成' })
  assert.equal(f.service.source(f.actor, batch.id).base64, parsed.bytes.toString('base64'))
  assert.equal(f.store.list<AuditEvent>('events').filter(event => event.entityId === plan.id && ['submit', 'approve'].includes(event.action)).length, 0)
  assert.ok(f.store.list<Publication>('publications').some(publication => publication.plans.some(snapshot => snapshot.id === plan.id && snapshot.status === 'published')))
})

test('an imported draft becomes an existing published plan using its original ID instead of creating a second plan', async t => {
  const f = fixture(t), parsed = await parsedFile(t, f, completeMonthly(f.member.id))
  const draftBatch = setMode(f, parsed.batch, 'draft')
  const draft = f.service.commit(f.actor, draftBatch.id, { version: draftBatch.version })
  const planId = draft.rows[0].result!.id
  assert.equal(f.store.get<MonthlyPlan>('plans', planId)!.status, 'draft')
  const copied = fork(f.store, f.actor, draft)
  const next = await f.service.analyze(f.actor, copied.id, { version: copied.version })
  const existing = setMode(f, next, 'existing')
  assert.equal(existing.rows[0].id, draft.rows[0].id)
  const committed = f.service.commit(f.actor, existing.id, { version: existing.version })
  assert.equal(committed.rows[0].result!.id, planId)
  assert.equal(committed.activatedCount, 1)
  assert.equal(committed.committedCount, 0)
  assert.equal(f.store.list('plans').length, 1)
  assert.equal(f.store.get<MonthlyPlan>('plans', planId)!.status, 'published')
  assert.equal(f.store.get<MonthlyPlan>('plans', planId)!.actualOutcome, '原表中保存的实际成果')
})

test('legacy draft link keys activate related monthly and weekly records using all original business IDs', async t => {
  const f = fixture(t), parsed = await parsedFile(t, f, [completeMonthly(f.member.id), weekly(f.member.id, { dueDate: '2026-09-11' })])
  parsed.batch.rows[1].linkedRowId = parsed.batch.rows[0].id
  const draftBatch = setMode(f, parsed.batch, 'draft')
  const key = (rowId: string, suffix: string) => createHash('sha256').update(`${draftBatch.sourceId}:${rowId}:${suffix}`).digest('hex')
  const originalInsert = f.store.insert.bind(f.store)
  const oldRelease = t.mock.method(f.store, 'insert', function <T extends Entity>(collection: string, input: Omit<T, keyof Entity> & Partial<Entity>): T {
    if (collection !== 'importLinks') return originalInsert<T>(collection, input)
    const legacy = { ...input, id: key((input as unknown as { rowId: string }).rowId, 'draft') } as typeof input & { mode?: string; executionFingerprint?: string }
    delete legacy.mode
    delete legacy.executionFingerprint
    return originalInsert<T>(collection, legacy)
  })
  const draft = f.service.commit(f.actor, draftBatch.id, { version: draftBatch.version })
  oldRelease.mock.restore()
  const planId = draft.rows[0].result!.id, weekId = draft.rows[1].result!.id
  const taskId = f.store.get<WeeklyRecord>('weeklyRecords', weekId)!.taskId
  for (const row of draft.rows) {
    assert.ok(f.store.get('importLinks', key(row.id, 'draft')))
    assert.equal(f.store.get('importLinks', key(row.id, 'operational')), undefined)
  }
  const copied = fork(f.store, f.actor, draft)
  const next = await f.service.analyze(f.actor, copied.id, { version: copied.version })
  next.rows[1].linkedRowId = next.rows[0].id
  const existing = setMode(f, next, 'existing')
  const committed = f.service.commit(f.actor, existing.id, { version: existing.version })
  assert.deepEqual(committed.rows.map(row => row.result), draft.rows.map(row => row.result))
  assert.equal(committed.activatedCount, 2)
  assert.equal(committed.committedCount, 0)
  assert.equal(committed.skippedCount, 0)
  assert.equal(f.store.get<MonthlyPlan>('plans', planId)!.status, 'published')
  const week = f.store.get<WeeklyRecord>('weeklyRecords', weekId)!
  assert.equal(week.submitted, true)
  assert.equal(week.taskId, taskId)
  assert.equal(week.monthlyPlanId, planId)
  for (const collection of ['plans', 'tasks', 'weeklyRecords']) assert.equal(f.store.list(collection).length, 1)
  assert.equal(f.store.list('historicalRecords').length, 2)
  assert.equal(f.service.source(f.actor, committed.id).base64, parsed.bytes.toString('base64'))
})

test('model output cannot mark imported monthly results accepted or supply confirmation choices', async t => {
  const f = fixture(t), parsed = await parsedFile(t, f, monthly(f.member.id, { monthlyResult: 'accepted', weeklyStatus: 'done' }))
  assert.equal(parsed.batch.rows[0].monthlyResult, undefined)
  assert.equal(parsed.batch.rows[0].weeklyStatus, undefined)
  const existing = setMode(f, parsed.batch, 'existing')
  const committed = f.service.commit(f.actor, existing.id, { version: existing.version })
  assert.equal(f.store.get<MonthlyPlan>('plans', committed.rows[0].result!.id)!.acceptanceStatus, 'submitted')
})

test('activating a same-source imported draft rejects manual changes instead of overwriting them', async t => {
  const f = fixture(t), parsed = await parsedFile(t, f, completeMonthly(f.member.id))
  const draftBatch = setMode(f, parsed.batch, 'draft')
  const draft = f.service.commit(f.actor, draftBatch.id, { version: draftBatch.version })
  const planId = draft.rows[0].result!.id, plan = f.store.get<MonthlyPlan>('plans', planId)!
  const changed = f.domain.updatePlan(f.actor, plan.id, { version: plan.version, title: '人工修改后的计划标题' })
  const copied = fork(f.store, f.actor, draft)
  const next = await f.service.analyze(f.actor, copied.id, { version: copied.version })
  const existing = setMode(f, next, 'existing')
  assert.throws(() => f.service.commit(f.actor, existing.id, { version: existing.version }), { status: 409 })
  assert.deepEqual(f.store.get<MonthlyPlan>('plans', planId), changed)
  assert.equal(f.store.list('plans').length, 1)
  assert.equal(f.service.get(f.actor, existing.id).status, 'parsed')
})

test('existing commit retries and another batch reusing the already active source item do not duplicate plans', async t => {
  const f = fixture(t), parsed = await parsedFile(t, f, monthly(f.member.id))
  const batch = setMode(f, parsed.batch, 'existing')
  const first = f.service.commit(f.actor, batch.id, { version: batch.version })
  f.service.commit(f.actor, batch.id, { version: batch.version })
  const copied = fork(f.store, f.actor, first)
  const next = await f.service.analyze(f.actor, copied.id, { version: copied.version })
  const existing = setMode(f, next, 'existing')
  const repeated = f.service.commit(f.actor, existing.id, { version: existing.version })
  assert.equal(f.store.list('plans').length, 1)
  assert.deepEqual(repeated.rows[0].result, first.rows[0].result)
  assert.equal(repeated.skippedCount, 1)
  assert.equal(repeated.committedCount, 0)
})

test('members request confirmation while only a manager can activate their existing plans, and editing clears that request', t => {
  const f = fixture(t)
  let batch = f.service.structured(f.member, { sourceKey: 'member-existing', mode: 'existing', rows: [monthly(f.member.id)] })
  assert.equal(batch.mode, 'existing')
  assert.throws(() => f.service.commit(f.member, batch.id, { version: batch.version }), { status: 403 })
  assert.equal(f.store.list('plans').length, 0)
  batch = f.service.requestConfirmation(f.member, batch.id, { version: batch.version })
  assert.ok(batch.reviewRequestedAt && Number.isFinite(Date.parse(batch.reviewRequestedAt)))
  batch = f.service.edit(f.member, batch.id, { version: batch.version, mode: 'existing', rows: batch.rows.map(row => ({ ...row, title: '成员校对后的既有计划' })) })
  assert.ok(!batch.reviewRequestedAt)
  batch = f.service.requestConfirmation(f.member, batch.id, { version: batch.version })
  const forManager = f.service.get(f.actor, batch.id)
  assert.equal(forManager.ownerId, f.member.id)
  const confirmed = f.service.commit(f.actor, forManager.id, { version: forManager.version })
  const plan = f.store.get<ImportedPlan>('plans', confirmed.rows[0].result!.id)!
  assert.equal(plan.status, 'published')
  assert.equal(plan.ownerId, f.member.id)
  assert.equal(plan.title, '成员校对后的既有计划')
  assert.equal(plan.importSource!.sourceId, batch.sourceId)
})

test('another member cannot view, confirm, edit or commit somebody else\'s existing import source', t => {
  const f = fixture(t)
  const other = f.domain.createUser(f.actor, { name: '其他成员', email: 'other-existing@example.test', password: 'Synthetic-pass-2026!', position: '研发', role: 'member' })
  const batch = f.service.structured(f.member, { sourceKey: 'private-existing', mode: 'existing', rows: [monthly(f.member.id)] })
  assert.throws(() => f.service.source(other, batch.id), { status: 403 })
  assert.throws(() => f.service.requestConfirmation(other, batch.id, { version: batch.version }), { status: 403 })
  assert.throws(() => f.service.edit(other, batch.id, { version: batch.version, mode: 'existing', rows: batch.rows }), { status: 403 })
  assert.throws(() => f.service.commit(other, batch.id, { version: batch.version }), { status: 403 })
  assert.equal(f.store.list('plans').length, 0)
  assert.equal(f.service.get(f.member, batch.id).ownerId, f.member.id)
})

test('existing monthly and weekly source rows activate together and retain their explicit within-batch relationship', t => {
  const f = fixture(t)
  let batch = f.service.structured(f.actor, { sourceKey: 'existing-linked', mode: 'existing', rows: [monthly(f.member.id), weekly(f.member.id)] })
  batch.rows[1].linkedRowId = batch.rows[0].id
  batch = f.service.edit(f.actor, batch.id, { version: batch.version, mode: 'existing', rows: batch.rows })
  const committed = f.service.commit(f.actor, batch.id, { version: batch.version })
  const plan = f.store.list<ImportedPlan>('plans')[0], week = f.store.list<ImportedWeek>('weeklyRecords')[0], task = f.store.get<ImportedTask>('tasks', week.taskId)!
  assert.equal(plan.status, 'published')
  assert.equal(week.monthlyPlanId, plan.id)
  assert.equal(task.monthlyPlanId, plan.id)
  assert.equal(task.isTemporary, false)
  assert.equal(week.submitted, true)
  assert.equal(week.actualOutcome, '原周成果')
  assert.equal(week.status, 'done')
  assert.equal(week.importSource!.rowId, committed.rows[1].id)
  assert.equal(task.importSource!.sourceId, batch.sourceId)
})

test('an existing week with no monthly relationship remains real imported work without fabricating a monthly plan or temporary task', t => {
  const f = fixture(t)
  const batch = f.service.structured(f.actor, { sourceKey: 'existing-week-alone', mode: 'existing', rows: [weekly(f.member.id, { expectedOutcome: '', dueDate: '', sourceStatus: '未完成' })] })
  const committed = f.service.commit(f.actor, batch.id, { version: batch.version })
  const week = f.store.get<ImportedWeek>('weeklyRecords', committed.rows[0].result!.id)!, task = f.store.get<ImportedTask>('tasks', week.taskId)!
  assert.equal(f.store.list('plans').length, 0)
  assert.equal(week.monthlyPlanId, null)
  assert.equal(task.monthlyPlanId, null)
  assert.equal(task.isTemporary, false)
  assert.equal(task.temporaryReason, '')
  assert.equal(week.submitted, true)
  assert.equal(week.status, 'not_done')
  assert.equal(week.actualOutcome, '原周成果')
  assert.equal(week.importSource!.sourceId, batch.sourceId)
  assert.equal(task.importSource!.sourceId, batch.sourceId)
})

test('monthly acceptance requires an explicit confirmed result and real actual outcome, not merely a completed source status', t => {
  const f = fixture(t)
  const batch = f.service.structured(f.actor, { sourceKey: 'explicit-existing-result', mode: 'existing', rows: [monthly(f.member.id, { monthlyResult: 'accepted' })] })
  const committed = f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.equal(f.store.get<MonthlyPlan>('plans', committed.rows[0].result!.id)!.acceptanceStatus, 'accepted')
  const incomplete = f.service.structured(f.actor, { sourceKey: 'missing-accepted-outcome', mode: 'existing', rows: [monthly(f.member.id, { monthlyResult: 'accepted', actualOutcome: '' })] })
  assert.throws(() => f.service.commit(f.actor, incomplete.id, { version: incomplete.version }), { status: 400 })
  assert.equal(f.store.list('plans').length, 1)
})

test('a failure after the first existing plan write rolls back all activated records and leaves the source retryable', t => {
  const f = fixture(t)
  const batch = f.service.structured(f.actor, { sourceKey: 'existing-atomic', mode: 'existing', rows: [monthly(f.member.id), monthly(f.member.id, { title: '第二个原计划', sourceRow: 3 })] })
  const sourceBefore = f.service.source(f.actor, batch.id), auditCount = f.store.list('events').length
  const originalInsert = f.store.insert.bind(f.store)
  let planWrites = 0
  const injection = t.mock.method(f.store, 'insert', function <T extends Entity>(collection: string, input: Omit<T, keyof Entity> & Partial<Entity>): T {
    if (collection === 'plans' && ++planWrites === 2) throw new Error('synthetic second plan write failure')
    return originalInsert<T>(collection, input)
  })
  assert.throws(() => f.service.commit(f.actor, batch.id, { version: batch.version }), /synthetic second plan write failure/)
  assert.equal(planWrites, 2)
  for (const collection of ['plans', 'tasks', 'weeklyRecords', 'publications', 'historicalRecords', 'importLinks']) assert.equal(f.store.list(collection).length, 0, `${collection} must roll back`)
  assert.equal(f.store.list('events').length, auditCount)
  assert.equal(f.service.get(f.actor, batch.id).status, 'parsed')
  assert.equal(f.service.get(f.actor, batch.id).version, batch.version)
  assert.deepEqual(f.service.source(f.actor, batch.id), sourceBefore)
  injection.mock.restore()
  const retried = f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.equal(retried.committedCount, 2)
  assert.equal(f.store.list<MonthlyPlan>('plans').filter(plan => plan.status === 'published').length, 2)
})
