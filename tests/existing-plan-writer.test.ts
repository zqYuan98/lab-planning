import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { ImportRow } from '../shared/import-types.ts'
import type { AuditEvent, MonthlyPlan, Publication, Task, WeeklyRecord } from '../shared/types.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { ExistingPlanWriter, validateExistingRow } from '../server/existing-plan-writer.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:')
  t.after(() => store.close())
  const domain = new Domain(store)
  const manager = domain.setup({ name: '管理者', email: 'manager@existing.test', password: 'Fixture-password-2026!' })
  const member = domain.createUser(manager, { name: '成员', email: 'member@existing.test', password: 'Fixture-password-2026!', role: 'member' })
  return { store, domain, manager, member }
}
function row(ownerId: string, patch: Partial<ImportRow> = {}): ImportRow {
  return { id: 'source-row-1', kind: 'monthly', selected: true, sourceSheet: '原表', sourceRow: 1, sourceText: '', ownerName: '成员', ownerId,
    projectName: '', projectId: '', category: '', title: '原表已有工作', month: '2026-09', weekStart: '', dueDate: '', expectedOutcome: '', acceptanceCriteria: '',
    actualOutcome: '', blocker: '', nextAction: '', sourceStatus: '', monthlyPlanId: '', linkedRowId: '', taskId: '', issues: [], ...patch }
}

test('existing monthly plans publish directly with one complete snapshot per month and honest result states', t => {
  const f = fixture(t)
  const imported = f.store.transaction(() => {
    const writer = new ExistingPlanWriter(f.store, f.manager, { id: 'batch-1', sourceId: 'source-1' })
    const first = writer.monthly(row(f.member.id, { sourceStatus: '已完成', actualOutcome: '原表成果' }))
    const second = writer.monthly(row(f.member.id, { id: 'source-row-2', monthlyResult: 'accepted', actualOutcome: '明确验收成果' }))
    writer.monthly(row(f.member.id, { id: 'source-row-3', month: '2026-10' }))
    writer.finish(); writer.finish()
    return { first, second }
  })
  assert.equal(imported.first.status, 'published')
  assert.equal(imported.first.version, 1)
  assert.equal(imported.first.acceptanceStatus, 'submitted')
  assert.equal(imported.second.acceptanceStatus, 'accepted')
  assert.equal(imported.first.publishedVersion, imported.second.publishedVersion)
  assert.equal(imported.first.dueDate, '')
  assert.equal(imported.first.importSource?.sourceStatus, '已完成')
  const publications = f.store.list<Publication>('publications')
  assert.equal(publications.length, 2)
  assert.equal(publications.find(item => item.month === '2026-09')!.plans.length, 2)
  const events = f.store.list<AuditEvent>('events').filter(event => event.entityType === 'plan')
  assert.equal(events.length, 3)
  assert.ok(events.every(event => event.action === 'import_existing' && event.actorId === f.manager.id && event.before === null))
})

test('imported omissions stay editable while ordinary creation remains strict', t => {
  const f = fixture(t)
  const imported = f.store.transaction(() => {
    const writer = new ExistingPlanWriter(f.store, f.manager, { id: 'batch-2', sourceId: 'source-2' })
    const plan = writer.monthly(row(f.member.id))
    const weekly = writer.weekly(row(f.member.id, { id: 'weekly-1', kind: 'weekly', weekStart: '2026-09-09', sourceStatus: '已完成', sourceText: '文'.repeat(20000) }))
    writer.finish()
    return { plan, weekly }
  })
  assert.equal(imported.weekly.weekStart, '2026-09-07')
  assert.equal(imported.weekly.status, 'done')
  assert.equal(imported.weekly.submitted, true)
  assert.equal(imported.weekly.monthlyPlanId, null)
  const task = f.store.get<Task>('tasks', imported.weekly.taskId)!
  assert.equal(task.monthlyPlanId, null)
  assert.equal(task.isTemporary, false)
  assert.equal(task.temporaryReason, '')
  assert.equal(task.description.length, 20000)
  const updatedPlan = f.domain.updatePlan(f.manager, imported.plan.id, { version: imported.plan.version, title: '补充标题', dueDate: '', expectedOutcome: '', acceptanceCriteria: '', reason: '保留原表缺项' })
  const updatedWeek = f.domain.updateWeeklyRecord(f.member, imported.weekly.id, { version: imported.weekly.version, commitment: '', actualOutcome: '', blocker: '', nextAction: '下一步核对' })
  const updatedTask = f.domain.updateTask(f.member, task.id, { version: task.version, dueDate: '', description: task.description, title: '调整名称' })
  assert.equal(updatedPlan.dueDate, '')
  assert.equal(updatedWeek.actualOutcome, '')
  assert.equal(updatedTask.description.length, 20000)
  assert.throws(() => f.domain.createPlan(f.member, { month: '2026-09', title: '普通新计划', importSource: imported.plan.importSource }), { status: 400 })
  assert.throws(() => f.domain.createTask(f.member, { title: '普通新任务', isTemporary: false, importSource: task.importSource }), { status: 400 })
  assert.throws(() => f.domain.createWeeklyRecord(f.member, { taskId: task.id, weekStart: '2026-09-14', commitment: '', importSource: imported.weekly.importSource }), { status: 400 })
})

