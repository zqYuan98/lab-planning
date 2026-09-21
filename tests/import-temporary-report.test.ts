import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { ImportService } from '../server/import-service.ts'
import { exportMarkdown, generateReport } from '../server/reports.ts'
import { snapshotWarnings, weeklyAssociationLabel } from '../server/report-metrics.ts'
import type { Report, Task, WeeklyRecord } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), imports = new ImportService(store)
  t.after(() => { imports.close(); store.close() })
  const manager = domain.setup({ name: '报告核对管理员', email: 'temporary-report@example.test', password: 'Fixture-password-2026!' })
  const reason = '领导临时交办本周客户演示保障'
  const batch = imports.structured(manager, { sourceKey: 'temporary-and-unlinked-report', mode: 'existing', rows: [
    { kind: 'weekly', title: '临时演示支持', ownerId: manager.id, weekStart: '2026-09-14', expectedOutcome: '保障演示', isTemporary: true, temporaryReason: reason },
    { kind: 'weekly', title: '原表未注明归属的常规工作', ownerId: manager.id, weekStart: '2026-09-14', expectedOutcome: '整理已有资料' },
  ] })
  const saved = imports.commit(manager, batch.id, { version: batch.version })
  const temporary = store.get<WeeklyRecord>('weeklyRecords', saved.rows[0].result!.id)!
  const ordinary = store.get<WeeklyRecord>('weeklyRecords', saved.rows[1].result!.id)!
  return { store, domain, manager, reason, temporary, ordinary }
}

test('reports distinguish imported temporary assignments from ordinary unlinked imports and retain assignment reasons', t => {
  const f = fixture(t)
  const report = generateReport(f.store, 'weekly', '2026-09-14', f.manager.id)
  assert.equal(weeklyAssociationLabel(report.snapshot, f.temporary), `当期为临时工作；生成报告时仍待补关联；临时原因：${f.reason}`)
  assert.equal(weeklyAssociationLabel(report.snapshot, f.ordinary), '原资料导入时未关联月计划；生成报告时仍未关联')
  const warnings = snapshotWarnings(report)
  assert.ok(warnings.some(value => value.startsWith('「临时演示支持」当期为临时工作')))
  assert.ok(warnings.some(value => value.startsWith('「原表未注明归属的常规工作」原资料导入时未关联月计划')))
  const markdown = exportMarkdown(report)
  assert.ok(markdown.includes(`临时原因：${f.reason}`))
  assert.ok(markdown.includes('原资料导入时未关联月计划；生成报告时仍未关联'))
})

test('relinking imported work preserves historical temporary attribution and the frozen report reason', t => {
  const f = fixture(t)
  const before = generateReport(f.store, 'weekly', '2026-09-14', f.manager.id)
  let plan = f.domain.createPlan(f.manager, { month: '2026-09', title: '九月客户保障', category: '部门工作', expectedOutcome: '完成保障', acceptanceCriteria: '交付记录', dueDate: '2026-09-30' })
  plan = f.domain.submitPlan(f.manager, plan.id, { version: plan.version })
  plan = f.domain.reviewPlan(f.manager, plan.id, { version: plan.version, decision: 'approve', comment: '' })
  f.domain.publishMonth(f.manager, '2026-09', { planIds: [plan.id] })
  for (const record of [f.temporary, f.ordinary]) {
    const task = f.store.get<Task>('tasks', record.taskId)!
    f.domain.relinkTask(f.manager, task.id, { version: task.version, monthlyPlanId: plan.id, reason: '补充后续月度归属' })
  }
  const after = generateReport(f.store, 'weekly', '2026-09-14', f.manager.id)
  assert.equal(after.snapshot.tasks.find(task => task.id === f.temporary.taskId)!.isTemporary, false)
  assert.equal(after.snapshot.weeklyRecords.find(record => record.id === f.temporary.id)!.monthlyPlanId, null)
  assert.equal(weeklyAssociationLabel(after.snapshot, f.temporary), `当期为临时工作；生成报告时任务已补关联：2026-09 · 九月客户保障；临时原因：${f.reason}`)
  assert.equal(weeklyAssociationLabel(after.snapshot, f.ordinary), '原资料导入时未关联月计划；生成报告时任务已补关联：2026-09 · 九月客户保障')
  assert.ok(!snapshotWarnings(after).some(value => value.includes('仍未补充月计划关联')))
  const frozenBefore = f.store.get<Report>('reports', before.id)!
  assert.equal(weeklyAssociationLabel(frozenBefore.snapshot, f.temporary), `当期为临时工作；生成报告时仍待补关联；临时原因：${f.reason}`)
  const task = f.store.get<Task>('tasks', f.temporary.taskId)!
  assert.throws(() => f.domain.updateTask(f.manager, task.id, { version: task.version, temporaryReason: '替换历史交办说明' }), /不能直接修改/)
  assert.ok(exportMarkdown(f.store.get<Report>('reports', after.id)!).includes(`临时原因：${f.reason}`))
})
