import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'

test('API responses report server time and read cost; slow requests log identifiers only', async t => {
  process.env.SLOW_REQUEST_MS = '1'
  const store = new Store(':memory:'), server = createApp({ store }).listen(0, '127.0.0.1')
  delete process.env.SLOW_REQUEST_MS
  await once(server, 'listening')
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close() })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const setup = await fetch(`${origin}/api/auth/setup`, { method: 'POST', headers: { origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '计时管理者', email: 'manager@timing-test.example', password: 'test-password-2026' }) })
  assert.equal(setup.status, 201)
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]
  const originalWarn = console.warn, entries: string[] = []
  console.warn = (...values: unknown[]) => { entries.push(values.map(String).join(' ')) }
  try {
    const response = await fetch(`${origin}/api/workspace/projects?q=${encodeURIComponent('私密搜索词')}`, { headers: { cookie } })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('Server-Timing') ?? '', /^app;dur=\d+(\.\d)?, db;desc="sql=\d+ rows=\d+"$/)
    await response.arrayBuffer()
    await new Promise(resolve => setImmediate(resolve))
    const slow = entries.map(entry => JSON.parse(entry)).find(entry => entry.event === 'slow_request' && entry.route === '/api/workspace/projects')
    assert.ok(slow, 'slow request line is written')
    assert.equal(slow.requestId, response.headers.get('X-Request-Id'))
    assert.ok(slow.sql > 0)
    assert.ok(!entries.join('').includes('私密搜索词'))
    assert.ok(!entries.join('').includes(encodeURIComponent('私密搜索词')))
  } finally { console.warn = originalWarn }
})

test('slow request threshold rejects invalid configuration', () => {
  process.env.SLOW_REQUEST_MS = 'soon'
  try { assert.throws(() => createApp({ store: new Store(':memory:') }), /SLOW_REQUEST_MS/) }
  finally { delete process.env.SLOW_REQUEST_MS }
})
