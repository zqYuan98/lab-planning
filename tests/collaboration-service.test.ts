import test from 'node:test'
import assert from 'node:assert/strict'
import type { BlockerEpisode, FollowupRequest, ProgressEvent, TaskTracking } from '../shared/collaboration.ts'
import type { Task, User, WeeklyRecord } from '../shared/types.ts'
import { Store } from '../server/store.ts'
import { WorkService } from '../server/domain-work.ts'
import { CollaborationService, readCollaborationSettings } from '../server/collaboration-service.ts'
import { exportBusinessData } from '../server/data-transfer.ts'
import { previewRestore, restoreBusinessData } from '../server/data-restore.ts'
import { userDeletionPreview } from '../server/user-deletion.ts'
import { withSilentImport } from '../server/import-notification-context.ts'
import { ensureWeeklyPlanReviewRule } from '../server/weekly-plan-review.ts'
import { isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'

function fixture(enabled = true) {
  const store = new Store(':memory:'), work = new WorkService(store)
  let now = new Date()
  const service = new CollaborationService(store, () => now)
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id, name: id, email: `${id}@example.test`, role, position: '', active: true })
  const manager = user('manager', 'manager'), member = user('member', 'member'), other = user('other', 'member')
  if (enabled) service.updateSettings(manager, { requestId: 'settings-enable-001', version: 0, enabled: true, pilotUserIds: [member.id] })
  const task = work.createTask(manager, { ownerId: member.id, title: '可核验的实验任务', description: '交付验证报告', dueDate: '2099-01-20', isTemporary: true, temporaryReason: '专项验证' })
  return { store, service, work, manager, member, other, task, setNow: (date: Date) => { now = date }, now: () => now }
}

test('collaboration reads are inert and default-off still requires evidence for manual completion', () => {
  const f = fixture(false)
  try {
    assert.equal(readCollaborationSettings(f.store).enabled, false)
    assert.equal(f.store.list('collaborationSettings').length, 0)
    // Source metadata cannot select a different completion rule.
    const legacy = f.store.update<Task>('tasks', f.task.id, f.task.version, { workSource: undefined, assignedBy: undefined, assignedOn: undefined })
    assert.throws(() => f.work.updateTask(f.member, legacy.id, { version: legacy.version, status: 'done' }), { status: 400 })
    f.work.updateTask(f.member, legacy.id, { version: legacy.version, status: 'done', completionNote: '验收完成' })
    assert.equal(f.store.list('progressEvents').length, 1, 'base progress facts remain available while optional collaboration is disabled')
    assert.equal(f.store.list('collaborationNotificationIntents').length, 0)
    assert.equal(f.store.list('taskTrackings').length, 0)
  } finally { f.store.close() }
})

test('live assignments enroll only enabled pilots; future weekly assignments defer observation', () => {
  const f = fixture()
  try {
    assert.equal(f.store.get<TaskTracking>('taskTrackings', f.task.id)?.state, 'active')
    const outside = f.work.createTask(f.manager, { ownerId: f.other.id, title: '非试点', dueDate: '2099-01-20', isTemporary: true, temporaryReason: '临时' })
    assert.equal(f.store.get('taskTrackings', outside.id), undefined)
    const result = f.work.createWeeklyAssignment(f.manager, { requestId: 'future-week-assignment-001', task: { ownerId: f.member.id, title: '未来周安排', dueDate: '2099-01-20', isTemporary: true, temporaryReason: '临时' }, record: { weekStart: '2099-01-05', commitment: '未来周承诺', submitted: true } })
    const tracking = f.store.get<TaskTracking>('taskTrackings', result.task.id)!
    assert.equal(tracking.activeFrom, new Date(`${result.record.weekStart}T00:00:00+08:00`).toISOString())
  } finally { f.store.close() }
})

test('legacy writes share completion validation and meaningful-owner progress rules', () => {
  const f = fixture()
  try {
    assert.throws(() => f.work.updateTask(f.member, f.task.id, { version: f.task.version, status: 'done' }), { status: 400 })
    let task = f.work.updateTask(f.member, f.task.id, { reason: '测试场景确认承诺调整', version: f.task.version, description: '新的工作要求' })
    assert.equal(f.store.list('progressEvents').length, 0)
    assert.throws(() => f.work.updateTask(f.manager, task.id, { version: task.version, status: 'doing' }), { status: 400 })
    task = f.work.updateTask(f.manager, task.id, { version: task.version, status: 'doing', proxyReason: '根据会后记录代录' })
    let tracking = f.store.get<TaskTracking>('taskTrackings', task.id)!
    assert.equal(tracking.lastMeaningfulOwnerProgressAt, null)
    assert.ok(tracking.lastRecordedProgressAt)
    task = f.work.updateTask(f.member, task.id, { version: task.version, status: 'done', completionNote: '报告已完成并可复核' })
    tracking = f.store.get<TaskTracking>('taskTrackings', task.id)!
    assert.ok(tracking.lastMeaningfulOwnerProgressAt)
    assert.equal(tracking.state, 'closed')
    assert.equal(f.store.list<ProgressEvent>('progressEvents').length, 2)
  } finally { f.store.close() }
})

