import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { Notification, NotificationDelivery } from '../shared/notifications.ts'
import type { Task, User, WeeklyRecord } from '../shared/types.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { DingTalkError, type DingTalkClient, type DingTalkIdentity } from '../server/dingtalk.ts'
import { enqueueNotification, getNotification, getNotificationSettings, openNotification, updateNotificationSettings } from '../server/notifications.ts'
import { runNotificationWorker } from '../server/notification-worker.ts'
import { exportBusinessData } from '../server/data-transfer.ts'

function fixture(t: TestContext) {
  const env = { APP_ORIGIN: 'https://planning.test', DINGTALK_NOTIFICATIONS_ENABLED: 'true', DINGTALK_DEPLOYMENT_ID: 'test-deployment-unique', DINGTALK_CORP_ID: 'corp' }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]))
  Object.assign(process.env, env)
  const store = new Store(':memory:'), domain = new Domain(store)
  const user = (id: string, role: User['role'] = 'member') => store.insert<StoredUser>('users', { id, name: id, email: `${id}@test.local`, role, active: true, position: '', credentialVersion: 1, passwordHash: '' })
  const manager = user('manager', 'manager'), member = user('member'), peer = user('peer')
  const identity = store.insert<DingTalkIdentity>('externalIdentities', { provider: 'dingtalk', corpId: 'corp', userid: 'ding-member', userId: member.id })
  const config = getNotificationSettings(store)
  updateNotificationSettings(store, { ...config, externalEnabled: true, pilotUserIds: [member.id] }, true)
  let sends = 0, queries = 0
  const client: DingTalkClient = { configured: true, corpId: 'corp', clientId: 'client', getIdentity: async () => ({ corpId: 'corp', userid: 'ding-member' }), send: async () => { sends++; return { taskId: '123' } }, result: async () => { queries++; return 'delivered' } }
  const task = (extra = {}) => domain.createTask(manager, { ownerId: member.id, title: '交付实验报告', isTemporary: true, temporaryReason: '试点工作', dueDate: '2026-09-30', ...extra })
  const rows = () => store.list<Notification>('notifications')
  const deliveries = () => store.list<NotificationDelivery>('notificationDeliveries')
  const now = new Date(); now.setUTCHours(2, 0, 0, 0) // 10:00 Shanghai, keep business timestamps current.
  t.after(() => { store.close(); for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value } })
  return { store, domain, manager, member, peer, identity, client, task, rows, deliveries, now, sends: () => sends, queries: () => queries }
}
test('atomic weekly assignment rolls back everything on failure and retries return the same work once', t => {
  const f = fixture(t)
  const input = { requestId: 'weekly-assignment-001', task: { title: '一个安排', ownerId: f.member.id, isTemporary: true, temporaryReason: '验证', dueDate: '2026-09-30' }, record: { weekStart: '2026-09-14', commitment: '交付测试', submitted: true } }
  assert.throws(() => f.domain.createWeeklyAssignment(f.manager, { ...input, record: { ...input.record, weekStart: 'invalid-date' } }), { status: 400 })
  for (const collection of ['tasks', 'weeklyRecords', 'notifications', 'notificationDeliveries', 'weeklyAssignmentRequests']) assert.equal(f.store.list(collection).length, 0, collection)
  const first = f.domain.createWeeklyAssignment(f.manager, input), second = f.domain.createWeeklyAssignment(f.manager, input)
  assert.equal(second.record.id, first.record.id); assert.equal(f.rows().length, 1)
  assert.equal(f.rows()[0].targets[0].type, 'weeklyRecord')
  assert.throws(() => f.domain.createWeeklyAssignment(f.manager, { ...input, record: { ...input.record, commitment: '换内容' } }), { status: 409 })
  assert.equal(f.store.list('tasks').length, 1)
})
test('recipient authorization, opening and acknowledgment do not change task execution or formal receipts', t => {
  const f = fixture(t), task = f.task(), notification = f.rows()[0]
  assert.throws(() => getNotification(f.store, f.peer, notification.id), { status: 404 })
  assert.equal(getNotification(f.store, f.member, notification.id).openedAt, null)
  const opened = openNotification(f.store, f.member, notification.id)
  assert.ok(opened.openedAt); assert.equal(opened.acknowledgedAt, null)
  const acknowledged = openNotification(f.store, f.member, notification.id, true)
  assert.ok(acknowledged.acknowledgedAt); assert.equal(acknowledged.canAcknowledge, false)
  assert.equal(f.store.get<Task>('tasks', task.id)?.status, 'todo'); assert.equal(f.store.list('weeklySubmissions').length, 0)
  const changed = f.domain.updateTask(f.manager, task.id, { version: task.version, description: '新增验收要求' })
  const next = f.rows()[1]
  assert.equal(getNotification(f.store, f.member, next.id).canAcknowledge, true)
  assert.ok(getNotification(f.store, f.member, notification.id).supersededAt)
  f.domain.updateTask(f.member, changed.id, { version: changed.version, status: 'doing' })
  assert.equal(f.rows().length, 2)
})
test('outbox acceptance, receipt and opening are distinct and retries never mark read', async t => {
  const f = fixture(t); f.task()
  // Queue was created using the wall clock; tick after its due time within the sending window.
  const next = new Date(f.deliveries()[0].nextAttemptAt); next.setUTCHours(2, 0, 0, 0); if (next < new Date()) next.setUTCDate(next.getUTCDate() + 1)
  await runNotificationWorker(f.store, f.client, next)
  assert.equal(f.sends(), 1); assert.equal(f.deliveries()[0].status, 'accepted'); assert.equal(f.rows()[0].openedAt, null)
  await runNotificationWorker(f.store, f.client, new Date(next.getTime() + 60000))
  assert.equal(f.queries(), 1); assert.equal(f.deliveries()[0].status, 'delivered'); assert.equal(f.rows()[0].openedAt, null)
  await runNotificationWorker(f.store, f.client, new Date(next.getTime() + 120000))
  assert.equal(f.sends(), 1)
})
test('unknown network outcome and abandoned lease are never automatically resent', async t => {
  const f = fixture(t); f.task()
  const when = new Date(Date.now() + 86400000); when.setUTCHours(2, 0, 0, 0)
  let calls = 0
  f.client.send = async () => { calls++; throw new DingTalkError('network', 'unknown') }
  await runNotificationWorker(f.store, f.client, when)
  assert.equal(f.deliveries()[0].status, 'unknown')
  await runNotificationWorker(f.store, f.client, new Date(when.getTime() + 3600000))
  assert.equal(calls, 1)
  f.task({ title: '第二个工作' })
  const pending = f.deliveries()[1]
  f.store.update<NotificationDelivery>('notificationDeliveries', pending.id, pending.version, { status: 'sending', leaseUntil: new Date(when.getTime() - 1).toISOString() })
  await runNotificationWorker(f.store, f.client, when)
  assert.equal(f.deliveries()[1].status, 'unknown'); assert.equal(calls, 1)
})
test('explicit transient rejection retries with bounded delay and repeated workers claim once', async t => {
  const f = fixture(t); f.task()
  const when = new Date(Date.now() + 86400000); when.setUTCHours(2, 0, 0, 0)
  let calls = 0
  f.client.send = async () => { calls++; if (calls === 1) throw new DingTalkError('rejected', 'definitive', true); return { taskId: '456' } }
  await Promise.all([runNotificationWorker(f.store, f.client, when), runNotificationWorker(f.store, f.client, when)])
  assert.equal(calls, 1); assert.equal(f.deliveries()[0].status, 'pending'); assert.equal(f.deliveries()[0].nextAttemptAt, new Date(when.getTime() + 60000).toISOString())
  await runNotificationWorker(f.store, f.client, new Date(when.getTime() + 59000)); assert.equal(calls, 1)
  await runNotificationWorker(f.store, f.client, new Date(when.getTime() + 60000)); assert.equal(calls, 2); assert.equal(f.deliveries()[0].status, 'accepted')
})
test('delivery diagnostics retain only numeric DingTalk error codes without changing retry decisions', async t => {
  const cases = [
    { name: 'permanent rejection', outcome: 'definitive' as const, retryable: false, code: '40035', status: 'failed', message: '钉钉明确拒收，请检查应用配置、成员范围和消息内容', expectedCalls: 1 },
    { name: 'transient rejection', outcome: 'definitive' as const, retryable: true, code: '88', status: 'pending', message: '钉钉明确拒收，将稍后重试', expectedCalls: 2 },
    { name: 'unknown outcome even with retryable flag', outcome: 'unknown' as const, retryable: true, code: '88', status: 'unknown', message: '发送结果未知，为避免重复通知未自动重发', expectedCalls: 1 },
  ]
  for (const item of cases) await t.test(item.name, async t => {
    const f = fixture(t); f.task()
    const when = new Date(Date.now() + 86400000); when.setUTCHours(2, 0, 0, 0)
    let calls = 0
    f.client.send = async () => { calls++; throw new DingTalkError(`钉钉接口拒绝请求（${item.code}）`, item.outcome, item.retryable) }
    await runNotificationWorker(f.store, f.client, when)
    assert.equal(f.deliveries()[0].status, item.status)
    assert.equal(f.deliveries()[0].lastError, `${item.message}（错误码：${item.code}）`)
    assert.equal(f.deliveries()[0].nextAttemptAt, new Date(when.getTime() + 60000).toISOString())
    await runNotificationWorker(f.store, f.client, new Date(when.getTime() + 60000))
    assert.equal(calls, item.expectedCalls)
    assert.equal(f.deliveries()[0].status, item.status)
  })
})

