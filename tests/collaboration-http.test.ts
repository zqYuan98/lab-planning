import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { MonthlyPlan, Task } from '../shared/types.ts'
import type { BusinessNotificationEvent, CollaborationSettings, CollaborationTaskView, DeadlineChangeRequest, DeadlineDecisionResult, FollowupRequest, FollowupResult, ProgressResult, TaskTracking } from '../shared/collaboration.ts'
import type { CollaborationPreference, DigestItem, NotificationDigest } from '../shared/collaboration-notifications.ts'
import type { Notification, NotificationSettingsView } from '../shared/notifications.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { Store } from '../server/store.ts'
import type { DingTalkClient } from '../server/dingtalk.ts'
import { adjacentWorkday, dayAt, shanghaiDate, shiftDay } from '../server/collaboration-calendar.ts'
import { runCollaborationDigests } from '../server/collaboration-digests.ts'
import { currentNotificationMessage } from '../server/notification-worker.ts'

// Every HTTP request is loopback; the injected provider fails if any code attempts external I/O.
const provider: DingTalkClient = { configured: false, corpId: '', clientId: '', async getIdentity() { throw new Error('No external I/O in HTTP tests') }, async send() { throw new Error('No external I/O in HTTP tests') }, async result() { throw new Error('No external I/O in HTTP tests') } }
interface BatchPreview {
  taskIds: string[]; requirement: string; dueAt: string; enroll: boolean; previewToken: string; readonly: boolean
  recipients: { recipientId: string; items: { taskId: string; taskVersion: number }[] }[]
}

async function fixture(t: TestContext, settingsPatch: Partial<CollaborationSettings> = {}) {
  const store = new Store(':memory:')
  const user = (id: string, role: StoredUser['role']) => store.insert<StoredUser>('users', { id, name: id, email: `${id}@example.test`, role, position: '', active: true, credentialVersion: 1, passwordHash: 'unused' })
  const manager = user('manager', 'manager'), member = user('member', 'member'), peer = user('peer', 'member')
  const server = createApp({ store, enableScheduler: false, dingtalkClient: provider }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close() })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const client = (actor: StoredUser) => {
    const cookie = `lab_session=${createSession(store, actor)}`
    return async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', expected = 200): Promise<T> {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
      const result = await response.text()
      assert.equal(response.status, expected, `${actor.id} ${method} ${path}: ${result}`)
      return JSON.parse(result) as T
    }
  }
  const admin = client(manager), owner = client(member), outsider = client(peer)
  await admin('/collaboration/settings', { requestId: 'http-enable-001', version: 0, enabled: true, pilotUserIds: [member.id], defaultManagerIds: [manager.id], ...settingsPatch }, 'PUT')
  const createTask = (title = '接口验证任务', dueDate = '2099-01-20') => admin<Task>('/tasks', { ownerId: member.id, title, description: '交付可复核报告', dueDate, isTemporary: true, temporaryReason: '测试安排' }, 'POST', 201)
  return { store, manager, member, peer, admin, owner, outsider, createTask }
}

test('HTTP batch followup preview is read-only, groups two tasks into one digest, and retries are idempotent', async t => {
  const f = await fixture(t), first = await f.createTask('接口验证 A'), second = await f.createTask('接口验证 B')
  const collections = ['events', 'followupRequests', 'businessNotificationEvents', 'notifications', 'notificationDigests', 'collaborationCommandReceipts']
  const before = collections.map(name => f.store.list(name))
  const preview = await f.admin<BatchPreview>('/followups/preview', { taskIds: [second.id, first.id], requirement: '请逐项补充进展与下一步' })
  assert.equal(preview.readonly, true)
  assert.equal(preview.recipients.length, 1)
  assert.equal(preview.recipients[0].recipientId, f.member.id)
  assert.deepEqual(new Set(preview.recipients[0].items.map(item => item.taskId)), new Set([first.id, second.id]))
  assert.deepEqual(collections.map(name => f.store.list(name)), before)
  const input = { requestId: 'http-batch-001', taskIds: preview.taskIds, requirement: preview.requirement, dueAt: preview.dueAt, enroll: preview.enroll, previewToken: preview.previewToken }
  const result = await f.admin<{ items: FollowupResult[]; recipientCount: number }>('/followups/batch', input)
  assert.equal(result.items.length, 2); assert.equal(result.recipientCount, 1)
  const digests = f.store.list<NotificationDigest>('notificationDigests').filter(row => row.type === 'manual_followup')
  assert.equal(digests.length, 1); assert.equal(digests[0].itemIds.length, 2)
  assert.equal(f.store.list<Notification>('notifications').filter(row => row.kind === 'collaboration_manual_followup').length, 1)
  const committed = collections.map(name => f.store.list(name))
  assert.deepEqual(await f.admin('/followups/batch', input), result)
  assert.deepEqual(collections.map(name => f.store.list(name)), committed)
  await f.admin('/followups/batch', { ...input, requirement: '改变要求必须重新预览' }, 'POST', 409)
  assert.deepEqual(collections.map(name => f.store.list(name)), committed)
  await f.outsider(`/digests/${digests[0].id}`, undefined, 'GET', 404)
})

