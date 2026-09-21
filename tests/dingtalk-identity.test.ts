import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import express, { type ErrorRequestHandler } from 'express'
import { Store, HttpError } from '../server/store.ts'
import { createOriginGuard, createSession, requireAuth, type StoredUser } from '../server/auth.ts'
import { dingtalkRouter } from '../server/dingtalk-routes.ts'
import type { DingTalkClient, DingTalkIdentity } from '../server/dingtalk.ts'

async function fixture(options: { configured?: boolean; identity?: (code: string) => Promise<{ corpId: string; userid: string }> } = {}) {
  const store = new Store(':memory:')
  const addUser = (name: string, patch: Partial<StoredUser> = {}) => store.insert<StoredUser>('users', { name, email: `${name}@test.local`, role: 'member', position: '', active: true, credentialVersion: 1, passwordHash: 'not-exposed', ...patch })
  const user = addUser('member'), other = addUser('other')
  let now = Date.now(), calls = 0
  const client: DingTalkClient = {
    configured: options.configured ?? true, corpId: 'ding-corp', clientId: 'client',
    async getIdentity(code) { calls++; return options.identity ? options.identity(code) : { corpId: 'ding-corp', userid: code.startsWith('other') ? 'dt-other' : 'dt-member' } },
    async send() { throw new Error('Tests must never send messages') }, async result() { return 'pending' },
  }
  const app = express()
  app.use('/api', createOriginGuard(), express.json(), dingtalkRouter(store, client, () => now))
  app.get('/api/me', requireAuth(store), (req, res) => res.json(req.user))
  const errors: ErrorRequestHandler = (error, _req, res, _next) => res.status(error instanceof HttpError ? error.status : 500).json({ error: error.message })
  app.use(errors)
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  function browser(login?: StoredUser, firstCookieWins = false) {
    const cookies = new Map<string, string>()
    function loginAs(account: StoredUser) { cookies.set('lab_session', createSession(store, store.get<StoredUser>('users', account.id)!)) }
    if (login) loginAs(login)
    async function request(path: string, body?: unknown, status = 200, extraHeaders: Record<string, string> = {}) {
      const response = await fetch(`${origin}/api${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', origin, cookie: [...cookies].map(([key, value]) => `${key}=${value}`).join('; '), ...extraHeaders }, body: body === undefined ? undefined : JSON.stringify(body) })
      const seen = new Set<string>()
      for (const header of response.headers.getSetCookie()) {
        const pair = header.split(';')[0], index = pair.indexOf('=')
        const key = pair.slice(0, index), value = pair.slice(index + 1)
        // Model clients or intermediaries that preserve the first same-name header.
        if (firstCookieWins && seen.has(key)) continue
        seen.add(key)
        if (value) cookies.set(key, value); else cookies.delete(key)
      }
      const data = await response.json()
      assert.equal(response.status, status, JSON.stringify(data))
      return { data, response }
    }
    return { cookies, request, loginAs }
  }
  const bind = (account = user, userid = 'dt-member') => store.insert<DingTalkIdentity>('externalIdentities', { provider: 'dingtalk', corpId: client.corpId, userid, userId: account.id })
  return { store, user, other, addUser, client, browser, bind, advance: (ms: number) => { now += ms }, calls: () => calls, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close() } }
}

test('DingTalk config and disabled exchange do not reveal server secrets or call provider', async () => {
  const f = await fixture({ configured: false })
  try {
    const b = f.browser()
    assert.deepEqual((await b.request('/auth/dingtalk/config')).data, { configured: false, corpId: 'ding-corp', clientId: 'client' })
    await b.request('/auth/dingtalk/exchange', { code: 'secret-code' }, 503)
    assert.equal(f.calls(), 0)
    await b.request('/dingtalk/binding', undefined, 401)
  } finally { await f.close() }
})

test('DingTalk explicit binding requires authenticated account and browser proof, consumes it once, then normal SSO works', async () => {
  const f = await fixture()
  try {
    const b = f.browser()
    const exchanged = await b.request('/auth/dingtalk/exchange', { code: 'code-one' })
    assert.deepEqual(exchanged.data, { authenticated: false, bindingRequired: true })
    const cookie = exchanged.response.headers.getSetCookie().find(value => value.startsWith('lab_dingtalk_binding=') && !value.startsWith('lab_dingtalk_binding=;'))!
    assert.match(cookie, /HttpOnly/)
    assert.match(cookie, /SameSite=Strict/)
    assert.match(cookie, /Path=\/api/)
    assert.equal(f.store.list('externalIdentities').length, 0)
    await b.request('/dingtalk/bind', {}, 401)
    b.loginAs(f.user)
    const pending = (await b.request('/dingtalk/binding')).data
    assert.equal(pending.pending.corpId, 'ding-corp')
    assert.equal(pending.pending.userid, 'dt-member')
    await f.browser(f.other).request('/dingtalk/bind', {}, 400)
    const oldProof = b.cookies.get('lab_dingtalk_binding')!
    assert.equal((await b.request('/dingtalk/bind', {})).data.bound, true)
    b.cookies.set('lab_dingtalk_binding', oldProof)
    await b.request('/dingtalk/bind', {}, 400)
    assert.deepEqual(f.store.list<DingTalkIdentity>('externalIdentities').map(item => [item.provider, item.userId, item.userid]), [['dingtalk', f.user.id, 'dt-member']])
    assert.deepEqual(f.store.list<{ action: string; actorId: string }>('externalIdentityEvents').map(item => [item.action, item.actorId]), [['bound', f.user.id]])
    const signedIn = f.browser()
    const response = await signedIn.request('/auth/dingtalk/exchange', { code: 'code-two' })
    assert.equal(response.data.authenticated, true)
    assert.equal(response.data.user.id, f.user.id)
    assert.equal(response.data.user.passwordHash, undefined)
    assert.equal((await signedIn.request('/me')).data.id, f.user.id)
  } finally { await f.close() }
})

test('DingTalk exchange sends one challenge cookie and works when only the first same-name header survives', async () => {
  const f = await fixture()
  const proofHeaders = (response: Response) => response.headers.getSetCookie().filter(value => value.startsWith('lab_dingtalk_binding='))
  try {
    const b = f.browser(f.user, true)
    const first = await b.request('/auth/dingtalk/exchange', { code: 'first-proof' })
    assert.equal(proofHeaders(first.response).length, 1)
    assert.match(proofHeaders(first.response)[0], /^lab_dingtalk_binding=[a-f0-9]{64};/)
    assert.equal((await b.request('/dingtalk/binding')).data.pending.userid, 'dt-member')
    const oldProof = b.cookies.get('lab_dingtalk_binding')!

    const replaced = await b.request('/auth/dingtalk/exchange', { code: 'replacement-proof' })
    assert.equal(proofHeaders(replaced.response).length, 1)
    const latestProof = b.cookies.get('lab_dingtalk_binding')!
    assert.notEqual(latestProof, oldProof)
    const stale = f.browser(f.user)
    stale.cookies.set('lab_dingtalk_binding', oldProof)
    assert.equal((await stale.request('/dingtalk/binding')).data.pending, undefined)
    await stale.request('/dingtalk/bind', {}, 400)
    assert.equal((await b.request('/dingtalk/binding')).data.pending.userid, 'dt-member')

    const rejected = await b.request('/auth/dingtalk/exchange', { code: 'replacement-proof' }, 409)
    assert.equal(proofHeaders(rejected.response).length, 1)
    assert.match(proofHeaders(rejected.response)[0], /^lab_dingtalk_binding=;/)
    assert.equal(b.cookies.has('lab_dingtalk_binding'), false)
    stale.cookies.set('lab_dingtalk_binding', latestProof)
    assert.equal((await stale.request('/dingtalk/binding')).data.pending, undefined)
    await stale.request('/dingtalk/bind', {}, 400)
    assert.equal(f.store.list('externalIdentities').length, 0)

    await b.request('/auth/dingtalk/exchange', { code: 'bind-proof' })
    await b.request('/dingtalk/bind', {})
    const sso = await b.request('/auth/dingtalk/exchange', { code: 'sso-proof' })
    assert.equal(sso.data.authenticated, true)
    assert.equal(proofHeaders(sso.response).length, 1)
    assert.match(proofHeaders(sso.response)[0], /^lab_dingtalk_binding=;/)
    assert.equal(b.cookies.has('lab_dingtalk_binding'), false)
    assert.equal((await b.request('/me')).data.id, f.user.id)
  } finally { await f.close() }
})

test('DingTalk rejects code replay, arbitrary identity parameters, foreign corp and cross-origin writes', async () => {
  const f = await fixture()
  try {
    const b = f.browser(f.user)
    await b.request('/auth/dingtalk/exchange', { code: 'same-code' })
    await b.request('/auth/dingtalk/exchange', { code: 'same-code' }, 409)
    assert.equal(f.calls(), 1)
    await b.request('/auth/dingtalk/exchange', { code: 'new-code', userid: 'spoofed' }, 400)
    await b.request('/auth/dingtalk/exchange', { code: 'cross-site' }, 403, { origin: 'https://evil.test' })
    await b.request('/dingtalk/bind', { userid: 'spoofed' }, 400)
  } finally { await f.close() }
  const foreign = await fixture({ identity: async () => ({ corpId: 'other-corp', userid: 'dt-member' }) })
  try { await foreign.browser().request('/auth/dingtalk/exchange', { code: 'code' }, 403); assert.equal(foreign.store.list('externalIdentities').length, 0) } finally { await foreign.close() }
})

test('DingTalk challenges expire, are replaced by new exchange, and stay tied to the initiating account', async () => {
  const f = await fixture()
  try {
    const b = f.browser(f.user)
    await b.request('/auth/dingtalk/exchange', { code: 'first' })
    const firstProof = b.cookies.get('lab_dingtalk_binding')!
    await b.request('/auth/dingtalk/exchange', { code: 'second' })
    const latestProof = b.cookies.get('lab_dingtalk_binding')!
    b.cookies.set('lab_dingtalk_binding', firstProof)
    await b.request('/dingtalk/bind', {}, 400)
    b.cookies.set('lab_dingtalk_binding', latestProof)
    b.loginAs(f.other)
    assert.equal((await b.request('/dingtalk/binding')).data.pending, undefined)
    await b.request('/dingtalk/bind', {}, 400)
    b.loginAs(f.user)
    await b.request('/auth/dingtalk/exchange', { code: 'third' })
    f.advance(5 * 60_000 + 1)
    assert.equal((await b.request('/dingtalk/binding')).data.pending, undefined)
    await b.request('/dingtalk/bind', {}, 400)
  } finally { await f.close() }
})

test('DingTalk rejects both directions of binding conflicts and cannot switch a logged-in account through SSO', async () => {
  const f = await fixture()
  try {
    const first = f.browser(f.user), second = f.browser(f.other)
    await first.request('/auth/dingtalk/exchange', { code: 'first' })
    await second.request('/auth/dingtalk/exchange', { code: 'second' })
    await first.request('/dingtalk/bind', {})
    await second.request('/dingtalk/bind', {}, 409)
    await second.request('/auth/dingtalk/exchange', { code: 'third' }, 409)
    assert.equal((await second.request('/me')).data.id, f.other.id)
    await first.request('/auth/dingtalk/exchange', { code: 'other-new' }, 409)
    assert.equal(f.store.list('externalIdentities').length, 1)
  } finally { await f.close() }
})

test('DingTalk SSO respects inactive, pending, rejected and current credential versions without manager role escalation', async () => {
  const f = await fixture()
  try {
    f.bind()
    for (const patch of [{ active: false }, { active: true, registrationStatus: 'pending' as const }, { active: true, registrationStatus: 'rejected' as const }]) {
      const current = f.store.get<StoredUser>('users', f.user.id)!
      f.store.update<StoredUser>('users', current.id, current.version, patch)
      await f.browser().request('/auth/dingtalk/exchange', { code: `code-${current.version}` }, 403)
    }
    const current = f.store.get<StoredUser>('users', f.user.id)!
    f.store.update<StoredUser>('users', current.id, current.version, { active: true, registrationStatus: 'approved', credentialVersion: 2 })
    const browser = f.browser()
    const { data } = await browser.request('/auth/dingtalk/exchange', { code: 'approved-code' })
    assert.equal(data.user.role, 'member')
    assert.equal((await browser.request('/me')).data.id, f.user.id)
    const updated = f.store.get<StoredUser>('users', f.user.id)!
    f.store.update<StoredUser>('users', updated.id, updated.version, { credentialVersion: 3 })
    await browser.request('/me', undefined, 401)
  } finally { await f.close() }
})

test('DingTalk unbinding revokes all local sessions, clears cookies and removes mapping', async () => {
  const f = await fixture()
  try {
    f.bind()
    const b = f.browser(f.user), anotherSession = f.browser(f.user)
    const otherAccount = f.browser(f.other)
    const { response } = await b.request('/dingtalk/unbind', {})
    assert.ok(response.headers.getSetCookie().some(value => value.startsWith('lab_session=;')))
    assert.equal(f.store.list('externalIdentities').length, 0)
    assert.deepEqual(f.store.list<{ action: string; actorId: string }>('externalIdentityEvents').map(item => [item.action, item.actorId]), [['unbound', f.user.id]])
    await b.request('/me', undefined, 401)
    await anotherSession.request('/me', undefined, 401)
    assert.equal((await otherAccount.request('/me')).data.id, f.other.id)
    assert.equal((await f.browser().request('/auth/dingtalk/exchange', { code: 'after-unbind' })).data.bindingRequired, true)
  } finally { await f.close() }
})

test('DingTalk exchange bounds failed per-IP attempts and does not leak unexpected provider errors', async () => {
  const f = await fixture({ identity: async () => { throw new Error('access_token=secret-code-sensitive') } })
  try {
    const b = f.browser()
    for (let i = 0; i < 20; i++) {
      const { data } = await b.request('/auth/dingtalk/exchange', { code: `code-${i}` }, 401)
      assert.equal(JSON.stringify(data).includes('secret'), false)
    }
    const result = await b.request('/auth/dingtalk/exchange', { code: 'limited' }, 429)
    assert.ok(Number(result.response.headers.get('retry-after')) > 0)
    assert.equal(f.calls(), 20)
    f.advance(15 * 60_000 + 1)
    await b.request('/auth/dingtalk/exchange', { code: 'new-window' }, 401)
    assert.equal(f.calls(), 21)
  } finally { await f.close() }
})

test('DingTalk permits office colleagues to share one IP while bounding total successful exchanges', async () => {
  const f = await fixture()
  try {
    f.bind()
    const b = f.browser()
    for (let i = 0; i < 120; i++) {
      const { data } = await b.request('/auth/dingtalk/exchange', { code: `office-${i}` })
      assert.equal(data.authenticated, true)
    }
    assert.equal(f.calls(), 120)
    await b.request('/auth/dingtalk/exchange', { code: 'office-burst-limit' }, 429)
    assert.equal(f.calls(), 120)
    f.advance(15 * 60_000 + 1)
    assert.equal((await b.request('/auth/dingtalk/exchange', { code: 'office-next-window' })).data.authenticated, true)
  } finally { await f.close() }
})

test('DingTalk successful exchanges do not consume or erase earlier failures', async () => {
  const f = await fixture({ identity: async code => {
    if (code.startsWith('bad-')) throw new Error('invalid authorization code')
    return { corpId: 'ding-corp', userid: 'dt-member' }
  } })
  try {
    f.bind()
    const b = f.browser()
    for (let i = 0; i < 19; i++) {
      await b.request('/auth/dingtalk/exchange', { code: `bad-${i}` }, 401)
      assert.equal((await b.request('/auth/dingtalk/exchange', { code: `good-${i}` })).data.authenticated, true)
    }
    await b.request('/auth/dingtalk/exchange', { code: 'bad-final' }, 401)
    await b.request('/auth/dingtalk/exchange', { code: 'good-blocked-after-failures' }, 429)
    assert.equal(f.calls(), 39)
  } finally { await f.close() }
})
