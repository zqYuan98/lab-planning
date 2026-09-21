import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AuditEvent, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { FollowupRequest, ProgressEvent, TaskTracking } from '../shared/collaboration.ts'
import { WorkService } from '../server/domain-work.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import { Store } from '../server/store.ts'

function fixture(t: TestContext, collaboration = false) {
  const store = new Store(':memory:'), work = new WorkService(store), service = new CollaborationService(store)
  t.after(() => store.close())
  const user = (id: string, role: User['role'] = 'member') => store.insert<User>('users', { id, name: id, email: `${id}@completion.test`, role, active: true, position: '' })
  const manager = user('manager', 'manager'), member = user('member'), other = user('other')
  if (collaboration) service.updateSettings(manager, { requestId: 'weekly-completion-enable', version: 0, enabled: true, pilotUserIds: [member.id] })
  const task = work.createTask(collaboration ? manager : member, { title: '交付规划方案', ownerId: member.id, isTemporary: true, temporaryReason: '专项工作', dueDate: '2099-12-31', workSource: 'leader', waitingForFeedback: true })
  const record = work.createWeeklyRecord(member, { taskId: task.id, weekStart: '2026-09-14', commitment: '完成评审材料', submitted: true })
  const input = { version: record.version, status: 'done', actualOutcome: '方案已评审通过并交付', completeTask: true, taskVersion: task.version }
  const snapshot = () => JSON.stringify(['tasks', 'weeklyRecords', 'events', 'progressEvents', 'taskTrackings', 'followupRequests', 'businessNotificationEvents', 'collaborationEventConsumptions', 'digestItems', 'notifications', 'notificationDeliveries'].map(collection => [collection, store.list(collection)]))
  return { store, work, service, manager, member, other, task, record, input, snapshot }
}

test('ordinary weekly completion and explicit false preserve overall task status and version', t => {
  const f = fixture(t)
  let weekly = f.work.updateWeeklyRecord(f.member, f.record.id, { version: f.record.version, status: 'done', actualOutcome: '完成本周部分' })
  assert.deepEqual(f.store.get<Task>('tasks', f.task.id), f.task)
  weekly = f.work.updateWeeklyRecord(f.member, weekly.id, { version: weekly.version, status: 'done', actualOutcome: '补充本周成果', completeTask: false, taskVersion: 'ignored-for-ordinary-save' })
  assert.equal(weekly.actualOutcome, '补充本周成果')
  assert.deepEqual(f.store.get<Task>('tasks', f.task.id), f.task)
})

test('explicit weekly completion atomically completes the same task and copies final outcome as explanation', t => {
  const f = fixture(t)
  const weekly = f.work.updateWeeklyRecord(f.member, f.record.id, f.input)
  const task = f.store.get<Task>('tasks', f.task.id)!
  assert.equal(weekly.status, 'done')
  assert.equal(weekly.taskId, task.id)
  assert.equal(weekly.version, f.record.version + 1)
  assert.equal(task.status, 'done')
  assert.equal(task.version, f.task.version + 1)
  assert.equal(task.completionNote, weekly.actualOutcome)
  assert.equal(task.waitingForFeedback, false)
  assert.equal(task.workSource, f.task.workSource)
  assert.equal(f.store.list('tasks').length, 1)
  assert.equal(f.store.list('weeklySubmissions').length, 0)
  const audits = f.store.list<AuditEvent>('events').filter(event => event.action === 'update')
  assert.deepEqual(audits.map(event => event.entityType), ['weeklyRecord', 'task'])
})

test('explicit completion validates its boolean, completed weekly status and actual outcome even for imports', t => {
  const f = fixture(t), original = f.snapshot()
  for (const completeTask of ['true', 1, null, {}, []]) {
    assert.throws(() => f.work.updateWeeklyRecord(f.member, f.record.id, { ...f.input, completeTask }), { status: 400 })
    assert.equal(f.snapshot(), original)
  }
  assert.throws(() => f.work.updateWeeklyRecord(f.member, f.record.id, { ...f.input, status: 'doing' }), { status: 400 })
  assert.throws(() => f.work.updateWeeklyRecord(f.member, f.record.id, { ...f.input, actualOutcome: '  ' }), { status: 400 })
  assert.equal(f.snapshot(), original)
  const imported = f.store.update<WeeklyRecord>('weeklyRecords', f.record.id, f.record.version, { importSource: { batchId: 'batch', rowId: 'row', sourceId: 'source', sourceStatus: '已完成' } })
  const importedSnapshot = f.snapshot()
  assert.throws(() => f.work.updateWeeklyRecord(f.member, f.record.id, { ...f.input, version: imported.version, actualOutcome: '' }), { status: 400 })
  assert.equal(f.snapshot(), importedSnapshot)
})

test('stale or missing task versions and stale weekly versions cannot partially complete either record', t => {
  const f = fixture(t)
  const task = f.work.updateTask(f.member, f.task.id, { version: f.task.version, currentProgress: '刚补充的进展' })
  let before = f.snapshot()
  assert.throws(() => f.work.updateWeeklyRecord(f.member, f.record.id, f.input), { status: 409 })
  assert.equal(f.snapshot(), before)
  for (const taskVersion of [undefined, null, '2', 0]) {
    assert.throws(() => f.work.updateWeeklyRecord(f.member, f.record.id, { ...f.input, taskVersion }), { status: 409 })
    assert.equal(f.snapshot(), before)
  }
  const weekly = f.work.updateWeeklyRecord(f.member, f.record.id, { version: f.record.version, actualOutcome: '刚更新的周成果' })
  before = f.snapshot()
  assert.throws(() => f.work.updateWeeklyRecord(f.member, weekly.id, { ...f.input, taskVersion: task.version }), { status: 409 })
  assert.equal(f.snapshot(), before)
})

