import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { Task, User } from '../shared/types.ts'
import type { BlockerEpisode, FollowupRequest, TaskTracking } from '../shared/collaboration.ts'
import type { Notification } from '../shared/notifications.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { MyActionsService } from '../server/my-actions.ts'
import { TaskDeliveryService } from '../server/task-deliveries.ts'
import { TaskSupportService } from '../server/task-support.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import { getOperationEpoch, rotateOperationEpoch } from '../server/operation-context.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store)
  t.after(() => store.close())
  let now = new Date('2026-09-22T01:00:00.000Z'), serial = 0
  const actions = new MyActionsService(store, () => now), deliveries = new TaskDeliveryService(store, () => now), support = new TaskSupportService(store, () => now), collaboration = new CollaborationService(store, () => now)
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id, role, name: id, email: `${id}@test.invalid`, active: true, position: '' })
  const manager = user('manager', 'manager'), second = user('second-manager', 'manager'), member = user('member', 'member'), coordinator = user('coordinator', 'member'), observer = user('observer', 'observer')
  const task = (title = '跨期任务', dueDate = '2026-09-30') => domain.createTask(manager, { title, dueDate, ownerId: member.id, isTemporary: true, temporaryReason: '专项' })
  const deliver = (row: Task) => deliveries.submit(member, row.id, { requestId: `actions-delivery-${++serial}`, taskVersion: row.version, previousRevision: 0, actualOutcome: row.title, evidenceRefs: [], acceptanceCriteria: '完整验证报告', reviewerId: manager.id })
  const decision = (row: Task) => support.createDecision(second, { requestId: `actions-decision-${++serial}`, taskId: row.id, taskVersion: row.version, question: '是否接受替代验证方案', options: ['同意', '调整'], decisionOwnerId: manager.id, responseDueAt: '2026-09-24T01:00:00.000Z' })
  getOperationEpoch(store)
  return { store, domain, actions, deliveries, support, collaboration, manager, second, member, coordinator, observer, task, deliver, decision, setNow: (value: string) => { now = new Date(value) } }
}

test('action counts cover the complete authorized set before filtering and pagination; ordering favors overdue work across months', t => {
  const f = fixture(t), late = f.deliver(f.task('上月未处理成果', '2026-08-31')), future = f.deliver(f.task('本月成果', '2026-09-30'))
  f.decision(f.task('资源决策'))
  const first = f.actions.list(f.manager, { limit: 1 })
  assert.equal(first.items.length, 1)
  assert.equal(first.items[0].sourceId, late.delivery.id)
  assert.equal(first.counts.delivery_review, 2)
  assert.equal(first.counts.decision, 1)
  assert.equal(first.totalCount, 3)
  assert.equal(first.filteredCount, 3)
  assert.ok(first.nextCursor)
  const second = f.actions.list(f.manager, { limit: 1, cursor: first.nextCursor! })
  assert.notEqual(second.items[0].key, first.items[0].key)
  assert.deepEqual(second.counts, first.counts)
  const filtered = f.actions.list(f.manager, { kind: 'delivery_review', limit: 1 })
  assert.equal(filtered.filteredCount, 2)
  assert.equal(filtered.totalCount, 3)
  assert.deepEqual(filtered.counts, first.counts)
  assert.equal(f.actions.list(f.manager, { kind: 'delivery_review', cursor: filtered.nextCursor! }).items[0].sourceId, future.delivery.id)
  assert.equal(f.actions.list(f.member).totalCount, 0)
  assert.equal(f.actions.list(f.observer).totalCount, 0)
})

test('reading or opening notifications never clears business actions; terminal source decisions do', t => {
  const f = fixture(t), pending = f.deliver(f.task())
  const before = ['deliverySeries', 'taskDeliveries', 'deliveryDecisions', 'events', 'notifications', 'collaborationCommandReceipts'].map(name => f.store.list(name))
  const first = f.actions.list(f.manager)
  assert.deepEqual(f.actions.list(f.manager), first)
  assert.deepEqual(['deliverySeries', 'taskDeliveries', 'deliveryDecisions', 'events', 'notifications', 'collaborationCommandReceipts'].map(name => f.store.list(name)), before)
  const notice = f.store.list<Notification>('notifications').find(row => row.kind === 'delivery_submitted')!
  f.store.update<Notification>('notifications', notice.id, notice.version, { openedAt: '2026-09-22T01:00:00.000Z', acknowledgedAt: '2026-09-22T01:00:00.000Z' })
  assert.equal(f.actions.list(f.manager).counts.delivery_review, 1)
  f.deliveries.decide(f.manager, pending.delivery.id, { requestId: 'actions-accept-delivery', seriesVersion: pending.series.version, action: 'review', conclusion: 'accepted', note: '达标' })
  assert.equal(f.actions.list(f.manager).counts.delivery_review, 0)
})

