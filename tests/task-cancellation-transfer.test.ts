import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Domain } from '../server/domain.ts'
import { Store } from '../server/store.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import { evaluateWorkRisks } from '../server/collaboration-rules.ts'
import { publishCollaborationEvents } from '../server/collaboration-notifications.ts'
import { runCollaborationDigests } from '../server/collaboration-digests.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { enqueueNotification, pendingNotificationTargets, targetAccessible } from '../server/notifications.ts'
import type { AuditEvent, Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { BlockerEpisode, DeadlineChangeRequest, FollowupRequest, ProgressEvent, TaskTracking } from '../shared/collaboration.ts'
import type { Notification } from '../shared/notifications.ts'

function fixture(t: TestContext, suffix = 'source') {
  const store = new Store(':memory:'), domain = new Domain(store), collaboration = new CollaborationService(store)
  t.after(() => store.close())
  const user = (name: string, role: User['role']) => store.insert<User>('users', {
    id: `${name}-${suffix}`, name, role, email: `${name}@cancellation-transfer.test`, active: true, position: '',
  })
  const manager = user('manager', 'manager'), member = user('member', 'member'), peer = user('peer', 'member')
  function populate() {
    collaboration.updateSettings(manager, { requestId: 'enable-cancellation-tests', version: 0, enabled: true, deadlineApprovalEnabled: true, pilotUserIds: [member.id], defaultManagerIds: [manager.id] })
    const original = domain.createTask(manager, { title: '显式作废的旧任务', ownerId: member.id, isTemporary: true, temporaryReason: '阶段安排', dueDate: '2099-01-20' })
    const task = domain.updateTask(member, original.id, { version: original.version, status: 'doing', currentProgress: '已经完成前期分析' })
    const record = domain.createWeeklyRecord(member, { taskId: task.id, weekStart: '2026-09-21', commitment: '旧周安排', submitted: true })
    const report = store.insert<Report>('reports', { type: 'weekly', period: record.weekStart, title: '作废前报告', status: 'finalized', revision: 1, narrative: '冻结历史', authorId: manager.id, finalizedAt: new Date().toISOString(),
      snapshot: { tasks: [task], weeklyRecords: [record], nextWeeklyRecords: [], plans: [], nextPlans: [], projects: [], users: [manager, member], annualGoals: [], publications: [], changes: [] } })
    domain.deleteWeeklyRecord(manager, record.id, { version: record.version, reason: '周安排不再使用' })
    const followup = collaboration.createFollowup(manager, task.id, { requestId: 'cancel-old-followup', version: task.version, requirement: '确认后续安排', dueAt: '2099-01-21T00:00:00.000Z' }).request
    const tracking = store.get<TaskTracking>('taskTrackings', task.id)!
    const deadline = collaboration.requestDeadline(member, task.id, { requestId: 'cancel-old-deadline', version: task.version, dueDateVersion: tracking.dueDateVersion, requestedDueDate: '2099-02-01', reason: '等待确认' })
    const blocker = store.insert<BlockerEpisode>('blockerEpisodes', { sourceType: 'task', sourceId: task.id, parentTaskId: task.id, ownerId: member.id,
      generation: tracking.generation, openedAt: new Date().toISOString(), openedBy: member.id, resolvedAt: null, resolvedBy: null, reason: '待确认', impact: '暂停推进', supportNeeded: '明确需求', reviewAt: null, closureReason: '' })
    return { task, record, report, followup, deadline, blocker }
  }
  return { store, domain, collaboration, manager, member, peer, populate }
}

test('explicit cancellation closes only its live obligations without completing or rewriting historical work', t => {
  const f = fixture(t), data = f.populate()
  const historical = { progress: f.store.list<ProgressEvent>('progressEvents'), record: f.store.get('weeklyRecords', data.record.id), report: f.store.get('reports', data.report.id) }
  const notificationCount = f.store.list('notifications').length, deliveryCount = f.store.list('notificationDeliveries').length
  const cancelled = f.domain.cancelTask(f.manager, data.task.id, { version: data.task.version, reason: '旧任务确认不再使用' })
  assert.equal(cancelled.status, 'doing')
  assert.equal(f.store.get<TaskTracking>('taskTrackings', data.task.id)!.state, 'closed')
  assert.equal(f.store.get<FollowupRequest>('followupRequests', data.followup.id)!.status, 'cancelled')
  assert.equal(f.store.get<DeadlineChangeRequest>('deadlineChangeRequests', data.deadline.id)!.status, 'cancelled')
  assert.equal(f.store.get<BlockerEpisode>('blockerEpisodes', data.blocker.id)!.resolvedAt, cancelled.cancellation!.cancelledAt)
  assert.deepEqual(f.store.list('progressEvents'), historical.progress)
  assert.deepEqual(f.store.get('weeklyRecords', data.record.id), historical.record)
  assert.deepEqual(f.store.get('reports', data.report.id), historical.report)
  assert.equal(f.store.list('notifications').length, notificationCount)
  assert.equal(f.store.list('notificationDeliveries').length, deliveryCount)
  const history = f.collaboration.taskView(f.member, data.task.id)
  assert.equal(history.enabled, false); assert.equal(history.eligible, false)
  assert.deepEqual(history.progressEvents, historical.progress)
  assert.throws(() => f.collaboration.createFollowup(f.manager, data.task.id, { requestId: 'cancel-no-new-followup', version: cancelled.version, enroll: true, requirement: '不能催办' }), { status: 409 })
  assert.throws(() => f.collaboration.recordProgress(f.member, data.task.id, { requestId: 'cancel-no-new-progress', version: cancelled.version, note: '不能新增进展' }), { status: 409 })
  assert.throws(() => f.collaboration.updateTracking(f.manager, data.task.id, { requestId: 'cancel-no-reenrollment', taskVersion: cancelled.version, version: history.tracking!.version, state: 'active' }), { status: 409 })
  assert.throws(() => f.collaboration.taskView(f.peer, data.task.id), { status: 404 })
})

test('cancellation prevents queued facts and digest items from creating new notifications or obligations', t => {
  const f = fixture(t), data = f.populate()
  const assigned = f.store.list<Notification>('notifications').find(row => row.targets.some(target => target.type === 'task' && target.id === data.task.id))!
  assert.ok(assigned)
  f.domain.cancelTask(f.manager, data.task.id, { version: data.task.version, reason: '不再推进' })
  assert.deepEqual(pendingNotificationTargets(f.store, f.member, assigned), [])
  for (const target of [{ type: 'task' as const, id: data.task.id }, { type: 'followup' as const, id: data.followup.id }, { type: 'deadlineRequest' as const, id: data.deadline.id }]) {
    assert.equal(targetAccessible(f.store, f.member, target), false)
    assert.equal(enqueueNotification(f.store, { eventKey: `late-${target.type}`, recipientId: f.member.id, title: '晚到的通知', body: '不得重新进入待办', targets: [target], actionable: true, kind: 'work_changed' }), null)
  }
  const before = { notifications: f.store.list('notifications'), deliveries: f.store.list('notificationDeliveries'), obligations: f.store.list('notificationObligations') }
  for (const row of f.store.list<{ id: string; version: number }>('collaborationEventConsumptions')) f.store.delete('collaborationEventConsumptions', row.id, row.version)
  publishCollaborationEvents(f.store)
  runCollaborationDigests(f.store, new Date('2099-01-23T09:30:00.000Z'))
  assert.deepEqual(evaluateWorkRisks(f.store, new Date('2099-01-23T09:30:00.000Z')), [])
  assert.deepEqual(f.store.list('notifications'), before.notifications)
  assert.deepEqual(f.store.list('notificationDeliveries'), before.deliveries)
  assert.deepEqual(f.store.list('notificationObligations'), before.obligations)
})

test('cancelled task, tombstone and progress round-trip with mapped cancellation actors and unchanged report history', t => {
  const source = fixture(t), target = fixture(t, 'target'), data = source.populate()
  source.domain.cancelTask(source.manager, data.task.id, { version: data.task.version, reason: '任务已不再使用' })
  assert.equal(source.domain.bootstrap(source.manager).tasks.length, 0)
  const packet = JSON.parse(JSON.stringify(exportBusinessData(source.store, source.manager)))
  assert.equal(packet.collections.tasks.length, 1)
  assert.equal(packet.collections.tasks[0].cancellation.cancelledBy, source.manager.id)
  assert.equal(packet.collections.weeklyRecords.length, 1)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  const task = target.store.get<Task>('tasks', data.task.id)!
  assert.equal(task.cancellation!.cancelledBy, target.manager.id)
  assert.equal(task.status, 'doing')
  assert.equal(task.currentProgress, data.task.currentProgress)
  assert.equal(target.domain.bootstrap(target.manager).tasks.length, 0)
  assert.equal(target.domain.bootstrap(target.manager, false, true).tasks.length, 1)
  assert.equal(target.store.get<Report>('reports', data.report.id)!.snapshot.tasks[0].cancellation, undefined)
  const event = target.store.list<AuditEvent>('events').find(row => row.entityType === 'task' && row.action === 'cancel')!
  assert.equal((event.after as Task).cancellation!.cancelledBy, target.manager.id)
  assert.equal((event.before as Task).cancellation, undefined)
  assert.equal(target.store.list<ProgressEvent>('progressEvents').length, source.store.list('progressEvents').length)
  assert.equal(target.store.list('notifications').length, 0)
  assert.equal(target.store.list('notificationDeliveries').length, 0)
  assert.ok(exportBusinessData(source.store, source.member).collections.tasks[0].cancellation)
  assert.equal(exportBusinessData(source.store, source.peer).collections.tasks.length, 0)
  assert.throws(() => previewRestore(source.store, source.member, packet), { status: 403 })
})

test('restore rejects a cancelled task with live weekly work or open collaboration while preserving legacy packets', t => {
  const source = fixture(t), target = fixture(t, 'target'), data = source.populate()
  const legacy = exportBusinessData(source.store, source.manager)
  assert.equal(legacy.collections.tasks[0].cancellation, undefined)
  assert.equal(previewRestore(target.store, target.manager, legacy).canRestore, true)
  source.domain.cancelTask(source.manager, data.task.id, { version: data.task.version, reason: '任务已不再使用' })
  const packet = exportBusinessData(source.store, source.manager)
  for (const mutate of [
    (copy: typeof packet) => { delete copy.collections.weeklyRecords[0].deletion },
    (copy: typeof packet) => { copy.collections.taskTrackings[0].state = 'active' },
    (copy: typeof packet) => { copy.collections.followupRequests[0].status = 'open' },
    (copy: typeof packet) => { copy.collections.deadlineChangeRequests[0].status = 'open' },
    (copy: typeof packet) => { copy.collections.blockerEpisodes[0].resolvedAt = null },
    (copy: typeof packet) => { copy.collections.tasks[0].cancellation!.cancelledBy = 'missing-manager' },
  ]) {
    const copy = structuredClone(packet); mutate(copy)
    const preview = previewRestore(target.store, target.manager, copy)
    assert.equal(preview.canRestore, false, mutate.toString())
    assert.throws(() => restoreBusinessData(target.store, target.manager, copy, {}, preview.fingerprint), { status: 409 })
  }
  for (const bad of [{ reason: ' ' }, { cancelledAt: 'invalid' }, { extra: true }]) {
    const copy = structuredClone(packet); Object.assign(copy.collections.tasks[0].cancellation!, bad)
    assert.throws(() => previewRestore(target.store, target.manager, copy), { status: 400 })
  }
  assert.equal(target.store.list('tasks').length, 0)
})

test('audit failure rolls back cancellation and every collaboration closure', t => {
  const f = fixture(t), data = f.populate()
  const names = ['tasks', 'taskTrackings', 'followupRequests', 'deadlineChangeRequests', 'blockerEpisodes', 'progressEvents']
  const before = names.map(name => f.store.list(name))
  const insert = f.store.insert.bind(f.store)
  f.store.insert = ((collection: string, value: unknown) => {
    if (collection === 'events' && (value as AuditEvent).action === 'cancel') throw new Error('audit unavailable')
    return insert(collection, value as never)
  }) as typeof f.store.insert
  assert.throws(() => f.domain.cancelTask(f.manager, data.task.id, { version: data.task.version, reason: '应原子回滚' }), /audit unavailable/)
  assert.deepEqual(names.map(name => f.store.list(name)), before)
})
