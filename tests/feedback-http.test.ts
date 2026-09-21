import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { randomBytes } from 'node:crypto'
import { crc32, deflateSync } from 'node:zlib'
import type { AddressInfo } from 'node:net'
import type { FeedbackAttachmentInput, FeedbackDetailResponse } from '../shared/feedback.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { Store } from '../server/store.ts'

function screenshot(width = 1, height = 1): FeedbackAttachmentInput {
  const chunk = (type: string, body: Buffer) => {
    const label = Buffer.from(type), length = Buffer.alloc(4), check = Buffer.alloc(4)
    length.writeUInt32BE(body.length); check.writeUInt32BE(crc32(Buffer.concat([label, body])))
    return Buffer.concat([length, label, body, check])
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6
  const pixels = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([Buffer.from([0]), randomBytes(width * 4)])))
  return { name: '真实截图.png', mimeType: 'image/png', dataBase64: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]).toString('base64') }
}
async function fixture(t: TestContext) {
  const store = new Store(':memory:')
  const makeUser = (id: string, role: 'member' | 'manager') => store.insert<StoredUser>('users', { id, name: id, email: `${id}@feedback-http.test`, role, active: true, position: '', passwordHash: 'not-used-in-session-test', credentialVersion: 1 })
  const manager = makeUser('manager', 'manager'), member = makeUser('member', 'member'), other = makeUser('other', 'member')
  const cookies = new Map([manager, member, other].map(user => [user.id, `lab_session=${createSession(store, user)}`]))
  const app = createApp({ store, enableScheduler: false }), server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close() })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const request = (path: string, user = member.id, body?: unknown, extraHeaders: Record<string, string> = {}) => fetch(`${base}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST', headers: { ...(user ? { cookie: cookies.get(user)! } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  return { store, manager, member, other, request }
}

test('HTTP feedback creation supports three real screenshots beyond the regular body limit; downloads recheck authorization', async t => {
  const { manager, member, other, request } = await fixture(t)
  const image = screenshot(512, 512), body = { requestId: 'http-create', description: '手机周报保存问题', attachments: [image, image, image] }
  const response = await request('/feedback', member.id, body)
  assert.equal(response.status, 201)
  assert.ok(response.headers.get('x-request-id'))
  const detail = await response.json() as FeedbackDetailResponse
  assert.equal(detail.attachments.length, 3)
  assert.equal(JSON.stringify(detail).includes('dataBase64'), false)
  const url = `/feedback/${detail.feedback.id}/attachments/${detail.attachments[0].id}`
  for (const user of [manager.id, member.id]) {
    const download = await request(url, user)
    assert.equal(download.status, 200); assert.equal(download.headers.get('content-type'), 'image/png')
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(download.headers.get('cache-control'), 'private, no-store')
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(image.dataBase64, 'base64'))
  }
  assert.equal((await request(url, other.id)).status, 404)
  assert.equal((await request(url, '')).status, 401)
  assert.equal((await request(`/feedback/${detail.feedback.id}`, other.id)).status, 404)
  assert.equal((await request('/feedback?scope=all', member.id)).status, 403)
  const retry = await request('/feedback', member.id, body)
  assert.equal((await retry.json() as FeedbackDetailResponse).feedback.id, detail.feedback.id)
})

test('HTTP feedback mutations preserve retry semantics and report conflicts with server-generated error IDs', async t => {
  const { manager, member, request } = await fixture(t)
  const created = await (await request('/feedback', member.id, { requestId: 'create', description: '错误重试' })).json() as FeedbackDetailResponse
  const path = `/feedback/${created.feedback.id}/actions`, input = { requestId: 'start', version: 1, action: 'start' }
  const started = await request(path, manager.id, input)
  assert.equal(started.status, 200)
  const retry = await request(path, manager.id, input)
  assert.equal(retry.status, 200)
  const stale = await request(path, manager.id, { ...input, requestId: 'different' }, { 'X-Request-Id': 'spoofed-client' })
  assert.equal(stale.status, 409)
  const error = await stale.json() as { error: string; requestId: string }
  assert.ok(error.requestId); assert.notEqual(error.requestId, 'spoofed-client')
  assert.equal(error.requestId, stale.headers.get('x-request-id'))
  assert.match(error.error, /已更新/)
})

test('HTTP oversized bodies fail before mutation, malformed image bytes never persist, and upload needs a session', async t => {
  const { store, member, request } = await fixture(t)
  assert.equal((await request('/feedback', '', { requestId: 'anonymous', description: 'no session' })).status, 401)
  const huge = await request('/feedback', member.id, { requestId: 'too-large', description: 'oversized', padding: 'a'.repeat(9 * 1024 * 1024) })
  assert.equal(huge.status, 413)
  const damaged = await request('/feedback', member.id, { requestId: 'bad-image', description: '损坏图片', attachments: [{ name: 'bad.png', mimeType: 'image/png', dataBase64: Buffer.from('<script>bad</script>').toString('base64') }] })
  assert.equal(damaged.status, 400)
  assert.equal(store.list('feedback').length, 0)
  assert.equal(store.list('feedbackAttachments').length, 0)
})