test('action cursor is bound to actor, filter, permission version and operation epoch and rejects vanished source anchors', t => {
  const f = fixture(t), one = f.deliver(f.task('一')), two = f.deliver(f.task('二'))
  const page = f.actions.list(f.manager, { limit: 1 })
  assert.ok(page.nextCursor)
  assert.throws(() => f.actions.list(f.second, { cursor: page.nextCursor! }), { status: 409, code: 'ACCESS_SCOPE_CHANGED' })
  assert.throws(() => f.actions.list(f.manager, { cursor: page.nextCursor!, kind: 'delivery_review' }), { status: 409, code: 'ACCESS_SCOPE_CHANGED' })
  f.store.update<User>('users', f.manager.id, f.manager.version, { name: '权限上下文更新的管理者' })
  assert.throws(() => f.actions.list(f.manager, { cursor: page.nextCursor! }), { status: 409, code: 'ACCESS_SCOPE_CHANGED' })
  const next = f.actions.list(f.manager, { limit: 1 })
  rotateOperationEpoch(f.store)
  assert.throws(() => f.actions.list(f.manager, { cursor: next.nextCursor! }), { status: 409, code: 'ACCESS_SCOPE_CHANGED' })
  const fresh = f.actions.list(f.manager, { limit: 1 }), selected = fresh.items[0].sourceId === one.delivery.id ? one : two
  f.deliveries.decide(f.manager, selected.delivery.id, { requestId: 'actions-remove-cursor-source', seriesVersion: selected.series.version, action: 'review', conclusion: 'accepted', note: '已处理' })
  assert.throws(() => f.actions.list(f.manager, { cursor: fresh.nextCursor! }), { status: 409, code: 'ACTION_LIST_CHANGED' })
})

test('unassigned monthly approval is explicitly a shared manager queue and competing approval loses by version', t => {
  const f = fixture(t)
  const draft = f.domain.createPlan(f.member, { title: '临时月目标', month: '2026-09', dueDate: '2026-09-30', category: '专项', expectedOutcome: '验证结果', acceptanceCriteria: '可复核', isTemporary: true, temporaryReason: '新需求' })
  const submitted = f.domain.submitPlan(f.member, draft.id, { version: draft.version })
  for (const actor of [f.manager, f.second]) {
    const queue = f.actions.list(actor).items.find(item => item.sourceId === draft.id)!
    assert.equal(queue.kind, 'monthly_review')
    assert.equal(queue.sharedQueue, true)
    assert.deepEqual(new Set(queue.assigneeIds), new Set([f.manager.id, f.second.id]))
  }
  f.domain.reviewPlan(f.manager, draft.id, { version: submitted.version, decision: 'approve' })
  assert.throws(() => f.domain.reviewPlan(f.second, draft.id, { version: submitted.version, decision: 'approve' }), { status: 409 })
  assert.equal(f.actions.list(f.second).counts.monthly_review, 0)
})

test('disabled collaboration yields recovery actions for old followup and deadline sources while base deliveries remain actionable', t => {
  const f = fixture(t)
  const settings = f.collaboration.updateSettings(f.manager, { requestId: 'actions-enable-collab', version: 0, enabled: true, pilotUserIds: [f.member.id], defaultManagerIds: [f.manager.id], deadlineApprovalEnabled: true })
  const task = f.task('需跟进任务'), tracking = f.store.get<TaskTracking>('taskTrackings', task.id)!
  f.collaboration.createFollowup(f.manager, task.id, { requestId: 'actions-followup-create', version: task.version, requirement: '请补充执行证据', dueAt: '2026-09-24T01:00:00.000Z' })
  f.collaboration.requestDeadline(f.member, task.id, { requestId: 'actions-deadline-request', version: task.version, dueDateVersion: tracking.dueDateVersion, requestedDueDate: '2026-10-01', reason: '外部条件尚未具备' })
  f.deliver(f.task('基础成果'))
  assert.equal(f.actions.list(f.member).counts.followup_response, 1)
  f.collaboration.updateSettings(f.manager, { requestId: 'actions-disable-collab', version: settings.version, enabled: false })
  const manager = f.actions.list(f.manager)
  assert.equal(manager.counts.assignment, 2)
  assert.equal(manager.counts.deadline_review, 0)
  assert.equal(manager.counts.delivery_review, 1)
  assert.ok(manager.items.filter(item => item.kind === 'assignment').every(item => item.sharedQueue && item.blockedReason?.includes('关闭')))
  assert.equal(f.actions.list(f.member).counts.followup_response, 0)
})

