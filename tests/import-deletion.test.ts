import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { setImmediate } from 'node:timers/promises'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { ImportService, type HistoricalRecord } from '../server/import-service.ts'
import { updateAiSettings } from '../server/ai-service.ts'
import { createApp } from '../server/app.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import type { ImportBatch } from '../shared/import-types.ts'
import type { AuditEvent, Entity, MonthlyPlan } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), service = new ImportService(store)
  const actor = domain.setup({ name: '管理者', email: 'delete-manager@example.test', password: 'Synthetic-pass-2026!' })
  const member = domain.createUser(actor, { name: '成员', email: 'delete-member@example.test', password: 'Synthetic-pass-2026!', position: '研发', role: 'member' })
  const other = domain.createUser(actor, { name: '其他成员', email: 'delete-other@example.test', password: 'Synthetic-pass-2026!', position: '研发', role: 'member' })
  t.after(() => { service.close(); store.close() })
  return { store, domain, service, actor, member, other }
}

const monthly = (ownerId: string) => ({ kind: 'monthly', ownerId, title: '原月度目标', month: '2026-09', dueDate: '2026-09-30', category: '研发', expectedOutcome: '完成样机', acceptanceCriteria: '通过评审' })
const weekly = (ownerId: string) => ({ kind: 'weekly', ownerId, title: '原周度计划', weekStart: '2026-09-07', dueDate: '2026-09-11', expectedOutcome: '完成接口调试' })

function parsedCopy(store: Store, before: ImportBatch, mode = before.mode): ImportBatch {
  return store.insert<ImportBatch>('importBatches', { ownerId: before.ownerId, sourceId: before.sourceId, fileName: before.fileName, kind: before.kind, status: 'parsed', sourceSheets: before.sourceSheets, warnings: [], rows: before.rows.map(row => ({ ...row, result: undefined })), mode })
}

test('owners and managers can delete uploaded or parsed batches; strangers and stale versions cannot', async t => {
  const f = fixture(t)
  const uploaded = await f.service.upload(f.member, { fileName: 'note.txt', text: '可删除的上传资料' })
  assert.throws(() => f.service.deleteBatch(f.other, uploaded.id, { version: uploaded.version }), { status: 403 })
  assert.throws(() => f.service.deleteBatch(f.member, uploaded.id, {}), { status: 409 })
  const edited = f.service.edit(f.member, uploaded.id, { version: uploaded.version, rows: [] })
  assert.throws(() => f.service.deleteBatch(f.member, uploaded.id, { version: uploaded.version }), { status: 409 })
  assert.deepEqual(f.service.deleteBatch(f.member, uploaded.id, { version: edited.version }), { ok: true, deletedHistoryCount: 0 })
  assert.equal(f.service.list(f.member).length, 0)
  assert.equal(f.store.get('importSources', uploaded.sourceId), undefined)
  assert.throws(() => f.service.get(f.member, uploaded.id), { status: 404 })
  assert.throws(() => f.service.source(f.member, uploaded.id), { status: 404 })
  assert.throws(() => f.service.edit(f.member, uploaded.id, { version: edited.version, rows: [] }), { status: 404 })
  assert.throws(() => f.service.commit(f.member, uploaded.id, { version: edited.version }), { status: 404 })
  const replacement = await f.service.upload(f.member, { fileName: 'note.txt', text: '可删除的上传资料' })
  assert.notEqual(replacement.id, uploaded.id)
  const parsed = f.service.structured(f.member, { sourceKey: 'uncommitted', rows: [monthly(f.member.id)] })
  f.service.deleteBatch(f.actor, parsed.id, { version: parsed.version })
  const retried = f.service.structured(f.member, { sourceKey: 'uncommitted', rows: [monthly(f.member.id)] })
  assert.notEqual(retried.id, parsed.id)
  assert.equal(f.service.commit(f.member, retried.id, { version: retried.version }).committedCount, 1)
})

