import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { User } from '../shared/types.ts'
import type { Notification, NotificationDelivery } from '../shared/notifications.ts'
import type { WeeklyCycle, WeeklyDeadlinePolicy, WeeklyDuty, WeeklyRule } from '../shared/weekly-submissions.ts'
import type { DingTalkClient, DingTalkIdentity } from '../server/dingtalk.ts'
import { Store } from '../server/store.ts'
import { currentReminderSlot, runNotificationReminders } from '../server/notification-reminders.ts'
import { currentNotificationMessage, runNotificationWorker } from '../server/notification-worker.ts'
import { enqueueNotification, getNotificationSettings, updateNotificationSettings } from '../server/notifications.ts'

const WEEK = '2026-09-14'
const WEDNESDAY = '2026-09-16T08:00:00.000Z'
const FRIDAY = '2026-09-18T08:00:00.000Z'
const SATURDAY = '2026-09-19T08:00:00.000Z'
const metadata = { version: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }

function fixture(t: TestContext, deadlineAt: string | null, options: { noCycle?: boolean; policy?: WeeklyDeadlinePolicy } = {}) {
  const store = new Store(':memory:')
  t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.restoreEntity<User>('users', {
    ...metadata, id, name: id, email: `${id}@example.test`, position: '', active: true, role,
  })
  const manager = user('holiday-manager', 'manager'), member = user('holiday-member', 'member')
  store.restoreEntity<WeeklyRule>('weeklyRules', {
    ...metadata, id: 'weekly-submission-rule', enabled: true, effectiveWeek: WEEK, timezone: 'Asia/Shanghai',
    windows: [{ fromWeek: WEEK, toWeek: null }], planReviewEffectiveWeek: WEEK,
    ...(options.policy ? { deadlinePolicies: [options.policy] } : {}),
  })
  if (!options.noCycle) {
    store.restoreEntity<WeeklyCycle>('weeklyCycles', {
      ...metadata, id: WEEK, week: WEEK, deadlineAt, rosterIds: [member.id], needsReview: false,
      confirmedBy: manager.id, confirmationReason: '合成测试名单', frozenAt: '2026-09-14T00:00:00.000Z',
    })
    if (deadlineAt) for (const kind of ['results', 'plan'] as const) store.restoreEntity<WeeklyDuty>('weeklyDuties', {
      ...metadata, id: `holiday-${kind}`, ownerId: member.id, cycleWeek: WEEK, kind,
      contentWeek: kind === 'results' ? WEEK : '2026-09-21', deadlineAt,
    })
  }
  const run = (at: string) => runNotificationReminders(store, new Date(at))
  const notifications = () => store.list<Notification>('notifications')
  const setDeadline = (deadlineAt: string | null) => {
    const cycle = store.get<WeeklyCycle>('weeklyCycles', WEEK)!
    store.update<WeeklyCycle>('weeklyCycles', cycle.id, cycle.version, { deadlineAt })
    if (deadlineAt) for (const duty of store.list<WeeklyDuty>('weeklyDuties')) store.update<WeeklyDuty>('weeklyDuties', duty.id, duty.version, { deadlineAt })
  }
  const snapshot = () => JSON.stringify(['weeklyRules', 'weeklyCycles', 'weeklyDuties', 'weeklyMissing', 'weeklySubmissions', 'notifications', 'notificationDeliveries'].map(collection => store.list(collection)))
  return { store, manager, member, run, notifications, setDeadline, snapshot }
}