test('delivery diagnostics never persist arbitrary errors, secrets or URLs', async t => {
  const cases = [
    { name: 'provider text with secret URL suffix', error: new DingTalkError('钉钉接口拒绝请求（40035） https://oapi.dingtalk.com/path?access_token=secret-token', 'definitive'), status: 'failed', message: '钉钉明确拒收，请检查应用配置、成员范围和消息内容' },
    { name: 'secret error without numeric code', error: new DingTalkError('appsecret=secret-token https://provider.test/failure', 'definitive'), status: 'failed', message: '钉钉明确拒收，请检查应用配置、成员范围和消息内容' },
    { name: 'trailing newline is not an exact numeric message', error: new DingTalkError('钉钉接口拒绝请求（40035）\n', 'definitive'), status: 'failed', message: '钉钉明确拒收，请检查应用配置、成员范围和消息内容' },
    { name: 'untyped error cannot impersonate adapter message', error: new Error('钉钉接口拒绝请求（40035）'), status: 'unknown', message: '发送结果未知，为避免重复通知未自动重发' },
    { name: 'unknown error with secret URL', error: new DingTalkError('https://provider.test/send?access_token=secret-token', 'unknown', true), status: 'unknown', message: '发送结果未知，为避免重复通知未自动重发' },
  ]
  for (const item of cases) await t.test(item.name, async t => {
    const f = fixture(t); f.task()
    const when = new Date(Date.now() + 86400000); when.setUTCHours(2, 0, 0, 0)
    let calls = 0
    f.client.send = async () => { calls++; throw item.error }
    await runNotificationWorker(f.store, f.client, when)
    assert.equal(f.deliveries()[0].status, item.status)
    assert.equal(f.deliveries()[0].lastError, item.message)
    const persisted = JSON.stringify(f.deliveries())
    assert.equal(persisted.includes('secret-token'), false)
    assert.equal(persisted.includes('https://'), false)
    await runNotificationWorker(f.store, f.client, new Date(when.getTime() + 3600000))
    assert.equal(calls, 1)
  })
})

