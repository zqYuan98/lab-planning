import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import type { DingTalkClient } from '../server/dingtalk.ts'
import type { NotificationPage } from '../server/notification-pagination.ts'
import { enqueueNotification } from '../server/notifications.ts'
import { Store } from '../server/store.ts'
import type { Notification, NotificationView } from '../shared/notifications.ts'
import type { Task } from '../shared/types.ts'
import { NotificationDetailContent } from '../src/pages/Messages.tsx'

async function fixture(t: TestContext) {
  const previousOrigin = process.env.APP_ORIGIN
  process.env.APP_ORIGIN = 'https://planning.test'
  const store = new Store(':memory:')
  const user = (id: string) => store.insert<StoredUser>('users', { id, name: id, email: `${id}@test.local`, role: 'member', active: true, position: '', credentialVersion: 1, passwordHash: '' })
  const member = user('pagination-member'), peer = user('pagination-peer')
  let externalCalls = 0
  const unavailable = async (): Promise<never> => { externalCalls++; throw new Error('Pagination must never contact DingTalk') }
  const client: DingTalkClient = { configured: false, corpId: '', clientId: '', getIdentity: unavailable, send: unavailable, result: unavailable }
  const server = createApp({ store, dingtalkClient: client }).listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`
  const cookies = new Map([member, peer].map(actor => [actor.id, `lab_session=${createSession(store, actor)}`]))
  const call = (path: string, actor: StoredUser | null = member, method = 'GET', body: unknown = {}) => fetch(base + path, {
    method, headers: { ...(actor ? { cookie: cookies.get(actor.id)! } : {}), origin: 'https://planning.test', 'content-type': 'application/json' },
    ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
  })
  const page = async (query = '', actor = member) => {
    const response = await call(`/notifications${query}`, actor)
    assert.equal(response.status, 200, await response.clone().text())
    return await response.json() as NotificationPage
  }
  const notice = (id: string, actor = member, createdAt = '2026-09-20T08:00:00.000Z') => store.restoreEntity<Notification>('notifications', {
    id, version: 1, createdAt, updatedAt: createdAt, eventKey: id, recipientId: actor.id, kind: 'information', title: id, body: `消息 ${id}`,
    targets: [], actionable: false, openedAt: null, acknowledgedAt: null, supersededAt: null,
  })
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
    if (previousOrigin === undefined) delete process.env.APP_ORIGIN
    else process.env.APP_ORIGIN = previousOrigin
    assert.equal(externalCalls, 0)
  })
  return { store, member, peer, call, page, notice }
}

test('an opened obligation older than 200 messages stays in server pending results and full inbox counts', async t => {
  const f = await fixture(t)
  const task = f.store.insert<Task>('tasks', { title: '旧安排仍需本人确认', monthlyPlanId: null, ownerId: f.member.id, description: '', dueDate: '2026-09-30', status: 'todo', isTemporary: true, temporaryReason: '分页测试' })
  const old = enqueueNotification(f.store, { eventKey: 'old-pending', recipientId: f.member.id, kind: 'work_assigned', title: task.title, body: '请确认', targets: [{ type: 'task', id: task.id }], actionable: true })!
  for (let i = 0; i < 260; i++) f.notice(`new-${String(i).padStart(3, '0')}`, f.member, new Date(Date.parse(old.createdAt) + 60_000 + i).toISOString())
  for (let i = 0; i < 11; i++) f.notice(`peer-${i}`, f.peer)
  const before = JSON.stringify(f.store.list('notifications'))
  assert.equal((await f.call(`/notifications/${old.id}`)).status, 200)
  assert.equal(JSON.stringify(f.store.list('notifications')), before, 'GET detail does not mark viewed')
  assert.equal((await f.call(`/notifications/${old.id}/open`, f.member, 'POST')).status, 200)
  const all = await f.page()
  assert.equal(all.items.length, 200)
  assert.ok(all.nextCursor)
  assert.equal(all.items.some(row => row.id === old.id), false)
  assert.equal(all.totalCount, 261)
  assert.equal(all.unreadCount, 260)
  assert.equal(all.pendingCount, 1)
  const pending = await f.page('?filter=pending&limit=50')
  assert.deepEqual(pending.items.map(row => row.id), [old.id])
  assert.ok(pending.items[0].openedAt)
  assert.equal(pending.items[0].acknowledgedAt, null)
  assert.equal(pending.filteredCount, 1)
  assert.equal(pending.totalCount, 261)
  assert.equal(pending.nextCursor, null)
  const unread = await f.page('?filter=unread&limit=5')
  assert.equal(unread.filteredCount, 260)
  assert.equal(unread.items.length, 5)
  assert.equal((await f.call('/notifications/open-all', f.member, 'POST')).status, 200)
  const afterOpenAll = await f.page('?filter=pending')
  assert.equal(afterOpenAll.unreadCount, 0)
  assert.equal(afterOpenAll.pendingCount, 1)
  assert.equal(afterOpenAll.items[0].acknowledgedAt, null)
  const token = afterOpenAll.items[0].confirmationToken
  assert.equal((await f.call(`/notifications/${old.id}/acknowledge`, f.member, 'POST', { confirmationToken: token })).status, 200)
  const confirmed = await f.page('?filter=pending')
  assert.equal(confirmed.pendingCount, 0)
  assert.equal(confirmed.filteredCount, 0)
  assert.deepEqual(confirmed.items, [])
  assert.equal(f.store.get<Task>('tasks', task.id)!.status, 'todo')
  assert.equal(f.store.list('weeklySubmissions').length, 0)
})

test('equal timestamps paginate stably without duplicates, missed older rows, or other recipients', async t => {
  const f = await fixture(t)
  const expected = Array.from({ length: 235 }, (_, i) => `message-${String(i).padStart(3, '0')}`)
  for (const id of [...expected].reverse()) f.notice(id)
  for (let i = 0; i < 19; i++) f.notice(`foreign-${i}`, f.peer)
  const seen: string[] = []
  let nextCursor: string | null = null
  let first = true
  do {
    const page: NotificationPage = await f.page(`?filter=all&limit=37${nextCursor ? `&cursor=${encodeURIComponent(nextCursor)}` : ''}`)
    assert.equal(page.totalCount, first ? 235 : 236)
    assert.equal(page.items.every(row => row.recipientId === f.member.id), true)
    seen.push(...page.items.map(row => row.id))
    nextCursor = page.nextCursor
    if (first) { f.notice('zz-new-after-first-page'); first = false }
  } while (nextCursor)
  assert.deepEqual(seen, [...expected].sort().reverse())
  assert.equal(new Set(seen).size, 235)
  assert.equal((await f.page('?limit=1')).items[0].id, 'zz-new-after-first-page')
  assert.equal((await f.page('?recipientId=pagination-peer')).totalCount, 236, 'query parameters cannot switch the authenticated inbox')
})

test('pagination rejects malformed and foreign cursors and keeps an opened unread boundary valid', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 4; i++) f.notice(`own-${i}`)
  for (let i = 0; i < 3; i++) f.notice(`other-${i}`, f.peer)
  const first = await f.page('?filter=unread&limit=2')
  const cursor = JSON.parse(Buffer.from(first.nextCursor!, 'base64url').toString('utf8')) as Record<string, unknown>
  const encoded = (value: unknown) => encodeURIComponent(Buffer.from(JSON.stringify(value)).toString('base64url'))
  for (const query of [
    '?limit=0', '?limit=201', '?limit=1.5', '?limit=-1', '?limit=abc', '?limit=1&limit=2', '?filter=unknown', '?filter=all&filter=pending',
    '?cursor=', '?cursor=!!!', '?cursor=a', `?cursor=${'a'.repeat(1025)}`, `?cursor=${encoded(null)}`, `?cursor=${encoded([])}`,
    `?filter=unread&cursor=${encoded({ ...cursor, createdAt: 'yesterday' })}`,
    `?filter=unread&cursor=${encoded({ ...cursor, createdAt: '2026-01-01T00:00:00.000Z' })}`,
    `?filter=unread&cursor=${encoded({ ...cursor, id: 'other-1' })}`,
    `?filter=unread&cursor=${encoded({ ...cursor, recipientId: f.peer.id })}`,
    `?filter=unread&cursor=${encoded({ ...cursor, extra: true })}`,
    `?filter=all&cursor=${encodeURIComponent(first.nextCursor!)}`,
  ]) assert.equal((await f.call(`/notifications${query}`)).status, 400, query)
  const foreign = await f.page('?limit=1', f.peer)
  assert.equal((await f.call(`/notifications?cursor=${encodeURIComponent(foreign.nextCursor!)}`)).status, 400)
  assert.equal((await f.call('/notifications/other-1')).status, 404)
  assert.equal((await f.call('/notifications', null)).status, 401)
  for (const row of first.items) assert.equal((await f.call(`/notifications/${row.id}/open`, f.member, 'POST')).status, 200)
  const next = await f.page(`?filter=unread&limit=2&cursor=${encodeURIComponent(first.nextCursor!)}`)
  assert.deepEqual(next.items.map(row => row.id), ['own-1', 'own-0'])
  assert.equal(next.unreadCount, 2)
  assert.equal(next.filteredCount, 2)
  assert.equal(next.nextCursor, null)
})

test('pending counts use current obligations instead of an old actionable flag', async t => {
  const f = await fixture(t)
  const task = f.store.insert<Task>('tasks', { title: '更新过的工作', monthlyPlanId: null, ownerId: f.member.id, description: '', dueDate: '2026-09-30', status: 'todo', isTemporary: true, temporaryReason: '分页测试' })
  const input = { recipientId: f.member.id, kind: 'work_assigned', title: task.title, body: '安排', targets: [{ type: 'task' as const, id: task.id }], actionable: true }
  const obsolete = enqueueNotification(f.store, { ...input, eventKey: 'superseded' })!
  const current = enqueueNotification(f.store, { ...input, eventKey: 'current' })!
  const pending = await f.page('?filter=pending')
  assert.equal(f.store.get<Notification>('notifications', obsolete.id)!.actionable, true)
  assert.deepEqual(pending.items.map(row => row.id), [current.id])
  assert.equal(pending.pendingCount, 1)
})

test('feedback detail links to feedback and omits work acknowledgement guidance', () => {
  const notification: NotificationView = {
    id: 'feedback-notification', version: 1, createdAt: '2026-09-21T08:00:00.000Z', updatedAt: '2026-09-21T08:00:00.000Z',
    eventKey: 'feedback-created', recipientId: 'member', kind: 'feedback_created', title: '反馈已受理', body: '已安排处理',
    targets: [{ type: 'feedback', id: 'feedback-one' }], actionable: false, openedAt: null, acknowledgedAt: null, supersededAt: null,
    deliveryStatus: null, canAcknowledge: false, unavailable: false,
  }
  const html = renderToStaticMarkup(createElement(NotificationDetailContent, { notification, busy: false, onVisit: () => {}, onOpenSource: () => {}, onAcknowledge: () => {} }))
  assert.ok(html.includes('查看反馈'))
  assert.ok(html.includes('问题反馈'))
  assert.ok(!html.includes('确认接收'))
  assert.ok(!html.includes('执行进展'))
  assert.ok(!html.includes('平台发送成功'))
})