test('deleting a committed batch removes its archives and source while preserving formal records and report snapshots', t => {
  const f = fixture(t)
  let batch = f.service.structured(f.actor, { sourceKey: 'committed-delete', mode: 'draft', rows: [monthly(f.member.id), weekly(f.member.id)] })
  batch.rows[1].linkedRowId = batch.rows[0].id
  batch = f.service.edit(f.actor, batch.id, { version: batch.version, rows: batch.rows })
  const committed = f.service.commit(f.actor, batch.id, { version: batch.version })
  const preserved = Object.fromEntries(['plans', 'tasks', 'weeklyRecords'].map(collection => [collection, f.store.list(collection)]))
  const report = f.store.insert<Entity & { snapshot: unknown }>('reports', { snapshot: { ...preserved, history: f.service.history(f.actor) } })
  const auditBefore = f.store.list<AuditEvent>('events')
  assert.deepEqual(f.service.deleteBatch(f.actor, committed.id, { version: committed.version }), { ok: true, deletedHistoryCount: 2 })
  for (const collection of ['plans', 'tasks', 'weeklyRecords']) assert.deepEqual(f.store.list(collection), preserved[collection])
  assert.deepEqual(f.store.get('reports', report.id), report)
  assert.deepEqual(f.store.list('historicalRecords'), [])
  assert.equal(f.store.get('importSources', committed.sourceId), undefined)
  assert.equal(f.store.list('importLinks').length, 2)
  assert.deepEqual(f.store.list<AuditEvent>('events').slice(0, auditBefore.length), auditBefore)
  const deletion = f.store.list<AuditEvent>('events').at(-1)!
  assert.equal(deletion.entityId, committed.id)
  assert.equal(deletion.action, 'delete')
})

test('deletion is transactional when audit persistence fails', t => {
  const f = fixture(t)
  const parsed = f.service.structured(f.actor, { sourceKey: 'rollback-delete', rows: [monthly(f.member.id)] })
  const batch = f.service.commit(f.actor, parsed.id, { version: parsed.version })
  const collections = ['importBatches', 'importSources', 'historicalRecords', 'importLinks', 'events']
  const before = Object.fromEntries(collections.map(collection => [collection, f.store.list(collection)]))
  const insert = f.store.insert.bind(f.store)
  t.mock.method(f.store, 'insert', function <T extends Entity>(collection: string, input: Omit<T, keyof Entity> & Partial<Entity>): T {
    if (collection === 'events') throw new Error('Synthetic audit write failure')
    return insert<T>(collection, input)
  })
  assert.throws(() => f.service.deleteBatch(f.actor, batch.id, { version: batch.version }), /Synthetic audit/)
  for (const collection of collections) assert.deepEqual(f.store.list(collection), before[collection], `${collection} must roll back`)
  const history = f.service.history(f.actor)[0]
  assert.throws(() => f.service.deleteHistory(f.actor, history.id, { version: history.version }), /Synthetic audit/)
  for (const collection of collections) assert.deepEqual(f.store.list(collection), before[collection], `${collection} must roll back`)
})

