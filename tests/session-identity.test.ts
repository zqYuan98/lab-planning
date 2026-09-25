import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { api, ApiError, json } from '../src/api.ts'
import { bindSessionActor, sessionActor, subscribeSessionIdentityChanges } from '../src/session-identity.ts'
import { advanceMutationContext, captureMutationContext, MutationContextChangedError } from '../src/mutation-response.ts'
import { workspaceQueryReader } from '../src/workspace-query-state.ts'
import type { WorkspacePage, WorkspaceShellData } from '../shared/workspace-query.ts'
import type { MonthlyWorkspace } from '../shared/period-workspace.ts'
import type { MonthlyPlan, Task } from '../shared/types.ts'

test('a shared-cookie account switch rejects old-tab reads and writes, resets context, and allows fresh identity discovery', async t => {
  const store = new Store(':memory:'), domain = new Domain(store)
  const user = (id: string, role: StoredUser['role'] = 'member') => store.insert<StoredUser>('users', { id, role, name: id, email: `${id}@identity.test`, active: true, position: '', credentialVersion: 1, passwordHash: 'unused' })
  const former = user('former'), next = user('next'), manager = user('manager', 'manager')
  const task = (owner: StoredUser) => store.insert<Task>('tasks', { ownerId: owner.id, title: `${owner.id}-private`, monthlyPlanId: null, description: '', dueDate: '', status: 'doing', isTemporary: true, temporaryReason: 'test' })
  const oldTask = task(former), newTask = task(next)
  const server = createApp({ store }).listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const cookies = new Map([former, next, manager].map(actor => [actor.id, `lab_session=${createSession(store, actor)}`]))
  const fetchHttp = globalThis.fetch
  let browserCookie = cookies.get(former.id)!, requests = 0, resets = 0
  // Each request reads the shared cookie, just as two tabs in one browser profile do.
  globalThis.fetch = (input, init) => { requests++; return fetchHttp(`${origin}${input}`, { ...init, headers: { ...init?.headers, cookie: browserCookie, origin } }) }
  const stop = subscribeSessionIdentityChanges(() => { resets++ })
  let cached: WorkspacePage<Task> | null = null
  const reader = workspaceQueryReader<WorkspacePage<Task>>({ load: signal => api('/workspace/tasks', { signal }), accept: value => { cached = value }, clear: () => { cached = null }, error() {}, loading() {} })
  t.after(async () => { reader.dispose(); stop(); globalThis.fetch = fetchHttp; bindSessionActor(null); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close() })
  bindSessionActor(former.id)
  await reader.read(); assert.deepEqual(cached!.items.map(row => row.id), [oldTask.id])
  const context = captureMutationContext()
  browserCookie = cookies.get(next.id)!
  await assert.rejects(reader.revalidate(), MutationContextChangedError)
  assert.equal(cached, null)
  assert.ok(captureMutationContext() > context)
  assert.equal(resets, 1)
  assert.equal(sessionActor().blocked, true)
  const readCount = requests
  await assert.rejects(api(`/tasks/${newTask.id}`, json({ version: newTask.version, title: 'wrong identity write' }, 'PATCH')), MutationContextChangedError)
  await reader.revalidate(); assert.equal(requests, readCount, 'retired readers and writes stay blocked during the identity transition')
  const rejectedWrite = await fetchHttp(`${origin}/api/tasks/${newTask.id}`, { method: 'PATCH', headers: { cookie: browserCookie, origin, 'Content-Type': 'application/json', 'X-Lab-Actor-Id': former.id }, body: JSON.stringify({ version: newTask.version, title: 'must not save' }) })
  assert.equal(rejectedWrite.status, 409)
  assert.equal((await rejectedWrite.json() as { code: string }).code, 'SESSION_IDENTITY_CHANGED')
  assert.equal(store.get<Task>('tasks', newTask.id)?.title, newTask.title)
  const me = await api<StoredUser>('/auth/me'), shell = await api<WorkspaceShellData>('/workspace')
  assert.equal(me.id, next.id); assert.equal(shell.user.id, next.id)
  bindSessionActor(shell.user.id)
  const fresh = await api<WorkspacePage<Task>>('/workspace/tasks')
  assert.deepEqual(fresh.items.map(row => row.id), [newTask.id])
  assert.equal((await fetchHttp(`${origin}/api/workspace/tasks`, { headers: { cookie: browserCookie } })).status, 200, 'existing clients without actor headers remain compatible')

  let plan = domain.createPlan(manager, { month: '2026-09', ownerId: former.id, collaboratorIds: [], title: '移交目标', category: '研发', expectedOutcome: '交付', acceptanceCriteria: '通过', dueDate: '2026-09-30' })
  plan = domain.submitPlan(manager, plan.id, { version: plan.version })
  plan = domain.reviewPlan(manager, plan.id, { version: plan.version, decision: 'approve' })
  domain.publishMonth(manager, plan.month, { planIds: [plan.id] }); plan = store.get<MonthlyPlan>('plans', plan.id)!
  const stableContext = captureMutationContext()
  assert.equal((await api<MonthlyWorkspace>('/workspace/monthly?month=2026-09')).total, 0)
  domain.updatePlan(manager, plan.id, { version: plan.version, ownerId: next.id, reason: '负责人移交' })
  assert.equal((await api<MonthlyWorkspace>('/workspace/monthly?month=2026-09')).items[0].id, plan.id)
  assert.equal(captureMutationContext(), stableContext, 'normal owner/scope changes keep the same identity and mounted drafts')
  assert.equal(resets, 1)
})

test('a late identity mismatch from a retired context cannot reset a newly confirmed account', async t => {
  const fetchHttp = globalThis.fetch
  let resolve!: (response: Response) => void
  globalThis.fetch = () => new Promise<Response>(done => { resolve = done })
  t.after(() => { globalThis.fetch = fetchHttp; bindSessionActor(null) })
  let resets = 0
  const stop = subscribeSessionIdentityChanges(() => { resets++ }); t.after(stop)
  bindSessionActor('old-actor')
  const pending = api('/workspace/monthly?month=2026-09')
  advanceMutationContext(); bindSessionActor('new-actor')
  const current = captureMutationContext()
  resolve(new Response(JSON.stringify({ error: 'changed', code: 'SESSION_IDENTITY_CHANGED' }), { status: 409 }))
  await assert.rejects(pending, error => error instanceof ApiError && error.code === 'SESSION_IDENTITY_CHANGED')
  assert.equal(captureMutationContext(), current)
  assert.deepEqual(sessionActor(), { actorId: 'new-actor', blocked: false })
  assert.equal(resets, 0)
})
