import test from 'node:test'
import assert from 'node:assert/strict'
import type { AuditEvent, Task, User } from '../shared/types.ts'
import type { DeliveryDecision, DeliverySeries, TaskDelivery } from '../shared/deliveries.ts'
import type { Notification } from '../shared/notifications.ts'
import { Store } from '../server/store.ts'
import { WorkService } from '../server/domain-work.ts'
import { TaskDeliveryService, effectiveDeliveryDecision } from '../server/task-deliveries.ts'

function fixture() {
  const store = new Store(':memory:'), work = new WorkService(store)
  let now = new Date('2026-09-22T01:00:00.000Z')
  const service = new TaskDeliveryService(store, () => now)
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id, role, name: id, email: `${id}@test.invalid`, active: true, position: '' })
  const member = user('member', 'member'), manager = user('manager', 'manager'), otherManager = user('other-manager', 'manager'), other = user('other', 'member')
  const task = work.createTask(member, { title: '交付实验报告', description: '完成独立验证', dueDate: '2026-09-22', isTemporary: true, temporaryReason: '专项验证' })
  const input = (requestId = 'delivery-submit-001') => ({ requestId, taskVersion: task.version, previousRevision: 0, actualOutcome: '实验报告已完成', evidenceRefs: ['验证表见附件归档说明'], acceptanceCriteria: '复核全部三个样本', reviewerId: manager.id })
  return { store, service, work, member, manager, otherManager, other, task, input, setNow: (value: string) => { now = new Date(value) } }
}

test('delivery submission is frozen, retried before CAS, and independent from task self-completion', t => {
  const f = fixture(); t.after(() => f.store.close())
  const result = f.service.submit(f.member, f.task.id, f.input())
  const frozen = f.store.get<TaskDelivery>('taskDeliveries', result.delivery.id)
  assert.equal(result.task.status, 'todo')
  assert.equal(result.delivery.taskVersion, f.task.version)
  assert.equal(result.delivery.revision, 1)
  assert.equal(result.delivery.dueDateSnapshot, '2026-09-22')
  assert.equal(result.series.status, 'pending_review')
  assert.deepEqual(f.service.submit(f.member, f.task.id, f.input()), result)
  assert.throws(() => f.service.submit(f.member, f.task.id, { ...f.input(), actualOutcome: '改写' }), { status: 409, code: 'IDEMPOTENCY_MISMATCH' })
  f.setNow('2026-09-26T01:00:00.000Z')
  const review = { requestId: 'delivery-review-001', seriesVersion: result.series.version, action: 'review', conclusion: 'accepted', note: '三个样本均符合要求' }
  const accepted = f.service.decide(f.manager, result.delivery.id, review)
  assert.deepEqual(f.service.decide(f.manager, result.delivery.id, review), accepted)
  assert.deepEqual(f.store.get('taskDeliveries', result.delivery.id), frozen)
  assert.equal(accepted.task.status, 'todo')
  const view = f.service.list(f.member, f.task.id).items[0]
  assert.equal(view.firstSubmittedAt, '2026-09-22T01:00:00.000Z')
  assert.equal(view.acceptedSubmittedAt, '2026-09-22T01:00:00.000Z')
  assert.equal(view.acceptedAt, '2026-09-26T01:00:00.000Z')
  assert.equal(f.store.list<Notification>('notifications').filter(row => row.kind === 'delivery_submitted').length, 1)
})

test('review and withdrawal race has exactly one terminal decision and preserves original retry', t => {
  const f = fixture(); t.after(() => f.store.close())
  const result = f.service.submit(f.member, f.task.id, f.input())
  const withdraw = { requestId: 'withdraw-version-one', seriesVersion: result.series.version, action: 'withdraw', note: '补齐数据后重交' }
  const withdrawn = f.service.decide(f.member, result.delivery.id, withdraw)
  assert.throws(() => f.service.decide(f.manager, result.delivery.id, { requestId: 'review-version-one', seriesVersion: result.series.version, action: 'review', conclusion: 'accepted', note: '通过' }), { status: 409, code: 'VERSION_CONFLICT' })
  assert.equal(f.store.list<DeliveryDecision>('deliveryDecisions').length, 1)
  const nextInput = { ...f.input('resubmit-version-two'), seriesId: withdrawn.series.id, seriesVersion: withdrawn.series.version, previousRevision: 1, previousSubmissionId: result.delivery.id, actualOutcome: '补齐后的成果' }
  const next = f.service.submit(f.member, f.task.id, nextInput)
  assert.equal(next.delivery.revision, 2)
  assert.equal(next.delivery.supersedesId, result.delivery.id)
  const replay = f.service.decide(f.member, result.delivery.id, withdraw)
  assert.deepEqual(replay.decision, withdrawn.decision)
  assert.deepEqual(replay.delivery, withdrawn.delivery)
  assert.deepEqual(replay.series, next.series)
  assert.equal(f.store.list<DeliveryDecision>('deliveryDecisions').length, 1)
  assert.equal(f.store.get<DeliverySeries>('deliverySeries', result.series.id)?.headSubmissionId, next.delivery.id)
})