test('deleting corrected archives preserves valid complete JSON export and restore without recreating history', t => {
  const f = fixture(t)
  const parsed = f.service.structured(f.actor, { sourceKey: 'export-after-delete', mode: 'draft', rows: [monthly(f.member.id)] })
  const batch = f.service.commit(f.actor, parsed.id, { version: parsed.version })
  const record = f.service.history(f.actor)[0]
  const corrected = f.service.editHistory(f.actor, record.id, { version: record.version, reason: '核对原始信息', row: { ...record.row, sourceStatus: '原资料待补充' } })
  f.service.deleteHistory(f.actor, corrected.id, { version: corrected.version })
  const afterHistory = exportBusinessData(f.store, f.actor, { type: 'all' })
  assert.deepEqual(afterHistory.collections.history, [])
  assert.equal(afterHistory.collections.plans[0].id, batch.rows[0].result!.id)
  assert.ok(afterHistory.collections.events.some(event => event.entityType === 'historicalRecord' && event.action === 'correct'))
  assert.ok(f.store.list<AuditEvent>('events').some(event => event.action === 'delete_history' && event.entityId === record.id))
  f.service.deleteBatch(f.actor, batch.id, { version: batch.version })
  const packet = exportBusinessData(f.store, f.actor, { type: 'all' })
  const exported = JSON.parse(JSON.stringify(packet))
  assert.deepEqual(exported.collections.history, [])
  assert.equal(exported.collections.plans[0].id, batch.rows[0].result!.id)
  const target = fixture(t)
  const broken = structuredClone(packet)
  const audit = broken.collections.events.find(event => event.entityType === 'historicalRecord')!
  ;(audit.after as HistoricalRecord).row.ownerId = 'missing-owner'
  assert.match(previewRestore(target.store, target.actor, broken).issues.join('\n'), /missing-owner/)
  const preview = previewRestore(target.store, target.actor, exported)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.actor, exported, {}, preview.fingerprint)
  assert.deepEqual(target.service.history(target.actor), [])
  assert.equal(target.store.list('plans').length, 1)
  assert.ok(target.store.list<AuditEvent>('events').some(event => event.entityId === record.id && event.action === 'correct'))
})

test('individual archive deletion enforces owner/importer permissions and does not resurrect during commit retries', t => {
  const f = fixture(t)
  const parsed = f.service.structured(f.actor, { sourceKey: 'archive-owner', rows: [monthly(f.member.id)] })
  const batch = f.service.commit(f.actor, parsed.id, { version: parsed.version })
  const original = f.service.history(f.member)[0]
  assert.throws(() => f.service.deleteHistory(f.other, original.id, { version: original.version }), { status: 404 })
  const corrected = f.service.editHistory(f.member, original.id, { version: original.version, reason: '补充说明', row: { ...original.row, blocker: '需补充数据' } })
  assert.throws(() => f.service.deleteHistory(f.member, original.id, { version: original.version }), { status: 409 })
  assert.deepEqual(f.service.deleteHistory(f.member, corrected.id, { version: corrected.version }), { ok: true })
  assert.equal(f.service.history(f.actor).length, 0)
  f.service.commit(f.actor, batch.id, { version: 1 })
  const copied = parsedCopy(f.store, batch)
  const retried = f.service.commit(f.actor, copied.id, { version: copied.version })
  assert.equal(retried.skippedCount, 1)
  assert.equal(retried.committedCount, 0)
  assert.equal(f.service.history(f.actor).length, 0)
  assert.equal(f.service.source(f.actor, batch.id).id, batch.sourceId)
  const imported = f.service.structured(f.member, { sourceKey: 'archive-importer', rows: [monthly(f.member.id)] })
  f.service.commit(f.member, imported.id, { version: imported.version })
  const record = f.service.history(f.member)[0]
  // Importers retain delete permission when a manager later assigns the archive.
  const assigned = f.service.editHistory(f.actor, record.id, { version: record.version, reason: '调整归属', row: { ...record.row, ownerId: f.other.id } })
  f.service.deleteHistory(f.member, assigned.id, { version: assigned.version })
  assert.equal(f.service.history(f.actor).length, 0)
})

test('deleted operational archives remain deleted when a draft is activated with the original business ID', t => {
  const f = fixture(t)
  const parsed = f.service.structured(f.actor, { sourceKey: 'activate-after-delete', mode: 'draft', rows: [monthly(f.member.id)] })
  const batch = f.service.commit(f.actor, parsed.id, { version: parsed.version })
  const record = f.service.history(f.actor)[0]
  f.service.deleteHistory(f.actor, record.id, { version: record.version })
  const copied = parsedCopy(f.store, batch, 'existing')
  const activated = f.service.commit(f.actor, copied.id, { version: copied.version })
  assert.deepEqual(activated.rows[0].result, batch.rows[0].result)
  assert.equal(activated.activatedCount, 1)
  assert.equal(f.store.get<MonthlyPlan>('plans', batch.rows[0].result!.id)?.status, 'published')
  assert.equal(f.store.list('plans').length, 1)
  assert.equal(f.service.history(f.actor).length, 0)
})

