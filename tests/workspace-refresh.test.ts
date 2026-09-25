import test from 'node:test'
import assert from 'node:assert/strict'
import { createWorkspaceRefreshSource, WORKSPACE_REFRESH_INTERVAL_MS } from '../src/workspace-refresh.ts'
import { workspaceQueryReader } from '../src/workspace-query-state.ts'
import { ApiError } from '../src/api.ts'
import { advanceMutationContext, captureMutationContext, publishMutationResponse } from '../src/mutation-response.ts'
import { Store, HttpError } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { PeriodWorkspaceService } from '../server/period-workspace.ts'
import type { MonthlyWorkspace } from '../shared/period-workspace.ts'
import type { MonthlyPlan, User } from '../shared/types.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function browserEnvironment() {
  const window = new EventTarget(), document = new EventTarget(), timers = new Map<number, () => void>()
  let visible = true, online = true, now = 0, nextTimer = 0
  const source = createWorkspaceRefreshSource({
    window, document, visible: () => visible, online: () => online, now: () => now,
    setInterval: (callback, interval) => { assert.equal(interval, WORKSPACE_REFRESH_INTERVAL_MS); const timer = ++nextTimer; timers.set(timer, callback); return timer },
    clearInterval: timer => { timers.delete(timer as number) },
  })
  return {
    source, timers,
    focus: () => window.dispatchEvent(new Event('focus')),
    visibility: (value: boolean) => { visible = value; document.dispatchEvent(new Event('visibilitychange')) },
    connection: (value: boolean) => { online = value; window.dispatchEvent(new Event(value ? 'online' : 'offline')) },
    elapse: (milliseconds = WORKSPACE_REFRESH_INTERVAL_MS) => { now += milliseconds; for (const callback of [...timers.values()]) callback() },
  }
}

test('mounted queries share a bounded timer, coalesce focus/visibility, pause hidden/offline and unsubscribe completely', () => {
  const browser = browserEnvironment()
  let first = 0, second = 0
  const stopFirst = browser.source.subscribe(() => { first++ }), stopSecond = browser.source.subscribe(() => { second++ })
  assert.equal(browser.timers.size, 1)
  assert.deepEqual([first, second], [0, 0], 'subscription does not duplicate each page initial read')
  browser.focus(); browser.visibility(true)
  assert.deepEqual([first, second], [1, 1])
  browser.elapse(); assert.deepEqual([first, second], [2, 2])
  browser.visibility(false); assert.equal(browser.timers.size, 0)
  browser.elapse(); browser.focus(); assert.deepEqual([first, second], [2, 2])
  browser.visibility(true); assert.deepEqual([first, second], [3, 3])
  browser.connection(false); assert.equal(browser.timers.size, 0)
  browser.elapse(); assert.deepEqual([first, second], [3, 3])
  browser.connection(true); assert.deepEqual([first, second], [4, 4])
  stopFirst(); browser.elapse(); assert.deepEqual([first, second], [4, 5])
  stopSecond(); assert.equal(browser.timers.size, 0)
  browser.elapse(); browser.focus(); browser.connection(true); browser.visibility(true)
  assert.deepEqual([first, second], [4, 5]); assert.equal(browser.timers.size, 0)
})

test('external revalidation is silent and deduplicated while explicit mutations still supersede older reads', async () => {
  const pending = deferred<number>(), afterMutation = deferred<number>(), loading: boolean[] = [], signals: AbortSignal[] = []
  let cached = 0, reads = 0
  const reader = workspaceQueryReader({
    load: signal => { signals.push(signal); reads++; return reads === 1 ? Promise.resolve(1) : reads === 2 ? pending.promise : afterMutation.promise },
    accept: value => { cached = value }, clear: () => { cached = 0 }, error: () => {}, loading: value => loading.push(value),
  })
  try {
    await reader.read(); loading.length = 0
    const refresh = reader.revalidate()
    await reader.revalidate(); await reader.revalidate()
    assert.equal(reads, 2); assert.equal(signals[1].aborted, false)
    assert.equal(cached, 1); assert.deepEqual(loading, [], 'background activity cannot cause loading-based editor unmounts')
    publishMutationResponse(captureMutationContext(), '/plans/one', {})
    assert.equal(reads, 3); assert.equal(signals[1].aborted, true)
    pending.resolve(2); await tick(); assert.equal(cached, 1)
    afterMutation.resolve(3); await refresh; assert.equal(cached, 3)
  } finally { reader.dispose() }
  await reader.revalidate(); assert.equal(reads, 3)
})

