import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { readImportContext } from '../server/import-context.ts'
import { ExistingPlanWriter } from '../server/existing-plan-writer.ts'
import { ImportService } from '../server/import-service.ts'
import type { AuditEvent, MonthlyPlan, Report } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), imports = new ImportService(store)
  const manager = domain.setup({ name: '删除迁移管理员', email: 'manager@plan-deletion-transfer.test', password: 'Fixture-password-2026!' })
  const member = domain.createUser(manager, { name: '删除迁移成员', email: 'member@plan-deletion-transfer.test', password: 'Fixture-password-2026!', role: 'member' })
  t.after(() => { imports.close(); store.close() })
  const create = () => domain.createPlan(manager, { ownerId: member.id, month: '2026-11', title: '重复月度目标', category: '研发', dueDate: '2026-11-30', expectedOutcome: '交付模型', acceptanceCriteria: '测试通过' })
  return { store, domain, manager, member, imports, create }
}

test('deleted monthly targets round-trip with mapped deletion actors and unchanged historical snapshots', t => {
  const source = fixture(t), target = fixture(t), plan = source.create()
  const report = source.store.insert<Report>('reports', { type: 'monthly', period: plan.month, title: '删除前快照', status: 'draft', revision: 1, narrative: '原始事实', authorId: source.manager.id, finalizedAt: null,
    snapshot: { plans: [plan], nextPlans: [], tasks: [], weeklyRecords: [], nextWeeklyRecords: [], projects: [], users: [source.manager, source.member], annualGoals: [], publications: [], changes: [] } })
  const deleted = source.domain.deletePlan(source.manager, plan.id, { version: plan.version, reason: '已确认与保留目标重复' })
  const packet = exportBusinessData(source.store, source.manager)
  assert.deepEqual(packet.collections.plans.find(row => row.id === plan.id)?.deletion, deleted.deletion)
  assert.equal(packet.collections.reports.find(row => row.id === report.id)!.snapshot.plans[0].deletion, undefined)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  const restored = target.store.get<MonthlyPlan>('plans', plan.id)!
  assert.deepEqual(restored.deletion, { ...deleted.deletion, deletedBy: target.manager.id })
  assert.equal(restored.status, plan.status)
  const audit = target.store.list<AuditEvent>('events').find(event => event.entityType === 'plan' && event.entityId === plan.id && (event.after as MonthlyPlan | null)?.deletion)!
  assert.equal((audit.after as MonthlyPlan).deletion!.deletedBy, target.manager.id)
  assert.equal((audit.before as MonthlyPlan).deletion, undefined)
  assert.equal(target.store.get<Report>('reports', report.id)!.snapshot.plans[0].deletion, undefined)
  for (const actor of [target.manager, target.member]) assert.ok(!readImportContext(target.store, actor).plans.some(row => row.id === plan.id))
})

test('former participants can export deleted history without exposing later deletion reasons or rewriting the old snapshot', t => {
  const source = fixture(t), target = fixture(t), plan = source.create()
  const peer = source.domain.createUser(source.manager, { name: '接手成员', email: 'successor@plan-deletion-transfer.test', password: 'Fixture-password-2026!', role: 'member' })
  const moved = source.domain.updatePlan(source.manager, plan.id, { version: plan.version, ownerId: peer.id, title: '交接后的私有标题', expectedOutcome: '交接后的私有内容' })
  source.domain.deletePlan(source.manager, moved.id, { version: moved.version, reason: '接手成员的私有删除原因' })
  const packet = exportBusinessData(source.store, source.member)
  const historical = packet.collections.plans.find(row => row.id === plan.id)!
  assert.equal(historical.visibility, 'historical')
  assert.equal(historical.deletion?.reason, '目标已删除，删除原因不在当前查看范围')
  assert.equal(historical.version, plan.version)
  assert.equal(historical.updatedAt, plan.updatedAt)
  assert.doesNotMatch(JSON.stringify(packet), /交接后的私有|接手成员的私有删除原因/)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, false)
  assert.match(preview.issues.join('\n'), /参考或历史投影不能作为真实目标恢复/)
  assert.equal(target.store.list('plans').length, 0)
})

test('monthly deletion migration rejects invalid times, published tombstones and dangling deletion actors', t => {
  const source = fixture(t), target = fixture(t), plan = source.create()
  source.domain.deletePlan(source.manager, plan.id, { version: plan.version, reason: '重复目标' })
  const packet = exportBusinessData(source.store, source.manager)
  const tooEarly = structuredClone(packet)
  tooEarly.collections.plans[0].deletion!.deletedAt = '2000-01-01T00:00:00.000Z'
  assert.match(previewRestore(target.store, target.manager, tooEarly).issues.join('\n'), /删除时间/)
  const published = structuredClone(packet)
  published.collections.plans[0].status = 'published'
  published.collections.plans[0].publishedVersion = 1
  assert.match(previewRestore(target.store, target.manager, published).issues.join('\n'), /已删除月目标必须为未发布/)
  const missingActor = structuredClone(packet)
  missingActor.collections.plans[0].deletion!.deletedBy = 'missing-deletion-actor'
  assert.match(previewRestore(target.store, target.manager, missingActor).issues.join('\n'), /missing-deletion-actor/)
  assert.equal(target.store.list('plans').length, 0)
})

test('restore validates live task and weekly references to deleted monthly targets atomically', t => {
  const source = fixture(t), target = fixture(t), plan = source.create()
  const task = source.domain.createTask(source.member, { title: '目标下的任务', monthlyPlanId: plan.id, dueDate: '2026-11-13' })
  source.domain.createWeeklyRecord(source.member, { taskId: task.id, weekStart: '2026-11-09', commitment: '完成测试', submitted: false })
  source.store.update<MonthlyPlan>('plans', plan.id, plan.version, { deletion: { deletedAt: new Date().toISOString(), deletedBy: source.manager.id, reason: '构造非法迁移依赖' } })
  const packet = exportBusinessData(source.store, source.manager)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, false)
  assert.match(preview.issues.join('\n'), /已删除月目标不能保留有效任务/)
  assert.match(preview.issues.join('\n'), /已删除月目标不能保留有效周安排/)
  const collections = ['plans', 'tasks', 'weeklyRecords', 'events']
  const before = collections.map(name => target.store.list(name))
  assert.throws(() => restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint), { status: 409 })
  collections.forEach((name, index) => assert.deepEqual(target.store.list(name), before[index]))
})

test('existing-plan writer explicitly rejects activation of a deleted imported draft', t => {
  const f = fixture(t)
  const batch = f.imports.structured(f.manager, { sourceKey: 'deleted-activation', mode: 'draft', rows: [{ kind: 'monthly', ownerId: f.member.id, title: '导入草稿', month: '2026-11', category: '研发', dueDate: '2026-11-30', expectedOutcome: '交付模型', acceptanceCriteria: '测试通过' }] })
  const committed = f.imports.commit(f.manager, batch.id, { version: batch.version })
  const plan = f.store.get<MonthlyPlan>('plans', committed.rows[0].result!.id)!
  const deleted = f.domain.deletePlan(f.manager, plan.id, { version: plan.version, reason: '重复目标' })
  const writer = new ExistingPlanWriter(f.store, f.manager, batch)
  assert.throws(() => writer.monthly(committed.rows[0], plan.id), /原目标已删除，请排除此来源并核对保留的目标/)
  assert.deepEqual(f.store.get('plans', plan.id), deleted)
  assert.equal(f.store.list('publications').length, 0)
})
