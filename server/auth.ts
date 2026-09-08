import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto'
import type { RequestHandler, Response } from 'express'
import type { Entity, User } from '../shared/types.ts'
import { HttpError, Store } from './store.ts'

declare global { namespace Express { interface Request { user: User } } }
export interface StoredUser extends User { passwordHash: string; credentialVersion: number }
interface Session extends Entity { userId: string; credentialVersion: number; expiresAt: string; revoked: boolean }
const COOKIE = 'lab_session'
const SESSION_MS = 12 * 60 * 60 * 1000

export function safeUser(user: User): User {
  const { id, version, createdAt, updatedAt, name, email, role, position, active } = user
  return { id, version, createdAt, updatedAt, name, email, role, position, active }
}
export function hashPassword(password: unknown): string {
  if (typeof password !== 'string' || password.length < 8 || password.length > 256) throw new HttpError(400, '密码需要 8 至 256 个字符')
  const salt = randomBytes(16).toString('hex')
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`
}
export function checkPassword(password: unknown, hash: string): boolean {
  if (typeof password !== 'string' || password.length > 256) return false
  const [salt, key] = hash.split(':')
  if (!salt || !key) return false
  const expected = Buffer.from(key, 'hex')
  const actual = scryptSync(password, salt, 64)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
function tokenHash(token: string) { return createHash('sha256').update(token).digest('hex') }
function cookieToken(header?: string) {
  const value = header?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1)
  return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined
}
const cookieOptions = () => ({ httpOnly: true, sameSite: 'strict' as const, secure: process.env.COOKIE_SECURE === 'true' || process.env.APP_ORIGIN?.startsWith('https://') === true, path: '/' })
export function createSession(store: Store, user: StoredUser, res: Response) {
  const token = randomBytes(32).toString('hex')
  store.insert<Session>('sessions', { id: tokenHash(token), userId: user.id, credentialVersion: user.credentialVersion, expiresAt: new Date(Date.now() + SESSION_MS).toISOString(), revoked: false })
  res.cookie(COOKIE, token, { ...cookieOptions(), maxAge: SESSION_MS })
}
export function clearSession(store: Store, cookie: string | undefined, res: Response, clearCookie = true) {
  const token = cookieToken(cookie)
  const session = token ? store.get<Session>('sessions', tokenHash(token)) : undefined
  if (session && !session.revoked) store.update<Session>('sessions', session.id, session.version, { revoked: true })
  if (clearCookie) res.clearCookie(COOKIE, cookieOptions())
}
export const requireAuth = (store: Store): RequestHandler => (req, _res, next) => {
  const token = cookieToken(req.headers.cookie)
  const session = token ? store.get<Session>('sessions', tokenHash(token)) : undefined
  const user = session ? store.get<StoredUser>('users', session.userId) : undefined
  if (!session || session.revoked || Date.parse(session.expiresAt) <= Date.now() || !user?.active || user.credentialVersion !== session.credentialVersion) return next(new HttpError(401, '请先登录'))
  req.user = safeUser(user)
  next()
}
export const requireManager: RequestHandler = (req, _res, next) => req.user?.role === 'manager' ? next() : next(new HttpError(403, '此操作需要管理者权限'))

/** Cookie mutations are JSON-only and must originate from this application. */
export const originGuard: RequestHandler = (req, _res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next()
  if (!req.is('application/json')) return next(new HttpError(415, '请求必须使用 application/json'))
  const origin = req.get('origin')
  const allowed = new Set([`${req.protocol}://${req.get('host')}`])
  if (process.env.APP_ORIGIN) allowed.add(process.env.APP_ORIGIN.replace(/\/$/, ''))
  // Vite forwards the browser Origin while preserving the API Host during local development.
  if (process.env.NODE_ENV !== 'production') {
    allowed.add('http://127.0.0.1:5173')
    allowed.add('http://localhost:5173')
  }
  if ((origin && !allowed.has(origin)) || (!origin && req.get('sec-fetch-site') === 'cross-site')) return next(new HttpError(403, '禁止跨站修改数据'))
  next()
}