test('one explicit save creates one progress event and idempotent retry returns the original result', () => {
  const f = fixture()
  try {
    const record = f.work.createWeeklyRecord(f.manager, { taskId: f.task.id, weekStart: '2099-01-05', commitment: '本周独立工作', submitted: true })
    const input = { requestId: 'progress-command-001', version: f.task.version, taskStatus: 'doing', weeklyRecordId: record.id, weeklyRecordVersion: record.version, weekly: { status: 'done', actualOutcome: '本周交付完成' }, note: '本周部分已交付' }
    const result = f.service.recordProgress(f.member, f.task.id, input)
    assert.equal(result.task.status, 'doing')
    assert.equal(result.weeklyRecord?.status, 'done')
    assert.equal(f.store.list('progressEvents').length, 1)
    assert.deepEqual(f.service.recordProgress(f.member, f.task.id, input), result)
    assert.throws(() => f.service.recordProgress(f.member, f.task.id, { ...input, note: '不同内容' }), { status: 409 })
    assert.throws(() => f.service.recordProgress(f.other, f.task.id, input), { status: 404 })
  } finally { f.store.close() }
})

test('pending-plan execution feedback saves through progress API without publishing results or starting weekly followups', t => {
  const f = fixture(); t.after(() => f.store.close())
  ensureWeeklyPlanReviewRule(f.store)
  const record = f.work.createWeeklyRecord(f.member, { taskId: f.task.id, weekStart: '2099-01-05', commitment: '待审安排', submitted: true })
  assert.equal(record.planApproval?.required, true)
  const beforeTracking = f.store.get<TaskTracking>('taskTrackings', f.task.id)!
  const publishedCollections = ['businessNotificationEvents', 'digestItems', 'notifications', 'notificationDeliveries', 'blockerEpisodes', 'followupRequests']
  const notificationsBefore = publishedCollections.map(collection => f.store.list(collection))
  const input = { requestId: 'pending-weekly-only-progress', version: f.task.version, weeklyRecordId: record.id, weeklyRecordVersion: record.version,
    weekly: { status: 'done', actualOutcome: '审核期间已完成真实验证' } }
  const result = f.service.recordProgress(f.member, f.task.id, input)
  assert.equal(result.weeklyRecord?.actualOutcome, '审核期间已完成真实验证')
  assert.equal(result.weeklyRecord?.status, 'done')
  assert.equal(result.task.status, f.task.status)
  assert.equal(isEffectiveWeeklyRecord(result.weeklyRecord!), false)
  assert.ok(result.progressEvent!.changes.some(change => change.field === 'weeklyRecord.actualOutcome'))
  assert.equal(result.progressEvent!.meaningfulOwnerProgress, false)
  assert.deepEqual(f.store.get<TaskTracking>('taskTrackings', f.task.id), beforeTracking)
  assert.deepEqual(publishedCollections.map(collection => f.store.list(collection)), notificationsBefore)
  assert.deepEqual(f.service.recordProgress(f.member, f.task.id, input), result)
  assert.throws(() => f.service.createFollowup(f.manager, f.task.id, { requestId: 'pending-weekly-followup', version: result.task.version,
    weeklyRecordId: record.id, weeklyRecordVersion: result.weeklyRecord!.version, requirement: '催办待审周安排' }), { status: 409 })
})

test('pending-plan progress still validates no-change claims and manager proxy reasons', t => {
  const f = fixture(); t.after(() => f.store.close())
  ensureWeeklyPlanReviewRule(f.store)
  const record = f.work.createWeeklyRecord(f.member, { taskId: f.task.id, weekStart: '2099-01-05', commitment: '待审安排', submitted: true })
  const input = { requestId: 'pending-weekly-invalid-progress', version: f.task.version, weeklyRecordId: record.id, weeklyRecordVersion: record.version,
    weekly: { actualOutcome: '新的真实执行结果' } }
  assert.throws(() => f.service.recordProgress(f.member, f.task.id, { ...input, noteType: 'no_change', noChangeReason: '等待审批', nextAction: '继续反馈' }), { status: 400 })
  assert.throws(() => f.service.recordProgress(f.manager, f.task.id, input), { status: 400 })
  assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', record.id)?.actualOutcome, '')
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.version, f.task.version)
  assert.equal(f.store.list('progressEvents').length, 0)
  const saved = f.service.recordProgress(f.manager, f.task.id, { ...input, proxyReason: '根据成员现场反馈记录' })
  assert.equal(saved.weeklyRecord?.actualOutcome, '新的真实执行结果')
  assert.equal(saved.progressEvent?.proxyReason, '根据成员现场反馈记录')
})