test('a task write failure rolls back the preceding weekly update and audit', t => {
  const f = fixture(t), original = f.snapshot(), update = f.store.update.bind(f.store)
  f.store.update = ((collection: string, id: string, version: number, patch: never) => {
    if (collection === 'tasks') throw new Error('simulated task write failure')
    return update(collection, id, version, patch)
  }) as typeof f.store.update
  assert.throws(() => f.work.updateWeeklyRecord(f.member, f.record.id, f.input), /task write failure/)
  assert.equal(f.snapshot(), original)
})

test('completion validates ownership of both weekly record and task', t => {
  const f = fixture(t), before = f.snapshot()
  assert.throws(() => f.work.updateWeeklyRecord(f.other, f.record.id, f.input), { status: 403 })
  assert.equal(f.snapshot(), before)
  // A legacy/inconsistent weekly owner must not grant permission to the linked task.
  const task = f.store.update<Task>('tasks', f.task.id, f.task.version, { ownerId: f.other.id })
  const mismatched = f.snapshot()
  assert.throws(() => f.work.updateWeeklyRecord(f.member, f.record.id, { ...f.input, taskVersion: task.version }), { status: 403 })
  assert.equal(f.snapshot(), mismatched)
})

test('an already completed task retains its explanation and version but still requires a current task version', t => {
  const f = fixture(t)
  const completed = f.work.updateTask(f.member, f.task.id, { version: f.task.version, status: 'done', completionNote: '整件工作已验收' })
  const before = f.snapshot()
  assert.throws(() => f.work.updateWeeklyRecord(f.member, f.record.id, f.input), { status: 409 })
  assert.equal(f.snapshot(), before)
  const weekly = f.work.updateWeeklyRecord(f.member, f.record.id, { ...f.input, taskVersion: completed.version, actualOutcome: '补记本周交付部分' })
  assert.equal(weekly.status, 'done')
  assert.deepEqual(f.store.get<Task>('tasks', completed.id), completed)
})

test('explicit completion runs collaboration lifecycle and emits one combined progress event', t => {
  const f = fixture(t, true)
  const request = f.service.createFollowup(f.manager, f.task.id, { requestId: 'weekly-complete-followup', version: f.task.version, requirement: '说明交付结果' }).request
  const count = f.store.list<ProgressEvent>('progressEvents').length
  f.work.updateWeeklyRecord(f.member, f.record.id, f.input)
  const tracking = f.store.get<TaskTracking>('taskTrackings', f.task.id)!
  assert.equal(tracking.state, 'closed')
  assert.equal(tracking.closedReason, '任务已完成')
  assert.ok(tracking.lastMeaningfulOwnerProgressAt)
  const closed = f.store.get<FollowupRequest>('followupRequests', request.id)!
  assert.equal(closed.status, 'cancelled')
  assert.equal(closed.closeReason, '任务已完成')
  assert.equal(closed.closedBy, f.member.id)
  const progress = f.store.list<ProgressEvent>('progressEvents')
  assert.equal(progress.length, count + 1)
  assert.ok(progress.at(-1)!.changes.some(change => change.field === 'task.status' && change.after === 'done'))
  assert.ok(progress.at(-1)!.changes.some(change => change.field === 'weeklyRecord.status' && change.after === 'done'))
  assert.equal(progress.at(-1)!.auditEventIds.length, 2)
  const completions = f.store.list<{ kind: string; taskId: string }>('businessNotificationEvents').filter(event => event.kind === 'work_completed' && event.taskId === f.task.id)
  assert.equal(completions.length, 2)
})

test('a late collaboration hook rejection rolls back both records, tracking closure and followup cancellation', t => {
  const f = fixture(t, true)
  f.service.createFollowup(f.manager, f.task.id, { requestId: 'weekly-complete-rollback', version: f.task.version, requirement: '核验交付结果' })
  const before = f.snapshot()
  assert.throws(() => f.work.updateWeeklyRecord(f.member, f.record.id, { ...f.input, noteType: 'no_change', noChangeReason: '等待确认', nextAction: '继续核对' }), { status: 400 })
  assert.equal(f.snapshot(), before)
})

test('manager completion retains collaboration proxy checks with full rollback while default-off stays compatible', t => {
  const f = fixture(t, true), before = f.snapshot()
  assert.throws(() => f.work.updateWeeklyRecord(f.manager, f.record.id, f.input), { status: 400 })
  assert.equal(f.snapshot(), before)
  const draft = f.work.createWeeklyRecord(f.member, { taskId: f.task.id, weekStart: '2026-09-21', commitment: '未提交的下周安排' })
  const withDraft = f.snapshot()
  assert.throws(() => f.work.updateWeeklyRecord(f.manager, draft.id, { ...f.input, version: draft.version }), { status: 400 })
  assert.equal(f.snapshot(), withDraft)
  f.work.updateWeeklyRecord(f.manager, f.record.id, { ...f.input, proxyReason: '根据负责人反馈代录验收结果' })
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'done')
  assert.equal(f.store.get<TaskTracking>('taskTrackings', f.task.id)?.lastMeaningfulOwnerProgressAt, null)
  const disabled = fixture(t)
  disabled.work.updateWeeklyRecord(disabled.manager, disabled.record.id, disabled.input)
  assert.equal(disabled.store.get<Task>('tasks', disabled.task.id)?.status, 'done')
})
