import test from 'node:test'
import assert from 'node:assert/strict'
import { LatestRead, reconcileVersionedList } from '../src/latest-read.ts'
import { advanceMutationContext, captureMutationContext, publishMutationResponse, readInMutationContext, subscribeMutationResponses } from '../src/mutation-response.ts'
import { applyBootstrapMutation, confirmMutation, reconcileBootstrap } from '../src/workspace-response.ts'
import { api, finishSaved, json, SavedResultError } from '../src/api.ts'
import type { Bootstrap, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { CollaborationSettings, CollaborationTaskView, FollowupRequest } from '../shared/collaboration.ts'
import { applyFollowupMutation, reconcileFollowupDashboard, type FollowupDashboard } from '../src/followup-response.ts'
import { applyTaskViewMutation, reconcileTaskView } from '../src/task-view-response.ts'
import { SavedRefresh, type SavedRefreshState } from '../src/saved-refresh.ts'

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (reason: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

test('latest read owns data, errors and loading; older callers follow its completion', async () => {
  const a = deferred<string>(), b = deferred<string>(), values: string[] = [], errors: unknown[] = [], loading: boolean[] = [], signals: AbortSignal[] = []
  const queue = [a, b]
  const reader = new LatestRead({ load: signal => { signals.push(signal); return queue.shift()!.promise }, accept: value => { values.push(value) }, error: value => errors.push(value), loading: value => loading.push(value) })
  let oldFinished = false
  const old = reader.read().then(() => { oldFinished = true })
  const current = reader.read()
  assert.equal(signals[0].aborted, true)
  a.reject(new Error('obsolete failure'))
  await tick()
  assert.equal(oldFinished, false)
  assert.deepEqual(errors, [null, null])
  assert.equal(loading.at(-1), true)
  b.resolve('new')
  await Promise.all([old, current])
  assert.deepEqual(values, ['new'])
  assert.equal(loading.at(-1), false)
})

test('write barrier rejects an old response even if the network ignores cancellation', async () => {
  const a = deferred<number>(), b = deferred<number>(), values: number[] = [], queue = [a, b]
  const reader = new LatestRead({ load: () => queue.shift()!.promise, accept: value => { values.push(value) } })
  const old = reader.read()
  reader.invalidate()
  values.push(3) // confirmed mutation response
  const current = reader.read()
  a.resolve(1)
  await tick()
  assert.deepEqual(values, [3])
  b.resolve(3)
  await Promise.all([old, current])
  assert.deepEqual(values, [3, 3])
})

test('reset and dispose prevent stale identity or unmounted state writes', async () => {
  const a = deferred<number>(), b = deferred<number>(), values: number[] = [], errors: unknown[] = [], queue = [a, b]
  const reader = new LatestRead({ load: () => queue.shift()!.promise, accept: value => { values.push(value) }, error: value => errors.push(value) })
  const old = assert.rejects(reader.read(), /访问范围|账号/)
  reader.reset()
  a.resolve(1)
  await old
  const current = assert.rejects(reader.read(), /访问范围|账号/)
  reader.dispose()
  b.resolve(2)
  await current
  await tick()
  assert.deepEqual(values, [])
  assert.deepEqual(errors, [null, null])
})

test('all superseded callers receive only the latest real read failure', async () => {
  const a = deferred<number>(), b = deferred<number>(), queue = [a, b]
  const reader = new LatestRead({ load: () => queue.shift()!.promise, accept: () => {} })
  const first = assert.rejects(reader.read(), /current/), second = assert.rejects(reader.read(), /current/)
  b.reject(new Error('current failure'))
  await Promise.all([first, second])
  a.resolve(1)
})

test('complete lists retain newer matching objects without resurrecting deleted or unauthorized members', () => {
  const known = [{ id: 'keep', version: 3, title: 'saved' }, { id: 'removed', version: 8, title: 'private' }]
  const result = reconcileVersionedList(known, [{ id: 'keep', version: 2, title: 'stale' }])
  assert.deepEqual(result.items, [known[0]])
  assert.equal(result.stale, true)
  assert.deepEqual(reconcileVersionedList(known, []).items, [])
})

test('mutation responses are accepted only in the initiating identity generation; auth paths never publish', () => {
  const events: unknown[] = []
  const unsubscribe = subscribeMutationResponses(event => events.push(event))
  const before = captureMutationContext()
  advanceMutationContext()
  assert.equal(publishMutationResponse(before, '/tasks/t', { id: 't', version: 3 }), false)
  const current = captureMutationContext()
  assert.equal(publishMutationResponse(current, '/api/tasks/t', { id: 't', version: 4 }), true)
  publishMutationResponse(current, '/api/auth/logout', {})
  publishMutationResponse(current, '/auth/login', {})
  unsubscribe()
  assert.equal(events.length, 1)
  assert.equal((events[0] as { path: string }).path, '/tasks/t')
})

const entity = { id: 't', version: 1, createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z' }
const user: User = { ...entity, id: 'member', name: '成员', email: 'member@example.test', role: 'member', position: '', active: true }
const task: Task = { ...entity, ownerId: user.id, title: '任务', description: '', monthlyPlanId: null, dueDate: '2026-09-30', status: 'doing', isTemporary: true, temporaryReason: '临时' }
const workspace = (): Bootstrap => ({ user, users: [user], tasks: [task], weeklyRecords: [], plans: [], projects: [], annualGoals: [], publications: [], reports: [], aiConfigured: false })

test('confirmed cancellation cannot be resurrected by a later lower-version full snapshot', () => {
  const initial = workspace(), cancelled = { ...task, version: 2, cancellation: { cancelledAt: entity.updatedAt, cancelledBy: user.id, reason: '取消' } }
  const saved = applyBootstrapMutation(initial, cancelled), confirmed = confirmMutation({}, cancelled)
  assert.deepEqual(saved.tasks, [])
  const result = reconcileBootstrap(saved, initial, confirmed)
  assert.equal(result.stale, true)
  assert.deepEqual(result.value.tasks, [])
  assert.deepEqual(reconcileBootstrap(saved, { ...initial, tasks: [] }, confirmed).value.tasks, [])
})

test('narrower historical plan projection and changed identity never reuse private higher-version content', () => {
  const current = workspace()
  const plan = { ...entity, id: 'plan', version: 9, title: 'new private content', ownerId: 'other', collaboratorIds: [user.id] } as MonthlyPlan
  current.plans = [plan]
  const historical = { ...plan, version: 2, title: 'old visible content', visibility: 'historical' as const }
  const result = reconcileBootstrap(current, { ...current, plans: [historical] }, confirmMutation({}, { ...plan, acceptanceStatus: 'pending', month: '2026-09' }))
  assert.equal(result.stale, false)
  assert.deepEqual(result.value.plans, [historical])
  const newIdentity = { ...workspace(), user: { ...user, id: 'another' }, tasks: [] }
  assert.deepEqual(reconcileBootstrap(current, newIdentity).value, newIdentity)
})

test('real API success accepts saved version before refresh; refresh failure retries GET only', async t => {
  const original = globalThis.fetch
  const oldRead = deferred<Response>()
  let current = workspace(), confirmed = {}, getCalls = 0, writes = 0
  const saved = { ...task, version: 3, title: 'confirmed save' }
  globalThis.fetch = async (_url, options) => {
    if (options?.method === 'PATCH') { writes++; return new Response(JSON.stringify(saved)) }
    getCalls++
    if (getCalls === 1) return oldRead.promise
    if (getCalls === 2) return new Response(JSON.stringify({ error: 'read failed' }), { status: 503 })
    return new Response(JSON.stringify({ ...workspace(), tasks: [saved] }))
  }
  const reader = new LatestRead({ load: signal => api<Bootstrap>('/workspace', { signal }), accept: value => { current = reconcileBootstrap(current, value, confirmed).value } })
  const unsubscribe = subscribeMutationResponses(event => {
    reader.invalidate(); confirmed = confirmMutation(confirmed, event.value); current = applyBootstrapMutation(current, event.value)
  })
  t.after(() => { unsubscribe(); reader.dispose(); globalThis.fetch = original })
  const initialRead = assert.rejects(reader.read(), /read failed/)
  await api('/tasks/t', json({ version: 1, title: saved.title }, 'PATCH'))
  assert.equal(current.tasks[0].version, 3)
  oldRead.resolve(new Response(JSON.stringify(workspace())))
  let failed: SavedResultError | undefined
  try { await finishSaved(() => reader.read()) } catch (error) { assert.ok(error instanceof SavedResultError); failed = error }
  await initialRead
  assert.equal(current.tasks[0].title, saved.title)
  assert.ok(failed)
  await failed.retry()
  assert.equal(writes, 1)
  assert.equal(getCalls, 3)
})

test('real API suppresses a successful old-account mutation callback after switching accounts', async t => {
  const original = globalThis.fetch, response = deferred<Response>(), events: unknown[] = []
  globalThis.fetch = async () => response.promise
  const unsubscribe = subscribeMutationResponses(event => events.push(event))
  t.after(() => { unsubscribe(); globalThis.fetch = original })
  let callbackRan = false
  const pending = assert.rejects(api('/api/tasks/t', json({ title: 'old' }, 'PATCH')).then(() => { callbackRan = true }), /账号或访问范围/)
  advanceMutationContext()
  response.resolve(new Response(JSON.stringify({ ...task, version: 5 })))
  await pending
  assert.equal(callbackRan, false)
  assert.deepEqual(events, [])
})

test('refresh discovering a permission or restore epoch change does not resume old saved callbacks', async () => {
  const result = deferred<number>()
  const reader = new LatestRead({ load: () => result.promise, accept: () => { advanceMutationContext() } })
  let resumed = false
  const pending = assert.rejects(readInMutationContext(() => reader.read()).then(() => { resumed = true }), /账号或访问范围/)
  result.resolve(1)
  await pending
  assert.equal(resumed, false)
})

test('weekly assignment compound response retains its actual record key before a failed refresh', () => {
  const record: WeeklyRecord = { ...entity, id: 'week', taskId: task.id, ownerId: user.id, monthlyPlanId: null, weekStart: '2026-09-21', commitment: '推进', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'planned', submitted: false }
  const saved = applyBootstrapMutation(workspace(), { task, record })
  assert.deepEqual(saved.weeklyRecords, [record])
})

test('same historical projection does not regress while an incoming full list still removes missing plans', () => {
  const plan = { ...entity, id: 'plan', version: 9, visibility: 'historical', title: 'authorized historical' } as MonthlyPlan
  const current = { ...workspace(), plans: [plan] }
  const result = reconcileBootstrap(current, { ...current, plans: [{ ...plan, version: 2, title: 'old' }] })
  assert.equal(result.stale, true)
  assert.deepEqual(result.value.plans, [plan])
  assert.deepEqual(reconcileBootstrap(current, { ...current, plans: [] }).value.plans, [])
})

function dashboard(): FollowupDashboard {
  return { settings: { ...entity, enabled: true } as CollaborationSettings, preference: { version: 1, memberActionsEnabled: true }, tasks: [{ task, tracking: null, openFollowup: null, weeklySummary: null, overallStatusNeedsConfirmation: false }], risks: [], digests: [] }
}
test('followup preferences use saved response and a closed followup never regresses to open', () => {
  const initial = dashboard(), preference = applyFollowupMutation(initial, '/collaboration/preferences', { version: 2, memberActionsEnabled: false })
  const stalePreference = reconcileFollowupDashboard(preference, initial, {})
  assert.equal(stalePreference.stale, true)
  assert.equal(stalePreference.value.preference.memberActionsEnabled, false)
  const open = { ...entity, id: 'followup', taskId: task.id, requirement: '进展', status: 'open' } as FollowupRequest
  const completed = { ...open, version: 2, status: 'responded' as const }
  initial.tasks[0].openFollowup = open
  const saved = applyFollowupMutation(initial, '/followups/f/respond', { task, followup: completed })
  assert.equal(saved.tasks[0].openFollowup, null)
  const read = reconcileFollowupDashboard(saved, initial, confirmMutation({}, { followup: completed }))
  assert.equal(read.stale, true)
  assert.equal(read.value.tasks[0].openFollowup, null)
  assert.deepEqual(reconcileFollowupDashboard(saved, { ...initial, tasks: [] }, {}).value.tasks, [])
})

test('task detail accepts saved compound state and protects it from stale reads without unioning removed history', () => {
  const initial: CollaborationTaskView = { task, tracking: null, progressEvents: [], followups: [], responses: [], blockerEpisodes: [], blockerActions: [], deadlineRequests: [], effectiveManagerIds: [], enabled: true, eligible: true, weeklySummary: null, overallStatusNeedsConfirmation: false }
  const followup = { ...entity, id: 'f', taskId: task.id, requirement: '更新', status: 'open' } as FollowupRequest
  const saved = applyTaskViewMutation(initial, { task: { ...task, version: 4, title: 'saved' }, request: followup })
  assert.equal(saved.task.version, 4)
  assert.deepEqual(saved.followups, [followup])
  const response = reconcileTaskView(saved, initial)
  assert.equal(response.stale, true)
  assert.equal(response.value.task.title, 'saved')
  assert.deepEqual(response.value.followups, [])
})

test('a prior broad mutation cannot shadow the monotonic version of a narrower historical projection', () => {
  const plan = { ...entity, id: 'plan', version: 2, visibility: 'historical', title: 'historical', acceptanceStatus: 'pending', month: '2026-09' } as MonthlyPlan
  const current = { ...workspace(), plans: [plan] }
  const confirmed = confirmMutation({}, { ...plan, visibility: undefined, version: 9, title: 'private current' })
  const result = reconcileBootstrap(current, { ...current, plans: [{ ...plan, version: 1 }] }, confirmed)
  assert.equal(result.stale, true)
  assert.deepEqual(result.value.plans, [plan])
})

test('saved receipt survives replacement of a version-keyed form and prevents a second write until read-only recovery', async () => {
  const states: SavedRefreshState[] = [], reading = deferred<void>()
  const controller = new SavedRefresh(state => states.push(state))
  let writes = 0, reads = 0, renderedVersion = 1
  const save = () => controller.run(async () => { writes++; renderedVersion = 2 }, async () => { reads++; if (reads === 1) await reading.promise })
  const submittedByOldForm = assert.rejects(save(), SavedResultError)
  await tick()
  assert.equal(renderedVersion, 2)
  assert.equal(states.at(-1), 'refreshing')
  await assert.rejects(save(), /先重新加载/)
  reading.reject(new Error('503 read failure'))
  await submittedByOldForm
  assert.equal(states.at(-1), 'failed')
  await assert.rejects(save(), /先重新加载/)
  await controller.retry()
  assert.equal(states.at(-1), 'idle')
  assert.equal(writes, 1)
  assert.equal(reads, 2)
})

test('saved-refresh reset on account change prevents old completion from updating recovery state', async () => {
  const states: SavedRefreshState[] = [], saving = deferred<void>()
  const controller = new SavedRefresh(state => states.push(state))
  let reads = 0
  const pending = assert.rejects(controller.run(() => saving.promise, async () => { reads++ }), /账号或访问范围/)
  controller.reset()
  saving.resolve()
  await pending
  assert.deepEqual(states, ['saving', 'idle'])
  assert.equal(reads, 0)
})