test('background failures retain current data and account resets discard inflight completions and later timers', async () => {
  const pending = deferred<string>(), failure = new ApiError('offline', 0)
  let cached: string | null = null, reads = 0
  const reader = workspaceQueryReader({
    load: async () => { reads++; if (reads === 1) return 'saved'; if (reads === 2) throw failure; return pending.promise },
    accept: value => { cached = value }, clear: () => { cached = null }, error: () => {}, loading: () => {},
  })
  try {
    await reader.read()
    await assert.rejects(reader.revalidate(), error => error === failure)
    assert.equal(cached, 'saved')
    const refreshing = reader.revalidate(), rejected = assert.rejects(refreshing, /账号|范围/)
    advanceMutationContext(); assert.equal(cached, null)
    pending.resolve('old-account-response'); await rejected; await tick()
    await reader.revalidate(); assert.equal(cached, null); assert.equal(reads, 3)
  } finally { reader.dispose() }
})

test('stale pagination retries the first page once and preserves the mounted projection through transport failure', async () => {
  const stale = new ApiError('changed', 409, undefined, 'WORKSPACE_CURSOR_STALE')
  let cached: string | null = null, path = 'page-two', reads = 0, recoveries = 0, mode: 'initial' | 'offline' | 'fresh' | 'stale' = 'initial'
  const reader = workspaceQueryReader({
    load: async () => { reads++; if (mode === 'initial') return 'second page'; if (path === 'page-two' || mode === 'stale') throw stale; if (mode === 'offline') throw new ApiError('offline', 0); return 'fresh first page' },
    recoverQuery: () => { recoveries++; if (path !== 'page-two') return false; path = 'page-one'; return true },
    accept: value => { cached = value }, clear: () => { cached = null }, error: () => {}, loading: () => {},
  })
  try {
    await reader.read(); mode = 'offline'
    await assert.rejects(reader.revalidate(), /offline/)
    assert.equal(path, 'page-one'); assert.equal(reads, 3); assert.equal(recoveries, 1)
    assert.equal(cached, 'second page', 'a failed retry preserves content and editor mount')
    mode = 'fresh'; await reader.revalidate(); assert.equal(cached, 'fresh first page')
    mode = 'stale'; path = 'page-two'
    await assert.rejects(reader.revalidate(), error => error === stale)
    assert.equal(reads, 6); assert.equal(recoveries, 2, 'no recursive retry or perpetual stale cursor')
    assert.equal(cached, null, 'a failed scope check still fails closed')
  } finally { reader.dispose() }
})

test('aborted stale-cursor failures cannot retarget a newer query', async () => {
  let reject!: (error: unknown) => void, reads = 0, recoveries = 0, cached = ''
  const old = new Promise<string>((_resolve, fail) => { reject = fail })
  const reader = workspaceQueryReader({ load: () => ++reads === 1 ? old : Promise.resolve('new query'), recoverQuery: () => { recoveries++; return true }, accept: value => { cached = value }, clear: () => {}, error: () => {}, loading: () => {} })
  try {
    const previous = reader.read(); reader.resetQuery(); const next = reader.read()
    reject(new ApiError('stale old cursor', 409, undefined, 'WORKSPACE_CURSOR_STALE'))
    await Promise.all([previous, next]); assert.equal(cached, 'new query'); assert.equal(recoveries, 0)
  } finally { reader.dispose() }
})

