import test from 'node:test'
import assert from 'node:assert/strict'
import { createUsageAnalyticsClient, createUsageSettingsReader, usageRequest } from '../src/usage-analytics.ts'
import { finishSaved, SavedResultError } from '../src/api.ts'
import { advanceMutationContext, MutationContextChangedError, subscribeMutationResponses } from '../src/mutation-response.ts'

test('client only posts enabled member pages with closed fields and does not trigger business refresh', async t => {
  const original = globalThis.fetch, calls: Array<{ path: string; body: unknown }> = [], writes: string[] = []
  const unsubscribe = subscribeMutationResponses(event => writes.push(event.path))
  let enabled = false
  globalThis.fetch = async (input, init) => {
    assert.equal(init?.credentials, 'same-origin')
    calls.push({ path: String(input), body: init?.body ? JSON.parse(String(init.body)) : null })
    return String(input).endsWith('/status') ? new Response(JSON.stringify({ enabled, version: 'r2' })) : new Response(null, { status: 204 })
  }
  t.after(() => { globalThis.fetch = original; unsubscribe() })
  const client = createUsageAnalyticsClient({ id: 'alice', role: 'member' }, usageRequest, 'r2')
  await client.visit('work-register')
  assert.equal(calls.filter(call => call.body).length, 0)
  enabled = true
  await client.visit('work-register'); await client.visit('work-register'); await client.visit('monthly')
  await client.visit('/tasks?body=secret'); await client.visit('notification-settings')
  assert.deepEqual(calls.filter(call => call.body).map(call => call.body), [
    { page: 'work-register', version: 'r2', userId: 'alice' }, { page: 'monthly', version: 'r2', userId: 'alice' },
  ])
  assert.deepEqual(writes, [])
  client.dispose()
  const before = calls.length
  await createUsageAnalyticsClient({ id: 'manager', role: 'manager' }).visit('overview')
  await createUsageAnalyticsClient({ id: 'observer', role: 'observer' }).visit('authorized-work')
  assert.equal(calls.length, before)
})

test('late policy, identity switches, and disposal cannot send a page for the next account', async t => {
  const original = globalThis.fetch, bodies: unknown[] = []
  let release!: (response: Response) => void
  globalThis.fetch = async (_input, init) => {
    if (init?.body) { bodies.push(JSON.parse(String(init.body))); return new Response(null, { status: 204 }) }
    return new Promise<Response>(resolve => { release = resolve })
  }
  t.after(() => { globalThis.fetch = original })
  const old = createUsageAnalyticsClient({ id: 'alice', role: 'member' }, usageRequest, 'r2')
  const pending = old.visit('work-register')
  advanceMutationContext()
  release(new Response(JSON.stringify({ enabled: true, version: 'r2' })))
  await pending
  assert.deepEqual(bodies, [])
  await old.visit('monthly')
  const fresh = createUsageAnalyticsClient({ id: 'bob', role: 'member' }, usageRequest, 'r2')
  const freshPending = fresh.visit('monthly')
  release(new Response(JSON.stringify({ enabled: true, version: 'r2' })))
  await freshPending
  assert.deepEqual(bodies, [{ page: 'monthly', version: 'r2', userId: 'bob' }])
  const disposed = fresh.visit('weekly'); fresh.dispose()
  release(new Response(JSON.stringify({ enabled: true, version: 'r2' })))
  await disposed
  assert.equal(bodies.length, 1)
})

test('dedicated transport rejects stale aggregate responses without publishing a mutation', async t => {
  const original = globalThis.fetch, writes: string[] = [], unsubscribe = subscribeMutationResponses(event => writes.push(event.path))
  t.after(() => { globalThis.fetch = original; unsubscribe() })
  globalThis.fetch = async () => { advanceMutationContext(); return new Response(JSON.stringify({ enabled: true })) }
  await assert.rejects(usageRequest('/settings', { method: 'PUT', body: '{}' }), MutationContextChangedError)
  assert.deepEqual(writes, [])
  await assert.rejects(usageRequest('/arbitrary?body=secret'))
})

test('old client release cannot be attributed to the next deployment', async t => {
  const original = globalThis.fetch, bodies: string[] = []
  globalThis.fetch = async (_input, init) => { if (init?.body) bodies.push(String(init.body)); return new Response(JSON.stringify({ enabled: true, version: 'new-release' })) }
  t.after(() => { globalThis.fetch = original })
  await createUsageAnalyticsClient({ id: 'alice', role: 'member' }, usageRequest, 'old-release').visit('work-register')
  assert.deepEqual(bodies, [])
})

test('settings reads ignore reordered and disposed results; saved read retry never repeats PUT', async t => {
  const original = globalThis.fetch, releases: Array<(response: Response) => void> = [], accepted: number[] = []
  globalThis.fetch = async () => new Promise<Response>(resolve => releases.push(resolve))
  t.after(() => { globalThis.fetch = original })
  const reader = createUsageSettingsReader(28, value => accepted.push(value.settings.settings.version), () => {})
  const first = reader.read(), second = reader.read()
  releases[2](new Response(JSON.stringify({ settings: { version: 2 } }))); releases[3](new Response('{}'))
  await second; await first
  releases[0](new Response(JSON.stringify({ settings: { version: 1 } }))); releases[1](new Response('{}'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(accepted, [2])
  const late = reader.read(); reader.dispose()
  releases[4](new Response(JSON.stringify({ settings: { version: 3 } }))); releases[5](new Response('{}'))
  await assert.rejects(late, MutationContextChangedError)
  assert.deepEqual(accepted, [2])
  let puts = 0, reads = 0
  globalThis.fetch = async (_input, init) => {
    if (init?.method === 'PUT') { puts++; return new Response(JSON.stringify({ settings: { version: 4 } })) }
    reads++; return reads === 1 ? new Response('{"error":"offline"}', { status: 503 }) : new Response('{}')
  }
  await usageRequest('/settings', { method: 'PUT', body: '{}' })
  let saved: SavedResultError | undefined
  try { await finishSaved(async () => { await usageRequest('/summary') }, 4) } catch (error) { assert.ok(error instanceof SavedResultError); saved = error }
  assert.equal(saved!.savedVersion, 4); await saved!.retry(); assert.equal(puts, 1); assert.equal(reads, 2)
})