function externalFixture(t: TestContext, deadlineAt: string) {
  const f = fixture(t, deadlineAt)
  const env = { APP_ORIGIN: 'https://planning.test', DINGTALK_NOTIFICATIONS_ENABLED: 'true', DINGTALK_DEPLOYMENT_ID: 'holiday-test-only', DINGTALK_CORP_ID: 'holiday-corp', DINGTALK_NOTIFICATION_CONTENT_MODE: 'summary' }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  for (const user of [f.manager, f.member]) f.store.insert<DingTalkIdentity>('externalIdentities', { provider: 'dingtalk', corpId: env.DINGTALK_CORP_ID, userid: `fake-${user.id}`, userId: user.id })
  updateNotificationSettings(f.store, { ...getNotificationSettings(f.store), externalEnabled: true, pilotUserIds: [f.manager.id, f.member.id] }, true)
  const sent: string[] = []
  const client: DingTalkClient = {
    configured: true, corpId: env.DINGTALK_CORP_ID, clientId: 'fake-client',
    getIdentity: async () => ({ corpId: env.DINGTALK_CORP_ID, userid: 'fake-member' }),
    send: async (_userid, message) => { sent.push(message.body); return { taskId: `fake-${sent.length}` } },
    result: async () => 'pending',
  }
  const delivery = (row: Notification) => f.store.get<NotificationDelivery>('notificationDeliveries', row.id)!
  return { ...f, sent, client, delivery }
}

test('deadline slots use the Shanghai deadline date, preserve legacy Friday, and reject no-duty weeks', () => {
  for (const [day, deadline] of [['2026-09-16', WEDNESDAY], ['2026-09-19', SATURDAY]]) {
    assert.equal(currentReminderSlot(new Date(`${day}T00:59:59Z`), WEEK, deadline), undefined)
    assert.equal(currentReminderSlot(new Date(`${day}T01:00:00Z`), WEEK, deadline), '09:00')
    assert.equal(currentReminderSlot(new Date(`${day}T06:59:59Z`), WEEK, deadline), '09:00')
    assert.equal(currentReminderSlot(new Date(`${day}T07:00:00Z`), WEEK, deadline), '15:00')
    assert.equal(currentReminderSlot(new Date(`${day}T08:00:00Z`), WEEK, deadline), undefined)
    assert.equal(currentReminderSlot(new Date(`${day}T08:04:59Z`), WEEK, deadline), undefined)
    assert.equal(currentReminderSlot(new Date(`${day}T08:05:00Z`), WEEK, deadline), '16:05')
    assert.equal(currentReminderSlot(new Date(`${day}T15:59:59Z`), WEEK, deadline), '16:05')
    assert.equal(currentReminderSlot(new Date(`${day}T16:00:00Z`), WEEK, deadline), undefined)
  }
  assert.equal(currentReminderSlot(new Date('2026-09-18T01:00:00Z'), WEEK), '09:00')
  assert.equal(currentReminderSlot(new Date('2026-09-18T01:00:00Z')), '09:00')
  assert.equal(currentReminderSlot(new Date('2026-09-18T01:00:00Z'), WEEK, WEDNESDAY), undefined)
  assert.equal(currentReminderSlot(new Date('2026-09-18T01:00:00Z'), WEEK, null), undefined)
  assert.equal(currentReminderSlot(new Date('invalid')), undefined)
})

for (const [name, day, deadline] of [['Wednesday holiday cutoff', '2026-09-16', WEDNESDAY], ['Saturday make-up workday', '2026-09-19', SATURDAY]]) {
  test(`${name} sends only its current slots and remains idempotent`, t => {
    const f = fixture(t, deadline)
    f.run('2026-09-18T01:00:00Z')
    assert.equal(f.notifications().length, 0, 'a Friday tick must not override the persisted deadline')
    for (const time of ['01:00:00', '01:03:00', '07:00:00', '07:02:00', '08:05:00', '08:09:00']) f.run(`${day}T${time}Z`)
    assert.deepEqual(f.notifications().map(row => row.kind), ['weekly_reminder', 'weekly_reminder', 'weekly_summary'])
    assert.ok(f.notifications().every(row => row.eventKey.endsWith(`:deadline:${deadline}`)))
    assert.ok(f.notifications().every(row => row.body.includes(`${day} 16:00`)))
    assert.match(f.notifications()[2].body, /截止未交：2项（1人）/)
    const count = f.notifications().length
    f.run(`${day}T16:00:00Z`)
    assert.equal(f.notifications().length, count, 'recovery after local midnight must not replay a summary')
  })
}