test('structured retries after deleting committed batches preserve old UUIDs and never duplicate formal work', t => {
  const f = fixture(t)
  for (const legacy of [false, true]) {
    const input = { sourceKey: `structured-retry-${legacy}`, mode: 'draft', rows: [monthly(f.member.id), weekly(f.member.id)] }
    let parsed = f.service.structured(f.actor, input)
    parsed.rows[1].linkedRowId = parsed.rows[0].id
    parsed = f.service.edit(f.actor, parsed.id, { version: parsed.version, rows: parsed.rows })
    const batch = f.service.commit(f.actor, parsed.id, { version: parsed.version })
    if (legacy) {
      const identity = f.store.get<Entity>('importSourceIdentities', batch.sourceId)!
      f.store.delete('importSourceIdentities', identity.id, identity.version)
    }
    const emptyFork = f.store.insert<ImportBatch>('importBatches', { ownerId: f.actor.id, sourceId: batch.sourceId, fileName: batch.fileName, kind: batch.kind, status: 'uploaded', sourceSheets: [], warnings: [], rows: [], mode: batch.mode })
    f.service.deleteBatch(f.actor, batch.id, { version: batch.version })
    f.service.deleteBatch(f.actor, emptyFork.id, { version: emptyFork.version })
    assert.throws(() => f.service.structured(f.actor, { ...input, rows: [{ ...monthly(f.member.id), title: '修改过的原始资料' }, weekly(f.member.id)] }), { status: 409 })
    let retry = f.service.structured(f.actor, input)
    assert.deepEqual(retry.rows.map(row => row.id), batch.rows.map(row => row.id))
    retry.rows[1].linkedRowId = retry.rows[0].id
    retry = f.service.edit(f.actor, retry.id, { version: retry.version, rows: retry.rows })
    const committed = f.service.commit(f.actor, retry.id, { version: retry.version })
    assert.deepEqual(committed.rows.map(row => row.result), batch.rows.map(row => row.result))
    assert.equal(committed.committedCount, 0)
    assert.equal(committed.skippedCount, 2)
    assert.equal(f.service.history(f.actor).length, 0)
  }
  for (const collection of ['plans', 'tasks', 'weeklyRecords']) assert.equal(f.store.list(collection).length, 2)
})

test('shared uploads survive deleting one batch, and deleting the last batch clears source cache', async t => {
  const f = fixture(t)
  updateAiSettings(f.store, f.actor, { baseUrl: 'https://example.test/v1', model: 'synthetic', apiKey: 'synthetic-only' })
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rows: [{ kind: 'monthly', title: '源资料', sourceRow: 1 }], warnings: [] }) } }] })))
  const uploaded = await f.service.upload(f.actor, { fileName: 'source.txt', text: '源资料' })
  const analyzed = await f.service.analyze(f.actor, uploaded.id, { version: uploaded.version })
  const parsed = f.service.edit(f.actor, analyzed.id, { version: analyzed.version, rows: analyzed.rows, completionReview: { confirmed: true, sourceItemCount: analyzed.rows.length } })
  const batch = f.service.commit(f.actor, parsed.id, { version: parsed.version })
  const copied = parsedCopy(f.store, batch)
  assert.equal(f.store.list('importParsedChunks').length, 1)
  f.service.deleteBatch(f.actor, batch.id, { version: batch.version })
  assert.equal(f.service.source(f.actor, copied.id).id, batch.sourceId)
  assert.equal(f.store.list('importParsedChunks').length, 1)
  const reviewedCopy = f.service.edit(f.actor, copied.id, { version: copied.version, rows: copied.rows, completionReview: { confirmed: true, sourceItemCount: copied.rows.length } })
  const committed = f.service.commit(f.actor, copied.id, { version: reviewedCopy.version })
  assert.equal(committed.skippedCount, 1)
  assert.equal(f.service.history(f.actor).length, 0)
  f.service.deleteBatch(f.actor, committed.id, { version: committed.version })
  assert.equal(f.store.list('importSources').length, 0)
  assert.equal(f.store.list('importParsedChunks').length, 0)
})

