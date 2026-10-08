import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { ApiError } from '../src/api.ts'
import { exchangeDingTalk, identityThenWorkspace } from '../src/dingtalk-access.ts'

function legacyDingTalk(t: TestContext) {
  const timeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')!
  Object.defineProperty(AbortSignal, 'timeout', { configurable: true, value: undefined })
  t.after(() => Object.defineProperty(AbortSignal, 'timeout', timeout))
  t.mock.getter(globalThis.navigator, 'userAgent', () => 'DingTalk/7.0.0')
  t.mock.timers.enable({ apis: ['setTimeout'] })
}

test('DingTalk without AbortSignal.timeout can read configuration and cleans up its request timer', async t => {
  legacyDingTalk(t)
  let signal: AbortSignal | undefined
  const request = t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    assert.equal(url, '/api/auth/dingtalk/config')
    signal = options.signal!
    return Response.json({ configured: false })
  })
  await assert.rejects(exchangeDingTalk(), /钉钉接入尚未配置/)
  assert.equal(request.mock.callCount(), 1)
  t.mock.timers.tick(15000)
  assert.equal(signal?.aborted, false)
})

test('DingTalk config timeout aborts the request and blocks business loading with a readable error', async t => {
  legacyDingTalk(t)
  let signal: AbortSignal | undefined
  const request = t.mock.method(globalThis, 'fetch', (_url: string, options: RequestInit) => {
    signal = options.signal!
    return new Promise<Response>((_resolve, reject) => {
      signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    })
  })
  let loads = 0
  const pending = identityThenWorkspace({
    dingTalk: true, verify: exchangeDingTalk,
    normalSession: async () => assert.fail('must verify DingTalk identity'),
    load: async () => { loads++; return 'business' },
  })
  const rejected = assert.rejects(pending, /钉钉身份验证请求超时/)
  t.mock.timers.tick(9999)
  assert.equal(signal?.aborted, false)
  t.mock.timers.tick(1)
  await rejected
  assert.equal(signal?.aborted, true)
  assert.equal(request.mock.callCount(), 1)
  assert.equal(loads, 0)
})

test('DingTalk deadline covers reading the response body after headers arrive', async t => {
  legacyDingTalk(t)
  let reading = false
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => ({
    ok: true, status: 200, headers: new Headers(),
    text: () => new Promise<string>((_resolve, reject) => {
      reading = true
      options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
    }),
  }))
  const rejected = assert.rejects(exchangeDingTalk(), /钉钉身份验证请求超时/)
  await Promise.resolve()
  assert.equal(reading, true)
  t.mock.timers.tick(10000)
  await rejected
})

test('DingTalk keeps non-timeout API errors and clears the failed request timer', async t => {
  legacyDingTalk(t)
  let signal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (_url: string, options: RequestInit) => {
    signal = options.signal!
    return Response.json({ error: '身份配置暂不可用', code: 'DINGTALK_UNAVAILABLE' }, { status: 503 })
  })
  await assert.rejects(exchangeDingTalk(), error => error instanceof ApiError
    && error.status === 503 && error.code === 'DINGTALK_UNAVAILABLE' && error.message === '身份配置暂不可用')
  t.mock.timers.tick(15000)
  assert.equal(signal?.aborted, false)
})