test('HTTP stale batch preview conflicts without partial followup creation and peers cannot inspect or manage work', async t => {
  const f = await fixture(t), first = await f.createTask('甲'), second = await f.createTask('乙')
  await f.outsider(`/collaboration/tasks/${first.id}`, undefined, 'GET', 404)
  await f.outsider('/collaboration/settings', undefined, 'GET', 403)
  await f.outsider('/collaboration/settings', { requestId: 'peer-settings-001', version: 1, enabled: false }, 'PUT', 403)
  await f.outsider('/followups/preview', { taskIds: [first.id], requirement: '越权催办' }, 'POST', 403)
  const preview = await f.admin<BatchPreview>('/followups/preview', { taskIds: [first.id, second.id], requirement: '说明实验结果' })
  await f.admin(`/tasks/${second.id}`, { version: second.version, description: '验收要求已变化' }, 'PATCH')
  await f.admin('/followups/batch', { ...preview, requestId: 'http-stale-batch-001' }, 'POST', 409)
  assert.equal(f.store.list('followupRequests').length, 0)
  assert.equal(f.store.list<NotificationDigest>('notificationDigests').filter(row => row.type === 'manual_followup').length, 0)
})

test('HTTP ordinary progress preserves the open request; only explicit owner response closes it without formal submission', async t => {
  const f = await fixture(t), task = await f.createTask()
  const request = (await f.admin<FollowupResult>(`/tasks/${task.id}/followups`, { requestId: 'http-followup-001', version: task.version, requirement: '请说明当前进展' }, 'POST', 201)).request
  const saved = await f.owner<ProgressResult>(`/tasks/${task.id}/progress`, { requestId: 'http-save-001', version: task.version, note: '第一轮验证已完成', nextAction: '明天复核边界场景' })
  assert.equal(f.store.get<FollowupRequest>('followupRequests', request.id)?.status, 'open')
  const input = { requestId: 'http-respond-001', version: request.version, taskVersion: saved.task.version, progress: { note: '已复核边界场景，等待集成测试', nextAction: '开展集成测试' } }
  await f.outsider(`/followups/${request.id}/respond`, input, 'POST', 404)
  await f.admin(`/followups/${request.id}/respond`, input, 'POST', 403)
  const responded = await f.owner<ProgressResult>(`/followups/${request.id}/respond`, input)
  assert.equal(responded.followup?.status, 'responded')
  assert.equal(responded.response?.actorId, f.member.id)
  assert.equal(f.store.list('followupResponses').length, 1)
  assert.equal(f.store.list('progressEvents').length, 2)
  assert.equal(f.store.list('weeklySubmissions').length, 0)
  assert.deepEqual(await f.owner(`/followups/${request.id}/respond`, input), responded)
  assert.equal(f.store.list('followupResponses').length, 1)
  assert.equal(f.store.list('progressEvents').length, 2)
  assert.equal((await f.owner<CollaborationTaskView>(`/collaboration/tasks/${task.id}`)).followups[0].status, 'responded')
})

