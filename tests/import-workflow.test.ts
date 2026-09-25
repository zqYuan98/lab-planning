import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { ImportService } from '../server/import-service.ts'
import { updateAiSettings } from '../server/ai-service.ts'
import { createApp } from '../server/app.ts'
import { applyMigrations, STORAGE_VERSION } from '../server/storage-migrations.ts'
import type { ImportBatch } from '../shared/import-types.ts'
import type { MonthlyPlan, User, WeeklyRecord } from '../shared/types.ts'

function fixture() {
  const store = new Store(':memory:'), domain = new Domain(store), service = new ImportService(store)
  const actor = domain.setup({ name: '管理者', email: 'manager@example.test', password: 'Example-password-2026!' })
  const member = domain.createUser(actor, { name: '成员甲', email: 'member@example.test', password: 'Example-password-2026!', position: '研发', role: 'member' })
  return { store, domain, service, actor, member }
}
function monthly(ownerId: string) { return { kind: 'monthly', title: '样机交付', month: '2026-09', dueDate: '2026-09-30', ownerId, category: '研发', expectedOutcome: '交付样机', acceptanceCriteria: '通过评审', actualOutcome: '已提供历史样机', sourceStatus: '已完成' } }
function weekly(ownerId: string) { return { kind: 'weekly', title: '样机调试', weekStart: '2026-09-07', dueDate: '2026-09-11', ownerId, expectedOutcome: '完成调试', actualOutcome: '串口调通' } }

test('structured history permits missing fields, preserves original facts, and request retries are idempotent', () => {
  const f = fixture()
  try {
    const input = { sourceKey: 'dingtalk-history-001', rows: [{ kind: 'monthly', title: '旧事项', sourceText: '原表只记录名称和完成', actualOutcome: '完成', sourceStatus: '已完成' }] }
    const batch = f.service.structured(f.actor, input)
    assert.ok(batch.rows[0].issues.includes('缺少验收标准（原表没有时需补充）'))
    assert.equal(f.service.structured(f.actor, input).id, batch.id)
    const committed = f.service.commit(f.actor, batch.id, { version: batch.version })
    assert.equal(committed.committedCount, 1)
    assert.equal(f.service.commit(f.actor, batch.id, { version: 1 }).id, committed.id)
    assert.equal(f.service.history(f.actor).length, 1)
    assert.equal(f.service.history(f.actor)[0].row.sourceStatus, '已完成')
    assert.equal(f.store.list('plans').length, 0)
    assert.throws(() => f.service.structured(f.actor, { ...input, rows: [{ kind: 'monthly', title: '变更' }] }), /内容已改变/)
  } finally { f.store.close() }
})

test('monthly and weekly drafts commit atomically with preserved source facts and no fabricated acceptance', () => {
  const f = fixture()
  try {
    let batch = f.service.structured(f.actor, { sourceKey: 'linked', mode: 'draft', rows: [monthly(f.member.id), weekly(f.member.id)] })
    batch.rows[1].linkedRowId = batch.rows[0].id
    batch = f.service.edit(f.actor, batch.id, { version: batch.version, mode: 'draft', rows: batch.rows })
    assert.deepEqual(batch.rows.map(r => r.issues), [[], []])
    const committed = f.service.commit(f.actor, batch.id, { version: batch.version })
    const plan = f.store.list<MonthlyPlan>('plans')[0], record = f.store.list<WeeklyRecord>('weeklyRecords')[0]
    assert.equal(plan.status, 'draft'); assert.equal(plan.acceptanceStatus, 'pending')
    assert.equal(record.monthlyPlanId, plan.id); assert.equal(record.submitted, false)
    assert.equal(record.actualOutcome, '串口调通'); assert.equal(record.status, 'planned')
    assert.equal(f.service.history(f.actor)[0].row.actualOutcome, '已提供历史样机')
    f.service.commit(f.actor, batch.id, { version: committed.version })
    assert.equal(f.store.list('plans').length, 1); assert.equal(f.store.list('weeklyRecords').length, 1)
  } finally { f.store.close() }
})

test('invalid relation or current account permissions cannot partially write or impersonate another member', () => {
  const f = fixture()
  try {
    const batch = f.service.structured(f.member, { sourceKey: 'spoof', mode: 'draft', rows: [monthly(f.actor.id)] })
    assert.throws(() => f.service.commit(f.member, batch.id, { version: batch.version }), { status: 403 })
    assert.equal(f.store.list('plans').length, 0)
    assert.throws(() => f.service.get(f.member, f.service.structured(f.actor, { sourceKey: 'private', rows: [monthly(f.actor.id)] }).id), /无权查看/)
    let linked = f.service.structured(f.actor, { sourceKey: 'atomic', mode: 'draft', rows: [monthly(f.member.id), weekly(f.member.id)] })
    linked.rows[1].linkedRowId = linked.rows[0].id
    linked = f.service.edit(f.actor, linked.id, { version: linked.version, rows: linked.rows })
    f.domain.updateUser(f.actor, f.member.id, { version: f.member.version, active: false })
    assert.throws(() => f.service.commit(f.actor, linked.id, { version: linked.version }), /有效负责人/)
    assert.equal(f.store.list('plans').length, 0)
  } finally { f.store.close() }
})