test('support generation stays stable across progress, responded leaves actions, deferred work returns at review time and disabled assignee moves to management queue', t => {
  const f = fixture(t), initial = f.task('环境支持')
  f.domain.updateTask(f.member, initial.id, { version: initial.version, status: 'blocked', blockerReason: '环境不可用', blockerImpact: '无法验证', supportNeeded: '协调资源' })
  const episode = f.store.list<BlockerEpisode>('blockerEpisodes').find(row => row.parentTaskId === initial.id)!
  const assigned = f.support.assignBlocker(f.manager, episode.id, { requestId: 'actions-support-assign', version: episode.version, coordinatorId: f.coordinator.id, responseDueAt: '2026-09-24T01:00:00.000Z', reason: '分派值班协调' })
  const first = f.actions.list(f.coordinator).items[0]
  const recorded = f.support.handleBlocker(f.coordinator, episode.id, { requestId: 'actions-support-record', version: assigned.episode.version, action: 'record', note: '处理中' })
  assert.equal(f.actions.list(f.coordinator).items[0].key, first.key)
  assert.equal(f.actions.list(f.coordinator).items[0].sourceVersion, recorded.episode.version)
  const responded = f.support.handleBlocker(f.coordinator, episode.id, { requestId: 'actions-support-respond', version: recorded.episode.version, action: 'respond', note: '已有替代环境，待复查' })
  assert.equal(f.actions.list(f.coordinator).counts.support, 0)
  f.support.handleBlocker(f.manager, episode.id, { requestId: 'actions-support-defer', version: responded.episode.version, action: 'defer', note: '同意明日复查', reviewAt: '2026-09-23T01:00:00.000Z' })
  assert.equal(f.actions.list(f.coordinator).counts.revisit, 1)
  assert.equal(f.actions.list(f.coordinator).counts.support, 0)
  f.setNow('2026-09-23T02:00:00.000Z')
  assert.equal(f.actions.list(f.coordinator).counts.support, 1)
  f.store.update<User>('users', f.coordinator.id, f.coordinator.version, { active: false })
  assert.equal(f.actions.list(f.manager).counts.assignment, 1)
  assert.throws(() => f.actions.list(f.coordinator), { status: 403 })
})

test('cancelled source task leaves action projection while preserving its decision history', t => {
  const f = fixture(t), task = f.task('取消决策来源'), request = f.decision(task)
  assert.equal(f.actions.list(f.manager).counts.decision, 1)
  f.domain.cancelTask(f.manager, task.id, { version: task.version, reason: '范围取消' })
  assert.equal(f.actions.list(f.manager).counts.decision, 0)
  assert.ok(f.store.get('decisionRequests', request.id))
})

test('formal response consumes the scheduled revisit and a suggested future review does not create another obligation', t => {
  const f = fixture(t), initial = f.task('复查后回应')
  f.domain.updateTask(f.member, initial.id, { version: initial.version, status: 'blocked', blockerReason: '环境不可用', blockerImpact: '无法验证', supportNeeded: '协调资源' })
  const episode = f.store.list<BlockerEpisode>('blockerEpisodes').find(row => row.parentTaskId === initial.id)!
  const assigned = f.support.assignBlocker(f.manager, episode.id, { requestId: 'revisit-support-assign', version: episode.version, coordinatorId: f.coordinator.id, responseDueAt: '2026-09-24T01:00:00.000Z', reason: '分派协调' })
  const deferred = f.support.handleBlocker(f.manager, episode.id, { requestId: 'revisit-manager-defer', version: assigned.episode.version, action: 'defer', note: '次日复查', reviewAt: '2026-09-23T01:00:00.000Z' })
  f.setNow('2026-09-23T02:00:00.000Z')
  assert.equal(f.actions.list(f.coordinator).counts.support, 1)
  const response = f.support.handleBlocker(f.coordinator, episode.id, { requestId: 'revisit-final-respond', version: deferred.episode.version, action: 'respond', note: '复查完成并已回应', reviewAt: '2026-09-25T01:00:00.000Z' })
  assert.equal(response.episode.reviewAt, null)
  assert.equal(response.action.reviewAt, '2026-09-25T01:00:00.000Z')
  assert.equal(f.actions.list(f.coordinator).counts.support, 0)
  assert.equal(f.actions.list(f.coordinator).counts.revisit, 0)
  assert.equal(f.actions.list(f.manager).counts.support, 0)
})

