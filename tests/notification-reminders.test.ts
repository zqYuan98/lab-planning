import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { runNotificationReminders } from '../server/notification-reminders.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import type { Notification } from '../shared/notifications.ts'
import type { User, Task, WeeklyRecord } from '../shared/types.ts'
import type { WeeklyCycle, WeeklyRule } from '../shared/weekly-submissions.ts'
import { notificationView } from '../server/notifications.ts'

const WEEK = '2026-09-14'

test('old reminder detail shows current formal receipts without writing new deadline facts', () => {
  const f = fixture()
  try {
    f.run('2026-09-18T01:00:00Z')
    const row = f.notifications(f.member.id)[0]
    f.set('2026-09-18T03:00:00Z'); f.submit(f.member, 'results'); f.submit(f.member, 'plan')
    const snapshot = () => JSON.stringify(['weeklyCycles', 'weeklyDuties', 'weeklyMissing', 'weeklySubmissions', 'notifications', 'notificationDeliveries'].map(collection => f.store.list(collection)))
    const before = snapshot(), view = notificationView(f.store, f.member, row, new Date('2026-09-18T03:01:00Z'))
    assert.match(view.body, /当前已正式提交/); assert.doesNotMatch(view.body, /尚未正式提报|尚未正式提交/)
    assert.equal(view.buttonText, '查看事项'); assert.equal(snapshot(), before)
    f.record()
    const changed = notificationView(f.store, f.member, row, new Date('2026-09-18T03:02:00Z'))
    assert.match(changed.body, /内容有修改，待重新正式提报/); assert.equal(changed.buttonText, '核对并正式提交')
  } finally { f.store.close() }
})

function fixture() {
  const store = new Store(':memory:')
  let now = new Date('2026-09-13T01:00:00Z')
  const service = new WeeklySubmissionService(store, () => now)
  function user(id: string, role: User['role'] = 'member') {
    return store.restoreEntity<User>('users', {
      id, version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
      name: id, email: `${id}@example.test`, position: '', active: true, role,
    })
  }
  const manager = user('manager', 'manager'), member = user('member'), other = user('other')
  service.getRule()
  const set = (value: string) => { now = new Date(value) }
  set('2026-09-18T00:00:00Z')
  service.reconcile()
  const run = (value: string) => { set(value); runNotificationReminders(store, now) }
  const notifications = (recipientId?: string) => store.list<Notification>('notifications').filter(row => !recipientId || row.recipientId === recipientId)
  const duty = (owner = member, kind: 'results' | 'plan' = 'results') => service.view(owner, WEEK).duties.find(row => row.kind === kind)!
  function submit(owner = member, kind: 'results' | 'plan' = 'results') {
    const current = duty(owner, kind)
    return service.submit(owner, {
      dutyId: current.id, version: current.version, manifest: current.manifest,
      requestId: crypto.randomUUID(), draftAction: 'retain', note: '本周期暂无其他工作安排',
    })
  }
  function exempt(owner = member, kind: 'results' | 'plan' = 'results') {
    const current = duty(owner, kind)
    service.adjust(manager, { dutyId: current.id, version: current.version, action: 'exempt', reason: '本周期请假免交' })
  }
  function record(weekStart = WEEK, submitted = true) {
    const task = store.insert<Task>('tasks', { title: '验证任务', ownerId: member.id, monthlyPlanId: null, description: '', dueDate: '2026-09-30', status: 'doing', isTemporary: true, temporaryReason: '临时支持' })
    return store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, ownerId: member.id, monthlyPlanId: null, weekStart, commitment: '交付验证结果', actualOutcome: '已完成第一轮验证', status: 'doing', blocker: '', nextAction: '', evidenceUrl: '', submitted })
  }
  return { store, service, manager, member, other, user, set, run, notifications, duty, submit, exempt, record }
}

test('Friday Shanghai slots combine formal duties and keep content week distinct from submission cycle', () => {
  const f = fixture()
  try {
    f.run('2026-09-18T00:59:59Z')
    assert.equal(f.notifications().length, 0)
    f.run('2026-09-18T01:00:00Z')
    assert.equal(f.notifications().length, 2)
    const notification = f.notifications(f.member.id)[0]
    assert.equal(notification.kind, 'weekly_reminder')
    assert.equal(notification.actionable, false)
    assert.equal(notification.targets.length, 2)
    assert.deepEqual(notification.targets.map(target => [target.type, target.cycleWeek, target.weekStart, target.kind]), [
      ['weeklySubmission', WEEK, WEEK, 'results'],
      ['weeklySubmission', WEEK, '2026-09-21', 'plan'],
    ])
    assert.match(notification.body, /提醒时间：2026-09-18 09:00（北京时间）/)
    assert.match(notification.body, /下周计划（2026-09-21 至 2026-09-27）/)
    assert.match(notification.body, /正式提报截止：2026-09-18 16:00（北京时间）/)
    f.run('2026-09-18T01:04:59Z')
    runNotificationReminders(f.store, new Date('2026-09-18T01:02:00Z'))
    assert.equal(f.notifications().length, 2, 'repeated workers reuse persisted slot event keys')
    f.run('2026-09-18T07:00:00Z')
    assert.equal(f.notifications(f.member.id).length, 2, 'afternoon is a distinct reminder event')
    assert.match(f.notifications(f.member.id)[1].body, /提醒时间：2026-09-18 15:00/)
  } finally { f.store.close() }
})

