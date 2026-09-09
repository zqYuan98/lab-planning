import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { setImmediate } from 'node:timers/promises'
import type { AddressInfo } from 'node:net'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { closeImportServices } from '../server/import-routes.ts'
import { updateAiSettings } from '../server/ai-service.ts'
import type { ImportBatch } from '../shared/import-types.ts'
import type { Entity } from '../shared/types.ts'

type ModelPart = { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
interface ModelRequest { model: string; messages: Array<{ role: string; content: string | ModelPart[] }> }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3x8AAAAASUVORK5CYII=', 'base64')

async function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store)
  const actor = domain.setup({ name: '文件输入回归测试', email: 'input-kinds@example.test', password: 'Synthetic-pass-2026!' })
  updateAiSettings(store, actor, { baseUrl: 'https://synthetic-model.example.test/v1', model: 'synthetic-text-model', visionModel: 'synthetic-vision-model', apiKey: 'synthetic-test-only' })
  const cookie = `lab_session=${createSession(store, store.get<StoredUser>('users', actor.id)!)}`
  const server = createApp({ store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  t.after(async () => {
    closeImportServices(store)
    await new Promise<void>(resolve => server.close(() => resolve()))
    store.close()
  })
  const realFetch = globalThis.fetch, modelRequests: ModelRequest[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, request?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.startsWith(`${origin}/`)) return realFetch(input, request)
    assert.equal(url, 'https://synthetic-model.example.test/v1/chat/completions', 'tests must never contact any real model provider')
    const body = JSON.parse(String(request?.body)) as ModelRequest
    modelRequests.push(body)
    const content = body.messages.find(message => message.role === 'user')!.content
    const table = typeof content === 'string' && content.includes('"sheetName"')
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rows: [{
      kind: 'monthly', sourceRow: table ? 2 : 1, title: '合成月计划', ownerName: actor.name,
      month: '2026-09', dueDate: '2026-09-30', expectedOutcome: '合成成果', acceptanceCriteria: '合成验收要求',
      sourceText: '合成来源文字', sourceStatus: '',
    }], warnings: [] }) } }] }), { headers: { 'content-type': 'application/json' } })
  })
  async function call<T>(path: string, body?: unknown, expected = body === undefined ? 200 : 201): Promise<T> {
    const response = await fetch(`${origin}/api${path}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { origin, cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const result = await response.json()
    assert.equal(response.status, expected, `${path}: ${JSON.stringify(result)}`)
    return result as T
  }
  async function waitForBatch(id: string) {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const batch = await call<ImportBatch>(`/imports/${id}`)
      if (batch.analysis?.status !== 'running') return batch
      await setImmediate()
    }
    assert.fail('Synthetic background analysis did not settle within five seconds')
  }
  return { store, call, waitForBatch, modelRequests }
}

// Includes the empty sheets array sent by the existing UI for images and pasted text.
const uiPayload = (batch: ImportBatch, sheets: string[]) => ({
  version: batch.version, sheets, instruction: '请解析为月计划', forceRefresh: false, kind: 'monthly', period: '2026-09',
})

test('PNG monthly-plan upload with the actual UI sheets:[] payload completes using image_url and the vision model', async t => {
  const f = await fixture(t)
  const uploaded = await f.call<ImportBatch>('/imports', { fileName: '合成月计划.png', mimeType: 'image/png', base64: png.toString('base64') })
  assert.equal(uploaded.kind, 'image')
  assert.deepEqual(uploaded.sourceSheets, [])
  await f.call<ImportBatch>(`/imports/${uploaded.id}/analyze`, uiPayload(uploaded, []), 202)
  const result = await f.waitForBatch(uploaded.id)
  assert.equal(result.analysis?.status, 'completed', result.analysis?.error)
  assert.equal(result.status, 'parsed')
  assert.equal(result.rows[0].title, '合成月计划')
  assert.equal(f.modelRequests.length, 1)
  assert.equal(f.modelRequests[0].model, 'synthetic-vision-model')
  const content = f.modelRequests[0].messages.find(message => message.role === 'user')!.content
  assert.ok(Array.isArray(content))
  assert.deepEqual(content.find(part => part.type === 'image_url'), { type: 'image_url', image_url: { url: `data:image/png;base64,${png.toString('base64')}` } })
  assert.equal(f.store.list('plans').length, 0, 'successful parsing must remain a reviewable preview')
})

test('TXT monthly-plan upload with the actual UI sheets:[] payload completes as text without requiring worksheets', async t => {
  const f = await fixture(t), original = '2026年9月月计划：提交合成测试成果。'
  const uploaded = await f.call<ImportBatch>('/imports', { fileName: '合成月计划.txt', text: original })
  assert.equal(uploaded.kind, 'text')
  assert.deepEqual(uploaded.sourceSheets, [])
  await f.call<ImportBatch>(`/imports/${uploaded.id}/analyze`, uiPayload(uploaded, []), 202)
  const result = await f.waitForBatch(uploaded.id)
  assert.equal(result.analysis?.status, 'completed', result.analysis?.error)
  assert.equal(result.rows[0].title, '合成月计划')
  assert.equal(f.modelRequests.length, 1)
  assert.equal(f.modelRequests[0].model, 'synthetic-text-model')
  const content = f.modelRequests[0].messages.find(message => message.role === 'user')!.content
  assert.equal(typeof content, 'string')
  assert.ok(String(content).includes(original))
  assert.equal(f.store.list('historicalRecords').length, 0)
})

test('table input still fails sheets:[] before model use and succeeds when its worksheet is selected', async t => {
  const f = await fixture(t)
  const uploaded = await f.call<ImportBatch>('/imports', { fileName: '合成表格.csv', mimeType: 'text/csv', base64: Buffer.from('工作内容,月份\n合成月计划,2026-09').toString('base64') })
  assert.equal(uploaded.kind, 'table')
  await f.call<ImportBatch>(`/imports/${uploaded.id}/analyze`, uiPayload(uploaded, []), 202)
  const failed = await f.waitForBatch(uploaded.id)
  assert.equal(failed.analysis?.status, 'failed')
  assert.match(failed.analysis?.error ?? '', /请选择至少一张工作表/)
  assert.equal(f.modelRequests.length, 0)
  assert.equal((await f.call<ImportBatch>(`/imports/${uploaded.id}`)).status, 'uploaded')
  await f.call<ImportBatch>(`/imports/${uploaded.id}/analyze`, uiPayload(uploaded, [uploaded.sourceSheets[0].name]), 202)
  const result = await f.waitForBatch(uploaded.id)
  assert.equal(result.analysis?.status, 'completed', result.analysis?.error)
  assert.equal(result.rows[0].sourceSheet, uploaded.sourceSheets[0].name)
  assert.equal(result.rows[0].sourceRow, 2)
  assert.match(result.rows[0].sourceText, /合成月计划/)
  assert.equal(f.modelRequests.length, 1)
  assert.equal(f.modelRequests[0].model, 'synthetic-text-model')
})

test('a PNG batch previously failed by the old worksheet check retries in place and clears its old error', async t => {
  const f = await fixture(t)
  const uploaded = await f.call<ImportBatch>('/imports', { fileName: '旧失败月计划.png', mimeType: 'image/png', base64: png.toString('base64') })
  interface PersistedJob extends Entity {
    ownerId: string; batchId: string; status: 'failed'; completedChunks: number; totalChunks: number; error: string
  }
  // The old validation failed before the model call and retained this job state.
  f.store.insert<PersistedJob>('importJobs', {
    id: uploaded.id, ownerId: uploaded.ownerId, batchId: uploaded.id, status: 'failed', completedChunks: 0, totalChunks: 0, error: '请选择至少一张工作表',
  })
  const before = await f.call<ImportBatch>(`/imports/${uploaded.id}`)
  assert.equal(before.analysis?.status, 'failed')
  assert.match(before.analysis?.error ?? '', /请选择至少一张工作表/)
  await f.call<ImportBatch>(`/imports/${before.id}/analyze`, uiPayload(before, []), 202)
  const after = await f.waitForBatch(before.id)
  assert.equal(after.id, before.id)
  assert.equal(after.sourceId, before.sourceId)
  assert.equal(after.analysis?.status, 'completed', after.analysis?.error)
  assert.equal(after.analysis?.error, undefined)
  assert.equal(after.status, 'parsed')
  assert.equal(after.rows.length, 1)
  assert.equal(f.store.list('importSources').length, 1)
  assert.equal(f.store.list('importBatches').length, 1)
  assert.equal(f.modelRequests.length, 1)
})
