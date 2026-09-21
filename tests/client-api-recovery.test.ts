import test from 'node:test'
import assert from 'node:assert/strict'
import { api, ApiError, finishSaved, SavedResultError } from '../src/api.ts'
import { clearClientError, latestClientError } from '../src/error-context.ts'

test('API errors expose the server request ID without returning raw exception bodies', async t => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original; clearClientError() })
  globalThis.fetch = async () => new Response(JSON.stringify({ error: '服务暂时无法处理请求', requestId: 'same-request' }), {
    status: 500, headers: { 'Content-Type': 'application/json', 'X-Request-Id': 'same-request' },
  })
  await assert.rejects(api('/bootstrap'), (error: unknown) => error instanceof ApiError && error.requestId === 'same-request' && error.status === 500)
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
