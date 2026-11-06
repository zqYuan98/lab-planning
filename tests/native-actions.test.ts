import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Entity, MonthlyPlan, Task, User } from '../shared/types.ts'
import type { ActionIntent, CallbackInbox, ChannelOperation, ExternalObjectLink, NativeDeliveryAttempt, NativeSettings } from '../shared/native-actions.ts'
import type { Notification, NotificationDelivery } from '../shared/notifications.ts'
import type { FollowupRequest } from '../shared/collaboration.ts'
import type { DigestItem, NotificationDigest } from '../shared/collaboration-notifications.ts'
import { Store } from '../server/store.ts'
import { DingTalkError, type DingTalkClient, type DingTalkIdentity } from '../server/dingtalk.ts'
import type { DingTalkNativeClient } from '../server/dingtalk-native.ts'
import { getNativeSettings, nativeCapabilityState, updateNativeSettings, verifyNativeIdentity } from '../server/native-settings.ts'
import { routeNativeNotification, nativeDesired, nativeHash, refreshNativeLinks, recreateNativeLink } from '../server/native-service.ts'
import { runNativeWorker } from '../server/native-worker.ts'
import { reconcileNativeTodos, reconcileNativeDepartures } from '../server/native-reconcile.ts'
import { receiveNativeStream, processNativeInbox, applyNativeDeparture } from '../server/native-callbacks.ts'
import { confirmNativeIntent, createNativeIntent } from '../server/native-commands.ts'
import { startNativeStream, GuardedStreamClient, type NativeStreamClient } from '../server/native-stream.ts'
import { enqueueNotification, getNotification, getNotificationSettings, openNotification, targetAccessible, updateNotificationSettings } from '../server/notifications.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import { collaborationTargetAccessible } from '../server/collaboration-content.ts'
import { Domain } from '../server/domain.ts'
import { exportBusinessData } from '../server/data-transfer.ts'
import { currentNotificationMessage, runNotificationWorker } from '../server/notification-worker.ts'
import { EventAck, TOPIC_CARD, type DWClientDownStream } from 'dingtalk-stream'

