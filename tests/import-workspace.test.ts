import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { MonthlyPlan, Publication, Task, User } from '../shared/types.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { ImportWorkspaceService } from '../server/import-workspace.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), service = new ImportWorkspaceService(store)
  t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.insert<StoredUser>('users', { passwordHash: '', credentialVersion: 1, id, role, name: id, email: `${id}@import-query.invalid`, active: true, position: '' })
  const manager = user('manager', 'manager'), member = user('member', 'member'), peer = user('peer', 'member'), observer = user('observer', 'observer')
  const task = domain.createTask(member, { title: "literal%'_ task", dueDate: '2026-09-30', isTemporary: true, temporaryReason: '本人事项' })
  for (let index = 0; index < 125; index++) store.restoreEntity<Task>('tasks', { ...task, id: `candidate-${index}`, title: `候选 ${index}` })
  const secret = domain.createTask(peer, { title: 'peer-private', dueDate: '2026-09-30', isTemporary: true, temporaryReason: '同事私有' })
  return { store, domain, service, manager, member, peer, observer, task, secret }
}

test('import task candidates page the entire authorized range and preserve literal searches and selected tail references', t => {
  const f = fixture(t), all: string[] = []
  let cursor: string | null = null
  do {
    const page = f.service.candidates(f.member, { kind: 'tasks', limit: 50, ...(cursor ? { cursor } : {}) })
    assert.equal(page.total, 126); assert.ok(page.items.length <= 50)
    all.push(...page.items.map(row => row.id)); cursor = page.nextCursor
  } while (cursor)
  assert.equal(new Set(all).size, 126)
  assert.deepEqual(f.service.candidates(f.member, { kind: 'tasks', q: "%'_" }).items.map(row => row.id), [f.task.id])
  assert.equal(f.service.candidates(f.member, { kind: 'tasks', ownerId: f.peer.id }).total, 0)
  const refs = f.service.references(f.member, { tasks: [f.task.id, f.secret.id], users: [f.member.id] })
  assert.deepEqual(refs.tasks.map(row => row.id), [f.task.id])
  assert.equal(JSON.stringify(refs).includes('peer-private'), false)
  assert.deepEqual(refs.users.map(row => row.id), [f.member.id])
  assert.throws(() => f.service.references(f.member, { tasks: Array(101).fill(f.task.id) }), { status: 400 })
  assert.throws(() => f.service.candidates(f.observer, { kind: 'tasks' }), { status: 403 })
  assert.throws(() => f.service.candidates(f.member, { kind: "tasks' OR 1=1" }), { status: 400 })
})

test('import selection preserves explicit retired references but candidates exclude historical projections and cancelled tasks', t => {
  const f = fixture(t)
  const project = f.domain.createProject(f.manager, { name: '引用项目', code: 'REF', ownerId: f.member.id, description: '' })
  const plan = f.domain.createPlan(f.manager, { ownerId: f.member.id, projectId: project.id, category: '测试', month: '2026-09', title: '现行目标', expectedOutcome: '成果', acceptanceCriteria: '标准', dueDate: '2026-09-30' })
  f.store.restoreEntity<MonthlyPlan>('plans', { ...plan, id: 'historical-plan', visibility: 'historical' })
  f.store.restoreEntity<MonthlyPlan>('plans', { ...plan, id: 'reference-plan', visibility: 'reference' })
  f.store.update<Task>('tasks', f.task.id, f.task.version, { cancellation: { cancelledAt: f.task.updatedAt, cancelledBy: f.manager.id, reason: '撤销' } })
  assert.deepEqual(f.service.candidates(f.member, { kind: 'plans' }).items.map(row => row.id), [plan.id])
  assert.equal(f.service.candidates(f.member, { kind: 'tasks' }).items.some(row => row.id === f.task.id), false)
  const refs = f.service.references(f.member, { plans: [plan.id], tasks: [f.task.id] })
  assert.equal(refs.tasks[0].id, f.task.id); assert.ok(refs.tasks[0].cancellation)
  assert.deepEqual(refs.users.map(row => row.id), [f.member.id]); assert.deepEqual(refs.projects.map(row => row.id), [project.id])
})

test('import references preserve historical participation without exposing the current private goal or unrelated publication bodies', t => {
  const f = fixture(t)
  const plan = f.domain.createPlan(f.manager, { ownerId: f.member.id, category: '测试', month: '2026-09', title: '原参与目标', expectedOutcome: '原成果', acceptanceCriteria: '原标准', dueDate: '2026-09-30' })
  f.store.insert<Publication>('publications', { month: plan.month, revision: 1, actorId: f.manager.id, reason: 'secret note', plans: [plan] })
  f.store.update<MonthlyPlan>('plans', plan.id, plan.version, { ownerId: f.peer.id, title: 'private-current', expectedOutcome: 'PRIVATE_RESULT' })
  for (let i = 0; i < 100; i++) f.store.insert<Publication>('publications', { month: '2025-01', revision: i + 1, actorId: f.manager.id, reason: 'unrelated', plans: [{ ...plan, id: `unrelated-${i}`, ownerId: f.peer.id, expectedOutcome: 'x'.repeat(5000) }] })
  f.store.resetReadMetrics()
  const refs = f.service.references(f.member, { plans: [plan.id] })
  assert.equal(refs.plans[0].title, '原参与目标'); assert.equal(refs.plans[0].visibility, 'historical')
  assert.equal(JSON.stringify(refs).includes('PRIVATE_RESULT'), false)
  assert.ok(f.store.getReadMetrics().parsedBytes < 15000, JSON.stringify(f.store.getReadMetrics()))
})

test('the retired full-data route is absent while shell and paged import queries remain authenticated', async t => {
  const f = fixture(t), server = createApp({ store: f.store, enableScheduler: false }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, headers = { cookie: `lab_session=${createSession(f.store, f.member)}` }
  assert.equal('bootstrap' in Domain.prototype, false)
  assert.equal((await fetch(`${origin}/api/bootstrap`, { headers })).status, 404)
  const shell = await (await fetch(`${origin}/api/workspace`, { headers })).json() as Record<string, unknown>
  for (const name of ['tasks', 'plans', 'weeklyRecords', 'users', 'projects', 'reports']) assert.equal(name in shell, false)
  const response = await fetch(`${origin}/api/workspace/import-candidates?kind=tasks&limit=50`, { headers })
  assert.equal(response.status, 200)
  const page = await response.json() as { total: number; items: Task[] }
  assert.equal(page.total, 126); assert.equal(page.items.length, 50)
  assert.equal((await fetch(`${origin}/api/workspace/import-candidates?kind=tasks`)).status, 401)
})