test('HTTP deadline approval enforces actor and version checks, and approval invalidates queued reminders for the old date', async t => {
  const f = await fixture(t, { deadlineApprovalEnabled: true, autoRulesEnabled: true, staleWorkdays: 30 })
  const today = shanghaiDate(new Date()), task = await f.createTask('延期验证', shiftDay(today, -1))
  const tracking = f.store.get<TaskTracking>('taskTrackings', task.id)!
  const sendAt = dayAt(adjacentWorkday(today, 1))
  runCollaborationDigests(f.store, sendAt)
  const digest = f.store.list<NotificationDigest>('notificationDigests').find(row => row.type === 'risk_member')!
  assert.ok(digest, 'an old-deadline reminder must exist before the approval')
  const oldReminder = f.store.get<Notification>('notifications', digest.notificationId!)!
  assert.ok(currentNotificationMessage(f.store, f.member, oldReminder, sendAt, true))
  const input = { requestId: 'http-deadline-001', version: task.version, dueDateVersion: tracking.dueDateVersion, requestedDueDate: shiftDay(today, 30), reason: '增加兼容性验证' }
  await f.owner(`/tasks/${task.id}`, { version: task.version, dueDate: input.requestedDueDate }, 'PATCH', 409)
  await f.admin(`/tasks/${task.id}/deadline-requests`, input, 'POST', 403)
  const request = await f.owner<DeadlineChangeRequest>(`/tasks/${task.id}/deadline-requests`, input, 'POST', 201)
  assert.equal(f.store.get<Task>('tasks', task.id)?.dueDate, task.dueDate)
  const decide = { requestId: 'http-decision-001', version: request.version, dueDateVersion: tracking.dueDateVersion, decision: 'approved', note: '同意增加验证' }
  await f.owner(`/deadline-requests/${request.id}/decide`, decide, 'POST', 403)
  await f.outsider(`/deadline-requests/${request.id}/decide`, decide, 'POST', 403)
  await f.admin(`/deadline-requests/${request.id}/decide`, { ...decide, version: request.version + 1 }, 'POST', 409)
  const approved = await f.admin<DeadlineDecisionResult>(`/deadline-requests/${request.id}/decide`, decide)
  assert.equal(approved.request.status, 'approved')
  assert.equal(approved.task.dueDate, input.requestedDueDate)
  assert.equal(approved.tracking.dueDateVersion, tracking.dueDateVersion + 1)
  assert.equal(currentNotificationMessage(f.store, f.member, oldReminder, sendAt, true), undefined, 'worker must refuse the old-date reminder after approval')
  const pending = await f.owner<DeadlineChangeRequest>(`/tasks/${task.id}/deadline-requests`, { ...input, requestId: 'http-deadline-002', version: approved.task.version, dueDateVersion: approved.tracking.dueDateVersion, requestedDueDate: shiftDay(today, 40) }, 'POST', 201)
  const changed = await f.admin<Task>(`/tasks/${task.id}`, { version: approved.task.version, dueDate: shiftDay(today, 35), reason: '主管调整了新的截止' }, 'PATCH')
  await f.admin(`/deadline-requests/${pending.id}/decide`, { ...decide, requestId: 'http-decision-002', version: pending.version, dueDateVersion: pending.dueDateVersion }, 'POST', 409)
  assert.equal(f.store.get<Task>('tasks', task.id)?.dueDate, changed.dueDate)
  assert.equal(f.store.get<DeadlineChangeRequest>('deadlineChangeRequests', pending.id)?.status, 'superseded')
})

test('HTTP changing the global sending window cannot strand enabled collaboration slots and validation is atomic', async t => {
  const f = await fixture(t, { autoRulesEnabled: true, dailyManagerEnabled: true })
  const original = (await f.admin<NotificationSettingsView>('/notification-settings')).settings
  const patch = { version: original.version, externalEnabled: false, pilotUserIds: [], sendStartHour: 10, sendEndHour: 16 }
  await f.admin('/notification-settings', patch, 'PUT', 400)
  assert.deepEqual((await f.admin<NotificationSettingsView>('/notification-settings')).settings, original)
  await f.admin('/notification-settings', { ...patch, sendStartHour: 8, sendEndHour: 17 }, 'PUT', 400)
  assert.deepEqual((await f.admin<NotificationSettingsView>('/notification-settings')).settings, original)
  assert.equal(f.store.list('notificationAdminEvents').length, 0)
  const saved = await f.admin<NotificationSettingsView>('/notification-settings', { ...patch, sendStartHour: 9, sendEndHour: 18 }, 'PUT')
  assert.equal(saved.settings.sendEndHour, 18)
  assert.equal(f.store.list('notificationAdminEvents').length, 1)
  const settings = await f.admin<CollaborationSettings>('/collaboration/settings')
  await f.admin('/collaboration/settings', { requestId: 'http-disable-slots-001', version: settings.version, autoRulesEnabled: false, dailyManagerEnabled: false }, 'PUT')
  await f.admin('/notification-settings', { ...patch, version: saved.settings.version }, 'PUT')
  const noSlots = await f.admin<CollaborationSettings>('/collaboration/settings')
  await f.admin('/collaboration/settings', { requestId: 'http-enable-stranded-001', version: noSlots.version, autoRulesEnabled: true }, 'PUT', 400)
  assert.deepEqual(await f.admin('/collaboration/settings'), noSlots)
})