test('historical correction requires current effective decision and does not change newer head status', t => {
  const f = fixture(); t.after(() => f.store.close())
  const one = f.service.submit(f.member, f.task.id, f.input())
  const returned = f.service.decide(f.manager, one.delivery.id, { requestId: 'return-version-one', seriesVersion: one.series.version, action: 'review', conclusion: 'returned', note: '需补齐第三组' })
  const two = f.service.submit(f.member, f.task.id, { ...f.input('submit-version-two'), seriesId: one.series.id, seriesVersion: returned.series.version, previousRevision: 1, previousSubmissionId: one.delivery.id })
  assert.equal(f.service.list(f.manager, f.task.id).items[0].allowedActions.includes('correct'), true)
  assert.throws(() => f.service.decide(f.otherManager, one.delivery.id, { requestId: 'incorrect-manager-one', seriesVersion: two.series.version, action: 'correct', conclusion: 'accepted', note: '误操作更正', supersedesDecisionId: returned.decision!.id }), { status: 403 })
  const correction = f.service.decide(f.manager, one.delivery.id, { requestId: 'correct-version-one', seriesVersion: two.series.version, action: 'correct', conclusion: 'accepted', note: '补充核查发现原数据已齐备', supersedesDecisionId: returned.decision!.id })
  assert.equal(correction.series.headSubmissionId, two.delivery.id)
  assert.equal(correction.series.status, 'pending_review')
  assert.equal(effectiveDeliveryDecision(f.store, one.delivery.id)?.id, correction.decision!.id)
  assert.equal(effectiveDeliveryDecision(f.store, two.delivery.id), null)
  assert.equal(f.store.get<DeliveryDecision>('deliveryDecisions', returned.decision!.id)?.conclusion, 'returned')
  assert.throws(() => f.service.decide(f.manager, one.delivery.id, { requestId: 'stale-correction-one', seriesVersion: correction.series.version, action: 'correct', conclusion: 'returned', note: '错误旧基线', supersedesDecisionId: returned.decision!.id }), { status: 409 })
  assert.equal(f.service.history(f.member, one.series.id, { limit: 1 }).nextCursor, '2')
})

test('accepted replacement is explicit and designated reviewer reassignment preserves submission snapshot', t => {
  const f = fixture(); t.after(() => f.store.close())
  const one = f.service.submit(f.member, f.task.id, f.input())
  const accepted = f.service.decide(f.manager, one.delivery.id, { requestId: 'accept-version-one', seriesVersion: one.series.version, action: 'review', conclusion: 'accepted', note: '符合全部验收条件' })
  const replacement = { ...f.input('replace-version-one'), seriesId: one.series.id, seriesVersion: accepted.series.version, previousRevision: 1, previousSubmissionId: one.delivery.id }
  assert.throws(() => f.service.submit(f.member, f.task.id, replacement), { status: 400 })
  const two = f.service.submit(f.member, f.task.id, { ...replacement, replaceAccepted: true })
  f.store.update<User>('users', f.manager.id, f.manager.version, { active: false })
  assert.equal(f.service.list(f.member, f.task.id).items[0].reviewerAvailable, false)
  assert.throws(() => f.service.decide(f.manager, two.delivery.id, { requestId: 'disabled-reviewer', seriesVersion: two.series.version, action: 'review', conclusion: 'accepted', note: '通过' }), { status: 403 })
  const reassigned = f.service.reassign(f.otherManager, two.series.id, { requestId: 'reassign-reviewer', seriesVersion: two.series.version, reviewerId: f.otherManager.id, reason: '原验收人停用，由备岗接手' })
  assert.equal(reassigned.delivery.reviewerIdSnapshot, f.manager.id)
  const approved = f.service.decide(f.otherManager, two.delivery.id, { requestId: 'replacement-review', seriesVersion: reassigned.series.version, action: 'review', conclusion: 'accepted', note: '替代版本验收通过' })
  assert.equal(approved.series.status, 'accepted')
})

