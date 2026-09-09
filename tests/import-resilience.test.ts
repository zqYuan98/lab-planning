import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { ImportService, type HistoricalRecord } from '../server/import-service.ts'
import { updateAiSettings } from '../server/ai-service.ts'
import { assertIntegrationTokenActive, createIntegrationToken, revokeIntegrationToken } from '../server/integration-auth.ts'
import type { ImportBatch } from '../shared/import-types.ts'
import type { Entity, User } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), service = new ImportService(store)
  const actor = domain.setup({ name: '恢复测试管理员', email: 'resilience@example.test', password: 'Synthetic-pass-2026!' })
  updateAiSettings(store, actor, { baseUrl: 'https://model.example.test/v1', model: 'synthetic-model', apiKey: 'synthetic-test-only' })
  t.after(() => store.close())
  const upload = (content = '标题\ntask-one', name = 'fixture.csv') => service.upload(actor, { fileName: name, base64: Buffer.from(content).toString('base64') })
  return { store, domain, service, actor, upload }
}

function completion(rows: unknown[]) {
  return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rows, warnings: [] }) } }] }), { headers: { 'content-type': 'application/json' } })
}
const candidate = (title = '合成事项', sourceRow = 2) => ({ kind: 'monthly', sourceRow, title, month: '2026-09' })

// Mirrors the authorized fork route's stored batch fields without running a web server.
function fork(store: Store, actor: User, before: ImportBatch): ImportBatch {
  return store.insert<ImportBatch>('importBatches', {
    ownerId: actor.id, sourceId: before.sourceId, fileName: before.fileName, kind: before.kind,
    status: 'uploaded', sourceSheets: before.sourceSheets, warnings: [], rows: [], mode: before.mode,
  })
}

async function waitForAnalysis(service: ImportService, actor: User, id: string) {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    const batch = service.get(actor, id)
    if (batch.analysis?.status !== 'running') return batch
    await setImmediate()
  }
  assert.fail('Synthetic background analysis did not settle within five seconds')
}

test('empty model extraction can be retried with identical input and does not poison the chunk cache', async t => {
  const f = fixture(t), batch = await f.upload()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => completion(++calls === 1 ? [] : [candidate()]))
  await assert.rejects(f.service.analyze(f.actor, batch.id, { version: batch.version }), { status: 422 })
  assert.equal(f.store.list('importParsedChunks').length, 0)
  assert.equal(f.service.get(f.actor, batch.id).status, 'uploaded')
  const retry = await f.service.analyze(f.actor, batch.id, { version: batch.version })
  assert.equal(calls, 2)
  assert.equal(retry.rows[0].title, '合成事项')
  assert.equal(f.store.list('historicalRecords').length, 0)
})

test('explicit forceRefresh calls the model again while ordinary retries reuse successful chunks', async t => {
  const f = fixture(t), uploaded = await f.upload()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => completion([candidate(++calls === 1 ? '初次识别' : '重新识别')]))
  let batch = await f.service.analyze(f.actor, uploaded.id, { version: uploaded.version })
  const originalRowId = batch.rows[0].id
  batch = await f.service.analyze(f.actor, batch.id, { version: batch.version })
  assert.equal(calls, 1)
  assert.equal(batch.rows[0].title, '初次识别')
  batch = await f.service.analyze(f.actor, batch.id, { version: batch.version, forceRefresh: true })
  assert.equal(calls, 2)
  assert.equal(batch.rows[0].title, '重新识别')
  assert.equal(batch.rows[0].id, originalRowId)
  assert.equal(f.store.list('importParsedChunks').length, 1)
})

test('two managers committing the same source item through separate batches share one stored result', async t => {
  const f = fixture(t), uploaded = await f.upload()
  const second = f.domain.createUser(f.actor, { name: '另一位管理员', email: 'second@example.test', password: 'Synthetic-pass-2026!', position: '测试', role: 'manager' })
  t.mock.method(globalThis, 'fetch', async () => completion([candidate()]))
  const parsed = await f.service.analyze(f.actor, uploaded.id, { version: uploaded.version })
  const first = f.service.commit(f.actor, parsed.id, { version: parsed.version })
  const next = fork(f.store, second, parsed)
  const secondParsed = await f.service.analyze(second, next.id, { version: next.version })
  const committed = f.service.commit(second, next.id, { version: secondParsed.version })
  assert.equal(first.rows[0].id, committed.rows[0].id)
  assert.deepEqual(first.rows[0].result, committed.rows[0].result)
  assert.equal(f.store.list('historicalRecords').length, 1)
  assert.equal(committed.skippedCount, 1)
  assert.equal(committed.committedCount, 0)
})

