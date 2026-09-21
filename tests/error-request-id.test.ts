import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'

test('API validation and server failures share generated response/log identifiers without logging secrets', async t => {
  const store = new Store(':memory:'), server = createApp({ store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close() })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const unauthenticated = await fetch(`${origin}/api/bootstrap`, { headers: { 'X-Request-Id': 'attacker-controlled' } })
  assert.equal(unauthenticated.status, 401)
  const denied = await unauthenticated.json() as { requestId: string }
  assert.match(denied.requestId, /^[a-f0-9-]{36}$/)
  assert.equal(denied.requestId, unauthenticated.headers.get('X-Request-Id'))
  const setup = await fetch(`${origin}/api/auth/setup`, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '测试管理者', email: 'manager@error-test.example', password: 'test-password-2026' }) })
  assert.equal(setup.status, 201)
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]
  const original = store.list.bind(store), originalError = console.error, entries: string[] = []
  store.list = (collection: string) => { if (collection === 'projects') throw new Error('private-message\nsecret-auth-value\n    at private-token (fake.ts:1:1)'); return original(collection) }
  console.error = (...values: unknown[]) => { entries.push(values.map(String).join(' ')) }
  try {
    const response = await fetch(`${origin}/api/bootstrap?token=private-token`, { headers: { cookie } })
    assert.equal(response.status, 500)
    const body = await response.json() as { error: string; requestId: string }
    assert.equal(body.requestId, response.headers.get('X-Request-Id'))
    assert.ok(entries.some(entry => entry.includes(body.requestId)))
    assert.ok(!entries.join('').includes('secret-auth-value'))
    assert.ok(!entries.join('').includes('private-message'))
    assert.ok(!entries.join('').includes('private-token'))
    assert.ok(!body.error.includes('secret-auth-value'))
  } finally { store.list = original; console.error = originalError }
})
