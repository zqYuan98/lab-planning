import { createHash, randomBytes } from 'node:crypto'
import { Router, type Request, type RequestHandler, type Response } from 'express'
import type { Entity } from '../shared/types.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { appOrigin, clearSession, createSession, requireAuth, safeUser, setSessionCookie, type StoredUser } from './auth.ts'
import { DingTalkError, type DingTalkClient, type DingTalkIdentity } from './dingtalk.ts'
import { HttpError, type Store } from './store.ts'

const CHALLENGE_COOKIE = 'lab_dingtalk_binding'
const CHALLENGE_MS = 5 * 60_000
const LIMIT_MS = 15 * 60_000
const EXCHANGE_LIMIT = 120
const FAILED_EXCHANGE_LIMIT = 20
interface Challenge { corpId: string; userid: string; expiresAt: number; userId?: string }
interface StoredSession extends Entity { userId: string; revoked: boolean }
interface IdentityAudit extends Entity { action: 'bound' | 'unbound'; actorId: string; userId: string; identityId: string; corpId: string; provider: 'dingtalk' }
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const options = () => ({ httpOnly: true, sameSite: 'strict' as const, secure: process.env.COOKIE_SECURE === 'true' || appOrigin()?.protocol === 'https:', path: '/api' })
function challengeToken(req: Request) {
  const token = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${CHALLENGE_COOKIE}=`))?.slice(CHALLENGE_COOKIE.length + 1)
  return token && /^[a-f0-9]{64}$/.test(token) ? digest(token) : undefined
}
function emptyBody(req: Request) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length) throw new HttpError(400, '此操作不接受客户端身份参数')
}

/** Mount under /api after createOriginGuard, before the application's general requireAuth. */
export function dingtalkRouter(store: Store, client: DingTalkClient, clock: () => number = Date.now) {
  const router = Router()
  const challenges = new Map<string, Challenge>()
  const usedCodes = new Map<string, number>()
  const attempts = new Map<string, { count: number; failures: number; expiresAt: number }>()
  let inFlight = 0
  const auth = requireAuth(store)
  const optionalAuth: RequestHandler = (req, res, next) => auth(req, res, error => error && (!(error instanceof HttpError) || error.status !== 401) ? next(error) : next())
  function cleanup() {
    const now = clock()
    for (const [key, value] of challenges) if (value.expiresAt <= now) challenges.delete(key)
    for (const [key, expiresAt] of usedCodes) if (expiresAt <= now) usedCodes.delete(key)
    for (const [key, value] of attempts) if (value.expiresAt <= now) attempts.delete(key)
  }
  function revokeChallenge(req: Request) {
    const key = challengeToken(req)
    if (key) challenges.delete(key)
  }
  function clearChallenge(req: Request, res: Response) {
    revokeChallenge(req)
    res.clearCookie(CHALLENGE_COOKIE, options())
  }
  function verifiedAccount(userId: string) {
    const user = store.get<StoredUser>('users', userId)
    if (!user || !canUseAccount(user) || !Number.isSafeInteger(user.credentialVersion) || user.credentialVersion < 1) throw new HttpError(403, '账号尚未获批或已停用，请联系管理者')
    return user
  }
  function allIdentities() { return store.list<DingTalkIdentity>('externalIdentities').filter(item => item.provider === 'dingtalk') }
  function binding(userId: string) { return allIdentities().find(item => item.userId === userId) }
  function revokeSessions(userId: string) {
    for (const session of store.list<StoredSession>('sessions')) if (session.userId === userId && session.revoked !== true) store.update<StoredSession>('sessions', session.id, session.version, { revoked: true })
  }
  function pending(req: Request) {
    cleanup()
    const key = challengeToken(req)
    const value = key ? challenges.get(key) : undefined
    return value && client.configured && value.corpId === client.corpId && (!value.userId || value.userId === req.user.id) ? value : undefined
  }
  const limit: RequestHandler = (req, res, next) => {
    cleanup()
    const key = req.ip ?? 'local'
    const state = attempts.get(key) ?? { count: 0, failures: 0, expiresAt: clock() + LIMIT_MS }
    if (state.count >= EXCHANGE_LIMIT || state.failures >= FAILED_EXCHANGE_LIMIT || attempts.size >= 1000 && !attempts.has(key) || usedCodes.size >= 1000 || challenges.size >= 1000 || inFlight >= 10) {
      res.set('Retry-After', String(Math.max(1, Math.ceil((state.expiresAt - clock()) / 1000))))
      return next(new HttpError(429, '钉钉登录尝试过多，请稍后再试'))
    }
    state.count++
    attempts.set(key, state)
    // Colleagues can share one office IP. Successful exchanges consume the
    // larger burst budget, but neither consume nor reset credential failures.
    // Provider outages (5xx) remain bounded by the total budget only.
    res.once('finish', () => {
      if (res.statusCode >= 400 && res.statusCode < 500 && res.statusCode !== 429) state.failures++
    })
    next()
  }

  router.get('/auth/dingtalk/config', (_req, res) => res.json({ configured: client.configured, corpId: client.corpId, clientId: client.clientId,
    ...(process.env.DINGTALK_APPLINK_ENABLED === 'true' ? { appLinkEnabled: true, agentId: process.env.DINGTALK_AGENT_ID ?? '' } : {}) }))
  router.post('/auth/dingtalk/exchange', limit, optionalAuth, async (req, res) => {
    // Revoke the old proof immediately, but emit only one same-name Set-Cookie.
    // Do not depend on clients preserving both a clear and replacement header.
    revokeChallenge(req)
    try {
      if (!client.configured) throw new HttpError(503, '钉钉企业应用尚未完成配置')
      if (!req.body || typeof req.body.code !== 'string' || !req.body.code || req.body.code.length > 2048 || /\s/.test(req.body.code) || Object.keys(req.body).some(key => key !== 'code')) throw new HttpError(400, '请提供有效的钉钉授权码')
      const codeHash = digest(req.body.code)
      if (usedCodes.has(codeHash)) throw new HttpError(409, '钉钉授权码已使用，请重新获取')
      usedCodes.set(codeHash, clock() + CHALLENGE_MS)
      let identity: { corpId: string; userid: string }
      inFlight++
      try { identity = await client.getIdentity(req.body.code) }
      catch (error) {
        // Never return provider payloads, codes, tokens or exception causes to a browser/log.
        throw new HttpError(error instanceof DingTalkError && error.retryable ? 503 : 401, '钉钉身份验证失败，请重试或使用账号登录')
      } finally { inFlight-- }
      if (identity.corpId !== client.corpId || !identity.userid || identity.userid.length > 256 || /[\s,\x00-\x1f\x7f]/.test(identity.userid)) throw new HttpError(403, '钉钉企业身份不匹配')
      const matches = allIdentities().filter(item => item.corpId === identity.corpId && item.userid === identity.userid)
      if (matches.length > 1) throw new HttpError(409, '钉钉绑定存在冲突，请联系管理者')
      const existing = matches[0]
      if (existing && allIdentities().filter(item => item.userId === existing.userId).length !== 1) throw new HttpError(409, '钉钉绑定存在冲突，请联系管理者')
      if (req.user && (existing && existing.userId !== req.user.id || !existing && binding(req.user.id))) throw new HttpError(409, '当前系统账号与钉钉身份不一致，请先退出并核对账号')
      if (existing) {
        const authenticated = store.transaction(() => {
          const user = verifiedAccount(existing.userId)
          clearSession(store, req.headers.cookie, res, false)
          return { user: safeUser(user), token: createSession(store, user) }
        })
        res.clearCookie(CHALLENGE_COOKIE, options())
        setSessionCookie(res, authenticated.token)
        return res.json({ authenticated: true, user: authenticated.user })
      }
      if (req.user) verifiedAccount(req.user.id)
      const token = randomBytes(32).toString('hex')
      challenges.set(digest(token), { ...identity, expiresAt: clock() + CHALLENGE_MS, ...(req.user ? { userId: req.user.id } : {}) })
      res.cookie(CHALLENGE_COOKIE, token, { ...options(), maxAge: CHALLENGE_MS })
      res.json({ authenticated: false, bindingRequired: true })
    } catch (error) {
      res.clearCookie(CHALLENGE_COOKIE, options())
      throw error
    }
  })
  router.get('/dingtalk/binding', auth, (req, res) => {
    const existing = binding(req.user.id)
    const challenge = pending(req)
    res.json({ bound: !!existing, ...(existing ? { corpId: existing.corpId, boundAt: existing.createdAt } : {}), ...(challenge ? { pending: { corpId: challenge.corpId, userid: challenge.userid, expiresAt: new Date(challenge.expiresAt).toISOString() } } : {}) })
  })
  router.post('/dingtalk/bind', auth, (req, res) => {
    emptyBody(req)
    const challenge = pending(req)
    // Even a conflict consumes the proof; repeat requests must reverify with DingTalk.
    clearChallenge(req, res)
    if (!challenge) throw new HttpError(400, '绑定验证已失效，请在钉钉中重新验证身份')
    const created = store.transaction(() => {
      verifiedAccount(req.user.id)
      if (allIdentities().some(item => item.userId === req.user.id || item.corpId === challenge.corpId && item.userid === challenge.userid)) throw new HttpError(409, '该钉钉身份或系统账号已经绑定，请联系管理者核对')
      const identity = store.insert<DingTalkIdentity>('externalIdentities', { provider: 'dingtalk', corpId: challenge.corpId, userid: challenge.userid, userId: req.user.id })
      store.insert<IdentityAudit>('externalIdentityEvents', { action: 'bound', actorId: req.user.id, userId: req.user.id, identityId: identity.id, corpId: identity.corpId, provider: 'dingtalk' })
      return identity
    })
    res.json({ bound: true, corpId: created.corpId, boundAt: created.createdAt })
  })
  router.post('/dingtalk/unbind', auth, (req, res) => {
    emptyBody(req)
    const previous = allIdentities().filter(item => item.userId === req.user.id)
    store.transaction(() => {
      for (const item of previous) {
        store.delete('externalIdentities', item.id, item.version)
        store.insert<IdentityAudit>('externalIdentityEvents', { action: 'unbound', actorId: req.user.id, userId: req.user.id, identityId: item.id, corpId: item.corpId, provider: 'dingtalk' })
      }
      revokeSessions(req.user.id)
    })
    for (const [key, value] of challenges) if (value.userId === req.user.id || previous.some(item => item.corpId === value.corpId && item.userid === value.userid)) challenges.delete(key)
    clearChallenge(req, res)
    clearSession(store, req.headers.cookie, res)
    res.json({ ok: true, bound: false })
  })
  return router
}
