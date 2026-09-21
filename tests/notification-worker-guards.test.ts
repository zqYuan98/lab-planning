import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MonthlyPlan, Task, User } from '../shared/types.ts'
import type { Notification, NotificationDelivery, NotificationDeliveryContent, NotificationSettings } from '../shared/notifications.ts'
import type { Feedback } from '../shared/feedback.ts'
import { Store } from '../server/store.ts'
import { enqueueNotification, getNotificationSettings, openNotification, updateNotificationSettings } from '../server/notifications.ts'
import { currentNotificationMessage, runNotificationWorker } from '../server/notification-worker.ts'
import { shanghaiWeek } from '../server/weekly-submission-clock.ts'
import { DingTalkError, prepareDingTalkMessage, type DingTalkClient, type DingTalkIdentity } from '../server/dingtalk.ts'
import { exportBusinessData } from '../server/data-transfer.ts'

function fixture(t: TestContext, storePath = ':memory:') {
  const env = { APP_ORIGIN: 'https://planning.test', DINGTALK_NOTIFICATIONS_ENABLED: 'true', DINGTALK_DEPLOYMENT_ID: 'guard-deployment', DINGTALK_CORP_ID: 'corp', DINGTALK_NOTIFICATION_CONTENT_MODE: 'summary' }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  const store = new Store(storePath)
  const user = store.insert<User>('users', { id: 'member', name: '成员', email: 'member@test.local', role: 'member', position: '', active: true })
  const manager = store.insert<User>('users', { id: 'manager', name: '经理', email: 'manager@test.local', role: 'manager', position: '', active: true })
  for (const account of [user, manager]) store.insert<DingTalkIdentity>('externalIdentities', { provider: 'dingtalk', corpId: 'corp', userid: `ding-${account.id}`, userId: account.id })
  updateNotificationSettings(store, { ...getNotificationSettings(store), externalEnabled: true, pilotUserIds: [user.id, manager.id] }, true)
  const now = new Date(Date.now() + 86400000); now.setUTCHours(2, 0, 0, 0)
  const sent: { userid: string; body: string }[] = []
  const client: DingTalkClient = { configured: true, corpId: 'corp', clientId: 'client', getIdentity: async () => ({ corpId: 'corp', userid: 'ding-member' }), send: async (userid, message) => { sent.push({ userid, body: message.body }); return { taskId: String(sent.length) } }, result: async () => 'pending' }
  const delivery = (id: string) => store.get<NotificationDelivery>('notificationDeliveries', id)!
  const task = () => store.insert<Task>('tasks', { title: '任务', monthlyPlanId: null, ownerId: user.id, description: '', dueDate: '', status: 'todo', isTemporary: true, temporaryReason: '测试' })
  const plan = (status: MonthlyPlan['status']) => store.insert<MonthlyPlan>('plans', { month: '2026-09', title: '临时目标', projectId: null, category: '', ownerId: user.id, collaboratorIds: [], expectedOutcome: '', acceptanceCriteria: '', dueDate: '', priority: 'medium', status, reviewComment: '', publishedVersion: status === 'published' ? 1 : null, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', isTemporary: true })
  const notification = (input: Partial<Notification> & Pick<Notification, 'kind' | 'targets'>) => enqueueNotification(store, { eventKey: `test-${store.list('notifications').length}`, recipientId: user.id, title: '工作通知', body: '请查看工作安排', actionable: false, ...input })!
  t.after(() => { store.close(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  return { store, user, manager, now, client, sent, delivery, task, plan, notification }
}

test('worker commits its exact budgeted delivery snapshot before invoking the external send', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-planning-notification-snapshot-'))
  const databasePath = join(directory, 'fixture.sqlite')
  const f = fixture(t, databasePath)
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const task = f.task()
  f.store.update<Task>('tasks', task.id, task.version, { title: '接口联调报告😀', description: '提交测试结果与异常清单。'.repeat(400), dueDate: '2026-09-25' })
  const row = f.notification({ kind: 'work_assigned', actionable: true, contentSchemaVersion: 1, actorId: f.manager.id, targets: [{ type: 'task', id: task.id }] })
  assert.equal(f.store.list('notificationDeliveryContents').length, 0)
  let calls = 0
  let observed: { snapshot?: NotificationDeliveryContent; delivery?: NotificationDelivery; prepared: ReturnType<typeof prepareDingTalkMessage> } | undefined
  f.client.send = async (_userid, message) => {
    calls++
    // A second SQLite connection sees only committed rows, proving the snapshot
    // survives outside the worker transaction before the provider is invoked.
    const persisted = new Store(databasePath)
    try {
      observed = { snapshot: persisted.list<NotificationDeliveryContent>('notificationDeliveryContents')[0],
        delivery: persisted.get<NotificationDelivery>('notificationDeliveries', row.id), prepared: prepareDingTalkMessage(message) }
    } finally { persisted.close() }
    return { taskId: 'snapshot-receipt' }
  }
  await runNotificationWorker(f.store, f.client, f.now)
  assert.equal(calls, 1)
  assert.equal(f.delivery(row.id).status, 'accepted')
  assert.ok(observed?.snapshot, 'the committed snapshot must be visible at send entry')
  const { snapshot, prepared } = observed
  assert.equal(observed.delivery?.status, 'sending')
  assert.equal(observed.delivery?.attempts, 1)
  assert.equal(snapshot.deliveryId, row.id)
  assert.equal(snapshot.notificationId, row.id)
  assert.equal(snapshot.recipientId, f.user.id)
  assert.equal(snapshot.attempt, 1)
  assert.equal(snapshot.renderedAt, f.now.toISOString())
  assert.equal(snapshot.templateVersion, 1)
  assert.ok(snapshot.confirmationToken)
  assert.equal(prepared.truncated, true)
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot.payload), 'utf8') <= 2048)
  assert.deepEqual(snapshot.payload, prepared.payload)
  assert.equal(snapshot.payloadHash, prepared.payloadHash)
  assert.equal(snapshot.payloadHash, createHash('sha256').update(JSON.stringify(snapshot.payload)).digest('hex'))
  for (const field of ['title', 'body', 'buttonText', 'url'] as const) assert.equal(snapshot[field], prepared[field])
  assert.match(snapshot.body, /任务截止：2026-09-25/)
  assert.equal(f.store.list('notificationDeliveryContents').length, 1)
})

test('feedback stays in-app even if an otherwise eligible DingTalk delivery was mistakenly queued', async t => {
  const f = fixture(t), task = f.task()
  const feedback = f.store.insert<Feedback>('feedback', {
    reporterId: f.user.id, assigneeId: f.manager.id, description: 'PRIVATE feedback description', kind: 'bug', impact: 'normal', context: {},
    status: 'new', waiting: null, resolution: '', releaseVersion: '', releasedAt: null, closure: null, duplicateLinked: false, attachmentCount: 0,
  })
  // Each guard must work independently, including a legacy/mislabeled notification kind.
  const privateRows = [
    f.notification({ kind: 'feedback_comment', body: 'PRIVATE feedback comment', targets: [{ type: 'task', id: task.id }] }),
    f.notification({ kind: 'legacy_feedback_update', body: 'PRIVATE feedback result', targets: [{ type: 'feedback', id: feedback.id }] }),
  ]
  for (const row of privateRows) {
    assert.equal(f.store.get('notificationDeliveries', row.id), undefined, 'normal enqueue never creates a feedback outbox record')
    assert.equal(currentNotificationMessage(f.store, f.user, row, f.now), undefined, 'the delivery entry point independently refuses private feedback')
  }
  const ordinary = f.notification({ kind: 'work_assigned', targets: [{ type: 'task', id: task.id }] })
  const eligible = f.delivery(ordinary.id)
  assert.equal(eligible.status, 'pending')
  for (const row of privateRows) f.store.insert<NotificationDelivery>('notificationDeliveries', {
    ...eligible, id: row.id, notificationId: row.id,
  })
  await runNotificationWorker(f.store, f.client, f.now)
  assert.equal(f.delivery(ordinary.id).status, 'accepted', 'the same worker run must demonstrably be enabled and able to send')
  assert.equal(f.sent.length, 1)
  assert.ok(f.sent.every(message => !message.body.includes('PRIVATE')))
  for (const row of privateRows) {
    assert.equal(f.delivery(row.id).status, 'skipped')
    assert.equal(f.delivery(row.id).attempts, 0)
    assert.equal(f.store.list<NotificationDeliveryContent>('notificationDeliveryContents').some(content => content.notificationId === row.id), false, 'private feedback must never become an external payload snapshot')
  }
})

test('accepted and unknown deliveries retain their first content snapshot after business content changes', async t => {
  for (const outcome of ['accepted', 'unknown'] as const) await t.test(outcome, async t => {
    const f = fixture(t), task = f.task()
    const row = f.notification({ kind: 'work_assigned', contentSchemaVersion: 1, targets: [{ type: 'task', id: task.id }] })
    let sends = 0, queries = 0
    f.client.send = async () => {
      sends++
      if (outcome === 'unknown') throw new DingTalkError('provider acceptance cannot be determined', 'unknown')
      return { taskId: 'accepted-receipt' }
    }
    f.client.result = async () => { queries++; return 'pending' }
    await runNotificationWorker(f.store, f.client, f.now)
    assert.equal(f.delivery(row.id).status, outcome)
    const snapshots = f.store.list<NotificationDeliveryContent>('notificationDeliveryContents')
    assert.equal(snapshots.length, 1)
    f.store.update<Task>('tasks', task.id, task.version, { title: '后来修改的安排', description: '新增一组兼容性验证', dueDate: '2026-09-30' })
    const later = new Date(f.now.getTime() + 60_000)
    const current = currentNotificationMessage(f.store, f.user, row, later)!
    const changed = prepareDingTalkMessage({ title: current.title, body: current.body, card: current.content, buttonText: current.buttonText, url: snapshots[0].url })
    assert.notEqual(changed.payloadHash, snapshots[0].payloadHash, 'the business edit must actually change the candidate payload')
    for (const minutes of [1, 2, 3]) await runNotificationWorker(f.store, f.client, new Date(f.now.getTime() + minutes * 60_000))
    assert.equal(sends, 1)
    assert.equal(queries, outcome === 'accepted' ? 3 : 0)
    assert.equal(f.delivery(row.id).status, outcome)
    assert.equal(f.delivery(row.id).attempts, 1)
    assert.deepEqual(f.store.list('notificationDeliveryContents'), snapshots, 'receipt polling must neither replace nor append attempt snapshots')
  })
})

test('business exports retain business records but exclude persisted notification payload snapshots', async t => {
  const f = fixture(t), task = f.task()
  f.store.update<Task>('tasks', task.id, task.version, { dueDate: '2026-09-25' })
  const row = f.notification({ kind: 'work_assigned', title: 'delivery-snapshot-only-title', contentSchemaVersion: 1, targets: [{ type: 'task', id: task.id }] })
  await runNotificationWorker(f.store, f.client, f.now)
  assert.equal(f.delivery(row.id).status, 'accepted')
  const [snapshot] = f.store.list<NotificationDeliveryContent>('notificationDeliveryContents')
  assert.ok(snapshot)
  for (const actor of [f.manager, f.user]) {
    const packet = exportBusinessData(f.store, actor)
    assert.ok(packet.collections.tasks.some(record => record.id === task.id))
    assert.equal(Object.hasOwn(packet.collections, 'notificationDeliveryContents'), false)
    const serialized = JSON.stringify(packet)
    for (const privateValue of [snapshot.id, snapshot.notificationId, snapshot.payloadHash, snapshot.url, 'delivery-snapshot-only-title', 'notificationDeliveryContents']) {
      assert.equal(serialized.includes(privateValue), false, `export exposed delivery metadata: ${privateValue}`)
    }
  }
})

test('worker rechecks updated quiet hours after awaiting the preceding provider send', async t => {
  const f = fixture(t), task1 = f.task(), task2 = f.task()
  const one = f.notification({ kind: 'work_assigned', targets: [{ type: 'task', id: task1.id }] })
  const two = f.notification({ kind: 'work_assigned', targets: [{ type: 'task', id: task2.id }] })
  let count = 0
  f.client.send = async () => {
    count++
    const settings = getNotificationSettings(f.store)
    f.store.update<NotificationSettings>('notificationSettings', settings.id, settings.version, { sendStartHour: 11 })
    return { taskId: '1' }
  }
  await runNotificationWorker(f.store, f.client, f.now)
  assert.equal(count, 1)
  assert.equal(f.delivery(one.id).status, 'accepted')
  assert.equal(f.delivery(two.id).status, 'pending')
})

test('worker checks actual advancing clock and stops taking work during shutdown', async t => {
  const f = fixture(t)
  const one = f.notification({ kind: 'work_assigned', targets: [{ type: 'task', id: f.task().id }] })
  const two = f.notification({ kind: 'work_assigned', targets: [{ type: 'task', id: f.task().id }] })
  let clock = new Date(f.now); clock.setUTCHours(11, 59, 59, 0) // Shanghai 19:59:59.
  let calls = 0
  f.client.send = async () => { calls++; clock = new Date(clock.getTime() + 2000); return { taskId: '1' } }
  await runNotificationWorker(f.store, f.client, () => clock)
  assert.equal(calls, 1); assert.equal(f.delivery(one.id).status, 'accepted'); assert.equal(f.delivery(two.id).status, 'pending')
  clock = new Date(f.now)
  let stopping = false
  f.notification({ kind: 'work_assigned', targets: [{ type: 'task', id: f.task().id }] })
  f.client.send = async () => { calls++; stopping = true; return { taskId: '2' } }
  await runNotificationWorker(f.store, f.client, () => clock, () => stopping)
  assert.equal(calls, 2)
  assert.equal(f.store.list<NotificationDelivery>('notificationDeliveries').filter(row => row.status === 'pending').length, 1)
})

test('worker cancels queued monthly assignments when the target is no longer published', async t => {
  const f = fixture(t)
  for (const kind of ['monthly_published', 'plan_changed']) {
    const plan = f.plan('published')
    const row = f.notification({ kind, targets: [{ type: 'plan', id: plan.id }] })
    f.store.update<MonthlyPlan>('plans', plan.id, plan.version, { status: 'draft' })
    await runNotificationWorker(f.store, f.client, f.now)
    assert.equal(f.delivery(row.id).status, 'skipped')
  }
  assert.equal(f.sent.length, 0)
})

test('worker cancels stale proposal review/result notices and corrects already-published approval text', async t => {
  const f = fixture(t)
  const stale = [
    f.notification({ recipientId: f.manager.id, kind: 'proposal_review', targets: [{ type: 'plan', id: f.plan('approved').id }] }),
    f.notification({ kind: 'proposal_result', title: '临时目标已退回', targets: [{ type: 'plan', id: f.plan('submitted').id }] }),
    f.notification({ kind: 'proposal_result', title: '临时目标审核通过', targets: [{ type: 'plan', id: f.plan('returned').id }] }),
  ]
  const current = f.notification({ kind: 'proposal_result', title: '临时目标审核通过', body: '等待管理者正式发布。', targets: [{ type: 'plan', id: f.plan('published').id }] })
  await runNotificationWorker(f.store, f.client, f.now)
  assert.ok(stale.every(row => f.delivery(row.id).status === 'skipped'))
  assert.equal(f.delivery(current.id).status, 'accepted')
  assert.equal(f.sent.length, 1)
  assert.match(f.sent[0].body, /临时目标/)
  assert.match(f.sent[0].body, /审核通过，现已正式发布/)
  assert.doesNotMatch(f.sent[0].body, /等待管理者正式发布/)
})

test('worker never sends a Friday summary on the following Saturday', async t => {
  const f = fixture(t)
  const week = shanghaiWeek(f.now), friday = new Date(`${week}T08:06:00.000Z`)
  friday.setUTCDate(friday.getUTCDate() + 4)
  const summary = f.notification({ recipientId: f.manager.id, kind: 'weekly_summary', targets: [{ type: 'summary', id: week, cycleWeek: week }] })
  // Make the queue due even when this test runs before the corresponding Friday.
  const delivery = f.delivery(summary.id)
  f.store.update<NotificationDelivery>('notificationDeliveries', delivery.id, delivery.version, { nextAttemptAt: new Date(friday.getTime() - 1).toISOString() })
  const saturday = new Date(friday.getTime() + 86400000)
  await runNotificationWorker(f.store, f.client, saturday)
  assert.equal(f.sent.length, 0)
  assert.equal(f.delivery(summary.id).status, 'skipped')
})

test('worker also expires old participation-removal notices after seven days', async t => {
  const f = fixture(t)
  const row = f.notification({ kind: 'participation_removed', targets: [] })
  const when = new Date(f.now.getTime() + 8 * 86400000)
  await runNotificationWorker(f.store, f.client, when)
  assert.equal(f.sent.length, 0)
  assert.equal(f.delivery(row.id).status, 'skipped')
})

test('worker rejects a client enterprise mismatch for both queued sends and receipt polling', async t => {
  const f = fixture(t), task = f.task()
  const queued = f.notification({ kind: 'work_assigned', targets: [{ type: 'task', id: task.id }] })
  const accepted = f.notification({ kind: 'work_assigned', targets: [{ type: 'task', id: task.id }] })
  const receipt = f.delivery(accepted.id)
  f.store.update<NotificationDelivery>('notificationDeliveries', receipt.id, receipt.version, { status: 'accepted', providerTaskId: 'known', acceptedAt: f.now.toISOString() })
  f.client.corpId = 'other-corp'
  let queried = false
  f.client.result = async () => { queried = true; return 'delivered' }
  await runNotificationWorker(f.store, f.client, f.now)
  assert.equal(f.sent.length, 0)
  assert.equal(queried, false)
  assert.equal(f.delivery(queued.id).status, 'skipped')
  assert.equal(f.delivery(accepted.id).status, 'unknown')
})

test('worker cancels manual reminders once their original obligation was acknowledged or superseded', async t => {
  const f = fixture(t), task1 = f.task(), task2 = f.task(), task3 = f.task()
  const originals = [task1, task2, task3].map(task => f.notification({ kind: 'work_assigned', actionable: true, targets: [{ type: 'task', id: task.id }] }))
  const reminders = originals.map(original => f.notification({ eventKey: `manual:2026-09-18:${original.id}`, kind: 'manual_reminder', targets: original.targets }))
  openNotification(f.store, f.user, originals[0].id, true)
  const updated = f.notification({ kind: 'work_changed', actionable: true, targets: originals[1].targets })
  for (const row of [...originals, updated]) {
    const delivery = f.delivery(row.id)
    f.store.update<NotificationDelivery>('notificationDeliveries', delivery.id, delivery.version, { status: 'skipped' })
  }
  await runNotificationWorker(f.store, f.client, f.now)
  assert.equal(f.delivery(reminders[0].id).status, 'skipped')
  assert.equal(f.delivery(reminders[1].id).status, 'skipped')
  assert.equal(f.delivery(reminders[2].id).status, 'accepted')
  assert.equal(f.sent.length, 1)
})
