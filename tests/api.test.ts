import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Bootstrap, Entity, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import type { StoredUser } from '../server/auth.ts'

async function serverFixture() {
  const store = new Store(':memory:')
  const server = createApp({ store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  function client() {
    let cookie = ''
    return {
      get cookie() { return cookie },
      async request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', status = 200): Promise<T> {
        const response = await fetch(`${origin}/api${path}`, { method, headers: { 'content-type': 'application/json', origin, cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
        const header = response.headers.get('set-cookie')
        if (header) cookie = header.split(';')[0]
        const data = await response.json()
        assert.equal(response.status >= 200 && response.status < 300 ? 200 : response.status, status, `${method} ${path}: ${JSON.stringify(data)}`)
        return data as T
      },
    }
  }
  const close = async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close() }
  return { store, origin, client, close }
}

test('first-manager setup and same-origin JSON guard; safe users and expiring revoked sessions', async () => {
  const f = await serverFixture()
  const manager = f.client(), member = f.client(), stranger = f.client()
  const password = 'Temporary-password-123!'
  try {
    assert.deepEqual(await stranger.request('/auth/status'), { initialized: false })
    const blocked = await fetch(`${f.origin}/api/auth/setup`, { method: 'POST', headers: { origin: 'https://attacker.example', 'content-type': 'application/json' }, body: JSON.stringify({ name: '恶意', email: 'attacker@example.test', password }) })
    assert.equal(blocked.status, 403)
    assert.equal(f.store.list('users').length, 0)
    const form = await fetch(`${f.origin}/api/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'name=attacker' })
    assert.equal(form.status, 415)
    const lead = await manager.request<User>('/auth/setup', { name: '部门负责人', email: 'MANAGER@example.test', password })
    assert.equal(lead.email, 'manager@example.test')
    assert.match(manager.cookie, /^lab_session=[a-f0-9]{64}$/)
    assert.equal('passwordHash' in lead, false)
    const internal = f.store.get<StoredUser>('users', lead.id)!
    assert.notEqual(internal.passwordHash, password)
    assert.match(internal.passwordHash, /^[a-f0-9]{32}:[a-f0-9]{128}$/)
    await stranger.request('/auth/setup', { name: '第二初始化', email: 'other@example.test', password }, 'POST', 409)
    await stranger.request('/workspace', undefined, 'GET', 401)
    let person = await manager.request<User>('/users', { name: '成员', email: 'member@example.test', password, position: '算法', role: 'member' })
    await member.request('/auth/login', { email: person.email, password: 'wrong-password' }, 'POST', 401)
    const login = await fetch(`${f.origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json', origin: f.origin }, body: JSON.stringify({ email: person.email, password }) })
    assert.equal(login.status, 200)
    assert.match(login.headers.get('set-cookie')!, /HttpOnly/)
    assert.match(login.headers.get('set-cookie')!, /SameSite=Strict/)
    await member.request('/auth/login', { email: person.email, password })
    const activeSession = f.store.list<Entity & { userId: string; expiresAt: string; revoked: boolean }>('sessions').filter(session => session.userId === person.id && !session.revoked).at(-1)!
    f.store.update<Entity & { expiresAt: string }>('sessions', activeSession.id, activeSession.version, { expiresAt: '2000-01-01T00:00:00.000Z' })
    await member.request('/auth/me', undefined, 'GET', 401)
    await member.request('/auth/login', { email: person.email, password })
    await member.request('/users', { name: '越权', email: 'bad@example.test', password, role: 'manager' }, 'POST', 403)
    await member.request('/reports', undefined, 'GET', 403)
    await member.request('/report-schedule', undefined, 'GET', 403)
    const data = await member.request<Bootstrap>('/workspace')
    assert.equal(JSON.stringify(data).includes('passwordHash'), false)
    assert.equal(JSON.stringify(f.store.list('events')).includes('passwordHash'), false)
    const oldCookie = member.cookie
    person = await manager.request<User>(`/users/${person.id}`, { version: person.version, password: 'Changed-password-123!' }, 'PATCH')
    await member.request('/auth/me', undefined, 'GET', 401)
    await member.request('/auth/login', { email: person.email, password: 'Changed-password-123!' })
    assert.notEqual(member.cookie, oldCookie)
    person = await manager.request<User>(`/users/${person.id}`, { version: person.version, active: false }, 'PATCH')
    await member.request('/workspace', undefined, 'GET', 401)
    person = await manager.request<User>(`/users/${person.id}`, { version: person.version, active: true }, 'PATCH')
    await member.request('/workspace', undefined, 'GET', 401)
    await member.request('/auth/login', { email: person.email, password: 'Changed-password-123!' })
    const logoutCookie = member.cookie
    await member.request('/auth/logout', {})
    await member.request('/workspace', undefined, 'GET', 401)
    const reuseRevokedCookie = await fetch(`${f.origin}/api/auth/me`, { headers: { cookie: logoutCookie } })
    assert.equal(reuseRevokedCookie.status, 401)
    const crossSite = await fetch(`${f.origin}/api/users`, { method: 'POST', headers: { cookie: manager.cookie, 'content-type': 'application/json', origin: 'https://attacker.example' }, body: JSON.stringify({ name: '越权', email: 'x@example.test', password, role: 'manager' }) })
    assert.equal(crossSite.status, 403)
  } finally { await f.close() }
})

test('server prevents ownership spoofing, temporary-work bypass and snapshot relabeling', async () => {
  const f = await serverFixture()
  const manager = f.client(), member = f.client(), other = f.client()
  const password = 'Temporary-password-123!'
  try {
    await manager.request('/auth/setup', { name: '经理', email: 'manager@example.test', password })
    const person = await manager.request<User>('/users', { name: '成员', email: 'member@example.test', password, role: 'member' })
    const outsider = await manager.request<User>('/users', { name: '另一成员', email: 'other@example.test', password, role: 'member' })
    await member.request('/auth/login', { email: person.email, password })
    await other.request('/auth/login', { email: outsider.email, password })
    const input = { month: '2026-09', title: '研发成果', category: '研发', expectedOutcome: '验证报告', acceptanceCriteria: '评测通过', dueDate: '2026-09-30' }
    await member.request('/plans', { ...input, ownerId: outsider.id }, 'POST', 403)
    const plan = await manager.request<MonthlyPlan>('/plans', { ...input, ownerId: person.id, status: 'published', acceptanceStatus: 'accepted' })
    assert.equal(plan.status, 'draft')
    assert.equal(plan.acceptanceStatus, 'pending')
    await other.request(`/plans/${plan.id}/history`, undefined, 'GET', 403)
    await member.request('/tasks', { title: '伪造临时标记', monthlyPlanId: plan.id, isTemporary: true, temporaryReason: '绕过发布', dueDate: plan.dueDate }, 'POST', 400)
    await member.request('/tasks', { title: '缺失原因', isTemporary: true, dueDate: plan.dueDate }, 'POST', 400)
    const task = await member.request<Task>('/tasks', { title: '正式任务', monthlyPlanId: plan.id, dueDate: plan.dueDate })
    await other.request(`/tasks/${task.id}`, { version: task.version, title: '越权' }, 'PATCH', 403)
    await member.request(`/tasks/${task.id}`, { version: task.version, ownerId: outsider.id }, 'PATCH', 400)
    await member.request('/weekly-records', { taskId: task.id, weekStart: '2026-09-07', commitment: '计划外强制提交', submitted: true }, 'POST', 400)
    let weekly = await member.request<WeeklyRecord>('/weekly-records', { taskId: task.id, weekStart: '2026-09-07', commitment: '先拟草稿' })
    await other.request(`/weekly-records/${weekly.id}`, { version: weekly.version, actualOutcome: '越权' }, 'PATCH', 403)
    await member.request(`/weekly-records/${weekly.id}`, { version: weekly.version, weekStart: '2026-09-14' }, 'PATCH', 400)
    await member.request(`/weekly-records/${weekly.id}`, { version: weekly.version, status: 'done' }, 'PATCH', 400)
    await member.request(`/weekly-records/${weekly.id}`, { version: weekly.version, status: 'blocked' }, 'PATCH', 400)
    await member.request(`/weekly-records/${weekly.id}`, { version: weekly.version, evidenceUrl: 'javascript:alert(1)' }, 'PATCH', 400)
    weekly = await member.request<WeeklyRecord>(`/weekly-records/${weekly.id}`, { version: weekly.version, status: 'doing' }, 'PATCH')
    await member.request(`/weekly-records/${weekly.id}`, { version: weekly.version - 1, actualOutcome: '旧版本覆盖' }, 'PATCH', 409)
    const temp = await member.request<Task>('/tasks', { title: '紧急支持', isTemporary: true, temporaryReason: '故障排查', dueDate: plan.dueDate })
    const tempRecord = await member.request<WeeklyRecord>('/weekly-records', { taskId: temp.id, weekStart: '2026-09-07', commitment: '恢复服务', submitted: true })
    assert.equal(tempRecord.monthlyPlanId, null)
    assert.equal(tempRecord.submitted, true)
  } finally { await f.close() }
})