test('file source persists; AI only proposes values; an old analysis cannot overwrite newer edits', async t => {
  const f = fixture()
  try {
    updateAiSettings(f.store, f.actor, { baseUrl: 'https://example.test/v1', model: 'multimodal-test', apiKey: 'fixture-only' })
    const batch = await f.service.upload(f.actor, { fileName: 'monthly.csv', mimeType: 'text/csv', base64: Buffer.from('标题,姓名\n样机,成员甲\n').toString('base64') })
    assert.equal((await f.service.upload(f.actor, { fileName: 'renamed.csv', mimeType: 'text/csv', base64: Buffer.from('标题,姓名\n样机,成员甲\n').toString('base64') })).id, batch.id)
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    t.mock.method(globalThis, 'fetch', async () => {
      await gate
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ rows: [{ ...monthly(f.actor.id), ownerName: f.member.name, sourceRow: 2 }], warnings: [] }) } }] }), { headers: { 'content-type': 'application/json' } })
    })
    const parsing = f.service.analyze(f.actor, batch.id, { version: batch.version })
    f.service.edit(f.actor, batch.id, { version: batch.version, rows: [], mode: 'draft' })
    release()
    await assert.rejects(parsing, /批次已更新/)
    const current = f.service.get(f.actor, batch.id)
    const parsed = await f.service.analyze(f.actor, batch.id, { version: current.version })
    assert.equal(parsed.rows[0].ownerId, f.member.id)
    assert.match(parsed.rows[0].sourceText, /样机/)
    assert.equal(f.service.source(f.actor, batch.id).base64, Buffer.from('标题,姓名\n样机,成员甲\n').toString('base64'))
    assert.equal(f.store.list('plans').length, 0)
  } finally { f.store.close() }
})

test('failed model response leaves upload intact and does not create business records', async t => {
  const f = fixture()
  try {
    const batch = await f.service.upload(f.actor, { fileName: 'note.txt', text: '2026年9月工作事项：样机调试' })
    await assert.rejects(f.service.analyze(f.actor, batch.id, { version: batch.version }), /尚未完整配置/)
    updateAiSettings(f.store, f.actor, { baseUrl: 'https://example.test/v1', model: 'test', apiKey: 'fixture-only' })
    t.mock.method(globalThis, 'fetch', async () => new Response('{invalid', { status: 200 }))
    await assert.rejects(f.service.analyze(f.actor, batch.id, { version: batch.version }), /响应格式无效/)
    assert.equal(f.service.get(f.actor, batch.id).status, 'uploaded')
    assert.equal(f.store.list('plans').length, 0)
  } finally { f.store.close() }
})

test('existing database rows survive baseline migration; newer data format blocks downgrade', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE entities(collection TEXT,id TEXT,version INTEGER,data TEXT)')
    db.prepare('INSERT INTO entities VALUES(?,?,?,?)').run('plans', 'stable-id', 8, '{"title":"旧计划"}')
    applyMigrations(db); applyMigrations(db)
    assert.equal(db.prepare('SELECT version FROM entities').get()?.version, 8)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM schema_migrations').get()?.n, STORAGE_VERSION)
    assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='delivery_due'").get())
    db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(STORAGE_VERSION + 1, 'future', new Date().toISOString())
    assert.throws(() => applyMigrations(db), /数据库版本高于/)
    assert.equal(db.prepare('SELECT data FROM entities').get()?.data, '{"title":"旧计划"}')
  } finally { db.close() }
})

test('cookie API and scoped agent API enforce independent authentication, safe settings and token revocation', async () => {
  const store = new Store(':memory:'), server = createApp({ store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let cookie = ''
  async function call(path: string, body?: unknown, options: { method?: string; token?: string; status?: number } = {}) {
    const response = await fetch(`${origin}/api${path}`, { method: options.method ?? (body === undefined ? 'GET' : 'POST'), headers: { origin, 'content-type': 'application/json', ...(options.token ? { authorization: `Bearer ${options.token}` } : { cookie }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0]
    const data = await response.json()
    assert.equal(response.status, options.status ?? (response.status === 201 ? 201 : 200), JSON.stringify(data))
    return data
  }
  try {
    await call('/auth/setup', { name: '管理员', email: 'api@example.test', password: 'Example-password-2026!' })
    const settings = await call('/ai/settings', { baseUrl: 'https://example.test/v1', model: 'test', apiKey: 'unique-fixture-secret' }, { method: 'PUT' })
    assert.equal(settings.hasApiKey, true)
    assert.equal(JSON.stringify(await call('/workspace')).includes('unique-fixture-secret'), false)
    const token = await call('/integration-tokens', { name: '只写草稿', scopes: ['imports:read', 'imports:write'], expiresInDays: 1 })
    assert.equal(JSON.stringify(await call('/integration-tokens')).includes(token.token), false)
    assert.equal(JSON.stringify(store.list('events')).includes('unique-fixture-secret'), false)
    const batch = await call('/v1/imports/structured', { sourceKey: 'agent-one', rows: [{ kind: 'monthly', title: '历史资料' }] }, { token: token.token }) as ImportBatch
    await call(`/v1/imports/${batch.id}/commit`, { version: batch.version }, { token: token.token, status: 403 })
    await call(`/v1/imports/${batch.id}/COMMIT/`, { version: batch.version }, { token: token.token, status: 403 })
    await call('/v1/imports', undefined, { status: 401 }) // Cookie cannot silently become an API token.
    await call(`/integration-tokens/${token.id}/revoke`, {})
    await call('/v1/imports', undefined, { token: token.token, status: 401 })
    assert.equal(store.list('historicalRecords').length, 0)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close() }
})