test('HTTP editing submitted monthly-result text does not generate another submission event or approval item', async t => {
  const f = await fixture(t)
  let plan = await f.admin<MonthlyPlan>('/plans', { ownerId: f.member.id, month: '2099-01', title: '成果验证', category: '测试验证', priority: 'medium', dueDate: '2099-01-20', expectedOutcome: '交付报告', acceptanceCriteria: '报告可复核' }, 'POST', 201)
  plan = await f.admin<MonthlyPlan>(`/plans/${plan.id}/submit`, { version: plan.version })
  plan = await f.admin<MonthlyPlan>(`/plans/${plan.id}/review`, { version: plan.version, decision: 'approve', comment: '按标准交付' })
  await f.admin('/months/2099-01/publish', { planIds: [plan.id] })
  plan = f.store.get<MonthlyPlan>('plans', plan.id)!
  plan = await f.owner<MonthlyPlan>(`/plans/${plan.id}/result`, { version: plan.version, acceptanceStatus: 'submitted', actualOutcome: '报告已经完成' })
  const events = () => f.store.list<BusinessNotificationEvent>('businessNotificationEvents').filter(row => row.kind === 'plan_result_submitted')
  const items = () => f.store.list<DigestItem>('digestItems').filter(row => row.sourceKind === 'plan_result_submitted')
  assert.equal(events().length, 1); assert.equal(items().length, 1)
  const firstEvent = events()[0], firstItem = items()[0]
  plan = await f.owner<MonthlyPlan>(`/plans/${plan.id}/result`, { version: plan.version, acceptanceStatus: 'submitted', actualOutcome: '报告已经完成，补充可复核版本号 v2' })
  assert.equal(plan.actualOutcome, '报告已经完成，补充可复核版本号 v2')
  assert.deepEqual(events(), [firstEvent]); assert.deepEqual(items(), [firstItem])
})

test('HTTP manager deadline edits keep the legacy work-change notice without a duplicate collaboration notice to the member', async t => {
  const f = await fixture(t), task = await f.createTask()
  const before = new Set(f.store.list<Notification>('notifications').map(row => row.id))
  await f.admin(`/tasks/${task.id}`, { version: task.version, dueDate: '2099-01-25', reason: '补充验收步骤' }, 'PATCH')
  const notices = f.store.list<Notification>('notifications').filter(row => row.recipientId === f.member.id && !before.has(row.id))
  assert.deepEqual(notices.map(row => row.kind), ['work_changed'])
  assert.equal(f.store.list<BusinessNotificationEvent>('businessNotificationEvents').filter(row => row.kind === 'deadline_changed').length, 1, 'the business fact must still exist for audit and manager summaries')
  assert.equal(f.store.list<DigestItem>('digestItems').filter(row => row.recipientId === f.member.id && row.sourceKind === 'deadline_changed').length, 0)
})

test('HTTP optional summary preference defaults on, is isolated to the session user, and is removed with an unused account', async t => {
  const f = await fixture(t, { memberActionsEnabled: true })
  const getPreference = async (request: typeof f.owner) => (await request<{ preference: { version: number; memberActionsEnabled: boolean } }>('/collaboration')).preference
  assert.deepEqual(await getPreference(f.owner), { version: 0, memberActionsEnabled: true })
  assert.equal(f.store.list('collaborationPreferences').length, 0, 'a default read must not write preferences')
  const input = { requestId: 'http-preference-001', version: 0, memberActionsEnabled: false, userId: f.peer.id }
  const saved = await f.owner<CollaborationPreference>('/collaboration/preferences', input, 'PUT')
  assert.equal(saved.id, f.member.id); assert.equal(saved.userId, f.member.id)
  assert.equal(saved.memberActionsEnabled, false)
  assert.deepEqual(await f.owner('/collaboration/preferences', input, 'PUT'), saved)
  assert.deepEqual(await getPreference(f.outsider), { version: 0, memberActionsEnabled: true })
  await f.owner('/collaboration/preferences', { ...input, requestId: 'http-preference-stale', memberActionsEnabled: true }, 'PUT', 409)
  await f.owner('/collaboration/preferences', { requestId: 'http-preference-invalid', version: saved.version, memberActionsEnabled: 'false' }, 'PUT', 400)
  assert.deepEqual(f.store.get('collaborationPreferences', f.member.id), saved)
  await f.outsider('/collaboration/preferences', { requestId: 'http-peer-preference', version: 0, memberActionsEnabled: false }, 'PUT')
  const preview = await f.admin<{ canDelete: boolean; blockers: unknown[] }>(`/users/${f.peer.id}/deletion-preview`)
  assert.equal(preview.canDelete, true); assert.deepEqual(preview.blockers, [])
  await f.admin(`/users/${f.peer.id}`, { version: f.peer.version, confirmName: f.peer.name }, 'DELETE')
  assert.equal(f.store.get('collaborationPreferences', f.peer.id), undefined)
  assert.deepEqual(f.store.get('collaborationPreferences', f.member.id), saved)
  await f.outsider('/collaboration', undefined, 'GET', 401)
})

