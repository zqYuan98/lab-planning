import { createHash, randomBytes } from 'node:crypto'
import type { RequestHandler } from 'express'
import type { AuditEvent, Entity, User } from '../shared/types.ts'
import type { IntegrationTokenView } from '../shared/import-types.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { safeUser, type StoredUser } from './auth.ts'
import { manager, text, number, type Input } from './domain-common.ts'
import { HttpError, Store } from './store.ts'
import { assertBusinessActor } from './object-access.ts'
import { isManager } from './authorization.ts'

const SCOPES = ['imports:read', 'imports:write', 'imports:commit', 'data:read']
interface IntegrationToken extends Entity { userId: string; credentialVersion: number; name: string; expiresAt: string; revokedAt: string | null; scopes: string[] }
declare global { namespace Express { interface Request { integrationToken?: IntegrationToken } } }
function view(token: IntegrationToken): IntegrationTokenView { return { id: token.id, name: token.name, createdAt: token.createdAt, expiresAt: token.expiresAt, revokedAt: token.revokedAt, scopes: token.scopes } }
export function listIntegrationTokens(store: Store, actor: User) { actor = assertBusinessActor(store, actor); manager(actor); return store.list<IntegrationToken>('integrationTokens').filter(t => t.userId === actor.id).map(view) }
export function createIntegrationToken(store: Store, actor: User, input: Input) {
  actor = assertBusinessActor(store, actor)
  manager(actor)
  const name = text(input.name, '令牌名称', true, 100)
  const scopes = input.scopes ?? ['imports:read', 'imports:write', 'data:read']
  if (!Array.isArray(scopes) || !scopes.length || scopes.some(s => typeof s !== 'string' || !SCOPES.includes(s))) throw new HttpError(400, '接口权限范围无效')
  const expiresInDays = number(input.expiresInDays ?? 30, '有效天数', 1, 365, true)
  const account = store.get<StoredUser>('users', actor.id)
  if (!account || !canUseAccount(account)) throw new HttpError(403, '账号不可用')
  const secret = `lp_${randomBytes(32).toString('hex')}`
  return store.transaction(() => {
    const token = store.insert<IntegrationToken>('integrationTokens', { id: createHash('sha256').update(secret).digest('hex'), userId: actor.id, credentialVersion: account.credentialVersion, name, scopes: [...new Set(scopes)], expiresAt: new Date(Date.now() + expiresInDays * 86400000).toISOString(), revokedAt: null })
    store.insert<AuditEvent>('events', { entityType: 'integrationToken', entityId: token.id, actorId: actor.id, action: 'create', reason: '', before: null, after: view(token) })
    return { ...view(token), token: secret }
  })
}
export function revokeIntegrationToken(store: Store, actor: User, id: string) {
  actor = assertBusinessActor(store, actor)
  manager(actor)
  const token = store.get<IntegrationToken>('integrationTokens', id)
  if (!token || token.userId !== actor.id) throw new HttpError(404, '令牌不存在')
  if (token.revokedAt) return view(token)
  return view(store.update<IntegrationToken>('integrationTokens', id, token.version, { revokedAt: new Date().toISOString() }))
}
export function assertIntegrationTokenActive(store: Store, id: string, scope: string) {
  const token = store.get<IntegrationToken>('integrationTokens', id)
  const user = token ? store.get<StoredUser>('users', token.userId) : undefined
  if (!token || token.revokedAt || Date.parse(token.expiresAt) <= Date.now() || !token.scopes.includes(scope) || !user || !canUseAccount(user) || !isManager(user) || token.credentialVersion !== user.credentialVersion) throw new HttpError(403, '集成令牌权限已变化，已停止后续解析')
}
export function requireIntegrationAuth(store: Store): RequestHandler {
  const usage = new Map<string, { count: number; expires: number }>()
  return (req, res, next) => {
    const secret = req.get('authorization')?.match(/^Bearer (lp_[a-f0-9]{64})$/)?.[1]
    const token = secret ? store.get<IntegrationToken>('integrationTokens', createHash('sha256').update(secret).digest('hex')) : undefined
    const user = token ? store.get<StoredUser>('users', token.userId) : undefined
    if (!token || token.revokedAt || Date.parse(token.expiresAt) <= Date.now() || !user || !canUseAccount(user) || !isManager(user) || token.credentialVersion !== user.credentialVersion) return next(new HttpError(401, '集成令牌无效、已到期或已撤销'))
    const routePath = req.path.toLowerCase().replace(/\/+$/, '')
    const scope = routePath.startsWith('/data') || routePath === '/context' ? 'data:read' : ['GET', 'HEAD'].includes(req.method) ? 'imports:read' : req.method === 'DELETE' || routePath.endsWith('/commit') || /^\/imports\/history\//.test(routePath) ? 'imports:commit' : 'imports:write'
    if (!token.scopes.includes(scope)) return next(new HttpError(403, `令牌缺少${scope}权限`))
    const now = Date.now()
    for (const [key, value] of usage) if (value.expires <= now) usage.delete(key)
    const state = usage.get(token.id) ?? { count: 0, expires: now + 60000 }
    if (state.count >= 120) { res.set('Retry-After', '60'); return next(new HttpError(429, '接口调用过于频繁，请稍后重试')) }
    state.count++; usage.set(token.id, state)
    req.user = safeUser(user); req.integrationToken = token
    if (!['GET', 'HEAD'].includes(req.method)) store.insert<AuditEvent>('events', { entityType: 'integrationCall', entityId: token.id, actorId: user.id, action: `${req.method} ${req.path}`.slice(0, 250), reason: token.name, before: null, after: null })
    next()
  }
}