test('a Wednesday effective policy creates its first cycle from a read-only deadline preview', t => {
  const policy: WeeklyDeadlinePolicy = { version: 1, fromWeek: WEEK, mode: 'last_workday', calendarOverrides: { '2026-09-17': false, '2026-09-18': false } }
  const f = fixture(t, WEDNESDAY, { noCycle: true, policy })
  const before = f.snapshot()
  f.run('2026-09-15T01:00:00Z')
  assert.equal(f.snapshot(), before, 'a non-deadline tick must not initialize a cycle')
  f.run('2026-09-16T01:00:00Z')
  assert.equal(f.store.get<WeeklyCycle>('weeklyCycles', WEEK)?.deadlineAt, WEDNESDAY)
  assert.equal(f.notifications().length, 1)
  assert.equal(f.notifications()[0].targets.length, 2)
})

test('a whole-week rest cycle creates no reminder, summary, duty or missed fact', t => {
  const f = fixture(t, null)
  const before = f.snapshot()
  for (const day of ['2026-09-16', '2026-09-18', '2026-09-19']) for (const time of ['01:00:00', '07:00:00', '08:05:00']) f.run(`${day}T${time}Z`)
  assert.equal(f.snapshot(), before)
  for (const collection of ['weeklyDuties', 'weeklyMissing', 'notifications']) assert.equal(f.store.list(collection).length, 0)
})

test('recovery on a holiday deadline skips earlier slots and never replays the previous day', t => {
  const f = fixture(t, WEDNESDAY)
  f.run('2026-09-16T07:20:00Z')
  assert.equal(f.notifications().length, 1)
  assert.match(f.notifications()[0].eventKey, /:15:00:/)
  f.run('2026-09-17T01:00:00Z')
  assert.equal(f.notifications().length, 1)
})

test('send-time preview rejects expired slots, changed deadlines and no-duty cycles without writes', t => {
  const f = fixture(t, WEDNESDAY)
  f.run('2026-09-16T01:00:00Z')
  const row = f.notifications()[0]
  const before = f.snapshot()
  assert.ok(currentNotificationMessage(f.store, f.member, row, new Date('2026-09-16T02:00:00Z'), true))
  for (const at of ['2026-09-16T00:59:00Z', '2026-09-16T07:00:00Z', '2026-09-17T01:00:00Z']) assert.equal(currentNotificationMessage(f.store, f.member, row, new Date(at), true), undefined)
  assert.equal(f.snapshot(), before)
  f.setDeadline(SATURDAY)
  const changed = f.snapshot()
  for (const at of ['2026-09-16T02:00:00Z', '2026-09-19T01:00:00Z']) assert.equal(currentNotificationMessage(f.store, f.member, row, new Date(at), true), undefined)
  assert.equal(f.snapshot(), changed)
  f.setDeadline(null)
  const rest = f.snapshot()
  assert.equal(currentNotificationMessage(f.store, f.member, row, new Date('2026-09-19T01:00:00Z'), true), undefined)
  assert.equal(f.snapshot(), rest)
})

test('old queued date is skipped after deadline repair and the new date sends once through a fake provider', async t => {
  const f = externalFixture(t, FRIDAY)
  f.run('2026-09-18T01:00:00Z')
  const old = f.notifications()[0]
  assert.equal(f.delivery(old).status, 'pending')
  f.setDeadline(SATURDAY)
  f.run('2026-09-19T01:00:00Z')
  const current = f.notifications()[1]
  assert.notEqual(current.id, old.id)
  await runNotificationWorker(f.store, f.client, new Date('2026-09-19T01:01:00Z'))
  await runNotificationWorker(f.store, f.client, new Date('2026-09-19T01:02:00Z'))
  assert.equal(f.delivery(old).status, 'skipped')
  assert.equal(f.delivery(old).attempts, 0)
  assert.equal(f.delivery(current).status, 'accepted')
  assert.equal(f.delivery(current).attempts, 1)
  assert.equal(f.sent.length, 1)
  assert.match(f.sent[0], /2026-09-19 16:00/)
  assert.doesNotMatch(f.sent[0], /2026-09-18 16:00|今日 16:00/)
})