test('active direct and queued AI analysis block deletion until all writes settle', async t => {
  const f = fixture(t)
  updateAiSettings(f.store, f.actor, { baseUrl: 'https://example.test/v1', model: 'synthetic', apiKey: 'synthetic-only' })
  const uploaded = await f.service.upload(f.actor, { fileName: 'source.txt', text: '解析中的资料' })
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.mock.method(globalThis, 'fetch', async () => {
    await gate
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rows: [{ kind: 'monthly', title: '解析完成', sourceRow: 1 }], warnings: [] }) } }] }))
  })
  const pending = f.service.analyze(f.actor, uploaded.id, { version: uploaded.version })
  assert.throws(() => f.service.deleteBatch(f.actor, uploaded.id, { version: uploaded.version }), { status: 409 })
  release()
  const parsed = await pending
  assert.throws(() => f.service.deleteBatch(f.actor, uploaded.id, { version: uploaded.version }), { status: 409 })
  const started = f.service.startAnalysis(f.actor, parsed.id, { version: parsed.version, forceRefresh: true })
  assert.equal(started.analysis?.status, 'running')
  assert.throws(() => f.service.deleteBatch(f.actor, started.id, { version: started.version }), { status: 409 })
  const deadline = Date.now() + 5000
  while (f.service.get(f.actor, started.id).analysis?.status === 'running' && Date.now() < deadline) await setImmediate()
  const finished = f.service.get(f.actor, started.id)
  assert.equal(finished.analysis?.status, 'completed')
  f.service.deleteBatch(f.actor, finished.id, { version: finished.version })
  await setImmediate()
  for (const collection of ['importBatches', 'importSources', 'importParsedChunks', 'importJobs']) assert.equal(f.store.list(collection).length, 0)
})

test('DELETE routes support JSON versions and reject integrations without commit scope', async () => {
  const store = new Store(':memory:'), server = createApp({ store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let cookie = ''
  async function call(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', status = 200, token?: string) {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0]
    const data = await response.json()
    assert.equal(response.status, status, JSON.stringify(data))
    return data
  }
  try {
    const actor = await call('/auth/setup', { name: '接口管理员', email: 'delete-api@example.test', password: 'Synthetic-pass-2026!' }, 'POST', 201)
    const batch = await call('/imports/structured', { sourceKey: 'api-delete', rows: [monthly(actor.id)] }, 'POST', 201)
    const committed = await call(`/imports/${batch.id}/commit`, { version: batch.version })
    const history = (await call('/imports/history'))[0] as HistoricalRecord
    const readWrite = await call('/integration-tokens', { name: '仅解析', scopes: ['imports:read', 'imports:write'], expiresInDays: 1 }, 'POST', 201)
    await call(`/v1/imports/${committed.id}`, { version: committed.version }, 'DELETE', 403, readWrite.token)
    await call(`/v1/imports/history/${history.id}`, { version: history.version }, 'DELETE', 403, readWrite.token)
    await call(`/imports/history/${history.id}`, {}, 'DELETE', 409)
    assert.deepEqual(await call(`/imports/history/${history.id}`, { version: history.version }, 'DELETE'), { ok: true })
    assert.deepEqual(await call('/imports/history'), [])
    await call(`/imports/${committed.id}`, { version: batch.version }, 'DELETE', 409)
    const complete = await call('/integration-tokens', { name: '管理导入', scopes: ['imports:read', 'imports:commit'], expiresInDays: 1 }, 'POST', 201)
    assert.deepEqual(await call(`/v1/imports/${committed.id}`, { version: committed.version }, 'DELETE', 200, complete.token), { ok: true, deletedHistoryCount: 0 })
    assert.deepEqual(await call('/imports'), [])
    await call(`/imports/${committed.id}`, undefined, 'GET', 404)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    store.close()
  }
})
