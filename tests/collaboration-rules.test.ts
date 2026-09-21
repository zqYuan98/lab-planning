import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import type { Task, User } from '../shared/types.ts'
import type { BlockerEpisode, CollaborationSettings, FollowupRequest, TaskTracking } from '../shared/collaboration.ts'
import type { CollaborationPreference, DigestItem, NotificationDigest, ReminderOccurrence } from '../shared/collaboration-notifications.ts'
import { adjacentWorkday, dayAt, shanghaiDate, shiftDay, weekOf, workdayCount } from '../server/collaboration-calendar.ts'
import { automaticRiskCandidates, evaluateWorkRisks } from '../server/collaboration-rules.ts'
import { addDigestItem, createDigest, runCollaborationDigests } from '../server/collaboration-digests.ts'
import { enrollTaskTracking } from '../server/collaboration-tracking.ts'
import type { Notification } from '../shared/notifications.ts'
import { currentNotificationMessage } from '../server/notification-worker.ts'
import { visibleDigestItems } from '../server/collaboration-content.ts'

function fixture(t: TestContext, patch: Partial<CollaborationSettings> = {}) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const manager = store.insert<User>('users', { name: '主管', email: 'manager@test.local', role: 'manager', active: true, position: '' })
  const member = store.insert<User>('users', { name: '成员', email: 'member@test.local', role: 'member', active: true, position: '' })
  const settings = store.insert<CollaborationSettings>('collaborationSettings', { id: 'collaboration', enabled: true, autoRulesEnabled: true, deadlineApprovalEnabled: false,
    dailyManagerEnabled: true, weeklyManagerEnabled: true, memberActionsEnabled: false, pilotUserIds: [member.id], defaultManagerIds: [manager.id], calendarOverrides: {},
    staleWorkdays: 3, blockerWorkdays: 2, enabledAt: dayAt('2026-09-01').toISOString(), ...patch })
  function task(dueDate = '2026-09-30', enrolled = dayAt('2026-09-07', '15:00')) {
    const task = store.insert<Task>('tasks', { title: '接口验收', ownerId: member.id, monthlyPlanId: null, description: '提供报告', dueDate, status: 'doing', isTemporary: true, temporaryReason: '专项', workOrigin: { kind: 'assigned', actorId: manager.id, reason: '' } })
    const tracking = enrollTaskTracking(store, task, manager, enrolled, 'manual')
    return { task, tracking }
  }
  function followup(taskId: string, dueAt: string) {
    return store.insert<FollowupRequest>('followupRequests', { taskId, weeklyRecordId: null, ownerId: member.id, requestedBy: manager.id, managerRecipientIds: [manager.id], generation: 1,
      requirement: '请说明当前进展与下一步', dueAt, status: 'open', respondedAt: null, closedAt: null, closedBy: null, closeReason: '', lastChangedBy: manager.id, changeReason: '' })
  }
  return { store, manager, member, settings, task, followup }
}

test('calendar counts complete Shanghai workdays across weekends, overrides and year boundaries', () => {
  assert.equal(shanghaiDate(new Date('2026-09-14T16:00:00Z')), '2026-09-15')
  assert.equal(workdayCount('2026-09-14', '2026-09-17'), 2)
  assert.equal(workdayCount('2026-09-14', '2026-09-18'), 3)
  assert.equal(workdayCount('2026-09-14', '2026-09-18', { '2026-09-16': false }), 2)
  assert.equal(adjacentWorkday('2026-09-28', -1, { '2026-09-25': false, '2026-09-26': true }), '2026-09-26')
  assert.equal(shiftDay('2026-12-31', 1), '2027-01-01')
  assert.equal(weekOf('2027-01-01'), '2026-12-28')
})

test('stale threshold starts after the baseline day and dry-run makes no writes', t => {
  const f = fixture(t), { task, tracking } = f.task('2026-09-30', dayAt('2026-09-14', '15:00'))
  assert.equal(evaluateWorkRisks(f.store, dayAt('2026-09-17')).some(risk => risk.kind === 'stale'), false)
  assert.equal(evaluateWorkRisks(f.store, dayAt('2026-09-18')).some(risk => risk.kind === 'stale'), true)
  automaticRiskCandidates(f.store, dayAt('2026-09-18'))
  for (const name of ['reminderOccurrences', 'digestItems', 'notificationDigests', 'notifications']) assert.equal(f.store.list(name).length, 0, name)
  f.store.update<TaskTracking>('taskTrackings', task.id, tracking.version, { reminderBaselineAt: dayAt('2026-09-18').toISOString() })
  assert.equal(evaluateWorkRisks(f.store, dayAt('2026-09-18')).some(risk => risk.kind === 'stale'), false)
})