test('changing an already imported source item fails explicitly instead of silently discarding corrections', async t => {
  const f = fixture(t), uploaded = await f.upload()
  t.mock.method(globalThis, 'fetch', async () => completion([candidate('原识别标题')]))
  const parsed = await f.service.analyze(f.actor, uploaded.id, { version: uploaded.version })
  const committed = f.service.commit(f.actor, parsed.id, { version: parsed.version })
  const next = fork(f.store, f.actor, parsed)
  let revised = await f.service.analyze(f.actor, next.id, { version: next.version })
  revised.rows[0].title = '人工纠正标题'
  revised = f.service.edit(f.actor, revised.id, { version: revised.version, rows: revised.rows })
  assert.throws(() => f.service.commit(f.actor, revised.id, { version: revised.version }), error => {
    assert.equal((error as { status: number }).status, 409)
    assert.match((error as Error).message, /内容有变化.*纠正/)
    return true
  })
  assert.equal(f.service.get(f.actor, revised.id).status, 'parsed')
  assert.equal(f.store.list('historicalRecords').length, 1)
  assert.equal(f.store.get<HistoricalRecord>('historicalRecords', committed.rows[0].result!.id)?.row.title, '原识别标题')
})

test('concurrent successful analyses sharing a cache key both finish without duplicate-cache errors', async t => {
  const f = fixture(t), uploaded = await f.upload()
  let calls = 0, hold = false, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(globalThis, 'fetch', async () => { calls++; if (hold) await gate; return completion([candidate()]) })
  const parsed = await f.service.analyze(f.actor, uploaded.id, { version: uploaded.version })
  const next = fork(f.store, f.actor, parsed)
  hold = true
  const requests = [
    f.service.analyze(f.actor, parsed.id, { version: parsed.version, instruction: '共同的新解析要求' }),
    f.service.analyze(f.actor, next.id, { version: next.version, instruction: '共同的新解析要求' }),
  ]
  assert.equal(calls, 3, 'both requests must miss the newly introduced cache key before either completes')
  release()
  const results = await Promise.all(requests)
  assert.deepEqual(results.map(batch => batch.status), ['parsed', 'parsed'])
  assert.equal(f.store.list('importParsedChunks').length, 2)
})

test('background failure preserves completed chunks and source data; retry resumes without repeating successful calls', async t => {
  const f = fixture(t), uploaded = await f.upload(['标题', ...Array.from({ length: 25 }, (_, index) => `task-${index}`)].join('\n'))
  const originalSource = f.service.source(f.actor, uploaded.id).base64
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: unknown, request: RequestInit) => {
    if (++calls === 2) return new Response('synthetic upstream failure', { status: 503 })
    const envelope = JSON.parse(String(request.body)) as { messages: Array<{ content: string }> }
    const content = envelope.messages[1].content
    const marker = '\n资料：'
    const source = JSON.parse(content.slice(content.lastIndexOf(marker) + marker.length)) as { rows: Array<{ rowNumber: number; cells: string[] }> }
    return completion(source.rows.filter(row => row.cells[0].startsWith('task-')).map(row => candidate(row.cells[0], row.rowNumber)))
  })
  const started = f.service.startAnalysis(f.actor, uploaded.id, { version: uploaded.version })
  assert.equal(started.analysis?.status, 'running')
  assert.throws(() => f.service.startAnalysis(f.actor, uploaded.id, { version: uploaded.version }), { status: 409 })
  assert.throws(() => f.service.edit(f.actor, uploaded.id, { version: uploaded.version, rows: [] }), { status: 409 })
  assert.throws(() => f.service.commit(f.actor, uploaded.id, { version: uploaded.version }), { status: 409 })
  const failed = await waitForAnalysis(f.service, f.actor, uploaded.id)
  assert.equal(failed.analysis?.status, 'failed')
  assert.equal(failed.analysis?.completedChunks, 1)
  assert.equal(failed.analysis?.totalChunks, 2)
  assert.equal(failed.status, 'uploaded')
  assert.equal(f.store.list('importParsedChunks').length, 1)
  assert.equal(f.service.source(f.actor, uploaded.id).base64, originalSource)
  f.service.startAnalysis(f.actor, uploaded.id, { version: failed.version })
  const resumed = await waitForAnalysis(f.service, f.actor, uploaded.id)
  assert.equal(resumed.analysis?.status, 'completed')
  assert.equal(resumed.analysis?.completedChunks, 2)
  assert.equal(resumed.rows.length, 25)
  assert.equal(calls, 3, 'the first successful chunk is reused when retrying the second chunk')
  assert.equal(f.store.list('historicalRecords').length, 0)
})

test('restart marks orphaned running jobs retryable without deleting source data or cached chunks', async t => {
  const f = fixture(t), uploaded = await f.upload()
  interface SavedJob extends Entity { ownerId: string; batchId: string; status: string; completedChunks: number; totalChunks: number }
  interface SavedChunk extends Entity { rows: unknown[]; warnings: string[] }
  f.store.insert<SavedJob>('importJobs', { id: uploaded.id, ownerId: f.actor.id, batchId: uploaded.id, status: 'running', completedChunks: 1, totalChunks: 2 })
  f.store.insert<SavedChunk>('importParsedChunks', { id: 'synthetic-completed-chunk', rows: [candidate()], warnings: [] })
  const sourceBefore = f.service.source(f.actor, uploaded.id)
  const restarted = new ImportService(f.store)
  const current = restarted.get(f.actor, uploaded.id)
  assert.equal(current.analysis?.status, 'failed')
  assert.equal(current.analysis?.completedChunks, 1)
  assert.match(current.analysis?.error ?? '', /服务已重启.*重新开始解析/)
  assert.deepEqual(restarted.source(f.actor, uploaded.id), sourceBefore)
  assert.equal(f.store.list('importParsedChunks').length, 1)
})

