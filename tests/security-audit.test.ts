import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createHash } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import type { Entity, User } from '../shared/types.ts'
import { createApp } from '../server/app.ts'
import { Domain } from '../server/domain.ts'
import { Store } from '../server/store.ts'

const password = 'Audit-only-password-2026!'
const credentials = { name: '审查负责人', email: 'manager@audit.example', password }
function environment(values: Record<string, string | undefined>) {
  const previous = new Map(Object.keys(values).map(key => [key, process.env[key]]))
  for (const [key, value] of Object.entries(values)) value === undefined ? delete process.env[key] : process.env[key] = value
  return () => { for (const [key, value] of previous) value === undefined ? delete process.env[key] : process.env[key] = value }
}
async function fixture(env: Record<string, string | undefined> = {}) {
  const restore = environment({ NODE_ENV: 'test', APP_ORIGIN: undefined, COOKIE_SECURE: undefined, TRUST_PROXY: undefined, ...env })
  const store = new Store(':memory:')
  const app = createApp({ store })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> => {
    const options = { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', origin, ...headers } }
    const serialized = body === undefined ? undefined : JSON.stringify(body)
    // fetch overrides Host; use the HTTP transport to exercise actual DNS-rebinding requests.
    if (headers.host) return new Promise((done, reject) => {
      const request = httpRequest(`${origin}/api${path}`, options, response => {
        const chunks: Buffer[] = []
        response.on('data', chunk => chunks.push(Buffer.from(chunk)))
        response.on('end', () => done(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: new Headers(response.headers as Record<string, string>) })))
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end(serialized)
    })
    return fetch(`${origin}/api${path}`, { ...options, body: serialized })
  }
  const setup = async () => {
    const response = await request('/auth/setup', credentials)
    assert.equal(response.status, 201)
    return { user: await response.json() as User, cookie: response.headers.get('set-cookie')!.split(';')[0] }
  }
  const close = async () => { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); store.close(); restore() }
  return { app, store, origin, request, setup, close }
}

test('unconfigured local service rejects an attacker-controlled Host/Origin during first setup', async () => {
  const f = await fixture()
  try {
    const response = await f.request('/auth/setup', credentials, { host: 'attacker.example', origin: 'http://attacker.example' })
    assert.equal(response.status, 403)
    assert.equal(f.store.list('users').length, 0)
    const status = await f.request('/auth/status', undefined, { host: 'attacker.example', origin: 'http://attacker.example' })
    assert.equal(status.status, 403)
    await f.setup()
  } finally { await f.close() }
})

test('configured canonical origin rejects reflected hosts while supporting a rewriting proxy and secure cookies', async () => {
  const f = await fixture({ NODE_ENV: 'production', APP_ORIGIN: 'https://lab.example' })
  try {
    const attack = await f.request('/auth/setup', credentials, { host: 'evil.example', origin: 'http://evil.example' })
    assert.equal(attack.status, 403)
    const response = await f.request('/auth/setup', credentials, { origin: 'https://lab.example' })
    assert.equal(response.status, 201)
    assert.match(response.headers.get('set-cookie')!, /; Secure/)
    assert.match(response.headers.get('set-cookie')!, /HttpOnly/)
    const mismatch = await f.request('/auth/login', credentials, { origin: f.origin })
    assert.equal(mismatch.status, 403)
  } finally { await f.close() }
})

test('successful member login cannot clear the source budget for repeated manager password guesses', async () => {
  const f = await fixture()
  try {
    const { user } = await f.setup()
    const member = new Domain(f.store).createUser(user, { name: '审查成员', email: 'member@audit.example', password, position: '', role: 'member' })
    for (let i = 0; i < 10; i++) assert.equal((await f.request('/auth/login', { email: credentials.email, password: 'wrong-password' })).status, 401)
    assert.equal((await f.request('/auth/login', { email: member.email, password })).status, 200)
    for (let i = 0; i < 10; i++) assert.equal((await f.request('/auth/login', { email: credentials.email, password: 'wrong-password' })).status, 401)
    const denied = await f.request('/auth/login', { email: credentials.email, password: 'wrong-password' })
    assert.equal(denied.status, 429)
    assert.ok(Number(denied.headers.get('retry-after')) > 0)
  } finally { await f.close() }
})