test('HTTP approval digest preserves request facts, projects current decisions consistently, and sends only unresolved requests', async t => {
  const f = await fixture(t, { deadlineApprovalEnabled: true })
  const first = await f.createTask('摘要延期甲', '2099-01-20'), second = await f.createTask('摘要延期乙', '2099-01-21')
  const requestDeadline = async (task: Task, requestedDueDate: string, requestId: string) => {
    const tracking = f.store.get<TaskTracking>('taskTrackings', task.id)!
    return f.owner<DeadlineChangeRequest>(`/tasks/${task.id}/deadline-requests`, {
      requestId, version: task.version, dueDateVersion: tracking.dueDateVersion, requestedDueDate, reason: '补充验收场景后交付',
    }, 'POST', 201)
  }
  const firstRequest = await requestDeadline(first, '2099-01-27', 'http-digest-deadline-001')
  const secondRequest = await requestDeadline(second, '2099-01-29', 'http-digest-deadline-002')
  const digests = f.store.list<NotificationDigest>('notificationDigests').filter(row => row.type === 'approval_manager' && row.recipientId === f.manager.id)
  assert.equal(digests.length, 1, 'two requests for the same manager should share one pending approval digest')
  const digest = digests[0]
  assert.equal(digest.itemIds.length, 2)
  assert.ok(digest.notificationId)
  const notification = f.store.get<Notification>('notifications', digest.notificationId)!
  const firstStored = f.store.get<DigestItem>('digestItems', digest.itemIds[0])!
  assert.match(firstStored.lines.join('\n'), /原截止：2099-01-20/)
  assert.match(firstStored.lines.join('\n'), /当时记录：.*北京时间/)
  // Persisted pre-fix prose must also be corrected by the read projection, without rewriting history.
  f.store.update<DigestItem>('digestItems', firstStored.id, firstStored.version, { lines: [
    `延期申请待处理；发生于 ${firstStored.occurredAt}`, '新截止：2099-01-20', '申请截止：2099-01-27',
  ] })
  const storedItems = digest.itemIds.map(id => f.store.get<DigestItem>('digestItems', id))
  const readDigest = () => f.admin<NotificationDigest & { items: DigestItem[] }>(`/digests/${digest.id}`)
  const readNotification = () => f.admin<NonNullable<ReturnType<typeof currentNotificationMessage>>>(`/notifications/${digest.notificationId}`)
  const approve = (request: DeadlineChangeRequest, requestId: string) => f.admin<DeadlineDecisionResult>(`/deadline-requests/${request.id}/decide`, {
    requestId, version: request.version, dueDateVersion: request.dueDateVersion, decision: 'approved', note: '同意补充验证',
  })
  assert.equal(currentNotificationMessage(f.store, f.manager, notification, new Date(), true)?.content?.items.length, 2)
  await approve(firstRequest, 'http-digest-decision-001')

  const projectedDigest = await readDigest(), projectedNotification = await readNotification()
  assert.equal(projectedDigest.items.length, 2, 'processed requests remain readable as historical facts')
  const firstItem = projectedDigest.items.find(item => item.target.id === firstRequest.id)!
  assert.ok(firstItem)
  const lines = firstItem.lines.join('\n')
  assert.match(lines, /原截止[^\n]*2099-01-20/)
  assert.match(lines, /申请截止[^\n]*2099-01-27/)
  assert.match(lines, /当前处理状态：已批准/)
  assert.match(lines, /当前截止：2099-01-27/)
  assert.doesNotMatch(lines, /新截止：2099-01-20/, 'old prose must not mislabel the original deadline as the new deadline')
  assert.match(lines, /北京时间/)
  assert.doesNotMatch(lines, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/, 'rendered event time should not expose raw UTC timestamps')
  assert.deepEqual(projectedNotification.content?.items.find(item => item.target.id === firstRequest.id)?.lines, firstItem.lines, 'digest API and notification API must use the same current projection')
  assert.match(projectedNotification.body, /北京时间/)
  assert.doesNotMatch(projectedNotification.body, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)
  const stillPending = currentNotificationMessage(f.store, f.manager, notification, new Date(), true)
  assert.deepEqual(stillPending?.content?.items.map(item => item.target.id), [secondRequest.id], 'the send projection must omit only the approved request')

  await approve(secondRequest, 'http-digest-decision-002')
  assert.equal(currentNotificationMessage(f.store, f.manager, notification, new Date(), true), undefined, 'nothing is sent after both approval obligations are resolved')
  const completedHistory = await readDigest()
  assert.equal(completedHistory.items.length, 2)
  assert.ok(completedHistory.items.every(item => item.lines.some(line => line.includes('当前处理状态：已批准'))))
  assert.deepEqual(digest.itemIds.map(id => f.store.get<DigestItem>('digestItems', id)), storedItems, 'current-state projections must not rewrite the original stored digest items')
})