async function fixture(t: TestContext, channel: 'todo' | 'card' = 'todo', disk = false) {
  const env = { APP_ORIGIN: 'https://planning.test', DINGTALK_NATIVE_ENABLED: 'true', DINGTALK_NATIVE_STREAM_ENABLED: 'true', DINGTALK_NOTIFICATIONS_ENABLED: 'true', DINGTALK_DEPLOYMENT_ID: 'deployment', DINGTALK_CORP_ID: 'corp', DINGTALK_CLIENT_ID: 'app', DINGTALK_CLIENT_SECRET: 'secret', DINGTALK_CARD_TEMPLATE_ID: 'template-configured', DINGTALK_ROBOT_CODE: 'robot', DINGTALK_NOTIFICATION_CONTENT_MODE: 'summary' }
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])); Object.assign(process.env, env)
  const dir = disk ? mkdtempSync(join(tmpdir(), 'native-actions-')) : null, path = dir ? join(dir, 'fixture.sqlite') : ':memory:', store = new Store(path)
  const user = store.insert<User>('users', { id: 'member', name: '成员', role: 'member', email: 'member@test.local', position: '', active: true })
  const manager = store.insert<User>('users', { id: 'manager', name: '主管', role: 'manager', email: 'manager@test.local', position: '', active: true })
  const other = store.insert<User>('users', { id: 'other', name: '其他成员', role: 'member', email: 'other@test.local', position: '', active: true })
  const binding = store.insert<DingTalkIdentity>('externalIdentities', { provider: 'dingtalk', corpId: 'corp', userid: 'ding-member', userId: user.id })
  updateNotificationSettings(store, { ...getNotificationSettings(store), externalEnabled: true, pilotUserIds: [user.id], sendStartHour: 0, sendEndHour: 24 }, true)
  const now = new Date(), enabledAt = new Date(now.getTime() - 60000), calls: { kind: string; input: any }[] = []
  const client: DingTalkNativeClient = { configured: true, corpId: 'corp', appId: 'app', verifyMember: async userid => ({ userid, unionId: 'union-member' }),
    createTodo: async input => { calls.push({ kind: 'create', input }); return { taskId: 'provider-todo' } }, updateTodo: async input => { calls.push({ kind: 'update', input }) }, deleteTodo: async (...input) => { calls.push({ kind: 'delete', input }) }, listTodos: async () => ({ items: [], nextToken: null }),
    createCard: async input => { calls.push({ kind: 'card_create', input }) }, deliverCard: async (...input) => { calls.push({ kind: 'card_deliver', input }); return { carrierId: 'carrier' } }, updateCard: async (...input) => { calls.push({ kind: 'card_update', input }) }, sendRobot: async input => { calls.push({ kind: 'robot', input }) }, listLeaveRecords: async () => ({ records: [], nextToken: null }) }
  const enable = (patch: Partial<NativeSettings> = {}) => updateNativeSettings(store, manager, { ...getNativeSettings(store), todoEnabled: true, cardEnabled: true, robotEnabled: true, orgEventsEnabled: true, leaveSyncEnabled: false, primaryChannel: channel, pilotUserIds: [user.id], verifiedCapabilities: ['identity', 'todo', 'card', 'robot', 'orgEvents', 'leaveSync'], verificationNote: '模拟租户验收，生产未启用', ...patch }, client, enabledAt)
  enable(); await verifyNativeIdentity(store, manager, user.id, client, enabledAt)
  const task = store.insert<Task>('tasks', { id: 'task-one', title: '私密实验事项', ownerId: user.id, monthlyPlanId: null, description: '交付实验结果', dueDate: '2099-01-20', status: 'todo', isTemporary: true, temporaryReason: '测试' })
  const note = () => enqueueNotification(store, { eventKey: `native-${store.list('notifications').length}`, recipientId: user.id, title: '收到工作安排', body: '请核对', actionable: true, kind: 'work_assigned', targets: [{ type: 'task', id: task.id }] })!
  const firstLink = () => store.list<ExternalObjectLink>('nativeLinks')[0]
  t.after(() => { store.close(); if (dir) rmSync(dir, { recursive: true, force: true }); for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value })
  return { store, user, other, manager, binding, task, now, enabledAt, client, calls, note, enable, firstLink, path }
}
test('native settings default off, require verified capability and real template configuration', async t => {
  const f = await fixture(t), empty = new Store(':memory:'); t.after(() => empty.close())
  assert.equal(getNativeSettings(empty).todoEnabled, false); assert.equal(empty.list('nativeSettings').length, 0)
  assert.equal(nativeCapabilityState(empty, f.client).todo.enabled, false)
  delete process.env.DINGTALK_CARD_TEMPLATE_ID
  assert.throws(() => f.enable(), { status: 400 })
  assert.equal(nativeCapabilityState(f.store, f.client).card.enabled, false)
  assert.throws(() => updateNativeSettings(f.store, f.user, {}, f.client), { status: 403 })
})
test('todo create commits an exact input snapshot before the external call and closes only the acknowledgement obligation', async t => {
  const f = await fixture(t, 'todo', true), note = f.note()
  assert.equal(routeNativeNotification(f.store, note.id, f.now, undefined, f.client), true)
  assert.equal(f.store.get<NotificationDelivery>('notificationDeliveries', note.id)?.status, 'skipped')
  let createCalls = 0
  f.client.createTodo = async input => { createCalls++; const reader = new Store(f.path); try { const attempt = reader.list<NativeDeliveryAttempt>('nativeDeliveryAttempts')[0]; assert.equal(attempt.outcome, 'sending'); assert.equal(attempt.payloadHash, nativeHash(attempt.payload)); assert.deepEqual((attempt.payload as any).input, input) } finally { reader.close() }; return { taskId: 'provider-todo' } }
  await runNativeWorker(f.store, f.client, f.now)
  assert.equal(createCalls, 1); assert.equal(f.firstLink().state, 'created')
  openNotification(f.store, f.user, note.id, true, getNotification(f.store, f.user, note.id).confirmationToken!)
  await runNativeWorker(f.store, f.client, new Date(f.now.getTime() + 1000))
  assert.equal(f.calls.at(-1)?.kind, 'update'); assert.equal(f.calls.at(-1)?.input.done, true)
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'todo'); assert.equal(f.firstLink().state, 'closed')
  assert.equal(createCalls, 1)
})
test('acknowledgement before first send cancels the external creation', async t => {
  const f = await fixture(t), note = f.note(); routeNativeNotification(f.store, note.id, f.now, undefined, f.client)
  openNotification(f.store, f.user, note.id, true, getNotification(f.store, f.user, note.id).confirmationToken!)
  await runNativeWorker(f.store, f.client, f.now)
  assert.equal(f.calls.length, 0); assert.equal(f.firstLink().state, 'closed')
})
test('unknown create is not resent or downgraded; paginated sourceId reconciliation recovers its exact provider id', async t => {
  const f = await fixture(t), note = f.note(); routeNativeNotification(f.store, note.id, f.now, undefined, f.client)
  let creates = 0; f.client.createTodo = async () => { creates++; throw new DingTalkError('unknown', 'unknown') }
  await runNativeWorker(f.store, f.client, f.now)
  assert.equal(f.firstLink().state, 'unknown')
  await runNativeWorker(f.store, f.client, new Date(f.now.getTime() + 1000)); assert.equal(creates, 1)
  assert.equal(f.store.list('nativeDeliveryAttempts').length, 1)
  const link = f.firstLink(); f.store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { reconcileAt: f.now.toISOString() })
  const tokens: (string | undefined)[] = []
  f.client.listTodos = async (_unionId, token) => { tokens.push(token); return token ? { items: [{ taskId: 'recovered', sourceId: link.sourceId, subject: link.desired.title, isDone: false }], nextToken: null } : { items: [], nextToken: 'page-two' } }
  await reconcileNativeTodos(f.store, f.client, f.now)
  assert.deepEqual(tokens, [undefined, 'page-two']); assert.equal(f.firstLink().providerId, 'recovered'); assert.equal(f.firstLink().state, 'created')
  assert.equal(f.store.get<NotificationDelivery>('notificationDeliveries', note.id)?.status, 'skipped')
})
test('definitive never-accepted failure falls back once, while restored deployment isolates all old operations', async t => {
  const f = await fixture(t), note = f.note(); routeNativeNotification(f.store, note.id, f.now, undefined, f.client)
  f.client.createTodo = async () => { throw new DingTalkError('denied', 'definitive') }
  await runNativeWorker(f.store, f.client, f.now)
  assert.equal(f.store.get<NotificationDelivery>('notificationDeliveries', note.id)?.status, 'pending')
  assert.equal(routeNativeNotification(f.store, note.id, f.now, undefined, f.client), false)
  const nextNote = f.note(); routeNativeNotification(f.store, nextNote.id, f.now, undefined, f.client)
  process.env.DINGTALK_DEPLOYMENT_ID = 'restored-deployment'
  await runNativeWorker(f.store, f.client, f.now)
  assert.equal(f.calls.length, 0); assert.ok(f.store.list<ChannelOperation>('nativeOperations').every(row => row.status !== 'pending'))
})
test('external completion never acknowledges platform work; external delete needs explicit recreation', async t => {
  const f = await fixture(t), note = f.note(); routeNativeNotification(f.store, note.id, f.now, undefined, f.client); await runNativeWorker(f.store, f.client, f.now)
  let link = f.firstLink(); f.store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { reconcileAt: f.now.toISOString() })
  f.client.listTodos = async () => ({ items: [{ taskId: 'provider-todo', sourceId: link.sourceId, subject: link.desired.title, isDone: true }], nextToken: null })
  await reconcileNativeTodos(f.store, f.client, f.now)
  assert.equal(f.firstLink().state, 'mismatch'); assert.equal(getNotification(f.store, f.user, note.id).acknowledgedAt, null)
  const event = { headers: { eventCorpId: 'corp', eventId: 'deleted', eventType: 'todo_task_delete', eventBornTime: f.now.getTime() }, data: JSON.stringify({ taskId: 'provider-todo' }) }
  assert.equal(receiveNativeStream(f.store, f.client, 'event', event, f.now).accepted, true); processNativeInbox(f.store, f.client, f.now)
  assert.equal(f.firstLink().state, 'external_missing'); refreshNativeLinks(f.store, f.client, f.now); assert.equal(f.calls.filter(row => row.kind === 'create').length, 1)
  link = recreateNativeLink(f.store, f.manager, link.id, f.client, f.now); assert.equal(link.generation, 2); assert.notEqual(link.sourceId, f.firstLink().sourceId)
  assert.throws(() => recreateNativeLink(f.store, f.manager, f.firstLink().id, f.client, f.now), { status: 409 })
})
test('card create and deliver are distinct; verified callback persists before action and confirms once', async t => {
  const f = await fixture(t, 'card'), note = f.note(); routeNativeNotification(f.store, note.id, f.now, undefined, f.client); await runNativeWorker(f.store, f.client, f.now)
  assert.deepEqual(f.calls.map(row => row.kind), ['card_create', 'card_deliver'])
  const link = f.firstLink(), params = f.calls[0].input.params
  const envelope = { headers: { messageId: 'card-click' }, data: JSON.stringify({ type: 'actionCallback', corpId: 'corp', userId: 'ding-member', outTrackId: link.sourceId, content: JSON.stringify({ cardPrivateData: { actionIds: ['confirm'], params: { intentId: params.intentId, actionToken: params.actionToken } } }) }) }
  const result = receiveNativeStream(f.store, f.client, 'card', envelope, f.now)
  assert.equal(result.accepted, true); assert.equal(f.store.get<CallbackInbox>('nativeCallbackInbox', result.inboxId!)?.status, 'pending')
  assert.equal(getNotification(f.store, f.user, note.id).acknowledgedAt, null)
  assert.equal(receiveNativeStream(f.store, f.client, 'card', envelope, f.now).duplicate, true)
  processNativeInbox(f.store, f.client, f.now); processNativeInbox(f.store, f.client, f.now)
  assert.ok(getNotification(f.store, f.user, note.id).acknowledgedAt)
  assert.equal(f.store.list<ActionIntent>('nativeActionIntents').filter(row => row.status === 'succeeded').length, 1)
  await runNativeWorker(f.store, f.client, f.now); assert.equal(f.calls.at(-1)?.kind, 'card_update')
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'todo')
})
test('action intents bind actor, current version, expiry and payload; failed confirmations never mutate business state', async t => {
  const f = await fixture(t), note = f.note()
  const intent = createNativeIntent(f.store, f.user, { kind: 'acknowledge', targetId: note.id, requestId: 'test-request' }, f.client, f.now)
  assert.throws(() => confirmNativeIntent(f.store, f.other, intent.id, intent.token, f.client, f.now), { status: 403 })
  assert.throws(() => confirmNativeIntent(f.store, f.user, intent.id, 'wrong', f.client, f.now), { status: 403 })
  assert.throws(() => confirmNativeIntent(f.store, f.user, intent.id, intent.token, f.client, new Date(f.now.getTime() + 31 * 60000)), { status: 409 })
  f.store.update<Task>('tasks', f.task.id, f.task.version, { description: '安排已修改' })
  assert.throws(() => confirmNativeIntent(f.store, f.user, intent.id, intent.token, f.client, f.now), { status: 409 })
  assert.equal(getNotification(f.store, f.user, note.id).acknowledgedAt, null)
})
test('explicit progress preview calls the existing collaboration command only on confirmation', async t => {
  const f = await fixture(t), service = new CollaborationService(f.store, () => f.now)
  service.updateSettings(f.manager, { requestId: 'settings-command', version: 0, enabled: true, pilotUserIds: [f.user.id] })
  const intent = createNativeIntent(f.store, f.user, { kind: 'progress', targetId: f.task.id, requestId: 'progress-preview', progress: { taskStatus: 'doing', noteType: 'progress', note: '已开始验证' } }, f.client, f.now)
  assert.equal(f.store.list('progressEvents').length, 0)
  const result = confirmNativeIntent(f.store, f.user, intent.id, intent.token, f.client, f.now)
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'doing'); assert.equal(f.store.list('progressEvents').length, 1)
  assert.deepEqual(confirmNativeIntent(f.store, f.user, intent.id, intent.token, f.client, f.now), result)
  assert.equal(f.store.list('progressEvents').length, 1)
  assert.throws(() => createNativeIntent(f.store, f.user, { kind: 'progress', targetId: f.task.id, requestId: 'bad', progress: { dueDate: '2099-12-31' } as any }, f.client, f.now), { status: 400 })
})
test('single followup digest maps to the real response obligation; a multi-item digest stays in H5', async t => {
  const f = await fixture(t), service = new CollaborationService(f.store, () => f.now)
  service.updateSettings(f.manager, { requestId: 'settings-command', version: 0, enabled: true, pilotUserIds: [f.user.id] })
  service.updateTracking(f.manager, f.task.id, { requestId: 'tracking-command', version: 0, taskVersion: f.task.version, state: 'active', managerRecipientIds: [f.manager.id] })
  const request = f.store.insert<FollowupRequest>('followupRequests', { taskId: f.task.id, weeklyRecordId: null, ownerId: f.user.id, requestedBy: f.manager.id, managerRecipientIds: [f.manager.id], generation: 1, requirement: '请补充实验进度', dueAt: new Date(f.now.getTime() + 86400000).toISOString(), status: 'open', respondedAt: null, closedAt: null, closedBy: null, closeReason: '', lastChangedBy: f.manager.id, changeReason: '' })
  const item = f.store.insert<DigestItem>('digestItems', { recipientId: f.user.id, sourceId: request.id, sourceKind: 'followup', target: { type: 'followup', id: request.id }, taskId: f.task.id, ownerId: f.user.id, title: f.task.title, lines: [], occurredAt: f.now.toISOString(), consumedBy: null, generation: 1, actionable: true })
  const digest = f.store.insert<NotificationDigest>('notificationDigests', { recipientId: f.user.id, type: 'manual_followup', day: '2026-09-20', slot: 'manual', periodStart: f.now.toISOString(), periodEnd: f.now.toISOString(), itemIds: [item.id], generatedAt: f.now.toISOString(), ruleVersion: 1, notificationId: null })
  const note = enqueueNotification(f.store, { eventKey: 'single-digest', recipientId: f.user.id, kind: 'collaboration_manual_followup', title: '工作催办', body: '请回应', actionable: false, targets: [{ type: 'digest', id: digest.id }] })!
  assert.equal(routeNativeNotification(f.store, note.id, f.now, undefined, f.client), true)
  assert.equal(f.firstLink().action.kind, 'followup'); assert.equal(f.firstLink().action.id, request.id)
  const intent = createNativeIntent(f.store, f.user, { kind: 'respond', targetId: request.id, requestId: 'respond-preview', progress: { noteType: 'progress', note: '实验进展已补齐' } }, f.client, f.now)
  confirmNativeIntent(f.store, f.user, intent.id, intent.token, f.client, f.now)
  assert.equal(f.store.get<FollowupRequest>('followupRequests', request.id)?.status, 'responded')
  assert.equal(confirmNativeIntent(f.store, f.user, intent.id, intent.token, f.client, f.now).status, 'succeeded')
  assert.equal(f.store.list('followupResponses').length, 1)
  f.store.update<NotificationDigest>('notificationDigests', digest.id, digest.version, { itemIds: [item.id, item.id] })
  const multi = enqueueNotification(f.store, { eventKey: 'multi-digest', recipientId: f.user.id, kind: 'collaboration_manual_followup', title: '工作催办', body: '请回应', actionable: false, targets: [{ type: 'digest', id: digest.id }] })!
  assert.equal(routeNativeNotification(f.store, multi.id, f.now, undefined, f.client), false)
})
test('robot group replies never expose private work and private queries authorize the current binding', async t => {
  const f = await fixture(t)
  const envelope = (id: string, group: boolean) => ({ headers: {}, data: JSON.stringify({ msgId: id, senderCorpId: 'corp', senderStaffId: 'ding-member', conversationType: group ? '2' : '1', text: { content: '我的待办' }, sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?token=private', sessionWebhookExpiredTime: f.now.getTime() + 60000 }) })
  receiveNativeStream(f.store, f.client, 'robot', envelope('group', true), f.now); receiveNativeStream(f.store, f.client, 'robot', envelope('private', false), f.now)
  await runNativeWorker(f.store, f.client, f.now)
  assert.equal(f.calls.length, 2); assert.doesNotMatch(f.calls[0].input.text, /私密实验/); assert.match(f.calls[1].input.text, /私密实验/)
  assert.match(f.calls[0].input.text, /https:\/\/planning\.test\//)
  assert.equal(receiveNativeStream(f.store, f.client, 'robot', { headers: {}, data: envelope('foreign', false).data.replace('"corp"', '"foreign"') }, f.now).accepted, false)
})
test('departure events revoke access/session and preserve business; old binding events are ignored; paginated compensation resumes', async t => {
  const f = await fixture(t), note = f.note(); routeNativeNotification(f.store, note.id, f.now, undefined, f.client)
  f.store.insert<Entity & { userId: string; revoked: boolean }>('sessions', { id: 'session', userId: f.user.id, revoked: false })
  assert.equal(applyNativeDeparture(f.store, f.client, 'ding-member', new Date(f.enabledAt.getTime() - 1).toISOString(), 'old', f.now), 0)
  f.enable({ leaveSyncEnabled: true })
  let pages = 0
  f.client.listLeaveRecords = async (_start, _end, token) => { pages++; return token ? { records: [{ userid: 'ding-member', leaveTime: f.now.toISOString() }], nextToken: null } : { records: [], nextToken: 'page2' } }
  await reconcileNativeDepartures(f.store, f.client, f.now)
  assert.equal(pages, 2); assert.equal(f.store.get<User>('users', f.user.id)?.active, false)
  assert.equal(f.store.get<any>('sessions', 'session').revoked, true); assert.ok(f.store.get('tasks', f.task.id)); assert.equal(f.firstLink().state, 'isolated')
  assert.ok(f.store.list<ChannelOperation>('nativeOperations').every(row => row.status === 'cancelled'))
})
test('official Stream wrapper persists inbox before ACK and never starts when default-off', async t => {
  const f = await fixture(t, 'card'), note = f.note(); routeNativeNotification(f.store, note.id, f.now, undefined, f.client); await runNativeWorker(f.store, f.client, f.now)
  const callbacks = new Map<string, (msg: DWClientDownStream) => void>(), params = f.calls[0].input.params
  let event: ((msg: DWClientDownStream) => { status: EventAck }) | undefined, acks = 0, connects = 0, disconnected = 0
  const fake: NativeStreamClient = { connected: true, registered: true, config: { subscriptions: [] }, registerAllEventListener: callback => { event = callback }, registerCallbackListener: (topic, callback) => { callbacks.set(topic, callback) }, socketCallBackResponse: () => { assert.equal(f.store.list<CallbackInbox>('nativeCallbackInbox').at(-1)?.status, 'pending'); acks++ }, connect: async () => { connects++ }, disconnect: () => { disconnected++ } }
  const stop = startNativeStream(f.store, f.client, { factory: () => fake, clock: () => f.now })
  const data = { type: 'actionCallback', corpId: 'corp', userId: 'ding-member', outTrackId: f.firstLink().sourceId, content: JSON.stringify({ cardPrivateData: { actionIds: ['confirm'], params: { intentId: params.intentId, actionToken: params.actionToken } } }) }
  callbacks.get(TOPIC_CARD)!({ headers: { messageId: 'official-card' }, data: JSON.stringify(data) } as DWClientDownStream)
  assert.equal(acks, 1); assert.ok(event); assert.equal(connects, 0)
  await stop(); assert.equal(disconnected, 1)
  delete process.env.DINGTALK_NATIVE_ENABLED
  const stopDisabled = startNativeStream(f.store, f.client, { factory: () => { throw new Error('must not connect') } }); await stopDisabled()
})
test('business exports never include native identities, tokens, callbacks, operations or send snapshots', async t => {
  const f = await fixture(t), note = f.note(); routeNativeNotification(f.store, note.id, f.now, undefined, f.client); await runNativeWorker(f.store, f.client, f.now)
  createNativeIntent(f.store, f.user, { kind: 'acknowledge', targetId: note.id, requestId: 'export-intent' }, f.client, f.now)
  const packet = JSON.stringify(exportBusinessData(f.store, f.manager))
  for (const marker of ['nativeIdentities', 'nativeActionIntents', 'nativeIntentSecrets', 'nativeOperations', 'nativeDeliveryAttempts', 'union-member', 'provider-todo']) assert.ok(!packet.includes(marker), marker)
})
test('card resource creation followed by definite delivery rejection can fall back; unknown delivery never can', async t => {
  for (const outcome of ['definitive', 'unknown'] as const) await t.test(outcome, async t => {
    const f = await fixture(t, 'card'), note = f.note(); routeNativeNotification(f.store, note.id, f.now, undefined, f.client)
    f.client.deliverCard = async () => { throw new DingTalkError('not delivered', outcome) }
    await runNativeWorker(f.store, f.client, f.now)
    assert.ok(f.firstLink().providerId)
    assert.equal(f.store.get<NotificationDelivery>('notificationDeliveries', note.id)?.status, outcome === 'definitive' ? 'pending' : 'skipped')
    await runNativeWorker(f.store, f.client, f.now); assert.equal(f.calls.filter(row => row.kind === 'card_create').length, 1)
  })
})
test('queued native sends respect quiet hours at every request while explicit user bot replies are permitted', async t => {
  const f = await fixture(t), note = f.note(); routeNativeNotification(f.store, note.id, f.now, undefined, f.client)
  updateNotificationSettings(f.store, { ...getNotificationSettings(f.store), sendStartHour: 8, sendEndHour: 20 }, true)
  const quiet = new Date(f.now); quiet.setUTCHours(13, 0, 0, 0) // 21:00 Shanghai
  if (quiet < f.now) quiet.setUTCDate(quiet.getUTCDate() + 1)
  await runNativeWorker(f.store, f.client, quiet)
  assert.equal(f.calls.length, 0); assert.equal(f.store.list<ChannelOperation>('nativeOperations')[0].status, 'pending')
  const morning = new Date(quiet); morning.setUTCDate(morning.getUTCDate() + 1); morning.setUTCHours(1)
  await runNativeWorker(f.store, f.client, morning); assert.equal(f.calls.filter(row => row.kind === 'create').length, 1)
})
test('a card action preview is displayed before confirmation and rejects injected targets or a different operator', async t => {
  const f = await fixture(t, 'card'), service = new CollaborationService(f.store, () => f.now)
  service.updateSettings(f.manager, { requestId: 'settings-command', version: 0, enabled: true, pilotUserIds: [f.user.id] })
  const note = f.note()
  routeNativeNotification(f.store, note.id, f.now, { kind: 'progress', id: note.id, notificationId: note.id, taskId: f.task.id }, f.client)
  await runNativeWorker(f.store, f.client, f.now)
  const callback = (id: string, params: Record<string, string>, userId = 'ding-member', action = 'preview_progress') => ({ headers: { messageId: id }, data: JSON.stringify({ type: 'actionCallback', corpId: 'corp', userId, outTrackId: f.firstLink().sourceId, content: JSON.stringify({ cardPrivateData: { actionIds: [action], params } }) }) })
  assert.equal(receiveNativeStream(f.store, f.client, 'card', callback('bad-target', { taskId: 'other', note: '注入' }), f.now).accepted, false)
  assert.equal(receiveNativeStream(f.store, f.client, 'card', callback('bad-actor', { note: '注入' }, 'other'), f.now).accepted, false)
  assert.equal(receiveNativeStream(f.store, f.client, 'card', callback('preview', { taskStatus: 'doing', noteType: 'progress', note: '完成第一轮验证' }), f.now).accepted, true)
  await runNativeWorker(f.store, f.client, f.now)
  assert.equal(f.store.list('progressEvents').length, 0)
  const parameters = f.calls.filter(row => row.kind === 'card_update').at(-1)!.input[1]
  assert.match(parameters.summary, /完成第一轮验证/); assert.match(parameters.summary, /任务状态：进行中/); assert.equal(parameters.actionKind, 'confirm')
  const confirmAt = new Date(f.now.getTime() + 1000)
  receiveNativeStream(f.store, f.client, 'card', callback('confirmed', { intentId: parameters.intentId, actionToken: parameters.actionToken }, 'ding-member', 'confirm'), confirmAt)
  await runNativeWorker(f.store, f.client, confirmAt)
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'doing'); assert.equal(f.store.list('progressEvents').length, 1)
})
test('old activation links do not swallow new notifications and abandoned calls never send again', async t => {
  const f = await fixture(t), note = f.note(); routeNativeNotification(f.store, note.id, f.now, undefined, f.client)
  let operation = f.store.list<ChannelOperation>('nativeOperations')[0]
  f.store.update<ChannelOperation>('nativeOperations', operation.id, operation.version, { status: 'sending', attempts: 1, leaseUntil: new Date(f.now.getTime() - 1).toISOString() })
  await runNativeWorker(f.store, f.client, f.now)
  assert.equal(f.calls.length, 0); assert.equal(f.firstLink().state, 'unknown')
  assert.equal(f.store.get<ChannelOperation>('nativeOperations', operation.id)?.status, 'unknown')
  const otherNote = f.note(); f.enable({ verificationNote: '重新验收，启用边界改变' })
  refreshNativeLinks(f.store, f.client, f.now)
  assert.equal(f.firstLink().state, 'isolated')
  assert.equal(routeNativeNotification(f.store, otherNote.id, f.now, { ...f.firstLink().action, notificationId: otherNote.id }, f.client), true, 'unknown remains protected even across activation changes')
  operation = f.store.get<ChannelOperation>('nativeOperations', operation.id)!
  f.store.update<ChannelOperation>('nativeOperations', operation.id, operation.version, { status: 'succeeded' })
  const link = f.firstLink(); f.store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { state: 'created' })
  const newer = f.note()
  assert.equal(routeNativeNotification(f.store, newer.id, f.now, { ...link.action, notificationId: newer.id }, f.client), false)
  assert.equal(f.store.get<NotificationDelivery>('notificationDeliveries', newer.id)?.status, 'pending')
})
test('Stream shutdown defers unpersisted events and a delayed official handshake cannot open a new socket', async t => {
  const f = await fixture(t)
  let listener: ((message: DWClientDownStream) => { status: EventAck }) | undefined, resolveConnect: () => void = () => {}, disconnects = 0
  const connecting = new Promise<void>(resolve => { resolveConnect = resolve })
  const fake: NativeStreamClient = { connected: false, registered: false, config: { subscriptions: [] }, registerAllEventListener: callback => { listener = callback }, registerCallbackListener: () => {}, socketCallBackResponse: () => {}, connect: () => connecting, disconnect: () => { disconnects++ } }
  const stop = startNativeStream(f.store, f.client, { factory: () => fake, clock: () => f.now })
  const stopping = stop()
  assert.equal(listener!({ headers: {}, data: '{}' } as DWClientDownStream).status, EventAck.LATER)
  resolveConnect(); await stopping; assert.ok(disconnects >= 1)
  const actual = new GuardedStreamClient({ clientId: 'mock', clientSecret: 'mock', debug: false })
  let finishEndpoint: () => void = () => {}, opened = 0
  actual.getEndpoint = () => new Promise(resolve => { finishEndpoint = () => resolve(actual) })
  // The real guard's closed path returns before the SDK would construct any WebSocket.
  const original = actual._connect.bind(actual)
  actual._connect = async () => { await original(); opened += actual.connected ? 1 : 0 }
  const start = actual.connect(); actual.disconnect(); finishEndpoint(); await start
  assert.equal(opened, 0); assert.equal(actual.connected, false)
})
test('unknown obligation ownership is checked before a work-notification primary channel or disabled native capability', async t => {
  for (const mode of ['work_notification', 'disabled'] as const) await t.test(mode, async t => {
    const f = await fixture(t)
    const request = f.store.insert<FollowupRequest>('followupRequests', { taskId: f.task.id, weeklyRecordId: null, ownerId: f.user.id, requestedBy: f.manager.id, managerRecipientIds: [f.manager.id], generation: 1, requirement: '明确回应', dueAt: new Date(f.now.getTime() + 86400000).toISOString(), status: 'open', respondedAt: null, closedAt: null, closedBy: null, closeReason: '', lastChangedBy: f.manager.id, changeReason: '' })
    const makeNote = (eventKey: string) => enqueueNotification(f.store, { eventKey, recipientId: f.user.id, kind: 'collaboration_followup_requested', title: '回应催办', body: '请回应', actionable: false, targets: [{ type: 'followup', id: request.id }] })!
    const first = makeNote('first-followup'); assert.equal(routeNativeNotification(f.store, first.id, f.now, undefined, f.client), true)
    f.client.createTodo = async () => { throw new DingTalkError('unknown', 'unknown') }; await runNativeWorker(f.store, f.client, f.now)
    if (mode === 'work_notification') f.enable({ primaryChannel: 'work_notification', todoEnabled: false })
    else delete process.env.DINGTALK_NATIVE_ENABLED
    refreshNativeLinks(f.store, f.client, f.now); assert.equal(f.firstLink().state, 'isolated')
    const second = makeNote('second-followup')
    f.store.delete('externalIdentities', f.binding.id, f.binding.version)
    assert.equal(routeNativeNotification(f.store, second.id, f.now, undefined, f.client), true)
    assert.equal(f.store.get<NotificationDelivery>('notificationDeliveries', second.id)?.status, 'skipped')
    assert.equal(f.store.list('nativeLinks').length, 1)
  })
})
test('an old DingTalk userid cannot query the business of a user who has bound a different identity', async t => {
  const f = await fixture(t)
  f.store.delete('externalIdentities', f.binding.id, f.binding.version)
  f.store.insert<DingTalkIdentity>('externalIdentities', { provider: 'dingtalk', corpId: 'corp', userid: 'ding-new-member', userId: f.user.id })
  await verifyNativeIdentity(f.store, f.manager, f.user.id, f.client, f.now)
  const envelope = { headers: {}, data: JSON.stringify({ msgId: 'old-userid', senderCorpId: 'corp', senderStaffId: 'ding-member', conversationType: '1', text: { content: '我的待办' }, sessionWebhook: 'https://oapi.dingtalk.com/robot/sendBySession?token=old', sessionWebhookExpiredTime: f.now.getTime() + 60000 }) }
  receiveNativeStream(f.store, f.client, 'robot', envelope, f.now); await runNativeWorker(f.store, f.client, f.now)
  assert.equal(f.calls.length, 1); assert.doesNotMatch(f.calls[0].input.text, /私密实验事项/); assert.match(f.calls[0].input.text, /绑定当前企业钉钉账号/)
})
test('an existing work-notification retry cannot send when the same followup has an unknown native attempt', async t => {
  const f = await fixture(t), service = new CollaborationService(f.store, () => f.now)
  service.updateSettings(f.manager, { requestId: 'retry-settings', version: 0, enabled: true, pilotUserIds: [f.user.id] })
  service.updateTracking(f.manager, f.task.id, { requestId: 'retry-tracking', version: 0, taskVersion: f.task.version, state: 'active', managerRecipientIds: [f.manager.id] })
  const request = f.store.insert<FollowupRequest>('followupRequests', { taskId: f.task.id, weeklyRecordId: null, ownerId: f.user.id, requestedBy: f.manager.id, managerRecipientIds: [f.manager.id], generation: 1, requirement: '明确回应', dueAt: new Date(f.now.getTime() + 86400000).toISOString(), status: 'open', respondedAt: null, closedAt: null, closedBy: null, closeReason: '', lastChangedBy: f.manager.id, changeReason: '' })
  const note = (eventKey: string) => enqueueNotification(f.store, { eventKey, recipientId: f.user.id, kind: 'collaboration_followup_requested', title: '回应催办', body: '请回应', actionable: false, targets: [{ type: 'followup', id: request.id }] })!
  const retryNote = note('legacy-retry'), oldDelivery = f.store.get<NotificationDelivery>('notificationDeliveries', retryNote.id)!
  f.store.update<NotificationDelivery>('notificationDeliveries', oldDelivery.id, oldDelivery.version, { attempts: 1, lastError: '之前明确未受理' })
  const nativeNote = note('new-native-reminder'), runAt = new Date(f.now.getTime() + 1000)
  assert.equal(routeNativeNotification(f.store, nativeNote.id, runAt, undefined, f.client), true)
  f.client.createTodo = async () => { throw new DingTalkError('unknown', 'unknown') }; await runNativeWorker(f.store, f.client, runAt)
  f.enable({ primaryChannel: 'work_notification', todoEnabled: false }); refreshNativeLinks(f.store, f.client, runAt)
  assert.ok(currentNotificationMessage(f.store, f.user, retryNote, runAt), 'retry is otherwise eligible to send')
  let sends = 0
  const legacy: DingTalkClient = { configured: true, corpId: 'corp', clientId: 'app', getIdentity: async () => ({ corpId: 'corp', userid: 'ding-member' }), send: async () => { sends++; return { taskId: 'legacy-receipt' } }, result: async () => 'pending' }
  await runNotificationWorker(f.store, legacy, runAt)
  const delivery = f.store.get<NotificationDelivery>('notificationDeliveries', retryNote.id)!
  assert.equal(sends, 0); assert.equal(delivery.status, 'skipped'); assert.equal(delivery.attempts, 1)
  assert.match(delivery.lastError, /未确认的原生请求/)
  assert.equal(f.store.list('notificationDeliveryContents').length, 0)
})
test('a manual acknowledgement reminder retains the unknown native ownership of its source notification', async t => {
  const f = await fixture(t), source = f.note(), runAt = new Date(f.now.getTime() + 1000)
  routeNativeNotification(f.store, source.id, runAt, undefined, f.client)
  f.client.createTodo = async () => { throw new DingTalkError('unknown', 'unknown') }; await runNativeWorker(f.store, f.client, runAt)
  f.enable({ primaryChannel: 'work_notification', todoEnabled: false }); refreshNativeLinks(f.store, f.client, runAt)
  const reminder = enqueueNotification(f.store, { eventKey: `manual:2026-09-20:${source.id}`, recipientId: f.user.id, kind: 'manual_reminder', title: '请确认工作安排', body: '请确认原安排', actionable: false, sourceNotificationId: source.id, targets: source.targets })!
  assert.ok(currentNotificationMessage(f.store, f.user, reminder, runAt))
  let sends = 0
  const legacy: DingTalkClient = { configured: true, corpId: 'corp', clientId: 'app', getIdentity: async () => ({ corpId: 'corp', userid: 'ding-member' }), send: async () => { sends++; return { taskId: 'legacy-receipt' } }, result: async () => 'pending' }
  await runNotificationWorker(f.store, legacy, runAt)
  assert.equal(sends, 0); assert.equal(f.store.get<NotificationDelivery>('notificationDeliveries', reminder.id)?.status, 'skipped')
  assert.equal(f.store.list('nativeLinks').length, 1); assert.equal(f.store.list('notificationDeliveryContents').length, 0)
})

async function monthlyNativeFixture(t: TestContext, channel: 'todo' | 'card' = 'todo', kind: 'review' | 'acceptance' = 'review', digest = false, leaveSync = false) {
  const f = await fixture(t, channel)
  if (leaveSync) f.enable({ leaveSyncEnabled: true })
  const reviewer = f.store.update<User>('users', f.user.id, f.user.version, { role: 'manager' })
  const plan = f.store.insert<MonthlyPlan>('plans', { month: '2026-11', title: '重复的月度目标', ownerId: f.other.id, collaboratorIds: [], projectId: null, category: '研究', expectedOutcome: '原始目标要求', acceptanceCriteria: '评审', dueDate: '2026-11-30', priority: 'medium', status: kind === 'review' ? 'submitted' : 'published', publishedVersion: kind === 'review' ? null : 1, reviewComment: '', sourcePlanId: null, actualOutcome: '', acceptanceStatus: kind === 'review' ? 'pending' : 'submitted', acceptanceNote: '' })
  let target: Notification['targets'][number] = { type: 'plan', id: plan.id }
  if (digest) {
    const item = f.store.insert<DigestItem>('digestItems', { recipientId: reviewer.id, sourceId: plan.id, sourceKind: 'monthly_submitted', target, taskId: null, ownerId: f.other.id, title: plan.title, lines: ['待审核'], occurredAt: f.now.toISOString(), consumedBy: null, generation: null, actionable: false })
    const row = f.store.insert<NotificationDigest>('notificationDigests', { recipientId: reviewer.id, type: 'approval_manager', day: '2026-11-06', slot: 'daily', periodStart: f.enabledAt.toISOString(), periodEnd: f.now.toISOString(), itemIds: [item.id], generatedAt: f.now.toISOString(), ruleVersion: 1, notificationId: null })
    target = { type: 'digest', id: row.id }
  }
  const note = enqueueNotification(f.store, { eventKey: `monthly-native-${kind}`, recipientId: reviewer.id, title: '月度目标待处理', body: '请进入平台核对', kind: digest ? 'collaboration_digest' : 'proposal_review', actionable: false, targets: [target] })!
  assert.equal(routeNativeNotification(f.store, note.id, f.now, undefined, f.client), true)
  const remove = () => kind === 'review'
    ? new Domain(f.store).deletePlan(f.manager, plan.id, { version: plan.version, reason: '与导入目标重复' })
    // Current commands forbid deleting published acceptance work. Keep the synchronizer safe
    // for a legacy/imported tombstone attached to an already-existing external acceptance link.
    : f.store.update<MonthlyPlan>('plans', plan.id, plan.version, { deletion: { deletedAt: f.now.toISOString(), deletedBy: f.manager.id, reason: '旧数据删除标记' } })
  return { ...f, reviewer, plan, note, remove }
}

test('deleted monthly review and legacy acceptance close existing todos and cards without reopening notifications or sending a new obligation', async t => {
  for (const channel of ['todo', 'card'] as const) for (const kind of ['review', 'acceptance'] as const) await t.test(`${channel}/${kind}`, async t => {
    const f = await monthlyNativeFixture(t, channel, kind)
    await runNativeWorker(f.store, f.client, f.now)
    const originalLink = f.firstLink(), notes = f.store.list('notifications'), deliveries = f.store.list('notificationDeliveries')
    const deleted = f.remove()
    assert.equal(getNotification(f.store, f.reviewer, f.note.id).unavailable, true)
    assert.equal(targetAccessible(f.store, f.reviewer, { type: 'plan', id: f.plan.id }), false)
    assert.equal(collaborationTargetAccessible(f.store, f.reviewer, { type: 'plan', id: f.plan.id }), false)
    assert.equal(nativeDesired(f.store, f.reviewer.id, originalLink.action), undefined, 'new delivery cannot project the deleted obligation')
    await runNativeWorker(f.store, f.client, new Date(f.now.getTime() + 1000))
    const link = f.firstLink(), update = f.calls.at(-1)!
    assert.equal(link.id, originalLink.id); assert.equal(link.providerId, originalLink.providerId)
    assert.equal(link.state, 'closed'); assert.equal(link.desired.done, true)
    assert.match(link.desired.title, /已删除/); assert.match(link.desired.summary, /已删除/)
    assert.equal(link.desired.summary.includes('原始目标要求'), false)
    assert.equal(update.kind, channel === 'todo' ? 'update' : 'card_update')
    if (channel === 'todo') assert.equal(update.input.done, true)
    else { assert.equal(update.input[1].actionKind, ''); assert.equal(update.input[1].status, '平台已处理') }
    assert.deepEqual(f.store.list('notifications'), notes)
    assert.deepEqual(f.store.list('notificationDeliveries'), deliveries)
    assert.deepEqual(f.store.get('plans', f.plan.id), deleted, 'closing an external obligation does not approve or accept business work')
    const callCount = f.calls.length
    await runNativeWorker(f.store, f.client, new Date(f.now.getTime() + 2000))
    assert.equal(f.calls.length, callCount, 'a settled deletion closure does not send repeatedly')
    assert.equal(f.store.list('nativeLinks').length, 1)
  })
})

test('deletion before first native send cancels create and cannot create or recreate a deleted plan obligation', async t => {
  for (const channel of ['todo', 'card'] as const) await t.test(channel, async t => {
    const f = await monthlyNativeFixture(t, channel), action = f.firstLink().action
    f.remove()
    await runNativeWorker(f.store, f.client, f.now)
    assert.equal(f.calls.length, 0)
    assert.equal(f.firstLink().state, 'closed')
    assert.ok(f.store.list<ChannelOperation>('nativeOperations').every(operation => operation.status === 'cancelled'))
    const note = enqueueNotification(f.store, { eventKey: 'late-monthly-source', recipientId: f.reviewer.id, title: '旧来源通知', body: '过期', kind: 'proposal_review', actionable: false, targets: [{ type: 'plan', id: f.plan.id }] })!
    assert.equal(routeNativeNotification(f.store, note.id, f.now, { ...action, notificationId: note.id }, f.client), false)
    assert.equal(f.store.list('nativeLinks').length, 1)
    const link = f.firstLink()
    f.store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { state: 'external_missing' })
    assert.throws(() => recreateNativeLink(f.store, f.manager, link.id, f.client, f.now), { status: 409 })
    assert.equal(f.calls.length, 0)
  })
})

test('deleted plan closure respects live manager access, original notification scope and binding or activation generation', async t => {
  for (const change of ['demoted', 'disabled', 'rebound', 'activation', 'notification-target', 'notification-recipient'] as const) await t.test(change, async t => {
    const f = await monthlyNativeFixture(t)
    await runNativeWorker(f.store, f.client, f.now)
    f.remove()
    if (change === 'demoted') f.store.update<User>('users', f.reviewer.id, f.reviewer.version, { role: 'member' })
    if (change === 'disabled') f.store.update<User>('users', f.reviewer.id, f.reviewer.version, { active: false })
    if (change === 'rebound') f.store.update<DingTalkIdentity>('externalIdentities', f.binding.id, f.binding.version, { userid: 'replacement-account' })
    if (change === 'activation') f.enable({ verificationNote: '新代际' })
    if (change === 'notification-target') f.store.update<Notification>('notifications', f.note.id, f.note.version, { targets: [{ type: 'task', id: f.task.id }] })
    if (change === 'notification-recipient') f.store.update<Notification>('notifications', f.note.id, f.note.version, { recipientId: f.other.id })
    const calls = f.calls.length
    await runNativeWorker(f.store, f.client, new Date(f.now.getTime() + 1000))
    assert.equal(f.calls.length, calls, 'revoked scope or identity does not receive a terminal update')
    assert.equal(f.firstLink().state, 'isolated')
  })
})

test('a deleted single-plan approval digest closes its existing native link while keeping digest content hidden', async t => {
  const f = await monthlyNativeFixture(t, 'todo', 'review', true)
  await runNativeWorker(f.store, f.client, f.now)
  f.remove()
  const view = getNotification(f.store, f.reviewer, f.note.id)
  assert.equal(!!view.content?.items.some(item => item.target.type === 'plan' && item.target.id === f.plan.id), false)
  await runNativeWorker(f.store, f.client, new Date(f.now.getTime() + 1000))
  assert.equal(f.firstLink().state, 'closed')
  assert.equal(f.calls.at(-1)?.kind, 'update'); assert.equal(f.calls.at(-1)?.input.done, true)
})

test('deleted review with an uncertain original todo reconciles its source before closing and never creates twice', async t => {
  const f = await monthlyNativeFixture(t)
  let creates = 0
  f.client.createTodo = async () => { creates++; throw new DingTalkError('unknown', 'unknown') }
  await runNativeWorker(f.store, f.client, f.now)
  assert.equal(f.firstLink().state, 'unknown')
  f.remove()
  const link = f.firstLink()
  f.store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { reconcileAt: f.now.toISOString() })
  f.client.listTodos = async () => ({ items: [{ taskId: 'reconciled-existing-todo', sourceId: link.sourceId, subject: link.desired.title, isDone: false }], nextToken: null })
  await runNativeWorker(f.store, f.client, new Date(f.now.getTime() + 1000))
  assert.equal(creates, 1)
  assert.equal(f.firstLink().providerId, 'reconciled-existing-todo')
  assert.equal(f.firstLink().state, 'closed')
  assert.equal(f.calls.at(-1)?.kind, 'update'); assert.equal(f.calls.at(-1)?.input.done, true)
})

test('a goal deleted while leave reconciliation awaits cancels its pending native creation before any send', async t => {
  for (const channel of ['todo', 'card'] as const) await t.test(channel, async t => {
    const f = await monthlyNativeFixture(t, channel, 'review', false, true)
    let polled = false
    f.client.listLeaveRecords = async () => { await Promise.resolve(); polled = true; f.remove(); return { records: [], nextToken: null } }
    await runNativeWorker(f.store, f.client, f.now)
    assert.equal(polled, true)
    assert.equal(f.calls.length, 0)
    assert.equal(f.firstLink().state, 'closed')
    assert.equal(f.firstLink().desired.done, true)
    assert.ok(f.store.list<ChannelOperation>('nativeOperations').every(operation => operation.status === 'cancelled'))
    assert.equal(f.store.list('nativeDeliveryAttempts').length, 0)
  })
})

test('a goal deleted during awaited reconciliation replaces an already-queued native update with the latest terminal state', async t => {
  for (const channel of ['todo', 'card'] as const) await t.test(channel, async t => {
    const f = await monthlyNativeFixture(t, channel, 'review', false, true)
    await runNativeWorker(f.store, f.client, f.now)
    const providerId = f.firstLink().providerId, initialCallCount = f.calls.length
    const edited = new Domain(f.store).updatePlan(f.manager, f.plan.id, { version: f.plan.version, title: '查询期间再次核对的目标' })
    f.client.listTodos = async () => ({ items: [{ taskId: providerId!, sourceId: f.firstLink().sourceId, subject: f.plan.title, isDone: false }], nextToken: null })
    let polled = false
    f.client.listLeaveRecords = async () => {
      await Promise.resolve(); polled = true
      new Domain(f.store).deletePlan(f.manager, edited.id, { version: edited.version, reason: '查询期间确认重复' })
      return { records: [], nextToken: null }
    }
    await runNativeWorker(f.store, f.client, new Date(f.now.getTime() + 25 * 3600000))
    assert.equal(polled, true)
    const sent = f.calls.slice(initialCallCount)
    assert.equal(sent.length, 1, 'no stale intermediate update leaves the worker')
    assert.equal(sent[0].kind, channel === 'todo' ? 'update' : 'card_update')
    if (channel === 'todo') { assert.equal(sent[0].input.done, true); assert.match(sent[0].input.subject, /已删除/) }
    else { assert.equal(sent[0].input[1].status, '平台已处理'); assert.match(sent[0].input[1].title, /已删除/) }
    assert.equal(f.firstLink().providerId, providerId)
    assert.equal(f.firstLink().state, 'closed')
    assert.ok(f.store.list<ChannelOperation>('nativeOperations').some(operation => operation.status === 'cancelled' && operation.kind.endsWith('_update')))
  })
})

test('a later pending goal deleted during an earlier native send is rechecked before its own create', async t => {
  const f = await monthlyNativeFixture(t)
  const { id: _id, version: _version, createdAt: _createdAt, updatedAt: _updatedAt, ...fields } = f.plan
  const second = f.store.insert<MonthlyPlan>('plans', { ...fields, title: '尚未发送的第二目标' })
  const note = enqueueNotification(f.store, { eventKey: 'second-native-review', recipientId: f.reviewer.id, kind: 'proposal_review', title: '第二目标待审核', body: '请核对', targets: [{ type: 'plan', id: second.id }], actionable: false })!
  assert.equal(routeNativeNotification(f.store, note.id, f.now, undefined, f.client), true)
  let creates = 0
  f.client.createTodo = async input => {
    creates++; assert.equal(input.subject.includes(f.plan.title), true)
    await Promise.resolve()
    new Domain(f.store).deletePlan(f.manager, second.id, { version: second.version, reason: '前一请求期间确认重复' })
    return { taskId: 'first-only' }
  }
  await runNativeWorker(f.store, f.client, f.now)
  assert.equal(creates, 1)
  const secondLink = f.store.list<ExternalObjectLink>('nativeLinks').find(link => link.action.id === second.id)!
  assert.equal(secondLink.state, 'closed'); assert.equal(secondLink.providerId, null)
  assert.equal(f.store.list<NativeDeliveryAttempt>('nativeDeliveryAttempts').length, 1)
})
