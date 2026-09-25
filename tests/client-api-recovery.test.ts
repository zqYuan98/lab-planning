import test from 'node:test'
import assert from 'node:assert/strict'
import { api, ApiError, finishSaved, json, SavedResultError } from '../src/api.ts'
import { clearClientError, latestClientError } from '../src/error-context.ts'
import { advanceMutationContext, MutationContextChangedError, subscribeMutationResponses } from '../src/mutation-response.ts'

test('API errors expose the server request ID without returning raw exception bodies', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original; clearClientError() })
  globalThis.fetch = async () => new Response(JSON.stringify({ error: '服务暂时无法处理请求', requestId: 'same-request' }), {
    status: 500, headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'same-request' },
  })
  await assert.rejects(api('/workspace'), (error: unknown) => error instanceof ApiError && error.requestId === 'same-request' && error.status === 500)
  assert.equal(latestClientError()?.requestId, 'same-request')
})

test('interrupted writes report an unknown result and are never automatically retried', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original; clearClientError() })
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch') }
  await assert.rejects(api('/plans', { method: 'POST' }), /无法确认保存结果/)
  assert.equal(calls, 1)
})

test('saved mutation recovery retries only the failed refresh', async () => {
  let mutations = 0, reads = 0
  mutations++
  let savedError: SavedResultError | undefined
  try { await finishSaved(async () => { reads++; if (reads === 1) throw new Error('temporary connection loss') }) }
  catch (error) { assert.ok(error instanceof SavedResultError); savedError = error }
  assert.ok(savedError)
  await savedError.retry()
  assert.equal(mutations, 1)
  assert.equal(reads, 2)
})

test('a response body interrupted after headers retains the request ID and unknown write result', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original; clearClientError() })
  const response = new Response(null, { headers: { 'X-Request-Id': 'body-interrupted' } })
  response.text = async () => { throw new TypeError('terminated') }
  globalThis.fetch = async () => response
  await assert.rejects(api('/plans', { method: 'POST' }), (error: unknown) => error instanceof ApiError && error.requestId === 'body-interrupted' && error.message.includes('无法确认保存结果'))
  assert.equal(latestClientError()?.requestId, 'body-interrupted')
})

test('deadline repair preview POST keeps confirmation open by not publishing a write, while repair still refreshes', async t => {
  const original = globalThis.fetch, writes: string[] = []
  const unsubscribe = subscribeMutationResponses(event => { writes.push(event.path) })
  t.after(() => { globalThis.fetch = original; unsubscribe() })
  const result = { eligible:true, token:'preview-token' }
  globalThis.fetch = async (_url, init) => {
    assert.equal(init?.credentials, 'same-origin')
    assert.ok(init?.method === 'POST' || init?.method === 'PUT')
    return new Response(JSON.stringify(result))
  }
  for (const path of ['/weekly-submissions/deadline-repair/preview', '/api/weekly-submissions/deadline-repair/preview']) {
    assert.deepEqual(await api(path, json({week:'2026-09-21'})), result)
  }
  assert.deepEqual(writes, [], 'preview must not reach the App subscriber that reloads bootstrap and closes the modal')
  await api('/weekly-submissions/deadline-repair', json({week:'2026-09-21',token:'preview-token',reason:'修复'}))
  await api('/weekly-submissions/deadline-policy', json({version:1,mode:'last_workday'}, 'PUT'))
  assert.deepEqual(writes, ['/weekly-submissions/deadline-repair', '/weekly-submissions/deadline-policy'])
})

test('a late deadline preview still rejects an account or access-scope change before exposing its token', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => {
    advanceMutationContext()
    return new Response(JSON.stringify({eligible:true,token:'old-account-token'}))
  }
  await assert.rejects(api('/weekly-submissions/deadline-repair/preview', json({week:'2026-09-21'})), MutationContextChangedError)
})