test('self-review is rejected; no eligible nonowner manager preserves real submission pending assignment', t => {
  const f = fixture(); t.after(() => f.store.close())
  const selfTask = f.work.createTask(f.manager, { title: '本人管理任务', dueDate: '2026-09-22', isTemporary: true, temporaryReason: '临时' })
  assert.throws(() => f.service.submit(f.manager, selfTask.id, { ...f.input(), taskVersion: selfTask.version, reviewerId: f.manager.id }), { status: 400 })
  f.store.update<User>('users', f.otherManager.id, f.otherManager.version, { active: false })
  const result = f.service.submit(f.manager, selfTask.id, { ...f.input(), taskVersion: selfTask.version, reviewerId: null })
  assert.equal(result.series.reviewerId, null)
  assert.equal(result.delivery.submittedAt, '2026-09-22T01:00:00.000Z')
  assert.throws(() => f.service.decide(f.manager, result.delivery.id, { requestId: 'self-review-denied', seriesVersion: result.series.version, action: 'review', conclusion: 'accepted', note: '自验收' }), { status: 403 })
})

test('observer formerly owning task cannot read through business endpoints, mutate or replay cached receipt', t => {
  const f = fixture(); t.after(() => f.store.close())
  const input = f.input(); f.service.submit(f.member, f.task.id, input)
  const observer = f.store.update<User>('users', f.member.id, f.member.version, { role: 'observer' })
  assert.throws(() => f.service.submit(f.member, f.task.id, input), { status: 403 })
  assert.throws(() => f.service.list(observer, f.task.id), { status: 403 })
  assert.throws(() => f.service.list(f.other, f.task.id), { status: 404 })
})

test('manager proxy submit requires reason; explicit done uses base completion rules within same transaction', t => {
  const f = fixture(); t.after(() => f.store.close())
  assert.throws(() => f.service.submit(f.manager, f.task.id, f.input()), { status: 400 })
  assert.throws(() => f.service.submit(f.member, f.task.id, { ...f.input(), markTaskDone: true }), { status: 400 })
  assert.equal(f.store.list('taskDeliveries').length, 0)
  const result = f.service.submit(f.manager, f.task.id, { ...f.input(), proxyReason: '据成员正式邮件代交', markTaskDone: true, completionNote: '完整成果已提交，任务自报完成' })
  assert.equal(result.task.status, 'done')
  assert.equal(result.delivery.ownerId, f.member.id)
  assert.equal(result.delivery.submittedBy, f.manager.id)
  assert.equal(result.series.status, 'pending_review')
})

test('submission inbox failure rolls back frozen version, series, audits, task completion and command receipt', t => {
  const f = fixture(); t.after(() => f.store.close())
  const beforeEvents = f.store.list<AuditEvent>('events').length, original = f.store.insert.bind(f.store)
  f.store.insert = ((collection: string, value: never) => { if (collection === 'notifications') throw new Error('injected inbox disk failure'); return original(collection, value) }) as typeof f.store.insert
  assert.throws(() => f.service.submit(f.member, f.task.id, { ...f.input(), markTaskDone: true, completionNote: '完成' }), /injected inbox disk failure/)
  assert.equal(f.store.list('taskDeliveries').length, 0)
  assert.equal(f.store.list('deliverySeries').length, 0)
  assert.equal(f.store.list('events').length, beforeEvents)
  assert.equal(f.store.list('collaborationCommandReceipts').length, 0)
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'todo')
})

test('pending delivery prevents task cancellation and cancelled tasks cannot take new delivery commands', t => {
  const f = fixture(); t.after(() => f.store.close())
  const one = f.service.submit(f.member, f.task.id, f.input())
  assert.throws(() => f.work.cancelTask(f.manager, f.task.id, { version: f.task.version, reason: '范围变更' }), { status: 409 })
  const withdrawn = f.service.decide(f.member, one.delivery.id, { requestId: 'withdraw-to-cancel', seriesVersion: one.series.version, action: 'withdraw', note: '成果范围作废' })
  const cancelled = f.work.cancelTask(f.manager, f.task.id, { version: f.task.version, reason: '范围变更' })
  assert.equal(f.service.list(f.member, f.task.id).canSubmit, false)
  assert.throws(() => f.service.submit(f.member, f.task.id, { ...f.input('new-after-cancel'), taskVersion: cancelled.version, seriesId: one.series.id, seriesVersion: withdrawn.series.version, previousRevision: 1, previousSubmissionId: one.delivery.id }), { status: 409, code: 'TASK_CANCELLED' })
})