test('disabling the initiating account during a model request stops subsequent chunks and preserves the upload', async t => {
  const f = fixture(t), uploaded = await f.upload(['标题', ...Array.from({ length: 25 }, (_, index) => `task-${index}`)].join('\n'))
  const observer = f.domain.createUser(f.actor, { name: '权限管理者', email: 'observer@example.test', password: 'Synthetic-pass-2026!', position: '测试', role: 'manager' })
  const originalSource = f.service.source(f.actor, uploaded.id).base64
  let calls = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(globalThis, 'fetch', async () => { calls++; await gate; return completion([candidate()]) })
  f.service.startAnalysis(f.actor, uploaded.id, { version: uploaded.version })
  assert.equal(calls, 1)
  f.domain.updateUser(observer, f.actor.id, { version: f.actor.version, active: false })
  release()
  const stopped = await waitForAnalysis(f.service, observer, uploaded.id)
  assert.equal(stopped.analysis?.status, 'failed')
  assert.match(stopped.analysis?.error ?? '', /账号权限已变化/)
  assert.equal(calls, 1, 'account deactivation must prevent a request for the second chunk')
  assert.equal(stopped.status, 'uploaded')
  assert.equal(stopped.rows.length, 0)
  assert.equal(f.service.source(observer, uploaded.id).base64, originalSource)
  assert.equal(f.store.list('historicalRecords').length, 0)
})

test('revoking a credential guard stops a background job without changing its source or creating business data', async t => {
  const f = fixture(t), uploaded = await f.upload(['标题', ...Array.from({ length: 25 }, (_, index) => `task-${index}`)].join('\n'))
  const originalSource = f.service.source(f.actor, uploaded.id).base64
  const token = createIntegrationToken(f.store, f.actor, { name: '后台解析测试', scopes: ['imports:write'], expiresInDays: 1 })
  let calls = 0, release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(globalThis, 'fetch', async () => { calls++; await gate; return completion([candidate()]) })
  f.service.startAnalysis(f.actor, uploaded.id, { version: uploaded.version }, () => assertIntegrationTokenActive(f.store, token.id, 'imports:write'))
  assert.equal(calls, 1)
  revokeIntegrationToken(f.store, f.actor, token.id)
  release()
  const stopped = await waitForAnalysis(f.service, f.actor, uploaded.id)
  assert.equal(stopped.analysis?.status, 'failed')
  assert.match(stopped.analysis?.error ?? '', /集成令牌权限已变化/)
  assert.equal(calls, 1)
  assert.equal(stopped.status, 'uploaded')
  assert.equal(f.service.source(f.actor, uploaded.id).base64, originalSource)
  assert.equal(f.store.list('importParsedChunks').length, 0, 'a response returned after revocation must not be persisted as authorized output')
  assert.equal(f.store.list('plans').length, 0)
})

test('closing the import service before its database prevents late background reads, writes and unhandled failures', async t => {
  const store = new Store(':memory:'), domain = new Domain(store), service = new ImportService(store)
  const actor = domain.setup({ name: '停机测试管理员', email: 'shutdown@example.test', password: 'Synthetic-pass-2026!' })
  updateAiSettings(store, actor, { baseUrl: 'https://model.example.test/v1', model: 'synthetic-model', apiKey: 'synthetic-test-only' })
  let closed = false, release!: () => void
  t.after(() => { service.close(); if (!closed) store.close() })
  const uploaded = await service.upload(actor, { fileName: 'fixture.csv', base64: Buffer.from('标题\ntask-one').toString('base64') })
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(globalThis, 'fetch', async () => { await gate; return completion([candidate()]) })
  const analyze = t.mock.method(service, 'analyze')
  const get = t.mock.method(store, 'get'), list = t.mock.method(store, 'list'), insert = t.mock.method(store, 'insert'), update = t.mock.method(store, 'update'), transaction = t.mock.method(store, 'transaction')
  service.startAnalysis(actor, uploaded.id, { version: uploaded.version })
  const pending = analyze.mock.calls[0].result as Promise<ImportBatch>
  service.close()
  store.close(); closed = true
  const counts = [get, list, insert, update, transaction].map(method => method.mock.callCount())
  release()
  await assert.rejects(pending, /服务正在停止/)
  await setImmediate() // Allow the detached job's catch handler to run after shutdown.
  assert.deepEqual([get, list, insert, update, transaction].map(method => method.mock.callCount()), counts)
})