test('unanswerable followup references become manager recovery work instead of a member response action', async t => {
  for (const drift of ['missing_tracking', 'closed_tracking', 'wrong_generation', 'wrong_tracking_owner', 'task_done', 'withdrawn_weekly'] as const) await t.test(drift, child => {
    const f = fixture(child)
    f.collaboration.updateSettings(f.manager, { requestId: 'drift-followup-enable', version: 0, enabled: true, pilotUserIds: [f.member.id], defaultManagerIds: [f.manager.id] })
    const task = f.task(), tracking = f.store.get<TaskTracking>('taskTrackings', task.id)!
    let request = f.collaboration.createFollowup(f.manager, task.id, { requestId: 'drift-followup-create', version: task.version, requirement: '更新', dueAt: '2026-09-24T01:00:00.000Z' }).request
    assert.equal(f.actions.list(f.member).counts.followup_response, 1)
    if (drift === 'missing_tracking') f.store.delete('taskTrackings', tracking.id, tracking.version)
    else if (drift === 'closed_tracking') f.store.update<TaskTracking>('taskTrackings', tracking.id, tracking.version, { state: 'closed' })
    else if (drift === 'wrong_generation') f.store.update<TaskTracking>('taskTrackings', tracking.id, tracking.version, { generation: tracking.generation + 1 })
    else if (drift === 'wrong_tracking_owner') f.store.update<TaskTracking>('taskTrackings', tracking.id, tracking.version, { ownerId: f.coordinator.id })
    else if (drift === 'task_done') f.store.update<Task>('tasks', task.id, task.version, { status: 'done', completionNote: '恢复包保留旧催办但任务已完成' })
    else {
      const weekly = f.domain.createWeeklyRecord(f.member, { taskId: task.id, weekStart: '2026-09-21', commitment: '已撤回安排', submitted: false })
      request = f.store.update<FollowupRequest>('followupRequests', request.id, request.version, { weeklyRecordId: weekly.id })
    }
    assert.equal(f.actions.list(f.member).counts.followup_response, 0)
    const recovery = f.actions.list(f.manager).items.find(row => row.sourceId === request.id)!
    assert.equal(recovery.kind, 'assignment')
    assert.equal(recovery.sharedQueue, true)
    assert.ok(recovery.blockedReason)
  })
})

test('deadline approvals use the full manager queue and invalid request bases become recovery work', async t => {
  for (const drift of ['none', 'missing_tracking', 'wrong_generation', 'changed_deadline_version', 'changed_task_deadline', 'wrong_tracking_owner'] as const) await t.test(drift, child => {
    const f = fixture(child)
    f.collaboration.updateSettings(f.manager, { requestId: 'drift-deadline-enable', version: 0, enabled: true, pilotUserIds: [f.member.id], defaultManagerIds: [f.manager.id], deadlineApprovalEnabled: true })
    const task = f.task(), tracking = f.store.get<TaskTracking>('taskTrackings', task.id)!
    const request = f.collaboration.requestDeadline(f.member, task.id, { requestId: 'drift-deadline-create', version: task.version, dueDateVersion: tracking.dueDateVersion, requestedDueDate: '2026-10-01', reason: '资源延期' })
    const item = f.actions.list(f.second).items.find(row => row.sourceId === request.id)!
    assert.equal(item.kind, 'deadline_review')
    assert.deepEqual(new Set(item.assigneeIds), new Set([f.manager.id, f.second.id]))
    if (drift === 'none') {
      f.collaboration.decideDeadline(f.second, request.id, { requestId: 'queue-second-manager-decides', version: request.version, dueDateVersion: tracking.dueDateVersion, decision: 'returned', note: '按原期限完成' })
      assert.equal(f.actions.list(f.manager).counts.deadline_review, 0)
      return
    }
    if (drift === 'missing_tracking') f.store.delete('taskTrackings', tracking.id, tracking.version)
    else if (drift === 'wrong_generation') f.store.update<TaskTracking>('taskTrackings', tracking.id, tracking.version, { generation: tracking.generation + 1 })
    else if (drift === 'changed_deadline_version') f.store.update<TaskTracking>('taskTrackings', tracking.id, tracking.version, { dueDateVersion: tracking.dueDateVersion + 1 })
    else if (drift === 'changed_task_deadline') f.store.update<Task>('tasks', task.id, task.version, { dueDate: '2026-10-02' })
    else f.store.update<TaskTracking>('taskTrackings', tracking.id, tracking.version, { ownerId: f.coordinator.id })
    const current = f.actions.list(f.manager)
    assert.equal(current.counts.deadline_review, 0)
    assert.equal(current.items.find(row => row.sourceId === request.id)?.kind, 'assignment')
    assert.ok(current.items.find(row => row.sourceId === request.id)?.blockedReason)
  })
})
