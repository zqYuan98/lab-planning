import test from 'node:test'
import assert from 'node:assert/strict'
import type { BlockerEpisode } from '../shared/collaboration.ts'
import type { DecisionRequest } from '../shared/support.ts'
import type { Notification } from '../shared/notifications.ts'
import type { AuditEvent, Task, User } from '../shared/types.ts'
import { Store } from '../server/store.ts'
import { WorkService } from '../server/domain-work.ts'
import { TaskSupportService } from '../server/task-support.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import { notificationView } from '../server/notifications.ts'

function fixture() {
  const store = new Store(':memory:'), work = new WorkService(store), now = new Date('2026-09-22T01:00:00.000Z')
  const service = new TaskSupportService(store, () => now)
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id, role, name: id, email: `${id}@test.invalid`, active: true, position: '' })
  const member = user('member', 'member'), manager = user('manager', 'manager'), secondManager = user('second-manager', 'manager'), coordinator = user('coordinator', 'member'), outsider = user('outsider', 'member')
  const initial = work.createTask(member, { title: '需要跨团队支持的任务', description: '仅 owner 和管理者可见的任务私密说明', dueDate: '2026-09-25', isTemporary: true, temporaryReason: '专项' })
  // Simulates a legacy record with no verifiable blocker occurrence event.
  const task = store.update<Task>('tasks', initial.id, initial.version, { status: 'blocked', blockerReason: '测试环境故障', blockerImpact: '无法验证第三组数据', supportNeeded: '请协调恢复环境' })
  const episode = service.enrollBlocker(member, task.id, { requestId: 'support-enroll-001', taskVersion: task.version })
  const assign = (requestId = 'support-assign-001') => ({ requestId, version: episode.version, coordinatorId: coordinator.id, responseDueAt: '2026-09-24T09:00:00.000Z', reason: '由环境值班人员协调' })
  const decision = (requestId = 'decision-create-001') => ({ requestId, taskId: task.id, taskVersion: task.version, blockerEpisodeId: episode.id, question: '采用临时环境还是延期验证', options: ['临时环境', '延期验证'], decisionOwnerId: secondManager.id, responseDueAt: '2026-09-24T09:00:00.000Z', reason: '等待资源决策' })
  return { store, service, work, member, manager, secondManager, coordinator, outsider, task, episode, assign, decision }
}

test('support works with collaboration disabled and assigned member gets only necessary blocker context', t => {
  const f = fixture(); t.after(() => f.store.close())
  assert.equal(f.store.list('collaborationSettings').length, 0)
  assert.equal(f.episode.openedAtKnown, false)
  const assigned = f.service.assignBlocker(f.manager, f.episode.id, f.assign())
  assert.deepEqual(f.service.assignBlocker(f.manager, f.episode.id, f.assign()), assigned)
  const view = f.service.blockerView(f.coordinator, f.episode.id)
  assert.equal(view.minimalContext, true)
  assert.deepEqual(Object.keys(view.task).sort(), ['id', 'ownerId', 'title'])
  assert.equal(JSON.stringify(view).includes('任务私密说明'), false)
  assert.deepEqual(view.allowedActions, ['record', 'respond'])
  assert.throws(() => f.service.handleBlocker(f.member, f.episode.id, { requestId: 'owner-not-assignee', version: assigned.episode.version, action: 'respond', note: 'owner不代替指定协调人回应' }), { status: 403 })
  assert.throws(() => f.service.taskView(f.coordinator, f.task.id), { status: 404 })
  assert.throws(() => new CollaborationService(f.store).taskView(f.coordinator, f.task.id), { status: 404 })
  assert.throws(() => f.service.blockerView(f.outsider, f.episode.id), { status: 404 })
  const notification = f.store.list<Notification>('notifications').find(row => row.recipientId === f.coordinator.id && row.kind === 'support_assigned')!
  const inbox = notificationView(f.store, f.coordinator, notification)
  assert.equal(inbox.unavailable, false)
  assert.equal(inbox.body.includes('请协调恢复环境'), true)
  assert.equal(inbox.body.includes('任务私密说明'), false)
  assert.equal(f.store.list('notificationDeliveries').length, 0)
})