test('one task has one open followup, and stale requests cannot close a changed request', () => {
  const f = fixture()
  try {
    const created = f.service.createFollowup(f.manager, f.task.id, { requestId: 'create-followup-001', version: f.task.version, requirement: '请说明实验结果' })
    const second = f.service.createFollowup(f.manager, f.task.id, { requestId: 'create-followup-002', version: f.task.version, requirement: '另一个要求' })
    assert.equal(second.existing, true)
    assert.equal(created.request.id, second.request.id)
    const changed = f.service.updateFollowup(f.manager, created.request.id, { requestId: 'update-followup-001', version: created.request.version, requirement: '追加质量说明', reason: '补充验收依据' })
    assert.throws(() => f.service.respondFollowup(f.member, created.request.id, { requestId: 'respond-stale-001', version: created.request.version, taskVersion: f.task.version, progress: { note: '实验已经开展' } }), { status: 409 })
    assert.equal(f.store.get<FollowupRequest>('followupRequests', changed.id)?.status, 'open')
    assert.equal(f.store.list('progressEvents').length, 0)
  } finally { f.store.close() }
})

test('late no-change response is explicit, durable, idempotent and does not refresh meaningful progress', () => {
  const f = fixture()
  try {
    const due = new Date(f.now().getTime() + 60000)
    const request = f.service.createFollowup(f.manager, f.task.id, { requestId: 'create-late-followup', version: f.task.version, requirement: '请说明当前情况', dueAt: due.toISOString() }).request
    f.setNow(new Date(due.getTime() + 60000))
    const input = { requestId: 'respond-no-change-001', version: request.version, taskVersion: f.task.version, progress: { noteType: 'no_change', noChangeReason: '等待测试环境恢复', nextAction: '明天重新验证' } }
    const result = f.service.respondFollowup(f.member, request.id, input)
    assert.equal(result.response?.late, true)
    assert.equal(result.followup?.status, 'responded')
    assert.equal(result.tracking?.lastMeaningfulOwnerProgressAt, null)
    assert.deepEqual(f.service.respondFollowup(f.member, request.id, input), result)
    assert.equal(f.store.list('followupResponses').length, 1)
  } finally { f.store.close() }
})

test('normal saves and manager proxy closure cannot impersonate a member response', () => {
  const f = fixture()
  try {
    const request = f.service.createFollowup(f.manager, f.task.id, { requestId: 'create-proxy-followup', version: f.task.version, requirement: '更新验证结果' }).request
    const saved = f.service.recordProgress(f.member, f.task.id, { requestId: 'ordinary-save-001', version: f.task.version, note: '第一轮结果已整理' })
    assert.equal(f.store.get<FollowupRequest>('followupRequests', request.id)?.status, 'open')
    assert.throws(() => f.service.respondFollowup(f.manager, request.id, { requestId: 'proxy-respond-001', version: request.version, taskVersion: saved.task.version, progress: { note: '管理者核实' } }), { status: 403 })
    const closed = f.service.closeFollowup(f.manager, request.id, { requestId: 'proxy-close-001', version: request.version, reason: '会议已核实，结束此次追问' })
    assert.equal(closed.status, 'cancelled')
    assert.equal(closed.respondedAt, null)
    assert.equal(f.store.list('followupResponses').length, 0)
  } finally { f.store.close() }
})

