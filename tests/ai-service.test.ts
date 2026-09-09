import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AuditEvent, User } from '../shared/types.ts'
import { callAiJson, readAiSettings, resolveAiSettings, testAiConnection, updateAiSettings } from '../server/ai-service.ts'
import { HttpError, Store } from '../server/store.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:')
  const user = store.insert<User>('users', { name: '测试管理者', email: 'ai@example.test', role: 'manager', position: '负责人', active: true })
  const variables = ['AI_BASE_URL', 'AI_MODEL', 'AI_VISION_MODEL', 'AI_API_KEY']
  const previous = Object.fromEntries(variables.map(key => [key, process.env[key]]))
  for (const key of variables) delete process.env[key]
  t.after(() => {
    for (const key of variables) {
      if (previous[key] === undefined) delete process.env[key]
      else process.env[key] = previous[key]
    }
    store.close()
  })
  return { store, user, configure: () => updateAiSettings(store, user, { baseUrl: 'https://ai.example.test/v1/', model: 'text-test', visionModel: 'vision-test', apiKey: 'private-test-key' }) }
}

function completion(content: string) {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { headers: { 'content-type': 'application/json' } })
}

test('AI settings are manager-controlled and never return or audit credentials', t => {
  const { store, user, configure } = fixture(t)
  assert.deepEqual(readAiSettings(store), { baseUrl: '', model: '', visionModel: '', configured: false, hasApiKey: false, source: 'none' })
  assert.throws(() => updateAiSettings(store, { ...user, role: 'member' }, { apiKey: 'forbidden-key' }), { status: 403 })
  const safe = configure()
  assert.equal(safe.baseUrl, 'https://ai.example.test/v1')
  assert.equal(safe.configured, true)
  assert.equal(safe.source, 'settings')
  assert.equal(Object.hasOwn(safe, 'apiKey'), false)
  assert.equal(JSON.stringify(store.list<AuditEvent>('events')).includes('private-test-key'), false)
  updateAiSettings(store, user, { apiKey: '', model: 'text-next', visionModel: '' })
  assert.equal(resolveAiSettings(store).apiKey, 'private-test-key')
  assert.equal(readAiSettings(store).visionModel, 'text-next')
  updateAiSettings(store, user, { apiKey: 'replacement-key' })
  assert.equal(resolveAiSettings(store).apiKey, 'replacement-key')
  assert.equal(JSON.stringify(store.list<AuditEvent>('events')).includes('replacement-key'), false)
  const cleared = updateAiSettings(store, user, { clearApiKey: true })
  assert.equal(cleared.hasApiKey, false)
  assert.equal(cleared.configured, false)
})

test('environment configuration remains compatible and persisted settings take precedence', t => {
  const { store, user } = fixture(t)
  process.env.AI_BASE_URL = 'http://intranet.example.test:8000/v1/'
  process.env.AI_MODEL = 'environment-model'
  process.env.AI_API_KEY = 'environment-key'
  assert.equal(readAiSettings(store).source, 'environment')
  assert.equal(readAiSettings(store).visionModel, 'environment-model')
  updateAiSettings(store, user, { model: 'saved-model', apiKey: '' })
  process.env.AI_MODEL = 'changed-environment-model'
  assert.equal(readAiSettings(store).model, 'saved-model')
  assert.equal(resolveAiSettings(store).apiKey, 'environment-key')
  updateAiSettings(store, user, { clearApiKey: true })
  assert.equal(resolveAiSettings(store).apiKey, '')
  assert.equal(readAiSettings(store).source, 'settings')
})

test('configuration rejects embedded secrets and unsafe URLs atomically but allows internal HTTP', t => {
  const { store, user, configure } = fixture(t)
  configure()
  const events = store.list('events').length
  for (const baseUrl of ['ftp://example.test', 'https://name:password@example.test', 'https://example.test?key=secret', 'https://example.test#fragment', 'https://example.test?', 'https://example.test#', 'https://example.test\n/v1']) {
    assert.throws(() => updateAiSettings(store, user, { baseUrl, apiKey: 'new-secret' }), { status: 400 })
  }
  assert.throws(() => updateAiSettings(store, user, { apiKey: 'a\r\nb' }), { status: 400 })
  assert.throws(() => updateAiSettings(store, user, { apiKey: 'new-secret', clearApiKey: true }), { status: 400 })
  assert.throws(() => updateAiSettings(store, user, { clearApiKey: 'true' }), { status: 400 })
  assert.equal(resolveAiSettings(store).apiKey, 'private-test-key')
  assert.equal(store.list('events').length, events)
  assert.equal(updateAiSettings(store, user, { baseUrl: 'http://10.0.0.20:8000/v1' }).configured, true)
})

