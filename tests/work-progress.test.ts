import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { workProgressProjector } from '../server/work-progress.ts'
import type { AuditEvent, Task, WeeklyRecord } from '../shared/types.ts'
import type { ProgressEvent } from '../shared/collaboration.ts'

function fixture() {
  const store = new Store(':memory:'), domain = new Domain(store)
  const actor = domain.setup({ name: '核对', email: 'progress@example.test', password: 'Progress-test-2026!' })
  const task = domain.createTask(actor, { title: '真实进展', description: '完整成果', dueDate: '2026-09-30', isTemporary: true, temporaryReason: '验证' })
  return { store, domain, actor, task }
}
test('base progress and blocker facts persist with collaboration disabled without notification derivation', () => {
  const f = fixture()
  try {
    const task = f.domain.updateTask(f.actor, f.task.id, { version: f.task.version, currentProgress: '总体方案已形成', status: 'blocked', blockerReason: '缺数据', blockerImpact: '联调等待', supportNeeded: '协调数据' })
    assert.equal(f.store.list<ProgressEvent>('progressEvents').length, 1)
    assert.equal(f.store.list('blockerEpisodes').length, 1)
    assert.equal(f.store.list('businessNotificationEvents').length, 0)
    const before = workProgressProjector(f.store, f.actor)(task)
    const renamed = f.domain.updateTask(f.actor, task.id, { reason: '测试场景确认承诺调整', version: task.version, title: '更清晰的标题' })
    const after = workProgressProjector(f.store, f.actor)(renamed)
    assert.deepEqual(after, before)
    assert.equal(f.store.list<ProgressEvent>('progressEvents').length, 1)
  } finally { f.store.close() }
})
test('weekly execution stays separate from overall prose; deleted and future weeks cannot win', () => {
  const f = fixture()
  try {
    const task = f.domain.updateTask(f.actor, f.task.id, { version: 1, currentProgress: '早先总体说明' })
    const weekly = f.domain.createWeeklyRecord(f.actor, { taskId: task.id, weekStart: '2026-09-21', commitment: '本周验证', actualOutcome: '本周已验证接口', submitted: true, status: 'done' })
    // Controlled audit/event timestamps make the ordering independent of execution speed.
    for (const event of f.store.list<ProgressEvent>('progressEvents')) f.store.update<ProgressEvent>('progressEvents', event.id, event.version, { occurredAt: event.weeklyRecordId ? '2026-09-22T03:00:00Z' : '2026-09-21T03:00:00Z' })
    f.domain.createWeeklyRecord(f.actor, { taskId: task.id, weekStart: '2026-10-05', commitment: '未来承诺', actualOutcome: '未来记录内容', submitted: true, status: 'doing' })
    const view = workProgressProjector(f.store, f.actor, new Date('2026-09-22T08:00:00Z'))(task)
    assert.equal(view.overallProgress?.text, '早先总体说明')
    assert.equal(view.latestExecution?.text, '本周已验证接口')
    assert.equal(view.latestExecution?.weekStart, '2026-09-21')
    f.store.update<WeeklyRecord>('weeklyRecords', weekly.id, weekly.version, { deletion: { deletedAt: '2026-09-22T04:00:00Z', deletedBy: f.actor.id, reason: '撤回错误记录' } })
    const without = workProgressProjector(f.store, f.actor, new Date('2026-09-22T08:00:00Z'))(task)
    assert.equal(without.latestExecution?.text, '早先总体说明')
    assert.ok(!without.historicalExecution.some(row => row.text === '本周已验证接口'))
  } finally { f.store.close() }
})
test('legacy text has unknown time until an actual field audit supports reconstruction', () => {
  const f = fixture()
  try {
    const legacy = f.store.update<Task>('tasks', f.task.id, f.task.version, { currentProgress: '旧导入总体说明', completionNote: '历史交付说明' })
    const unknown = workProgressProjector(f.store, f.actor)(legacy)
    assert.equal(unknown.overallProgress?.changedAt, null)
    assert.equal(unknown.latestExecution, null)
    assert.ok(unknown.historicalExecution.every(row => row.evidenceQuality === 'unknown' && row.recordedAt === null))
    f.store.insert<AuditEvent>('events', { entityType: 'task', entityId: legacy.id, actorId: f.actor.id, action: 'update', reason: '', before: f.task, after: legacy })
    const known = workProgressProjector(f.store, f.actor)(legacy)
    assert.equal(known.latestExecution?.evidenceQuality, 'audit_reconstructed')
    assert.notEqual(known.overallProgress?.changedAt, null)
  } finally { f.store.close() }
})

test('normalized punctuation and multiple evidence fields do not invent unknown historical facts', () => {
  const f = fixture()
  try {
    const task = f.domain.updateTask(f.actor, f.task.id, { version: f.task.version, currentProgress: '总体结论：实验通过', status: 'done', completionNote: '完成说明：已归档' })
    const result = workProgressProjector(f.store, f.actor)(task)
    assert.equal(result.historicalExecution.length, 0)
    assert.ok(result.overallProgress?.changedAt)
    assert.equal(result.overallProgress?.evidenceRef, f.store.list<ProgressEvent>('progressEvents')[0].id)
  } finally { f.store.close() }
})