test('due-soon respects 17:00, adjusted holidays and enrollment cutoff without replaying missed slots', t => {
  const f = fixture(t, { staleWorkdays: 100, calendarOverrides: { '2026-09-25': false, '2026-09-26': true } })
  const early = f.task('2026-09-28', dayAt('2026-09-26', '16:59')), late = f.task('2026-09-28', dayAt('2026-09-26', '17:01'))
  assert.equal(automaticRiskCandidates(f.store, dayAt('2026-09-25', '17:00')), undefined)
  assert.equal(automaticRiskCandidates(f.store, dayAt('2026-09-26', '16:59'))?.risks.some(risk => risk.kind === 'due_soon'), false)
  const risks = automaticRiskCandidates(f.store, dayAt('2026-09-26', '17:01'))!.risks
  assert.ok(risks.some(risk => risk.taskId === early.task.id && risk.kind === 'due_soon'))
  assert.equal(risks.some(risk => risk.taskId === late.task.id && risk.kind === 'due_soon'), false)
  assert.equal(automaticRiskCandidates(f.store, dayAt('2026-09-27', '17:00')), undefined)
})

test('multiple risk labels in one card count as one reminder per rule and permit full weekly limits', t => {
  const f = fixture(t), { task } = f.task('2026-09-11')
  runCollaborationDigests(f.store, dayAt('2026-09-14'))
  const first = f.store.list<NotificationDigest>('notificationDigests').find(item => item.type === 'risk_member')!
  assert.equal(first.itemIds.length, 1)
  const item = f.store.get<DigestItem>('digestItems', first.itemIds[0])!
  assert.ok(item.title.includes('逾期')); assert.ok(item.title.includes('更新进展'))
  assert.ok(automaticRiskCandidates(f.store, dayAt('2026-09-15'))!.risks.some(risk => risk.taskId === task.id && risk.kind === 'stale'), 'second weekly stale reminder remains available after one combined card')
  runCollaborationDigests(f.store, dayAt('2026-09-15'))
  runCollaborationDigests(f.store, dayAt('2026-09-16'))
  assert.ok(automaticRiskCandidates(f.store, dayAt('2026-09-18'))!.risks.some(risk => risk.taskId === task.id && risk.kind === 'overdue'), 'third weekly overdue reminder remains available on Friday')
})

test('a later candidate in an existing slot is never marked reminded unless it is actually included', t => {
  const f = fixture(t, { staleWorkdays: 100 }), first = f.task('2026-09-11'), later = f.task('2026-09-30')
  f.followup(later.task.id, dayAt('2026-09-14', '10:00').toISOString())
  runCollaborationDigests(f.store, dayAt('2026-09-14', '09:00'))
  runCollaborationDigests(f.store, dayAt('2026-09-14', '10:01'))
  for (const occurrence of f.store.list<ReminderOccurrence>('reminderOccurrences')) {
    const digest = f.store.list<NotificationDigest>('notificationDigests').find(value => value.notificationId === occurrence.notificationId)
    assert.ok(digest)
    assert.ok(digest.itemIds.some(id => f.store.get<DigestItem>('digestItems', id)?.taskId === occurrence.taskId), `occurrence for ${occurrence.taskId} must appear in its actual digest`)
  }
  assert.ok(f.store.list<ReminderOccurrence>('reminderOccurrences').some(row => row.taskId === first.task.id))
})

test('after two overdue-request member reminders the third workday escalates only to managers', t => {
  const f = fixture(t, { staleWorkdays: 100 }), { task } = f.task()
  f.followup(task.id, dayAt('2026-09-13', '17:00').toISOString())
  for (const day of ['2026-09-14', '2026-09-15', '2026-09-16']) runCollaborationDigests(f.store, dayAt(day))
  const occurrences = f.store.list<ReminderOccurrence>('reminderOccurrences')
  assert.equal(new Set(occurrences.filter(row => row.recipientId === f.member.id && row.kinds.includes('followup_overdue')).map(row => row.day)).size, 2)
  assert.ok(occurrences.some(row => row.recipientId === f.manager.id && row.day === '2026-09-16' && row.kinds.includes('followup_overdue')))
  runCollaborationDigests(f.store, dayAt('2026-09-16', '09:30'))
  assert.equal(f.store.list('reminderOccurrences').length, occurrences.length, 'scheduler restart does not repeat the slot')
})