test('JSON requests select the multimodal model, preserve image parts and refuse redirects', async t => {
  const { store, configure } = fixture(t)
  configure()
  const messages = [{ role: 'user' as const, content: [{ type: 'text' as const, text: '读取表格，返回 JSON' }, { type: 'image_url' as const, image_url: { url: 'data:image/png;base64,dGVzdA==' } }] }]
  let called = false
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    called = true
    assert.equal(url, 'https://ai.example.test/v1/chat/completions')
    assert.equal(options.redirect, 'error')
    assert.equal(new Headers(options.headers).get('authorization'), 'Bearer private-test-key')
    const body = JSON.parse(String(options.body))
    assert.equal(body.model, 'vision-test')
    assert.deepEqual(body.messages, messages)
    assert.deepEqual(body.response_format, { type: 'json_object' })
    return completion('```json\n{"rows":[{"title":"测试"}]}\n```')
  })
  assert.deepEqual(await callAiJson(store, messages, { vision: true }), { rows: [{ title: '测试' }] })
  assert.equal(called, true)
})

test('AI failures and malformed JSON are sanitized without revealing upstream text or keys', async t => {
  const { store, configure } = fixture(t)
  configure()
  const responses = [
    () => Promise.resolve(new Response('private-test-key provider private diagnostics', { status: 401 })),
    () => Promise.resolve(new Response('not JSON private-test-key')),
    () => Promise.resolve(completion('Here is the result: {"ok":true} private-test-key')),
    () => Promise.resolve(completion('{"ok":true} {"extra":true}')),
    () => Promise.resolve(completion('')),
    () => Promise.resolve(new Response('{"choices":[]}')),
    () => Promise.reject(new Error('private-test-key request to secret-upstream-path')),
  ]
  let index = 0
  t.mock.method(globalThis, 'fetch', () => responses[index++]())
  for (const _ of responses) {
    await assert.rejects(callAiJson(store, [{ role: 'user', content: '{}' }]), error => {
      assert.ok(error instanceof HttpError)
      assert.equal(error.status, 502)
      assert.doesNotMatch(error.message, /private-test-key|private diagnostics|secret-upstream-path/)
      return true
    })
  }
})

test('response limits apply to streamed content as well as Content-Length', async t => {
  const { store, configure } = fixture(t)
  configure()
  let cancelled = 0
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(4 * 1024 * 1024 + 1)) },
      cancel() { cancelled++ },
    })
    return new Response(stream, calls === 1 ? { headers: { 'content-length': String(4 * 1024 * 1024 + 1) } } : undefined)
  })
  await assert.rejects(callAiJson(store, [{ role: 'user', content: '{}' }]), { status: 502 })
  await assert.rejects(callAiJson(store, [{ role: 'user', content: '{}' }]), { status: 502 })
  assert.equal(cancelled, 2)
})

test('timeout covers a stalled response body and unconfigured services never call fetch', async t => {
  const { store, configure } = fixture(t)
  let calls = 0, cancelled = false
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled = true } }))
  })
  await assert.rejects(callAiJson(store, [{ role: 'user', content: '{}' }]), { status: 503 })
  assert.equal(calls, 0)
  configure()
  await assert.rejects(callAiJson(store, [{ role: 'user', content: '{}' }], { timeoutMs: 10 }), { status: 504 })
  assert.equal(cancelled, true)
  await assert.rejects(callAiJson(store, [], { timeoutMs: 0 }), { status: 400 })
})

test('connection test is manager-only and sends no business data', async t => {
  const { store, user, configure } = fixture(t)
  configure()
  store.insert<User>('users', { name: '业务保密项目', email: 'private@example.test', role: 'member', position: '测试成员', active: true })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    calls++
    const body = JSON.parse(String(options.body))
    assert.equal(body.model, 'text-test')
    assert.doesNotMatch(String(options.body), /业务保密项目|ai@example.test/)
    return completion('{"ok":true,"private":"should not be echoed"}')
  })
  await assert.rejects(testAiConnection(store, { ...user, role: 'member' }), { status: 403 })
  assert.equal(calls, 0)
  assert.deepEqual(await testAiConnection(store, user), { ok: true, model: 'text-test' })
})
