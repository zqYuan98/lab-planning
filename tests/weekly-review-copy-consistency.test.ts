import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { OverviewWorkspaceService } from '../server/overview-workspace.ts'
import { notifyFormalSubmission } from '../server/collaboration-notifications.ts'
import { getNotification } from '../server/notifications.ts'
import { visibleDigestItems } from '../server/collaboration-content.ts'
import type { BusinessNotificationEvent, CollaborationSettings } from '../shared/collaboration.ts'
import type { DigestItem, NotificationDigest } from '../shared/collaboration-notifications.ts'
import type { Notification, NotificationDelivery } from '../shared/notifications.ts'
import type { Task, User, WeeklyRecord } from '../shared/types.ts'
import type { WeeklyDuty, WeeklySubmission } from '../shared/weekly-submissions.ts'
import { weeklyPlanFingerprint } from '../shared/weekly-record-state.ts'

test('personal overview does not infer a submitted review from an unconfirmed weekly arrangement', t => {
  const store = new Store(':memory:'); t.after(() => store.close())
  const member = store.insert<User>('users', { name: '成员', email: 'member@test.invalid', role: 'member', active: true, position: '' })
  const task = store.insert<Task>('tasks', { title: '本周安排', ownerId: member.id, monthlyPlanId: null, description: '', dueDate: '2026-10-10', status: 'doing', isTemporary: true, temporaryReason: '专项' })
  let record = store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, ownerId: member.id, monthlyPlanId: null, weekStart: '2026-10-05', commitment: '完成本周验证', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'doing', submitted: true,
    planApproval: { required: true, approvedSubmissionId: null, approvedFingerprint: null } })
  const overview = new OverviewWorkspaceService(store, () => new Date('2026-10-09T02:00:00Z'))
  assert.equal(store.list('weeklySubmissions').length, 0)
  assert.equal(overview.personal(member).focusRecords[0].pendingLabel, '计划未获确认 · 未纳入周统计')
  assert.equal(overview.personal(member).focusRecords[0].effective, false)
  record = store.update<WeeklyRecord>('weeklyRecords', record.id, record.version, { planApproval: { required: true, approvedSubmissionId: 'approved-receipt', approvedFingerprint: weeklyPlanFingerprint(record) } })
  assert.equal(overview.personal(member).focusRecords[0].effective, true)
  record = store.update<WeeklyRecord>('weeklyRecords', record.id, record.version, { commitment: '改变了原获批承诺' })
  assert.equal(overview.personal(member).focusRecords[0].pendingLabel, '计划有修改 · 待重新确认')
  assert.equal(overview.personal(member).focusRecords[0].effective, false)
  store.update<WeeklyRecord>('weeklyRecords', record.id, record.version, { submitted: false })
  assert.equal(overview.personal(member).focusRecords[0].pendingLabel, '草稿 · 未纳入周统计')
})

test('formal submission receipts explain results and plans in Chinese without changing source facts or sending self success alerts', t => {
  const store = new Store(':memory:'); t.after(() => store.close())
  const manager = store.insert<User>('users', { name: '主管', email: 'manager@test.invalid', role: 'manager', active: true, position: '' })
  const member = store.insert<User>('users', { name: '成员', email: 'member@test.invalid', role: 'member', active: true, position: '' })
  store.insert<CollaborationSettings>('collaborationSettings', { id: 'collaboration', enabled: true, autoRulesEnabled: false, deadlineApprovalEnabled: false,
    dailyManagerEnabled: false, weeklyManagerEnabled: false, memberActionsEnabled: false, pilotUserIds: [member.id], defaultManagerIds: [manager.id], calendarOverrides: {},
    staleWorkdays: 3, blockerWorkdays: 2, enabledAt: '2026-09-01T00:00:00Z' })
  for (const [kind, label] of [['results', '本周完成情况'], ['plan', '下周计划']] as const) {
    const duty = store.insert<WeeklyDuty>('weeklyDuties', { ownerId: member.id, cycleWeek: '2026-10-05', kind, contentWeek: kind === 'results' ? '2026-10-05' : '2026-10-12', deadlineAt: '2026-10-09T08:00:00Z' })
    const receipt = store.insert<WeeklySubmission>('weeklySubmissions', { dutyId: duty.id, ownerId: member.id, cycleWeek: duty.cycleWeek, kind, submittedAt: '2026-10-09T02:00:00Z', actorId: member.id, reason: '', note: '', requestId: `receipt-${kind}`, records: [], retainedDraftIds: [], retainedDraftManifest: [] })
    notifyFormalSubmission(store, receipt)
    const event = store.list<BusinessNotificationEvent>('businessNotificationEvents').find(row => row.subjectId === receipt.id)!
    assert.equal(event.facts.kind, kind)
    assert.deepEqual(store.get<WeeklySubmission>('weeklySubmissions', receipt.id), receipt)
    const notification = store.list<Notification>('notifications').find(row => row.recipientId === member.id && row.targets.some(target => target.id === duty.id))!
    assert.ok(notification.body.includes(`提报类型：${label}`))
    assert.doesNotMatch(notification.body, /提报类型：(results|plan)/)
    assert.equal(store.get<NotificationDelivery>('notificationDeliveries', notification.id)?.status, 'skipped')
    const managerItem = store.list<DigestItem>('digestItems').find(row => row.recipientId === manager.id && row.target.id === duty.id)!
    assert.ok(managerItem.lines.includes(`提报类型：${label}`))
    notifyFormalSubmission(store, receipt)
    assert.equal(store.list<Notification>('notifications').filter(row => row.recipientId === member.id && row.targets.some(target => target.id === duty.id)).length, 1)

    // Old deployments stored the raw enum in display prose; reads must translate it without rewriting audit history.
    const legacyNotification = store.update<Notification>('notifications', notification.id, notification.version, { body: notification.body.replace(`提报类型：${label}`, `提报类型：${kind}`) })
    const legacyItem = store.update<DigestItem>('digestItems', managerItem.id, managerItem.version, { lines: managerItem.lines.map(line => line === `提报类型：${label}` ? `提报类型：${kind}` : line) })
    const digest = store.insert<NotificationDigest>('notificationDigests', { recipientId: manager.id, type: 'daily_manager', day: '2026-10-09', slot: kind, periodStart: '2026-10-09', periodEnd: '2026-10-09', itemIds: [legacyItem.id], generatedAt: receipt.submittedAt, ruleVersion: 1, notificationId: null })
    assert.ok(getNotification(store, member, notification.id).body.includes(`提报类型：${label}`))
    assert.ok(visibleDigestItems(store, manager, digest)[0].lines.includes(`提报类型：${label}`))
    assert.deepEqual(store.get<Notification>('notifications', notification.id), legacyNotification)
    assert.deepEqual(store.get<DigestItem>('digestItems', legacyItem.id), legacyItem)
    assert.deepEqual(store.get<WeeklySubmission>('weeklySubmissions', receipt.id), receipt)
    assert.deepEqual(store.get<BusinessNotificationEvent>('businessNotificationEvents', event.id), event)
  }
})