test('individual published rows do not replace formal receipts; later slot only includes outstanding duty', () => {
  const f = fixture()
  try {
    f.record()
    f.record('2026-09-21')
    f.run('2026-09-18T01:00:00Z')
    assert.equal(f.notifications(f.member.id)[0].targets.length, 2)
    f.set('2026-09-18T03:00:00Z')
    f.submit()
    f.submit(f.other, 'results'); f.submit(f.other, 'plan')
    f.run('2026-09-18T07:00:00Z')
    assert.deepEqual(f.notifications(f.member.id)[1].targets.map(target => target.kind), ['plan'])
    assert.equal(f.notifications(f.other.id).length, 1, 'fully submitted member has no afternoon reminder')
    assert.doesNotMatch(f.notifications(f.member.id)[1].body, /本周完成情况/)
  } finally { f.store.close() }
})

test('changed formal content and retained drafts request resubmission without erasing an on-time receipt', () => {
  const f = fixture()
  try {
    const official = f.record(), draft = f.record('2026-09-21', false)
    f.submit(); f.submit(f.member, 'plan')
    const current = f.store.get<WeeklyRecord>('weeklyRecords', official.id)!
    f.store.update<WeeklyRecord>('weeklyRecords', current.id, current.version, { actualOutcome: '核对后更新的结果' })
    f.store.update<WeeklyRecord>('weeklyRecords', draft.id, draft.version, { commitment: '草稿补充承诺' })
    f.run('2026-09-18T01:00:00Z')
    const notification = f.notifications(f.member.id)[0]
    assert.equal(notification.targets.length, 2)
    assert.match(notification.body, /内容已更新，请重新核对提交/)
    assert.doesNotMatch(notification.body, /尚未正式提交/)
    assert.equal(f.duty().status, 'on_time')
    f.set('2026-09-18T02:00:00Z')
    f.submit(); f.submit(f.member, 'plan')
    f.run('2026-09-18T07:00:00Z')
    assert.equal(f.notifications(f.member.id).length, 1)
  } finally { f.store.close() }
})

test('exempt obligations, inactive accounts, unapproved accounts and users outside frozen roster are not reminded', () => {
  const f = fixture()
  try {
    f.exempt(f.member, 'results')
    f.run('2026-09-18T01:00:00Z')
    assert.deepEqual(f.notifications(f.member.id)[0].targets.map(target => target.kind), ['plan'])
    f.store.update<User>('users', f.member.id, f.member.version, { active: false })
    f.store.update<User>('users', f.other.id, f.other.version, { registrationStatus: 'pending' })
    f.user('joined-after-roster')
    f.run('2026-09-18T07:00:00Z')
    assert.equal(f.notifications().length, 2)
    assert.equal(f.notifications('joined-after-roster').length, 0)
  } finally { f.store.close() }
})

test('disabled and not-yet-effective weekly rules cannot produce notifications', () => {
  const f = fixture()
  try {
    let rule = f.service.getRule()
    rule = f.store.update<WeeklyRule>('weeklyRules', rule.id, rule.version, { enabled: false })
    f.run('2026-09-18T01:00:00Z')
    rule = f.store.update<WeeklyRule>('weeklyRules', rule.id, rule.version, { enabled: true, windows: [{ fromWeek: '2026-09-21', toWeek: null }] })
    f.run('2026-09-18T07:00:00Z')
    f.run('2026-09-18T08:05:00Z')
    assert.equal(f.notifications().length, 0)
  } finally { f.store.close() }
})

test('unconfirmed roster cannot generate personal reminders or misleading summary counts', () => {
  const f = fixture()
  try {
    const cycle = f.store.get<WeeklyCycle>('weeklyCycles', WEEK)!
    f.store.update<WeeklyCycle>('weeklyCycles', cycle.id, cycle.version, { needsReview: true })
    f.run('2026-09-18T01:00:00Z')
    f.run('2026-09-18T08:05:00Z')
    assert.equal(f.notifications().length, 0)
  } finally { f.store.close() }
})

