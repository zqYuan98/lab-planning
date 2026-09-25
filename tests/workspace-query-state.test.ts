import test from 'node:test'
import assert from 'node:assert/strict'
import { mergeWorkspaceReceipt, workspaceQueryReader } from '../src/workspace-query-state.ts'
import { ApiError } from '../src/api.ts'
import { advanceMutationContext, captureMutationContext, publishMutationResponse } from '../src/mutation-response.ts'
import { confirmMutation } from '../src/workspace-response.ts'
import { StaleReadError } from '../src/latest-read.ts'
import type { MonthlyPlan, Task } from '../shared/types.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))
const task = { id: 'task', version: 1, createdAt: '', updatedAt: '', title: 'before', ownerId: 'member', description: '', monthlyPlanId: null, isTemporary: true, temporaryReason: 'test', dueDate: '2026-09-30', status: 'doing' } as Task
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }

test('page reader clears cached values on authorization loss and scope-invalid cursor', async () => {
  for (const failure of [new ApiError('expired',401),new ApiError('revoked',403),new ApiError('gone',404),new ApiError('scope changed',409,undefined,'WORKSPACE_CURSOR_STALE')]) {
    let cached: { secret: string } | null = null, reject = false
    const reader = workspaceQueryReader({ load: async()=>{if(reject)throw failure;return {secret:'visible-before-revocation'}}, accept: value=>{cached=value},clear:()=>{cached=null},error:()=>{},loading:()=>{} })
    await reader.read(); assert.ok(cached); reject=true
    await assert.rejects(reader.read(), error=>error===failure); assert.equal(cached,null); reader.dispose()
  }
})
test('identity generation clears synchronously and rejects stale page completions', async () => {
  let cached: string | null = 'old', resolve!: (value:string)=>void
  const reader = workspaceQueryReader({ load:()=>new Promise<string>(done=>{resolve=done}),accept:value=>{cached=value},clear:()=>{cached=null},error:()=>{},loading:()=>{} })
  const pending = reader.read(), rejected = assert.rejects(pending,/账号|范围/)
  advanceMutationContext(); assert.equal(cached,null); resolve('old-private-data'); await rejected
  await new Promise(done=>setImmediate(done)); assert.equal(cached,null); reader.dispose()
})
test('successful mutation receipt remains visible after its follow-up transport failure', async () => {
  let cached: { version:number } | null = null, reject = false
  const reader = workspaceQueryReader({ load:async()=>{if(reject)throw new Error('network');return {version:1}},accept:value=>{cached=value},clear:()=>{cached=null},merge:(_value,receipt)=>receipt as {version:number},error:()=>{},loading:()=>{} })
  await reader.read(); reject=true
  publishMutationResponse(captureMutationContext(),'/tasks/example',{version:2})
  await new Promise(done=>setImmediate(done)); assert.deepEqual(cached,{version:2}); reader.dispose()
})

test('changing a query clears its private receipt cache while existing callers await the latest effective read', async () => {
  type Page = { items: Task[] }
  const old = deferred<Page>(), next = deferred<Page>(), afterWrite = deferred<Page>(), pending = [old, next, afterWrite]
  let cached: Page | null = null, initial = true
  const reader = workspaceQueryReader({ load: () => initial ? (initial = false, Promise.resolve({ items: [task] })) : pending.shift()!.promise, accept: value => { cached = value }, clear: () => { cached = null }, error: () => {}, loading: () => {} })
  try {
    await reader.read()
    const oldCaller = reader.read()
    reader.resetQuery(); cached = null
    const currentCaller = reader.read()
    publishMutationResponse(captureMutationContext(), '/tasks/task', { ...task, version: 2, title: 'old query saved' })
    assert.equal(cached, null, 'receipt may not repopulate the former query while its replacement is loading')
    old.resolve({ items: [task] }); next.resolve({ items: [{ ...task, title: 'obsolete next response' }] })
    await tick(); assert.equal(cached, null)
    afterWrite.resolve({ items: [] })
    await Promise.all([oldCaller, currentCaller]); assert.deepEqual(cached, { items: [] })
  } finally { reader.dispose() }
})

test('default page receipt merge retains a saved row after transport or stale successful reads without adding absent rows', async () => {
  let cached: { items: Task[] } | null = null, failure: Error | undefined, incoming = [task]
  const errors: unknown[] = []
  const reader = workspaceQueryReader({ load: async () => { if (failure) throw failure; return { items: incoming } }, accept: value => { cached = value }, clear: () => { cached = null }, error: error => errors.push(error), loading: () => {} })
  try {
    await reader.read(); failure = new Error('offline')
    const saved = { ...task, version: 2, title: 'confirmed' }
    publishMutationResponse(captureMutationContext(), '/tasks/task', [saved, { ...saved, id: 'outside-filter' }])
    await tick(); assert.deepEqual(cached, { items: [saved] })
    failure = undefined
    await assert.rejects(reader.read(), StaleReadError)
    assert.deepEqual(cached, { items: [saved] }); assert.ok(errors.some(error => error instanceof StaleReadError))
    incoming = []; await reader.read(); assert.deepEqual(cached, { items: [] })
    failure = new ApiError('scope lost', 403); await assert.rejects(reader.read()); assert.equal(cached, null)
  } finally { reader.dispose() }
})

test('receipts cannot replace a historical plan with current private content or expand a summary DTO', () => {
  const plan = { id: 'plan', version: 2, title: 'authorized old title', month: '2026-09', acceptanceStatus: 'pending', visibility: 'historical' } as MonthlyPlan
  const confirmed = confirmMutation({}, { ...plan, version: 9, visibility: undefined, title: 'private current title', expectedOutcome: 'private body' })
  assert.deepEqual(mergeWorkspaceReceipt({ items: [plan], references: { plans: [plan] } }, confirmed), { value: { items: [plan], references: { plans: [plan] } }, stale: false })
  const narrow = { ...task, description: undefined, statistic: 20 }
  delete narrow.description
  const saved = confirmMutation({}, { ...task, version: 2, description: 'full body not in summary', title: 'saved' })
  const unaffected = { items: [{ ...narrow, id: 'other-query-row' }] }
  assert.equal(mergeWorkspaceReceipt(unaffected, saved).value, unaffected, 'unrelated receipts must not trigger entity-array effects')
  const result = mergeWorkspaceReceipt({ items: [narrow] }, saved)
  assert.equal(result.value.items[0].title, 'saved'); assert.equal(result.value.items[0].statistic, 20)
  assert.equal('description' in result.value.items[0], false)
})