test('legacy Friday events do not duplicate on upgrade or revive on a new deadline date', t => {
  const f = fixture(t, FRIDAY)
  const legacy = enqueueNotification(f.store, {
    eventKey: `weekly:${WEEK}:09:00:${f.member.id}`, recipientId: f.member.id, kind: 'weekly_reminder', title: '周提报待提交提醒', body: '请在今日 16:00 前提交',
    targets: [{ type: 'weeklySubmission', id: 'holiday-results', cycleWeek: WEEK, weekStart: WEEK, kind: 'results' }], actionable: false,
  }, new Date('2026-09-18T01:00:00Z'))!
  assert.ok(currentNotificationMessage(f.store, f.member, legacy, new Date('2026-09-18T02:00:00Z'), true))
  f.run('2026-09-18T02:00:00Z')
  assert.equal(f.notifications().length, 1, 'a valid legacy slot must not get a second event key on upgrade')
  f.setDeadline(SATURDAY)
  assert.equal(currentNotificationMessage(f.store, f.member, legacy, new Date('2026-09-19T01:00:00Z'), true), undefined)
  f.run('2026-09-19T01:00:00Z')
  assert.equal(f.notifications().length, 2)
})

test('summary send rechecks its actual deadline, rule, role and pending roster review', t => {
  const f = fixture(t, WEDNESDAY)
  f.run('2026-09-16T08:05:00Z')
  const row = f.notifications()[0]
  const now = new Date('2026-09-16T08:06:00Z'), before = f.snapshot()
  assert.ok(currentNotificationMessage(f.store, f.manager, row, now, true))
  assert.equal(f.snapshot(), before)
  f.setDeadline(SATURDAY)
  assert.equal(currentNotificationMessage(f.store, f.manager, row, new Date('2026-09-19T08:06:00Z'), true), undefined)
  f.setDeadline(WEDNESDAY)
  let cycle = f.store.get<WeeklyCycle>('weeklyCycles', WEEK)!
  cycle = f.store.update<WeeklyCycle>('weeklyCycles', cycle.id, cycle.version, { needsReview: true })
  assert.equal(currentNotificationMessage(f.store, f.manager, row, now, true), undefined)
  f.store.update<WeeklyCycle>('weeklyCycles', cycle.id, cycle.version, { needsReview: false })
  let rule = f.store.get<WeeklyRule>('weeklyRules', 'weekly-submission-rule')!
  rule = f.store.update<WeeklyRule>('weeklyRules', rule.id, rule.version, { enabled: false })
  assert.equal(currentNotificationMessage(f.store, f.manager, row, now, true), undefined)
  f.store.update<WeeklyRule>('weeklyRules', rule.id, rule.version, { enabled: true })
  f.store.update<User>('users', f.manager.id, f.manager.version, { role: 'member' })
  assert.equal(currentNotificationMessage(f.store, f.manager, row, now, true), undefined)
})

test('observer-only accounts cannot initialize holiday scheduling or send queued reminders', t => {
  const f = fixture(t, WEDNESDAY)
  f.run('2026-09-16T01:00:00Z')
  const row = f.notifications()[0]
  f.store.update<User>('users', f.manager.id, f.manager.version, { role: 'observer' })
  f.store.update<User>('users', f.member.id, f.member.version, { role: 'observer' })
  const before = f.snapshot()
  assert.equal(currentNotificationMessage(f.store, f.member, row, new Date('2026-09-16T02:00:00Z'), true), undefined)
  f.run('2026-09-16T07:00:00Z')
  assert.equal(f.snapshot(), before)
})