test('only the latest current slot recovers, without earlier slot, day or week replays', () => {
  const f = fixture()
  try {
    for (const at of ['2026-09-18T00:59:59Z', '2026-09-18T08:00:00Z', '2026-09-18T08:04:59Z', '2026-09-19T01:00:00Z']) f.run(at)
    runNotificationReminders(f.store, new Date('invalid'))
    assert.equal(f.notifications().length, 0)
    f.run('2026-09-25T07:00:00Z')
    assert.equal(f.notifications().length, 2)
    assert.ok(f.notifications().every(row => row.targets.every(target => target.cycleWeek === '2026-09-21')))
    assert.ok(f.notifications().every(row => row.eventKey.includes(':15:00:')))
  } finally { f.store.close() }
})

test('a recovered morning slot emits once until 15:00 and an afternoon slot expires at 16:00', () => {
  const f = fixture()
  try {
    f.run('2026-09-18T06:59:59Z')
    assert.equal(f.notifications().length, 2)
    assert.ok(f.notifications().every(row => row.eventKey.includes(':09:00:')))
    assert.match(f.notifications(f.member.id)[0].body, /提醒时间：2026-09-18 14:59/)
    f.run('2026-09-18T07:59:59Z')
    assert.equal(f.notifications().length, 4)
    assert.ok(f.notifications().slice(2).every(row => row.eventKey.includes(':15:00:')))
    f.run('2026-09-18T08:00:00Z')
    assert.equal(f.notifications().length, 4)
  } finally { f.store.close() }
})

test('summary can recover during the same Shanghai Friday but cannot replay after midnight', () => {
  const f = fixture()
  try {
    f.run('2026-09-18T15:59:59Z')
    assert.equal(f.notifications().length, 1)
    assert.equal(f.notifications()[0].kind, 'weekly_summary')
    assert.match(f.notifications()[0].body, /统计时间：2026-09-18 23:59/)
    f.run('2026-09-18T16:00:00Z')
    assert.equal(f.notifications().length, 1)
  } finally { f.store.close() }
})

test('manager summary separates cutoff misses, current debts and subsequent valid receipts', () => {
  const f = fixture()
  try {
    f.submit()
    f.exempt(f.other, 'plan')
    f.set('2026-09-18T08:01:00Z')
    f.submit(f.member, 'plan')
    f.run('2026-09-18T08:05:00Z')
    const notifications = f.notifications()
    assert.equal(notifications.length, 1)
    const summary = notifications[0]
    assert.equal(summary.recipientId, f.manager.id)
    assert.equal(summary.kind, 'weekly_summary')
    assert.deepEqual(summary.targets, [{ type: 'summary', id: WEEK, cycleWeek: WEEK, weekStart: WEEK }])
    assert.match(summary.body, /截止未交：2项（2人）/)
    assert.match(summary.body, /当前仍欠交：1项（1人）/)
    assert.match(summary.body, /已补交：1项（1人）/)
    assert.match(summary.body, /当前豁免：1项（1人）/)
    f.run('2026-09-18T08:09:59Z')
    assert.equal(f.notifications().length, 1)
  } finally { f.store.close() }
})

test('late exemption keeps historical cutoff misses in manager summary', () => {
  const f = fixture()
  try {
    f.set('2026-09-18T08:01:00Z')
    f.exempt(f.member, 'results')
    f.run('2026-09-18T08:05:00Z')
    const summary = f.notifications(f.manager.id)[0]
    assert.match(summary.body, /截止未交：4项（2人）/)
    assert.match(summary.body, /当前仍欠交：3项（2人）/)
    assert.match(summary.body, /已补交：0项（0人）/)
    assert.match(summary.body, /当前豁免：1项（1人）/)
  } finally { f.store.close() }
})

test('restoring an originally on-time receipt does not mislabel it as a late submission', () => {
  const f = fixture()
  try {
    const receipt = f.submit()
    f.set('2026-09-18T08:01:00Z')
    for (const action of ['invalidate', 'restore']) {
      const current = f.duty()
      f.service.adjust(f.manager, { dutyId: current.id, version: current.version, action, submissionId: receipt.id, reason: '核对回执有效性' })
    }
    assert.equal(f.duty().status, 'on_time')
    f.run('2026-09-18T08:05:00Z')
    assert.match(f.notifications(f.manager.id)[0].body, /已补交：0项（0人）/)
    assert.match(f.notifications(f.manager.id)[0].body, /当前仍欠交：3项（2人）/)
  } finally { f.store.close() }
})

test('member reminders do not depend on an active manager account; summaries do', () => {
  const f = fixture()
  try {
    f.store.update<User>('users', f.manager.id, f.manager.version, { active: false })
    f.run('2026-09-18T01:00:00Z')
    assert.equal(f.notifications().length, 2)
    assert.equal(f.notifications(f.member.id)[0].targets.length, 2)
    f.run('2026-09-18T08:05:00Z')
    assert.equal(f.notifications().length, 2)
  } finally { f.store.close() }
})