test('only explicitly trusted proxy addresses split login budgets by forwarded client IP', async () => {
  const trusted = await fixture({ TRUST_PROXY: 'loopback' })
  try {
    await trusted.setup()
    for (let i = 0; i < 20; i++) assert.equal((await trusted.request('/auth/login', { email: credentials.email, password: 'wrong-password' }, { 'x-forwarded-for': '198.51.100.21' })).status, 401)
    assert.equal((await trusted.request('/auth/login', credentials, { 'x-forwarded-for': '198.51.100.22' })).status, 200)
  } finally { await trusted.close() }
  const untrusted = await fixture({ TRUST_PROXY: '192.0.2.0/24' })
  try {
    await untrusted.setup()
    for (let i = 0; i < 20; i++) assert.equal((await untrusted.request('/auth/login', { email: credentials.email, password: 'wrong-password' }, { 'x-forwarded-for': `198.51.100.${i + 1}` })).status, 401)
    assert.equal((await untrusted.request('/auth/login', credentials, { 'x-forwarded-for': '203.0.113.100' })).status, 429)
  } finally { await untrusted.close() }
})

test('unsafe proxy and malformed canonical origin configuration fail before serving requests', () => {
  for (const values of [{ TRUST_PROXY: 'true' }, { TRUST_PROXY: '1' }, { TRUST_PROXY: '0.0.0.0/0' }, { APP_ORIGIN: 'https://lab.example/private' }, { APP_ORIGIN: 'https://user:password@lab.example' }]) {
    const restore = environment({ APP_ORIGIN: undefined, TRUST_PROXY: undefined, ...values })
    const store = new Store(':memory:')
    try { assert.throws(() => createApp({ store }), /TRUST_PROXY|APP_ORIGIN/) }
    finally { store.close(); restore() }
  }
})

test('failed session persistence rolls back setup and leaves an existing login session usable', async () => {
  const f = await fixture()
  const insert = f.store.insert.bind(f.store)
  const rejectSessions = () => { f.store.insert = ((collection: string, input: never) => {
    if (collection === 'sessions') throw new Error('audit simulated storage failure')
    return insert(collection, input)
  }) as Store['insert'] }
  try {
    rejectSessions()
    assert.equal((await f.request('/auth/setup', credentials)).status, 500)
    assert.equal(f.store.list('users').length, 0)
    assert.equal(f.store.list('events').length, 0)
    f.store.insert = insert
    const { cookie } = await f.setup()
    rejectSessions()
    assert.equal((await f.request('/auth/login', credentials, { cookie })).status, 500)
    assert.equal((await f.request('/auth/me', undefined, { cookie })).status, 200)
  } finally { f.store.insert = insert; await f.close() }
})

test('malformed JSON never reflects request secrets and invalid persisted expiry fails closed', async () => {
  const f = await fixture()
  try {
    const marker = 'AUDITSECRET'
    const invalid = await fetch(`${f.origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: f.origin }, body: marker })
    assert.equal(invalid.status, 400)
    assert.ok(!(await invalid.text()).includes(marker))
    const { cookie } = await f.setup()
    const id = createHash('sha256').update(cookie.slice('lab_session='.length)).digest('hex')
    const session = f.store.get<Entity & { expiresAt: string }>('sessions', id)!
    f.store.update<Entity & { expiresAt: string }>('sessions', id, session.version, { expiresAt: 'not-a-date' })
    assert.equal((await f.request('/auth/me', undefined, { cookie })).status, 401)
  } finally { await f.close() }
})

test('rejected asynchronous transaction continuations cannot escape the rollback', async () => {
  const store = new Store(':memory:')
  let continuation: Promise<unknown> | undefined
  try {
    assert.throws(() => store.transaction(() => {
      store.insert('settings', { id: 'inside' })
      continuation = Promise.resolve().then(() => store.insert('settings', { id: 'escaped' }))
      return continuation
    }), /synchronous/)
    assert.equal(store.get('settings', 'inside'), undefined)
    await assert.rejects(continuation!, /transaction.*ended/i)
    assert.equal(store.get('settings', 'escaped'), undefined)
    const fresh = store.transaction(() => store.insert('settings', { id: 'fresh' }))
    assert.equal(fresh.id, 'fresh')
  } finally { store.close() }
})

test('SQLite lock failures preserve the real retryable error and do not corrupt transaction depth', () => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-security-audit-'))
  const path = join(directory, 'isolated.sqlite')
  const store = new Store(path)
  const database = (store as unknown as { db: DatabaseSync }).db
  const lock = new DatabaseSync(path)
  try {
    database.exec('PRAGMA busy_timeout=1')
    lock.exec('BEGIN IMMEDIATE')
    assert.throws(() => store.transaction(() => store.insert('settings', { id: 'locked' })), { status: 503 })
    lock.exec('ROLLBACK')
    assert.equal(store.get('settings', 'locked'), undefined)
    assert.equal(store.transaction(() => store.insert('settings', { id: 'after-lock' })).id, 'after-lock')
  } finally {
    if (lock.isTransaction) lock.exec('ROLLBACK')
    lock.close(); store.close()
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()))
    assert.ok(basename(directory).startsWith('lab-security-audit-'))
    rmSync(directory, { recursive: true, force: true })
  }
})