test('automatic retries stop after five definitive failures and result polling expires without resending', async t => {
  const f = fixture(t); f.task()
  let when = new Date(Date.now() + 86400000); when.setUTCHours(2, 0, 0, 0)
  let count = 0
  f.client.send = async () => { count++; throw new DingTalkError('reject', 'definitive', true) }
  for (let attempt = 0; attempt < 5; attempt++) {
    await runNotificationWorker(f.store, f.client, when)
    when = new Date(f.deliveries()[0].nextAttemptAt)
  }
  assert.equal(count, 5); assert.equal(f.deliveries()[0].status, 'failed')
  await runNotificationWorker(f.store, f.client, when); assert.equal(count, 5)
  const row = f.deliveries()[0]
  f.store.update<NotificationDelivery>('notificationDeliveries', row.id, row.version, { status: 'accepted', providerTaskId: '123', acceptedAt: new Date(when.getTime() - 24 * 3600000).toISOString() })
  await runNotificationWorker(f.store, f.client, when)
  assert.equal(f.deliveries()[0].status, 'unknown'); assert.equal(count, 5); assert.equal(f.queries(), 0)
})
test('quiet hours defer sends; deactivation, rebind and changed deployment cancel queued work', async t => {
  const f = fixture(t); f.task()
  const night = new Date(Date.now() + 86400000); night.setUTCHours(14, 0, 0, 0)
  await runNotificationWorker(f.store, f.client, night); assert.equal(f.sends(), 0)
  f.store.delete('externalIdentities', f.identity.id, f.identity.version)
  f.store.insert<DingTalkIdentity>('externalIdentities', { provider: 'dingtalk', corpId: 'corp', userid: 'another', userId: f.member.id })
  const morning = new Date(night.getTime() + 12 * 3600000)
  await runNotificationWorker(f.store, f.client, morning); assert.equal(f.sends(), 0); assert.equal(f.deliveries()[0].status, 'skipped')
  f.task(); f.store.update<User>('users', f.member.id, f.member.version, { active: false })
  await runNotificationWorker(f.store, f.client, morning); assert.equal(f.deliveries()[1].status, 'skipped')
})
test('enabling or rebinding does not replay history; disable and reenable invalidate previous pending deliveries', async t => {
  const f = fixture(t)
  updateNotificationSettings(f.store, { ...getNotificationSettings(f.store), externalEnabled: false }, true)
  f.task(); assert.equal(f.deliveries()[0].status, 'skipped')
  updateNotificationSettings(f.store, { ...getNotificationSettings(f.store), externalEnabled: true }, true)
  f.task(); assert.equal(f.deliveries()[1].status, 'pending')
  updateNotificationSettings(f.store, { ...getNotificationSettings(f.store), externalEnabled: false }, true)
  updateNotificationSettings(f.store, { ...getNotificationSettings(f.store), externalEnabled: true }, true)
  const when = new Date(Date.now() + 86400000); when.setUTCHours(2, 0, 0, 0)
  await runNotificationWorker(f.store, f.client, when)
  assert.equal(f.sends(), 0); assert.equal(f.deliveries()[1].status, 'skipped')
  const packet = JSON.stringify(exportBusinessData(f.store, f.manager))
  assert.ok(!packet.includes('externalIdentities')); assert.ok(!packet.includes('notificationDeliveries')); assert.ok(!packet.includes('ding-member'))
})
test('permission loss redacts old notification details and grouping acknowledgment preserves other current targets', t => {
  const f = fixture(t), one = f.task(), two = f.task({ title: '另外一项' })
  const group = enqueueNotification(f.store, { eventKey: 'group', recipientId: f.member.id, kind: 'work_assigned', title: '机密分组', body: '两个工作', actionable: true, targets: [{ type: 'task', id: one.id }, { type: 'task', id: two.id }] })!
  enqueueNotification(f.store, { eventKey: 'next-version', recipientId: f.member.id, kind: 'work_changed', title: '下一版', body: '新内容', actionable: true, targets: [{ type: 'task', id: one.id }] })
  assert.equal(getNotification(f.store, f.member, group.id).canAcknowledge, true)
  openNotification(f.store, f.member, group.id, true)
  assert.equal(getNotification(f.store, f.member, f.rows().at(-1)!.id).canAcknowledge, true)
  f.store.update<Task>('tasks', one.id, one.version, { ownerId: f.peer.id })
  const restricted = getNotification(f.store, f.member, group.id)
  assert.equal(restricted.title, '工作安排已更新'); assert.equal(restricted.targets.length, 1)
})
test('notification HTTP routes guard recipients, manager settings, CSRF, and uncertain manual retries', async t => {
  const f = fixture(t); f.task()
  const app = createApp({ store: f.store, dingtalkClient: f.client }), server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const address = server.address() as { port: number }, base = `http://127.0.0.1:${address.port}/api`
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const cookies = new Map([f.manager, f.member, f.peer].map(user => [user.id, `lab_session=${createSession(f.store, user)}`]))
  const call = (path: string, user = f.member, method = 'GET', origin = 'https://planning.test', body: unknown = {}) => fetch(base + path, { method, headers: { cookie: cookies.get(user.id)!, origin, 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) })
  const id = f.rows()[0].id
  assert.equal((await call(`/notifications/${id}`, f.peer)).status, 404)
  assert.equal((await call('/notification-settings')).status, 403)
  assert.equal((await call(`/notifications/${id}/acknowledge`, f.member, 'POST', 'https://evil.test')).status, 403)
  assert.equal((await call(`/notifications/${id}/remind`, f.member, 'POST')).status, 403)
  assert.equal((await call(`/notifications/${id}/preview`, f.member)).status, 403)
  const snapshot = () => JSON.stringify(['notifications', 'notificationObligations', 'notificationDeliveries', 'notificationReminderQuotas', 'weeklyCycles', 'weeklyDuties', 'weeklyMissing'].map(collection => f.store.list(collection)))
  const beforePreview = snapshot()
  const previewResponse = await call(`/notifications/${id}/preview?mode=reminder`, f.manager)
  assert.equal(previewResponse.status, 200)
  const preview = await previewResponse.json() as { body: string; eligible: boolean; buttonText: string; url: string }
  assert.match(preview.body, /交付实验报告/); assert.equal(preview.eligible, true)
  assert.equal(preview.buttonText, '查看并确认原安排'); assert.equal(new URL(preview.url).searchParams.get('notificationId'), id)
  assert.equal(snapshot(), beforePreview); assert.equal(f.sends(), 0)
  assert.equal((await call(`/notifications/${id}/remind`, f.manager, 'POST')).status, 200)
  assert.equal((await call(`/notifications/${id}/remind`, f.manager, 'POST')).status, 429)
  assert.equal(f.rows()[0].acknowledgedAt, null)
  assert.equal((await call(`/notifications/${id}`)).status, 200); assert.equal(f.rows()[0].openedAt, null)
  assert.equal((await call(`/notifications/${id}/acknowledge`, f.member, 'POST')).status, 409)
  const token = getNotification(f.store, f.member, id).confirmationToken
  assert.equal((await call(`/notifications/${id}/acknowledge`, f.member, 'POST', 'https://planning.test', { confirmationToken: token })).status, 200)
  assert.equal((await call(`/notifications/${id}/remind`, f.manager, 'POST')).status, 409)
  const delivery = f.deliveries()[0]
  f.store.update<NotificationDelivery>('notificationDeliveries', delivery.id, delivery.version, { status: 'unknown' })
  assert.equal((await call(`/notification-deliveries/${id}/retry`, f.manager, 'POST')).status, 409)
  const settings = await (await call('/notification-settings', f.manager)).json() as { deliveries: { id: string; acknowledgedAt: string }[] }
  assert.ok(settings.deliveries.find(row => row.id === id)?.acknowledgedAt)
  process.env.DINGTALK_DEPLOYMENT_ID = 'restored-new-deployment'
  const restored = await (await call('/notification-settings', f.manager)).json() as { activationRequired: boolean }
  assert.equal(restored.activationRequired, true)
})
test('five-minute changes coalesce queued deliveries while keeping the latest obligation and audit inbox', t => {
  const f = fixture(t), task = f.task({ description: '第一版' })
  const changed = f.domain.updateTask(f.manager, task.id, { version: task.version, description: '第二版', dueDate: '2026-09-27' })
  f.domain.updateTask(f.manager, task.id, { version: changed.version, description: '第三版', dueDate: task.dueDate })
  assert.equal(f.rows().length, 3)
  assert.equal(f.deliveries()[1].status, 'skipped'); assert.equal(f.deliveries()[2].status, 'pending')
  assert.ok(Date.parse(f.deliveries()[2].nextAttemptAt) >= Date.now() + 299000)
  assert.equal(getNotification(f.store, f.member, f.rows()[1].id).canAcknowledge, false)
  assert.equal(getNotification(f.store, f.member, f.rows()[2].id).canAcknowledge, true)
  const view = getNotification(f.store, f.member, f.rows()[2].id)
  assert.match(view.body, /第一版 → 第三版/)
  assert.doesNotMatch(view.body, /第二版|2026-09-27/)
  assert.equal(f.rows()[2].contentFacts?.changes.filter(change => change.field === 'dueDate').length, 0)
})