test('a task appearing in the morning risk card is not repeated in the 17:00 card on the same day', t => {
  const f = fixture(t), first = f.task('2026-09-15'), second = f.task('2026-09-15', dayAt('2026-09-14', '08:00'))
  runCollaborationDigests(f.store, dayAt('2026-09-14', '09:00'))
  runCollaborationDigests(f.store, dayAt('2026-09-14', '17:00'))
  const cards = f.store.list<NotificationDigest>('notificationDigests').filter(row => row.type === 'risk_member')
  assert.equal(cards.length, 2)
  const evening = cards.find(row => row.slot === '17:00')!
  assert.ok(evening.itemIds.some(id => f.store.get<DigestItem>('digestItems', id)?.taskId === second.task.id))
  assert.equal(evening.itemIds.some(id => f.store.get<DigestItem>('digestItems', id)?.taskId === first.task.id), false)
})

test('paused tracking cancels queued followup action sends while the original request stays available to respond', t => {
  const f = fixture(t), { task, tracking } = f.task(), now = dayAt('2026-09-14')
  const request = f.followup(task.id, dayAt('2026-09-15', '17:00').toISOString())
  const item = addDigestItem(f.store, f.member.id, 'followup-test-event', { sourceKind: 'followup_requested', target: { type: 'followup', id: request.id }, taskId: task.id, ownerId: f.member.id, title: task.title, lines: ['请说明当前进展'], occurredAt: now.toISOString(), generation: tracking.generation, actionable: true })
  const digest = createDigest(f.store, f.member.id, 'manual_followup', 'test', [item], now)!
  const row = f.store.get<Notification>('notifications', digest.notificationId!)!
  assert.ok(currentNotificationMessage(f.store, f.member, row, now, true))
  f.store.update<TaskTracking>('taskTrackings', task.id, tracking.version, { state: 'paused', pauseReason: '等待外部窗口', reviewAt: dayAt('2026-09-18').toISOString() })
  assert.equal(f.store.get<FollowupRequest>('followupRequests', request.id)?.status, 'open')
  assert.equal(currentNotificationMessage(f.store, f.member, row, now, true), undefined)
})

test('mixed risk card removes a completed task at send time but preserves readable historical digest items', t => {
  const f = fixture(t, { staleWorkdays: 100 }), first = f.task('2026-09-11'), second = f.task('2026-09-11'), now = dayAt('2026-09-14')
  runCollaborationDigests(f.store, now)
  const digest = f.store.list<NotificationDigest>('notificationDigests').find(row => row.type === 'risk_member')!
  const row = f.store.get<Notification>('notifications', digest.notificationId!)!
  f.store.update<Task>('tasks', first.task.id, first.task.version, { status: 'done' })
  const sending = currentNotificationMessage(f.store, f.member, row, now, true)
  assert.ok(sending)
  assert.equal(sending.content?.items.length, 1)
  assert.equal(sending.content?.items[0].target.id, second.task.id)
  assert.equal(sending.content?.totalCount, 1)
  assert.equal(visibleDigestItems(f.store, f.member, digest).length, 2)
})

test('management support closure stops automatic blocker escalation without falsifying task completion', t => {
  const f = fixture(t, { staleWorkdays: 100 }), { task } = f.task()
  f.store.update<Task>('tasks', task.id, task.version, { status: 'blocked' })
  const episode = f.store.insert<BlockerEpisode>('blockerEpisodes', { sourceType: 'task', sourceId: task.id, parentTaskId: task.id, ownerId: f.member.id,
    generation: 1, openedAt: dayAt('2026-09-09').toISOString(), openedBy: f.member.id, resolvedAt: null, resolvedBy: null, reason: '依赖未交付', impact: '影响联调', supportNeeded: '协调依赖', reviewAt: null, closureReason: '' })
  assert.ok(evaluateWorkRisks(f.store, dayAt('2026-09-14')).some(risk => risk.kind === 'blocker_escalation'))
  f.store.update<BlockerEpisode>('blockerEpisodes', episode.id, episode.version, { managementClosedAt: dayAt('2026-09-14', '10:00').toISOString(), managementNote: '已协调，后续由本人记录进展' })
  assert.equal(evaluateWorkRisks(f.store, dayAt('2026-09-15')).some(risk => risk.kind === 'blocker_escalation'), false)
  assert.equal(f.store.get<Task>('tasks', task.id)?.status, 'blocked')
})