test('HTTP responded followup history retains that response progress after later saves and hides it after ownership changes', async t => {
  const f = await fixture(t), task = await f.createTask('回应事实历史验证')
  const followup = (await f.admin<FollowupResult>(`/tasks/${task.id}/followups`, {
    requestId: 'http-response-history-followup', version: task.version, requirement: '说明本轮验证结果与下一步',
  }, 'POST', 201)).request
  const digest = f.store.list<NotificationDigest>('notificationDigests').find(row => row.type === 'manual_followup' && row.recipientId === f.member.id)!
  assert.ok(digest?.notificationId)
  const note = '本次回应事实：完成三组兼容性验证', nextAction = '本次回应下一步：周三提交复核材料'
  const responded = await f.owner<ProgressResult>(`/followups/${followup.id}/respond`, {
    requestId: 'http-response-history-response', version: followup.version, taskVersion: task.version, progress: { note, nextAction, evidenceUrl: 'https://evidence.example.test/response-proof' },
  })
  assert.ok(responded.response?.progressEventId, 'the response must identify its own progress event')
  const laterNote = '后续独立记录：开始准备部署', laterNextAction = '后续独立下一步：安排部署演练'
  const later = await f.owner<ProgressResult>(`/tasks/${task.id}/progress`, {
    requestId: 'http-response-history-later', version: responded.task.version, note: laterNote, nextAction: laterNextAction,
  })
  const projectedDigest = await f.owner<NotificationDigest & { items: DigestItem[] }>(`/digests/${digest.id}`)
  const projectedNotification = await f.owner<NonNullable<ReturnType<typeof currentNotificationMessage>>>(`/notifications/${digest.notificationId}`)
  assert.equal(projectedDigest.items.length, 1)
  const lines = projectedDigest.items[0].lines.join('\n')
  assert.ok(lines.includes(note), 'historical followup content must include the progress recorded by this response')
  assert.ok(lines.includes(nextAction), 'historical followup content must include this response next action')
  assert.match(lines, /本次回应成果材料：［链接请进入事项查看］/)
  assert.ok(!lines.includes('https://evidence.example.test/response-proof'), 'notification projection must not expose raw evidence links')
  assert.ok(!lines.includes(laterNote) && !lines.includes(laterNextAction), 'later task updates must not be shown as facts of the earlier response')
  assert.match(lines, /北京时间/)
  assert.doesNotMatch(lines, /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/)
  assert.deepEqual(projectedNotification.content?.items[0]?.lines, projectedDigest.items[0].lines)

  // No public reassignment endpoint exists; simulate a changed persisted owner before exercising HTTP access checks.
  f.store.update<Task>('tasks', task.id, later.task.version, { ownerId: f.peer.id })
  const hiddenDigest = await f.owner<NotificationDigest & { items: DigestItem[] }>(`/digests/${digest.id}`)
  const hiddenNotification = await f.owner<NonNullable<ReturnType<typeof currentNotificationMessage>>>(`/notifications/${digest.notificationId}`)
  assert.deepEqual(hiddenDigest.items, [], 'the former owner must no longer receive the followup item projection')
  assert.equal(hiddenNotification.content?.items.length ?? 0, 0)
  assert.ok(!hiddenNotification.body.includes(note) && !hiddenNotification.body.includes(nextAction))
  await f.owner(`/collaboration/tasks/${task.id}`, undefined, 'GET', 404)
})