test('another account transfer appears for the new owner through background refresh without a local mutation event', async t => {
  const store = new Store(':memory:'), domain = new Domain(store), service = new PeriodWorkspaceService(store), browser = browserEnvironment()
  t.after(() => store.close())
  const user = (id: string, role: User['role'] = 'member') => store.insert<User>('users', { id, name: id, email: `${id}@refresh.test`, role, active: true, position: '' })
  const manager = user('manager', 'manager'), oldOwner = user('old-owner'), newOwner = user('new-owner')
  let plan = domain.createPlan(manager, { title: '转交的部署目标', month: '2026-09', ownerId: oldOwner.id, collaboratorIds: [], category: '研发', expectedOutcome: '交付', acceptanceCriteria: '通过', dueDate: '2026-09-30' })
  plan = domain.submitPlan(manager, plan.id, { version: plan.version })
  plan = domain.reviewPlan(manager, plan.id, { version: plan.version, decision: 'approve' })
  domain.publishMonth(manager, plan.month, { planIds: [plan.id] }); plan = store.get<MonthlyPlan>('plans', plan.id)!
  let cached: MonthlyWorkspace | null = null, reads = 0
  const reader = workspaceQueryReader<MonthlyWorkspace>({ load: async () => { reads++; return service.monthly(newOwner, { month: plan.month }) }, accept: value => { cached = value }, clear: () => { cached = null }, error: () => {}, loading: () => {} })
  const stop = browser.source.subscribe(() => { void reader.revalidate().catch(() => {}) })
  try {
    await reader.read(); assert.equal(cached!.items.some(row => row.id === plan.id), false)
    domain.updatePlan(manager, plan.id, { version: plan.version, ownerId: newOwner.id, reason: '移交给新负责人' })
    assert.equal(reads, 1); assert.equal(cached!.items.some(row => row.id === plan.id), false, 'a remote mutation has no browser event')
    browser.elapse(); await tick()
    assert.equal(reads, 2); assert.equal(cached!.items.find(row => row.id === plan.id)?.ownerId, newOwner.id)
    assert.equal(cached!.items.find(row => row.id === plan.id)?.visibility, undefined)
  } finally { stop(); reader.dispose() }
})

test('real stale collection cursor recovers to fresh authorized membership after another account edit', async t => {
  const store = new Store(':memory:'), domain = new Domain(store), service = new PeriodWorkspaceService(store)
  t.after(() => store.close())
  const manager = store.insert<User>('users', { id: 'manager', name: 'manager', email: 'manager@paging.test', role: 'manager', active: true, position: '' })
  const input = { title: '分页目标', month: '2026-09', ownerId: manager.id, collaboratorIds: [], category: '研发', expectedOutcome: '交付', acceptanceCriteria: '通过', dueDate: '2026-09-30' }
  const plan = domain.createPlan(manager, input); domain.createPlan(manager, { ...input, title: '第二个目标' })
  let cursor = service.monthly(manager, { month: plan.month, limit: 1 }).nextCursor!, cached: MonthlyWorkspace | null = null, recoveries = 0
  const reader = workspaceQueryReader<MonthlyWorkspace>({
    load: async () => { try { return service.monthly(manager, { month: plan.month, limit: 1, ...(cursor ? { cursor } : {}) }) } catch (error) { if (error instanceof HttpError) throw new ApiError(error.message, error.status, undefined, error.code); throw error } },
    recoverQuery: () => { recoveries++; cursor = ''; return true }, accept: value => { cached = value }, clear: () => { cached = null }, error: () => {}, loading: () => {},
  })
  try {
    await reader.read(); const oldRevision = cached!.revision
    domain.updatePlan(manager, plan.id, { version: plan.version, title: '管理员另一会话已修改' })
    await reader.revalidate()
    assert.equal(recoveries, 1); assert.equal(cursor, ''); assert.notEqual(cached!.revision, oldRevision)
    assert.deepEqual(cached!.items, service.monthly(manager, { month: plan.month, limit: 1 }).items)
  } finally { reader.dispose() }
})