test('unreported management facts after 17:30 have a next-workday route even when optional automatic rules and full summaries are off', t => {
  const f = fixture(t, { autoRulesEnabled: false, dailyManagerEnabled: false, weeklyManagerEnabled: false }), { task } = f.task()
  addDigestItem(f.store, f.manager.id, 'overflow-after-summary', { sourceKind: 'work_blocked', target: { type: 'task', id: task.id }, taskId: task.id, ownerId: f.member.id,
    title: task.title, lines: ['期间发生阻塞，需要主管核对'], occurredAt: dayAt('2026-09-14', '17:45').toISOString(), generation: 1, actionable: false })
  const now = dayAt('2026-09-15')
  runCollaborationDigests(f.store, now)
  const digest = f.store.list<NotificationDigest>('notificationDigests').find(row => row.recipientId === f.manager.id)!
  assert.ok(digest, 'minimal management summary is independent of the optional daily summary')
  const row = f.store.get<Notification>('notifications', digest.notificationId!)!
  assert.ok(currentNotificationMessage(f.store, f.manager, row, now, true), 'facts must not be rejected by the automatic risk switch')
  assert.notEqual(digest.type, 'critical_manager', 'overflow summary does not consume a fourth critical-card quota')
  const count = f.store.list('notificationDigests').length
  runCollaborationDigests(f.store, dayAt('2026-09-15', '09:30'))
  assert.equal(f.store.list('notificationDigests').length, count)
})

test('member summary opt-out stops generation and queued sends while explicit followup obligations remain current', t => {
  const f = fixture(t, { autoRulesEnabled: false, dailyManagerEnabled: false, weeklyManagerEnabled: false, memberActionsEnabled: true }), { task } = f.task()
  const now = dayAt('2026-09-14', '17:30')
  const addFact = (sourceId: string, at: Date) => addDigestItem(f.store, f.member.id, sourceId, { sourceKind: 'progress_recorded', target: { type: 'task', id: task.id }, taskId: task.id,
    ownerId: f.member.id, title: task.title, lines: ['本人工作摘要中的一条事实'], occurredAt: at.toISOString(), generation: 1, actionable: false })
  addFact('optional-summary-first', now)
  runCollaborationDigests(f.store, now)
  const digest = f.store.list<NotificationDigest>('notificationDigests').find(row => row.type === 'member_actions')!
  assert.ok(digest, 'missing preference means opted in')
  const notification = f.store.get<Notification>('notifications', digest.notificationId!)!
  assert.ok(currentNotificationMessage(f.store, f.member, notification, now, true))
  f.store.insert<CollaborationPreference>('collaborationPreferences', { id: f.member.id, userId: f.member.id, memberActionsEnabled: false })
  assert.equal(currentNotificationMessage(f.store, f.member, notification, now, true), undefined, 'send must reread the current preference')
  const later = dayAt('2026-09-15', '17:30')
  const unconsumed = addFact('optional-summary-after-optout', later)
  runCollaborationDigests(f.store, later)
  assert.equal(f.store.list<NotificationDigest>('notificationDigests').filter(row => row.type === 'member_actions').length, 1)
  assert.equal(f.store.get<DigestItem>('digestItems', unconsumed.id)?.consumedBy, null)
  const request = f.followup(task.id, dayAt('2026-09-17', '17:00').toISOString())
  const mandatory = addDigestItem(f.store, f.member.id, 'mandatory-followup', { sourceKind: 'followup_requested', target: { type: 'followup', id: request.id }, taskId: task.id,
    ownerId: f.member.id, title: task.title, lines: ['请明确回应本次催办'], occurredAt: later.toISOString(), generation: 1, actionable: true })
  const followupDigest = createDigest(f.store, f.member.id, 'manual_followup', 'mandatory', [mandatory], later)!
  assert.ok(currentNotificationMessage(f.store, f.member, f.store.get<Notification>('notifications', followupDigest.notificationId!)!, later, true), 'optional opt-out cannot suppress a current followup obligation')
})