test('deadline approval guards old PATCH, preserves old deadline until approval and rejects changed date versions', () => {
  const f = fixture()
  try {
    f.service.updateSettings(f.manager, { requestId: 'enable-deadline-001', version: readCollaborationSettings(f.store).version, deadlineApprovalEnabled: true })
    const tracking = f.store.get<TaskTracking>('taskTrackings', f.task.id)!
    assert.throws(() => f.work.updateTask(f.member, f.task.id, { reason: '测试场景确认承诺调整', version: f.task.version, dueDate: '2099-01-25' }), { status: 409 })
    const request = f.service.requestDeadline(f.member, f.task.id, { requestId: 'request-deadline-001', version: f.task.version, dueDateVersion: tracking.dueDateVersion, requestedDueDate: '2099-01-25', reason: '新增兼容验证' })
    assert.equal(f.store.get<Task>('tasks', f.task.id)?.dueDate, '2099-01-20')
    const result = f.service.decideDeadline(f.manager, request.id, { requestId: 'decide-deadline-001', version: request.version, dueDateVersion: tracking.dueDateVersion, decision: 'approved', note: '同意延期验证' })
    assert.equal(result.task.dueDate, '2099-01-25')
    assert.equal(result.request.status, 'approved')
    assert.equal(result.tracking.dueDateVersion, tracking.dueDateVersion + 1)
    const pending = f.service.requestDeadline(f.member, f.task.id, { requestId: 'request-deadline-002', version: result.task.version, dueDateVersion: result.tracking.dueDateVersion, requestedDueDate: '2099-01-28', reason: '第二轮' })
    f.work.updateTask(f.manager, f.task.id, { version: result.task.version, dueDate: '2099-01-27', reason: '主管调整' })
    assert.throws(() => f.service.decideDeadline(f.manager, pending.id, { requestId: 'decide-deadline-002', version: pending.version, dueDateVersion: pending.dueDateVersion, decision: 'approved', note: '' }), { status: 409 })
    assert.equal(f.store.get<Task>('tasks', f.task.id)?.dueDate, '2099-01-27')
  } finally { f.store.close() }
})

test('pause needs a future review, explicit resume resets observation without rewriting progress or deadline', () => {
  const f = fixture()
  try {
    const original = f.store.get<TaskTracking>('taskTrackings', f.task.id)!
    const paused = f.service.updateTracking(f.manager, f.task.id, { requestId: 'tracking-pause-001', version: original.version, taskVersion: f.task.version, state: 'paused', reason: '设备维护', reviewAt: new Date(f.now().getTime() + 86400000).toISOString() })
    f.setNow(new Date(f.now().getTime() + 3600000))
    const resumed = f.service.updateTracking(f.manager, f.task.id, { requestId: 'tracking-resume-001', version: paused.version, taskVersion: f.task.version, state: 'active', reason: '设备恢复' })
    assert.equal(resumed.reminderBaselineAt, f.now().toISOString())
    assert.equal(resumed.dueDateVersion, original.dueDateVersion)
    assert.equal(resumed.lastMeaningfulOwnerProgressAt, null)
  } finally { f.store.close() }
})

test('blocker management close preserves actual blocked business state and audit', () => {
  const f = fixture()
  try {
    const result = f.service.recordProgress(f.member, f.task.id, { requestId: 'record-blocker-001', version: f.task.version, taskStatus: 'blocked', blockerReason: '测试环境不可用', blockerImpact: '验证延后', supportNeeded: '请恢复环境' })
    const episode = f.store.list<BlockerEpisode>('blockerEpisodes')[0]
    const handled = f.service.handleBlocker(f.manager, episode.id, { requestId: 'handle-blocker-001', version: episode.version, action: 'close', note: '已转为周会跟进支持' })
    assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'blocked')
    assert.equal(handled.episode.resolvedAt, null)
    assert.ok(handled.episode.managementClosedAt)
    assert.equal(result.progressEvent?.meaningfulOwnerProgress, true)
    assert.equal(f.store.list('blockerActions').length, 1)
  } finally { f.store.close() }
})

test('business migration carries progress and followups, pauses restored tracking and never clones delivery intent', () => {
  const f = fixture(), target = fixture(false)
  try {
    f.service.recordProgress(f.member, f.task.id, { requestId: 'migrate-progress-001', version: f.task.version, note: '已准备测试数据' })
    const current = f.store.get<Task>('tasks', f.task.id)!
    f.service.createFollowup(f.manager, f.task.id, { requestId: 'migrate-followup-001', version: current.version, requirement: '请补充结果' })
    const packet = exportBusinessData(f.store, f.manager)
    assert.equal(packet.formatVersion, 6)
    assert.equal(packet.collections.progressEvents.length, 1)
    assert.equal(Object.hasOwn(packet.collections, 'businessNotificationEvents'), false)
    const preview = previewRestore(target.store, target.manager, packet)
    assert.equal(preview.canRestore, true, preview.issues.join('\n'))
    restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
    assert.equal(target.store.get<TaskTracking>('taskTrackings', f.task.id)?.state, 'paused')
    assert.equal(target.store.list('businessNotificationEvents').length, 0)
    assert.equal(target.store.list('followupRequests').length, 1)
    assert.equal(userDeletionPreview(f.store, f.manager, f.member).blockers.some(row => row.key === 'progressEvents'), true)
    assert.equal(previewRestore(target.store, target.manager, packet).canRestore, true)
  } finally { f.store.close(); target.store.close() }
})