test('new coordinator cannot read prior management discussion or earlier assignee response history', t => {
  const f = fixture(); t.after(() => f.store.close())
  const noted = f.service.handleBlocker(f.manager, f.episode.id, { requestId: 'private-manager-note', version: f.episode.version, action: 'record', note: '管理讨论中的非必要私人信息' })
  const assigned = f.service.assignBlocker(f.manager, f.episode.id, { ...f.assign(), version: noted.episode.version })
  assert.equal(JSON.stringify(f.service.blockerView(f.coordinator, f.episode.id)).includes('管理讨论中的非必要私人信息'), false)
  const response = f.service.handleBlocker(f.coordinator, f.episode.id, { requestId: 'first-assignee-response', version: assigned.episode.version, action: 'respond', note: '第一协调人的内部处理过程' })
  f.service.assignBlocker(f.manager, f.episode.id, { ...f.assign('new-support-assignee'), version: response.episode.version, coordinatorId: f.outsider.id })
  const view = f.service.blockerView(f.outsider, f.episode.id)
  assert.equal(JSON.stringify(view).includes('第一协调人的内部处理过程'), false)
  assert.deepEqual(view.actions, [])
  assert.equal(view.episode.responseNote, '')
})

test('coordinator response and manager deferral are separate; management close does not resolve task', t => {
  const f = fixture(); t.after(() => f.store.close())
  const assigned = f.service.assignBlocker(f.manager, f.episode.id, f.assign())
  assert.throws(() => f.service.handleBlocker(f.coordinator, f.episode.id, { requestId: 'coordinator-close-no', version: assigned.episode.version, action: 'close', note: '越权关闭' }), { status: 403 })
  assert.throws(() => f.service.handleBlocker(f.coordinator, f.episode.id, { requestId: 'coordinator-defer-no', version: assigned.episode.version, action: 'defer', note: '越权延期', reviewAt: '2026-09-26T09:00:00.000Z' }), { status: 403 })
  const responded = f.service.handleBlocker(f.coordinator, f.episode.id, { requestId: 'coordinator-respond', version: assigned.episode.version, action: 'respond', note: '已协调基础设施组，建议周四复查', reviewAt: '2026-09-24T09:00:00.000Z' })
  assert.equal(responded.episode.coordinationState, 'responded')
  assert.equal(responded.episode.reviewAt, null)
  assert.equal(responded.action.reviewAt, '2026-09-24T09:00:00.000Z')
  assert.equal(responded.episode.resolvedAt, null)
  const deferred = f.service.handleBlocker(f.manager, f.episode.id, { requestId: 'manager-defer-001', version: responded.episode.version, action: 'defer', note: '同意周四复查', reviewAt: '2026-09-24T09:00:00.000Z' })
  assert.equal(deferred.episode.reviewAt, '2026-09-24T09:00:00.000Z')
  const closed = new CollaborationService(f.store).handleBlocker(f.manager, f.episode.id, { requestId: 'old-handler-close', version: deferred.episode.version, action: 'close', note: '管理协调已完成，执行人继续核验' })
  assert.equal(closed.episode.coordinationState, 'management_closed')
  assert.equal(closed.episode.resolvedAt, null)
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'blocked')
})

test('reassignment revokes former coordinator read, response and inbox access; disabled assignee is unavailable', t => {
  const f = fixture(); t.after(() => f.store.close())
  const assigned = f.service.assignBlocker(f.manager, f.episode.id, f.assign())
  const originalNotification = f.store.list<Notification>('notifications').find(row => row.recipientId === f.coordinator.id)!
  f.store.update<User>('users', f.coordinator.id, f.coordinator.version, { active: false })
  assert.equal(f.service.blockerView(f.manager, f.episode.id).coordinatorAvailable, false)
  assert.throws(() => f.service.handleBlocker(f.coordinator, f.episode.id, { requestId: 'disabled-response', version: assigned.episode.version, action: 'respond', note: '不能回应' }), { status: 403 })
  const reassigned = f.service.assignBlocker(f.manager, f.episode.id, { ...f.assign('support-reassign-001'), version: assigned.episode.version, coordinatorId: f.outsider.id })
  const current = f.store.get<User>('users', f.coordinator.id)!
  const restored = f.store.update<User>('users', current.id, current.version, { active: true })
  assert.throws(() => f.service.blockerView(restored, f.episode.id), { status: 404 })
  assert.equal(notificationView(f.store, restored, originalNotification).unavailable, true)
  assert.throws(() => f.service.handleBlocker(restored, f.episode.id, { requestId: 'old-assignee-response', version: reassigned.episode.version, action: 'respond', note: '不能回应' }), { status: 404 })
})