test('existing draft IDs are promoted without touching reused task status and edited drafts are rejected', t => {
  const f = fixture(t)
  const draft = f.domain.createPlan(f.member, { month: '2026-09', title: '原草稿', category: '研发', expectedOutcome: '原成果计划', acceptanceCriteria: '原标准', dueDate: '2026-09-30' })
  let task = f.domain.createTask(f.member, { title: '既有任务', monthlyPlanId: draft.id, dueDate: '2026-09-12' })
  task = f.domain.updateTask(f.member, task.id, { version: task.version, status: 'doing' })
  const draftWeek = f.domain.createWeeklyRecord(f.member, { taskId: task.id, weekStart: '2026-09-07', commitment: '原周承诺', submitted: false })
  f.store.transaction(() => {
    const writer = new ExistingPlanWriter(f.store, f.manager, { id: 'batch-3', sourceId: 'source-3' })
    const plan = writer.monthly(row(f.member.id, { title: '原草稿' }), draft.id)
    const weekly = writer.weekly(row(f.member.id, { id: 'weekly-2', kind: 'weekly', weekStart: '2026-09-07', sourceStatus: '完成', actualOutcome: '已有成果' }), plan.id, draftWeek.id)
    assert.equal(plan.id, draft.id)
    assert.equal(weekly.id, draftWeek.id)
    assert.equal(weekly.taskId, task.id)
    writer.finish()
  })
  assert.equal(f.store.get<Task>('tasks', task.id)!.status, 'doing')
  assert.equal(f.store.list<MonthlyPlan>('plans').length, 1)
  assert.equal(f.store.list<WeeklyRecord>('weeklyRecords').length, 1)
  const another = f.domain.createPlan(f.member, { month: '2026-09', title: '手改草稿', category: '研发', expectedOutcome: '成果', acceptanceCriteria: '标准', dueDate: '2026-09-30' })
  f.domain.updatePlan(f.member, another.id, { version: another.version, title: '已手工修改' })
  assert.throws(() => new ExistingPlanWriter(f.store, f.manager, { id: 'batch-4', sourceId: 'source-4' }).monthly(row(f.member.id), another.id), { status: 409 })
})

test('shared preview detects invalid links and explicit accepted outcomes while activation remains manager-only', t => {
  const f = fixture(t)
  assert.deepEqual(validateExistingRow(f.store, f.member, row(f.member.id)), [])
  assert.throws(() => new ExistingPlanWriter(f.store, f.member, { id: 'batch-5', sourceId: 'source-5' }), { status: 403 })
  assert.ok(validateExistingRow(f.store, f.member, row(f.manager.id)).some(issue => issue.includes('自己的')))
  assert.ok(validateExistingRow(f.store, f.manager, row(f.member.id, { monthlyResult: 'accepted' })).some(issue => issue.includes('实际成果')))
  assert.ok(validateExistingRow(f.store, f.manager, row(f.member.id, { dueDate: '2026-10-01' })).some(issue => issue.includes('所属月份')))
  assert.ok(validateExistingRow(f.store, f.manager, row(f.member.id, { kind: 'weekly', weekStart: '2026-09-07', monthlyPlanId: 'missing' })).some(issue => issue.includes('已生效')))
  const monthly = row(f.member.id)
  const weekly = row(f.member.id, { id: 'linked-week', kind: 'weekly', weekStart: '2026-09-07', linkedRowId: monthly.id })
  assert.deepEqual(validateExistingRow(f.store, f.manager, weekly, [monthly, weekly]), [])
  assert.throws(() => f.store.transaction(() => {
    const writer = new ExistingPlanWriter(f.store, f.manager, { id: 'batch-5', sourceId: 'source-5' })
    writer.monthly(monthly)
    writer.weekly({ ...weekly, monthlyPlanId: 'missing' })
    writer.finish()
  }), { status: 400 })
  assert.equal(f.store.list('plans').length, 0)
  assert.equal(f.store.list('publications').length, 0)
})

test('import provenance and omissions survive business export and restore without remapping source identifiers', t => {
  const source = fixture(t), target = fixture(t)
  source.store.transaction(() => {
    const writer = new ExistingPlanWriter(source.store, source.manager, { id: source.manager.id, sourceId: source.member.id })
    writer.monthly(row(source.member.id, { id: source.member.id }))
    writer.weekly(row(source.member.id, { id: 'weekly-empty', kind: 'weekly', weekStart: '2026-09-07', sourceStatus: '阻塞', sourceText: '长'.repeat(20000) }))
    writer.finish()
  })
  const packet = exportBusinessData(source.store, source.manager)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  const plan = target.store.list<MonthlyPlan>('plans')[0]
  assert.equal(plan.ownerId, target.member.id)
  assert.deepEqual(plan.importSource, { batchId: source.manager.id, sourceId: source.member.id, rowId: source.member.id, sourceStatus: '' })
  assert.equal(target.store.list<WeeklyRecord>('weeklyRecords')[0].blocker, '')
  assert.equal(target.store.list<Task>('tasks')[0].description.length, 20000)
  const missingSource = structuredClone(packet)
  delete missingSource.collections.plans[0].importSource
  assert.throws(() => previewRestore(target.store, target.manager, missingSource), { status: 400 })
  const secret = structuredClone(packet)
  Object.assign(secret.collections.plans[0].importSource!, { apiKey: 'must-not-import' })
  assert.throws(() => previewRestore(target.store, target.manager, secret), { status: 400 })
  const stored = source.store.list<MonthlyPlan>('plans')[0]
  Object.assign(stored.importSource!, { apiKey: 'must-not-export' })
  source.store.update<MonthlyPlan>('plans', stored.id, stored.version, { importSource: stored.importSource })
  assert.doesNotMatch(JSON.stringify(exportBusinessData(source.store, source.manager)), /must-not-export|apiKey/)
})
