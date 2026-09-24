import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { generateReport } from '../server/reports.ts'
import { reportMetrics } from '../server/report-metrics.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import { targetAccessible } from '../server/notifications.ts'
import type { AuditEvent, Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { BlockerEpisode, FollowupRequest } from '../shared/collaboration.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store)
  t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.restoreEntity<User>('users', { id, version: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', name: id, email: `${id}@weekly-delete.test`, role, active: true, position: '' })
  const manager = user('manager', 'manager'), member = user('member', 'member')
  const task = domain.createTask(member, { title: '前期填报的工作', isTemporary: true, temporaryReason: '临时交办待补月目标', dueDate: '2026-09-30' })
  const record = domain.createWeeklyRecord(member, { taskId: task.id, weekStart: '2026-09-14', commitment: '完成阶段成果', actualOutcome: '完成初稿', submitted: true })
  return { store, domain, manager, member, task, record }
}

test('only administrator may delete with a nonempty reason and current version; audit failure rolls back', t => {
  const f = fixture(t), input = { version: f.record.version, reason: '月度目标开放后重新关联安排' }
  assert.throws(() => f.domain.deleteWeeklyRecord(f.member, f.record.id, input), { status: 403 })
  assert.throws(() => f.domain.deleteWeeklyRecord(f.manager, f.record.id, { ...input, reason: ' ' }), { status: 400 })
  assert.throws(() => f.domain.deleteWeeklyRecord(f.manager, f.record.id, { ...input, version: 999 }), { status: 409 })
  const insert = f.store.insert.bind(f.store)
  f.store.insert = ((collection: string, row: never) => { if (collection === 'events') throw new Error('audit unavailable'); return insert(collection, row) }) as typeof f.store.insert
  assert.throws(() => f.domain.deleteWeeklyRecord(f.manager, f.record.id, input), /audit unavailable/)
  assert.deepEqual(f.store.get('weeklyRecords', f.record.id), f.record)
})

test('deletion preserves task, other weeks, receipts and saved reports, then permits same-task same-week recreation', t => {
  const f = fixture(t)
  const other = f.domain.carryWeeklyRecord(f.member, f.record.id, { weekStart: '2026-09-21' })
  let now = new Date('2026-09-13T00:00:00.000Z')
  const service = new WeeklySubmissionService(f.store, () => now)
  service.getRule(); now = new Date('2026-09-18T07:00:00.000Z')
  const duty = service.view(f.member, '2026-09-14').duties.find(row => row.kind === 'results')!
  const receipt = service.submit(f.member, { dutyId: duty.id, version: duty.version, manifest: duty.manifest, progressEventIds: duty.progressEventIds, requestId: 'before-deletion-receipt' })
  const before = f.store.get<WeeklyRecord>('weeklyRecords', f.record.id)!
  const report = generateReport(f.store, 'weekly', f.record.weekStart, f.manager.id)
  const otherBeforeDeletion = f.store.get<WeeklyRecord>('weeklyRecords', other.id)
  const completedTask = f.store.update<Task>('tasks', f.task.id, f.task.version, { status: 'done' })
  const deleted = f.domain.deleteWeeklyRecord(f.manager, before.id, { version: before.version, reason: '误填，重新关联月度目标' })
  assert.equal(deleted.deletion?.deletedBy, f.manager.id)
  assert.equal(f.domain.bootstrap(f.member).weeklyRecords.some(row => row.id === before.id), false)
  assert.equal(f.domain.bootstrap(f.manager).weeklyRecords.some(row => row.id === before.id), false)
  assert.deepEqual(f.store.get('tasks', f.task.id), completedTask)
  assert.deepEqual(f.store.get('weeklyRecords', other.id), otherBeforeDeletion)
  assert.deepEqual(f.store.get('weeklySubmissions', receipt.id), receipt)
  assert.deepEqual(f.store.get<Report>('reports', report.id), report)
  const afterDuty = service.view(f.member, '2026-09-14').duties.find(row => row.id === duty.id)!
  assert.equal(afterDuty.status, 'on_time'); assert.equal(afterDuty.changedSinceSubmission, true)
  assert.equal(reportMetrics(generateReport(f.store, 'weekly', before.weekStart, f.manager.id).snapshot).weekly.total, 0)
  const replacement = f.domain.createWeeklyRecord(f.member, { taskId: f.task.id, weekStart: before.weekStart, commitment: '重新安排', submitted: true })
  assert.notEqual(replacement.id, before.id); assert.equal(replacement.taskId, f.task.id)
  assert.equal(f.store.list<AuditEvent>('events').filter(event => event.entityId === before.id && event.action === 'delete').length, 1)
  assert.throws(() => f.domain.updateWeeklyRecord(f.manager, before.id, { version: deleted.version, actualOutcome: '不能改已删项' }), { status: 409 })
  assert.throws(() => f.domain.carryWeeklyRecord(f.manager, before.id, { weekStart: '2026-10-05' }), { status: 409 })
  assert.throws(() => f.domain.deleteWeeklyRecord(f.manager, before.id, { version: deleted.version, reason: '再次删除' }), { status: 409 })
})

test('deleting a weekly row closes only its followup and blocker and invalidates notification access', t => {
  const f = fixture(t), collaboration = new CollaborationService(f.store, () => new Date('2026-09-14T02:00:00.000Z'))
  collaboration.updateSettings(f.manager, { requestId: 'enable-week-delete', version: 0, enabled: true, pilotUserIds: [f.member.id] })
  const result = collaboration.createFollowup(f.manager, f.task.id, { requestId: 'followup-week-delete', version: f.task.version, enroll: true, weeklyRecordId: f.record.id, weeklyRecordVersion: f.record.version, requirement: '更新进展', dueAt: '2026-09-20T00:00:00.000Z' })
  const blocker = f.store.insert<BlockerEpisode>('blockerEpisodes', { sourceType: 'weeklyRecord', sourceId: f.record.id, parentTaskId: f.task.id, ownerId: f.member.id, generation: 1, openedAt: '2026-09-14T01:00:00.000Z', openedBy: f.member.id, resolvedAt: null, resolvedBy: null, reason: '待支持', impact: '延迟', supportNeeded: '协调', reviewAt: null, closureReason: '' })
  f.domain.deleteWeeklyRecord(f.manager, f.record.id, { version: f.record.version, reason: '纠错重填' })
  assert.equal(f.store.get<FollowupRequest>('followupRequests', result.request.id)?.status, 'cancelled')
  assert.ok(f.store.get<BlockerEpisode>('blockerEpisodes', blocker.id)?.resolvedAt)
  assert.equal(targetAccessible(f.store, f.member, { type: 'weeklyRecord', id: f.record.id }), false)
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'todo')
})

test('administrator can delete the only temporary arrangement, relink its task and recreate that week under the monthly goal', t => {
  const f = fixture(t)
  const plan = f.domain.createPlan(f.manager, { month: '2026-09', title: '补开的月度临时目标', ownerId: f.member.id,
    category: '研究', expectedOutcome: '交付评测报告', acceptanceCriteria: '验收通过', dueDate: '2026-09-30',
    isTemporary: true, temporaryReason: '补充前期临时安排的月度归属' })
  const submitted = f.domain.submitPlan(f.manager, plan.id, { version: plan.version })
  f.domain.reviewPlan(f.manager, plan.id, { version: submitted.version, decision: 'approve' })
  f.domain.publishMonth(f.manager, plan.month, { planIds: [plan.id] })
  const deleted = f.domain.deleteWeeklyRecord(f.manager, f.record.id, { version: f.record.version, reason: '先删除错误安排再补月度关联' })
  const relinked = f.domain.relinkTask(f.manager, f.task.id, { version: f.task.version, monthlyPlanId: plan.id, reason: '补开的临时目标已发布' })
  assert.equal(relinked.id, f.task.id)
  assert.equal(relinked.isTemporary, false)
  assert.deepEqual(f.store.get<WeeklyRecord>('weeklyRecords', f.record.id), deleted, 'deleted history keeps its original monthly association')
  const replacement = f.domain.createWeeklyRecord(f.manager, { taskId: relinked.id, weekStart: f.record.weekStart, commitment: '按月度目标重新安排', submitted: true, creationKind: 'assigned' })
  assert.equal(replacement.monthlyPlanId, plan.id)
  assert.equal(replacement.taskId, f.task.id)
  assert.notEqual(replacement.id, f.record.id)
  assert.deepEqual(f.domain.bootstrap(f.manager).weeklyRecords.map(row => row.id), [replacement.id])
})