test('decision requires designated manager, preserves generations and reasons in audit, and retries before CAS', t => {
  const f = fixture(); t.after(() => f.store.close())
  assert.throws(() => f.service.createDecision(f.member, f.decision()), { status: 403 })
  assert.throws(() => f.service.createDecision(f.manager, { ...f.decision(), decisionOwnerId: f.coordinator.id }), { status: 400 })
  const request = f.service.createDecision(f.manager, f.decision())
  assert.deepEqual(f.service.createDecision(f.manager, f.decision()), request)
  assert.throws(() => f.service.decideDecision(f.manager, request.id, { requestId: 'wrong-manager-decide', version: request.version, result: '临时环境' }), { status: 403 })
  const input = { requestId: 'designated-decide-001', version: request.version, result: '先使用临时环境验证，不延后原截止' }
  const decided = f.service.decideDecision(f.secondManager, request.id, input)
  assert.deepEqual(f.service.decideDecision(f.secondManager, request.id, input), decided)
  assert.equal(decided.status, 'decided')
  assert.throws(() => f.service.reopenDecision(f.manager, request.id, { requestId: 'missing-reopen-reason', version: decided.version, responseDueAt: '2026-09-25T09:00:00.000Z' }), { status: 400 })
  const reopened = f.service.reopenDecision(f.manager, request.id, { requestId: 'reopen-decision-001', version: decided.version, reason: '临时环境也不可用，需重新判断', responseDueAt: '2026-09-25T09:00:00.000Z' })
  assert.equal(reopened.generation, 2)
  assert.equal(reopened.status, 'open')
  assert.equal(reopened.result, '')
  assert.equal(f.store.list<AuditEvent>('events').some(row => row.entityType === 'decisionRequest' && (row.after as DecisionRequest)?.result === decided.result), true)
  const cancelled = f.service.cancelDecision(f.manager, request.id, { requestId: 'cancel-decision-001', version: reopened.version, reason: '事项范围已变更' })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'blocked')
})

test('decision responsibility invalidation requires explicit reassignment and observer old ownership gives no write rights', t => {
  const f = fixture(); t.after(() => f.store.close())
  const request = f.service.createDecision(f.manager, f.decision())
  f.store.update<User>('users', f.secondManager.id, f.secondManager.version, { active: false })
  assert.equal(f.service.decisionView(f.manager, request.id).ownerAvailable, false)
  const reassigned = f.service.reassignDecision(f.manager, request.id, { requestId: 'decision-reassign-001', version: request.version, decisionOwnerId: f.manager.id, reason: '原处理人已停用' })
  assert.equal(reassigned.decisionOwnerId, f.manager.id)
  f.store.update<User>('users', f.member.id, f.member.version, { role: 'observer' })
  assert.throws(() => f.service.enrollBlocker(f.member, f.task.id, { requestId: 'observer-enroll-001', taskVersion: f.task.version }), { status: 403 })
  assert.throws(() => f.service.handleBlocker(f.member, f.episode.id, { requestId: 'observer-handle-001', version: f.episode.version, action: 'respond', note: '旧owner回应' }), { status: 403 })
  assert.throws(() => f.service.createDecision(f.member, f.decision('observer-decision-001')), { status: 403 })
})

test('support assignment transaction rolls back episode, action, audit and receipt if inbox fails', t => {
  const f = fixture(); t.after(() => f.store.close())
  const before = ['blockerEpisodes', 'blockerActions', 'events', 'collaborationCommandReceipts', 'notifications'].map(collection => f.store.list(collection))
  const original = f.store.insert.bind(f.store)
  f.store.insert = ((collection: string, value: never) => { if (collection === 'notifications') throw new Error('injected support inbox failure'); return original(collection, value) }) as typeof f.store.insert
  assert.throws(() => f.service.assignBlocker(f.manager, f.episode.id, f.assign()), /injected support inbox failure/)
  assert.deepEqual(['blockerEpisodes', 'blockerActions', 'events', 'collaborationCommandReceipts', 'notifications'].map(collection => f.store.list(collection)), before)
})

test('support and decisions reject cancelled parent task without mutating historical responsibilities', t => {
  const f = fixture(); t.after(() => f.store.close())
  const assigned = f.service.assignBlocker(f.manager, f.episode.id, f.assign()), request = f.service.createDecision(f.manager, f.decision())
  f.work.cancelTask(f.manager, f.task.id, { version: f.task.version, reason: '任务终止' })
  assert.throws(() => f.service.handleBlocker(f.coordinator, f.episode.id, { requestId: 'cancelled-respond-001', version: assigned.episode.version, action: 'respond', note: '已终止' }), { status: 409, code: 'TASK_CANCELLED' })
  assert.throws(() => f.service.decideDecision(f.secondManager, request.id, { requestId: 'cancelled-decide-001', version: request.version, result: '已经终止' }), { status: 409, code: 'TASK_CANCELLED' })
  assert.equal(f.store.get<DecisionRequest>('decisionRequests', request.id)?.status, 'open')
  assert.equal(f.store.get<BlockerEpisode>('blockerEpisodes', f.episode.id)?.coordinatorId, f.coordinator.id)
  assert.deepEqual(f.service.blockerView(f.coordinator, f.episode.id).allowedActions, [])
})
