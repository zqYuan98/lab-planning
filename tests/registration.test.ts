import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { User } from '../shared/types.ts'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { buildReportSnapshot } from '../server/reports.ts'

const applicant = { name: '自主注册成员', email: 'person@example.test', position: '研发', password: '12345678' }
async function fixture() {
  const store = new Store(':memory:')
  const domain = new Domain(store)
  const server = createApp({ store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  async function request(path: string, body?: unknown, cookie = '', method = body === undefined ? 'GET' : 'POST', expected = 200, requestOrigin = origin) {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { 'content-type': 'application/json', origin: requestOrigin, cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
    const data = await response.json()
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`)
    return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '', response }
  }
  return { store, domain, request, close: async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close() } }
}

test('self-registration requires initialization, eight characters, same-origin JSON; never grants a session or privileges', async () => {
  const f = await fixture()
  try {
    await f.request('/auth/register', applicant, '', 'POST', 409)
    assert.equal(f.store.list('users').length, 0)
    await f.request('/auth/setup', { ...applicant, email: 'manager@example.test' }, '', 'POST', 201)
    await f.request('/auth/register', applicant, '', 'POST', 403, 'https://other.example')
    await f.request('/auth/register', { ...applicant, password: '1234567' }, '', 'POST', 400)
    const result = await f.request('/auth/register', { ...applicant, role: 'manager', active: true, registrationStatus: 'approved' }, '', 'POST', 202)
    assert.equal(result.cookie, '')
    assert.deepEqual(Object.keys(result.data), ['message'])
    const pending = f.store.list<StoredUser>('users').find(user => user.email === applicant.email)!
    assert.equal(pending.role, 'member')
    assert.equal(pending.active, false)
    assert.equal(pending.registrationStatus, 'pending')
    assert.equal(f.store.list('sessions').length, 1)
    await f.request('/auth/register', { ...applicant, email: 'PERSON@example.test', password: 'changed-password' }, '', 'POST', 409)
    assert.deepEqual(f.store.get('users', pending.id), pending)
    assert.equal(JSON.stringify(f.store.list('events')).includes('passwordHash'), false)
    assert.equal(JSON.stringify(f.store.list('events')).includes(applicant.password), false)
    await f.request('/bootstrap', undefined, '', 'GET', 401)
    await f.request('/auth/login', { ...applicant, password: 'incorrect' }, '', 'POST', 401)
    const blocked = await f.request('/auth/login', applicant, '', 'POST', 403)
    assert.match(blocked.data.error, /等待管理员审批/)
  } finally { await f.close() }
})

test('manager review lifecycle is versioned; ordinary members, account PATCH and review of approved accounts cannot bypass it', async () => {
  const f = await fixture()
  try {
    const lead = await f.request('/auth/setup', { ...applicant, email: 'manager@example.test' }, '', 'POST', 201)
    const legacy = f.domain.createUser(lead.data, { ...applicant, email: 'legacy@example.test', role: 'member' })
    const member = await f.request('/auth/login', { email: legacy.email, password: applicant.password })
    await f.request('/auth/register', applicant, '', 'POST', 202)
    let pending = f.store.list<User>('users').find(user => user.email === applicant.email)!
    const directory = await f.request('/bootstrap', undefined, member.cookie)
    assert.equal(directory.data.users.some((user: User) => user.id === pending.id), false)
    assert.equal(buildReportSnapshot(f.store, 'monthly', '2026-09').users.some(user => user.id === pending.id), false)
    const admin = await f.request('/bootstrap', undefined, lead.cookie)
    assert.equal(admin.data.users.find((user: User) => user.id === pending.id).registrationStatus, 'pending')
    const path = `/users/${pending.id}/registration-review`
    await f.request(path, { version: pending.version, decision: 'approve' }, member.cookie, 'POST', 403)
    await f.request(`/users/${pending.id}`, { version: pending.version, active: true, role: 'manager' }, lead.cookie, 'PATCH', 409)
    await f.request(path, { version: pending.version, decision: 'reject' }, lead.cookie, 'POST', 400)
    const rejected = await f.request(path, { version: pending.version, decision: 'reject', comment: '请先确认所属团队' }, lead.cookie)
    assert.equal(rejected.data.active, false)
    assert.equal(rejected.data.registrationStatus, 'rejected')
    await f.request('/auth/login', applicant, '', 'POST', 403)
    await f.request(path, { version: pending.version, decision: 'approve' }, lead.cookie, 'POST', 409)
    pending = rejected.data
    const approved = await f.request(path, { version: pending.version, decision: 'approve', role: 'manager' }, lead.cookie)
    assert.equal(approved.data.role, 'member')
    assert.equal(approved.data.active, true)
    const login = await f.request('/auth/login', applicant)
    assert.ok(login.cookie)
    await f.request('/bootstrap', undefined, login.cookie)
    await f.request(path, { version: approved.data.version, decision: 'reject', comment: '重复审核' }, lead.cookie, 'POST', 409)
    await f.request(`/users/${lead.data.id}/registration-review`, { version: lead.data.version, decision: 'approve' }, lead.cookie, 'POST', 409)
    assert.equal(f.store.get<User>('users', lead.data.id)!.role, 'manager')
    const reset = f.domain.updateUser(lead.data, legacy.id, { version: legacy.version, password: '87654321' })
    assert.equal(reset.active, true)
    await f.request('/auth/login', { email: legacy.email, password: '87654321' })
  } finally { await f.close() }
})

test('unapproved status blocks forged active sessions and assignments; failed audits roll back registration and review', async () => {
  const f = await fixture()
  try {
    const lead = f.domain.setup({ ...applicant, email: 'manager@example.test' })
    const originalInsert = f.store.insert.bind(f.store)
    const failAudit = () => { f.store.insert = ((collection: string, input: never) => { if (collection === 'events') throw new Error('audit unavailable'); return originalInsert(collection, input) }) as typeof f.store.insert }
    failAudit()
    assert.throws(() => f.domain.register(applicant), /audit unavailable/)
    f.store.insert = originalInsert
    assert.equal(f.store.list('users').length, 1)
    f.domain.register(applicant)
    let pending = f.store.list<StoredUser>('users').find(user => user.email === applicant.email)!
    failAudit()
    assert.throws(() => f.domain.reviewRegistration(lead, pending.id, { version: pending.version, decision: 'approve' }), /audit unavailable/)
    f.store.insert = originalInsert
    assert.deepEqual(f.store.get('users', pending.id), pending)
    pending = f.store.update<StoredUser>('users', pending.id, pending.version, { active: true })
    const token = createSession(f.store, pending)
    await f.request('/bootstrap', undefined, `lab_session=${token}`, 'GET', 401)
    assert.throws(() => f.domain.createProject(lead, { name: '分配测试', code: 'TEST', ownerId: pending.id }), /未通过注册审核/)
  } finally { await f.close() }
})

test('registration rate budget is separate from login and includes failed submissions', async () => {
  const f = await fixture()
  try {
    f.domain.setup({ ...applicant, email: 'manager@example.test' })
    for (let i = 0; i < 20; i++) await f.request('/auth/register', { ...applicant, password: '1234567' }, '', 'POST', 400)
    const limited = await f.request('/auth/register', applicant, '', 'POST', 429)
    assert.ok(Number(limited.response.headers.get('retry-after')) > 0)
    await f.request('/auth/login', { ...applicant, email: 'manager@example.test' })
    assert.equal(f.store.list('users').length, 1)
  } finally { await f.close() }
})
