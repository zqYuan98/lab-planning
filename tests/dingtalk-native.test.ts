import test from 'node:test'
import assert from 'node:assert/strict'
import { createDingTalkNativeClient, nativeEntryUrl } from '../server/dingtalk-native.ts'
import { DingTalkError } from '../server/dingtalk.ts'

const env = { APP_ORIGIN: 'https://planning.test', DINGTALK_CORP_ID: 'corp', DINGTALK_CLIENT_ID: 'app', DINGTALK_CLIENT_SECRET: 'secret', DINGTALK_ROBOT_CODE: 'robot' }
const todo = { unionId: 'union-one', sourceId: 'source-one', subject: '确认收到：中文😀', detailUrl: { appUrl: 'https://planning.test/entry?notificationId=n1', pcUrl: 'https://planning.test/entry?notificationId=n1' }, fields: [{ fieldKey: '事项要求', fieldValue: '核对工作要求' }], dueTime: 123456789 }
function mock(responses: unknown[]) {
  const calls: { url: URL; init: RequestInit; body: any }[] = []
  const fetcher = (async (url: URL | RequestInfo, init: RequestInit) => { calls.push({ url: new URL(String(url)), init, body: init.body ? JSON.parse(String(init.body)) : null }); const data = responses.shift(); if (data instanceof Error) throw data; return data instanceof Response ? data : new Response(JSON.stringify(data), { status: 200 }) }) as typeof fetch
  return { calls, client: createDingTalkNativeClient({ env, fetch: fetcher, now: () => 1000 }) }
}
test('native client uses official token, identity and work-todo wire schemas with one executor', async () => {
  const m = mock([{ access_token: 'old-token', expires_in: 7200 }, { errcode: 0, result: { userid: 'ding-one', unionid: 'union-one', active: false } }, { accessToken: 'new-token', expireIn: 7200 }, { id: 'provider-task' }, { result: true }, { result: true }])
  assert.deepEqual(await m.client.verifyMember('ding-one'), { userid: 'ding-one', unionId: 'union-one' })
  assert.deepEqual(await m.client.createTodo(todo), { taskId: 'provider-task' })
  await m.client.updateTodo({ unionId: 'union-one', taskId: 'provider-task', subject: todo.subject, done: true, fields: todo.fields })
  await m.client.deleteTodo('union-one', 'provider-task')
  assert.equal(m.calls[3].url.href, 'https://api.dingtalk.com/v1.0/todo/users/union-one/tasks')
  assert.deepEqual(m.calls[3].body.executorIds, ['union-one']); assert.equal(m.calls[3].body.isOnlyShowExecutor, true)
  assert.equal((m.calls[3].init.headers as Record<string, string>)['x-acs-dingtalk-access-token'], 'new-token')
  assert.deepEqual(m.calls[3].body.detailUrl, todo.detailUrl); assert.equal(m.calls[3].body.notifyConfigs.dingNotify, '0')
  assert.equal(m.calls[4].body.done, true); assert.equal(m.calls[5].init.method, 'DELETE')
  assert.equal(m.calls.filter(row => row.url.pathname.endsWith('accessToken')).length, 1)
})
test('native creation and transport uncertainty never become definite failure', async () => {
  for (const failure of [new Error('timeout with token'), { id: null }, new Response('{}', { status: 500 })]) {
    const m = mock([{ accessToken: 'new-token', expireIn: 7200 }, failure])
    await assert.rejects(m.client.createTodo(todo), error => error instanceof DingTalkError && error.outcome === 'unknown' && !error.message.includes('token'))
  }
  const m = mock([{ accessToken: 'new-token', expireIn: 7200 }, new Response('{}', { status: 403 })])
  await assert.rejects(m.client.createTodo(todo), error => error instanceof DingTalkError && error.outcome === 'definitive')
})
test('native detail URL validation rejects outsiders, duplicate ids, HTML routes and over-budget URLs before requests', async () => {
  const m = mock([])
  for (const url of ['https://evil.test/entry?notificationId=n', 'https://planning.test/entry?notificationId=n&next=x', 'https://planning.test/entry?notificationId=n&notificationId=b', 'http://planning.test/entry?notificationId=n', `https://planning.test/entry?notificationId=${'a'.repeat(1100)}`]) {
    assert.throws(() => nativeEntryUrl(url, env), DingTalkError)
    await assert.rejects(m.client.createTodo({ ...todo, detailUrl: { appUrl: url, pcUrl: url } }), DingTalkError)
  }
  assert.equal(m.calls.length, 0)
})
test('native todo pages and advanced card create-deliver-update parse the documented responses', async () => {
  const m = mock([{ accessToken: 'new-token', expireIn: 7200 }, { todoCards: [{ taskId: 'p1', sourceId: 's1', subject: '事项', isDone: false }], nextToken: 'cursor' }, { success: true, result: 'out-one' }, { success: true, result: [{ spaceType: 'IM_ROBOT', spaceId: 'ding-one', success: true, carrierId: 'carrier' }] }, { success: true, result: true }])
  assert.equal((await m.client.listTodos('union-one', 'previous')).nextToken, 'cursor')
  assert.deepEqual(m.calls[1].body.roleTypes, [['executor']]); assert.equal(m.calls[1].body.nextToken, 'previous')
  await m.client.createCard({ outTrackId: 'out-one', templateId: 'real-template-id', userid: 'ding-one', params: { title: '中文😀', status: '待处理' } })
  assert.deepEqual(await m.client.deliverCard('out-one', 'ding-one'), { carrierId: 'carrier' })
  await m.client.updateCard('out-one', { status: '已处理' })
  assert.equal(m.calls[2].body.callbackType, 'STREAM'); assert.equal(m.calls[2].body.userIdType, 1)
  assert.equal(m.calls[3].body.openSpaceId, 'dtv1.card//IM_ROBOT.ding-one')
  assert.deepEqual(m.calls[4].body.cardUpdateOptions, { updateCardDataByKey: true })
})
test('top-level card deliver success alone is not proof of delivery', async () => {
  const m = mock([{ accessToken: 'new-token', expireIn: 7200 }, { success: true, result: [] }])
  await assert.rejects(m.client.deliverCard('out', 'ding'), error => error instanceof DingTalkError && error.outcome === 'unknown')
})
test('robot success without a receipt is unknown; explicit invalid recipients are definitive', async () => {
  for (const [result, outcome] of [[{}, 'unknown'], [{ invalidStaffIdList: ['ding'] }, 'definitive']] as const) {
    const m = mock([{ accessToken: 'token', expireIn: 7200 }, result])
    await assert.rejects(m.client.sendRobot({ userid: 'ding', text: '回复' }), error => error instanceof DingTalkError && error.outcome === outcome)
  }
})
test('robot webhook is host/path/expiry controlled and leave compensation has a bounded time window', async () => {
  const m = mock([{ errcode: 0 }, { accessToken: 'new-token', expireIn: 7200 }, { records: [{ userId: 'ding-one', leaveTime: '2026-09-20T01:00:00Z', mobile: 'not persisted' }], nextToken: 'cursor' }])
  await assert.rejects(m.client.sendRobot({ webhook: 'https://attacker.test/robot/send', expiresAt: 2000, text: 'secret' }), DingTalkError)
  await assert.rejects(m.client.sendRobot({ webhook: 'https://oapi.dingtalk.com/robot/send', expiresAt: 500, text: 'secret' }), DingTalkError)
  await m.client.sendRobot({ webhook: 'https://oapi.dingtalk.com/robot/sendBySession?token=opaque', expiresAt: 2000, text: '仅通用入口' })
  const result = await m.client.listLeaveRecords('2026-09-01T00:00:00Z', '2026-09-20T00:00:00Z')
  assert.deepEqual(result.records[0], { userid: 'ding-one', leaveTime: '2026-09-20T01:00:00.000Z' })
  await assert.rejects(m.client.listLeaveRecords('2020-01-01', '2026-01-01'), DingTalkError)
  assert.equal(m.calls.length, 3)
})