test('silent import cannot enroll work or synthesize progress while collaboration is enabled', () => {
  const f = fixture()
  try {
    const imported = withSilentImport(f.store, () => {
      const task = f.work.createTask(f.manager, { ownerId: f.member.id, title: '恢复来源任务', dueDate: '2099-01-20', isTemporary: true, temporaryReason: '导入历史' })
      f.work.updateTask(f.manager, task.id, { version: task.version, status: 'done' })
      return task
    })
    assert.equal(f.store.get('taskTrackings', imported.id), undefined)
    assert.equal(f.store.list<ProgressEvent>('progressEvents').some(row => row.taskId === imported.id), false)
  } finally { f.store.close() }
})

test('a silently imported draft enrolls only when its manager explicitly publishes the first weekly arrangement', () => {
  const f = fixture()
  try {
    const imported = withSilentImport(f.store, () => {
      let task = f.work.createTask(f.manager, { ownerId: f.member.id, title: '导入待下发安排', dueDate: '2099-01-20', isTemporary: true, temporaryReason: '导入草稿' })
      task = f.store.update<Task>('tasks', task.id, task.version, { importSource: { batchId: 'batch', sourceId: 'source', rowId: 'row', sourceStatus: '草稿', mode: 'draft', notificationMode: 'silent' } })
      const record = f.work.createWeeklyRecord(f.manager, { taskId: task.id, weekStart: '2099-01-05', commitment: '待正式下发', submitted: false })
      return { task, record }
    })
    assert.equal(f.store.get('taskTrackings', imported.task.id), undefined)
    f.work.updateWeeklyRecord(f.manager, imported.record.id, { version: imported.record.version, submitted: true })
    assert.equal(f.store.get<TaskTracking>('taskTrackings', imported.task.id)?.state, 'active')
  } finally { f.store.close() }
})

test('invalid combined response rolls back task, progress, followup and command receipt together', () => {
  const f = fixture()
  try {
    const request = f.service.createFollowup(f.manager, f.task.id, { requestId: 'rollback-followup-001', version: f.task.version, requirement: '请核对当前进展' }).request
    const receipts = f.store.list('collaborationCommandReceipts').length
    assert.throws(() => f.service.respondFollowup(f.member, request.id, { requestId: 'rollback-response-001', version: request.version, taskVersion: f.task.version,
      progress: { taskStatus: 'done', completionNote: '已经完成', noteType: 'no_change', noChangeReason: '还在等待', nextAction: '继续等待' } }), { status: 400 })
    assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'todo')
    assert.equal(f.store.get<FollowupRequest>('followupRequests', request.id)?.status, 'open')
    assert.equal(f.store.list('progressEvents').length, 0)
    assert.equal(f.store.list('collaborationCommandReceipts').length, receipts)
  } finally { f.store.close() }
})

test('idempotency key is scoped to actor and command, not freely reusable across target tasks', () => {
  const f = fixture()
  try {
    const other = f.work.createTask(f.manager, { ownerId: f.member.id, title: '另一任务', dueDate: '2099-01-20', isTemporary: true, temporaryReason: '临时' })
    f.service.recordProgress(f.member, f.task.id, { requestId: 'cross-target-progress', version: f.task.version, note: '已准备验证资料' })
    assert.throws(() => f.service.recordProgress(f.member, other.id, { requestId: 'cross-target-progress', version: other.version, note: '已准备验证资料' }), { status: 409 })
  } finally { f.store.close() }
})

test('a followup response and its progress event share one instant even when the clock advances between calls', () => {
  const f = fixture()
  try {
    const request = f.service.createFollowup(f.manager, f.task.id, { requestId: 'create-instant-followup', version: f.task.version, requirement: '请说明当前情况', dueAt: new Date(f.now().getTime() + 3600000).toISOString() }).request
    // Every clock read lands on a new millisecond, as happens intermittently in production.
    let tick = f.now().getTime()
    const advancing = new CollaborationService(f.store, () => new Date(++tick))
    const result = advancing.respondFollowup(f.member, request.id, { requestId: 'respond-instant-001', version: request.version, taskVersion: f.task.version, progress: { note: '完成三组兼容性验证' } })
    const progress = f.store.get<ProgressEvent>('progressEvents', result.response!.progressEventId)!
    assert.equal(progress.occurredAt, result.response!.respondedAt)
    assert.equal(result.followup!.respondedAt, result.response!.respondedAt)
  } finally { f.store.close() }
})
