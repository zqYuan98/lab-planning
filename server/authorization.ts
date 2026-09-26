import type { RequestHandler } from 'express'
import type { User } from '../shared/types.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { safeUser, type StoredUser } from './auth.ts'
import { HttpError, type Store } from './store.ts'

/**
 * The single definition of who may act. Request handlers receive the account as it was when
 * the session was checked; every gate below re-reads it so a deactivation, role change or
 * rejected registration applies to the very next command.
 *
 * Roles:
 * - manager: runs the department — publishes goals, reviews, manages accounts, reports and settings.
 * - member: owns and reports personal work.
 * - observer: reads only objects explicitly granted to it; never writes business records.
 *
 * Module-specific helpers keep their own error messages and delegate the decision here.
 * tests/route-permission-matrix.test.ts pins the resulting status of every browser route.
 */
type RoleHolder = Pick<User, 'role'> | null | undefined
export const isManager = (actor: RoleHolder) => actor?.role === 'manager'
export const isMember = (actor: RoleHolder) => actor?.role === 'member'
export const isObserver = (actor: RoleHolder) => actor?.role === 'observer'

/** The stored account when it can still sign in and act; undefined otherwise. */
export function usableAccount(store: Store, actorId: string): User | undefined {
  const current = store.get<StoredUser>('users', actorId)
  return current && canUseAccount(current) ? safeUser(current) : undefined
}

type Denial = { message: string; code?: string }
const deny = (denial: Denial): never => { throw new HttpError(403, denial.message, denial.code) }

/** Any usable account, including observers. */
export function currentActor(store: Store, actor: Pick<User, 'id'>, denial: Denial = { message: '账号当前不可用', code: 'ACCESS_REVOKED' }): User {
  return usableAccount(store, actor.id) ?? deny(denial)
}
/** A usable manager or member; observers never write business records. */
export function businessActor(store: Store, actor: Pick<User, 'id'>, denials: { revoked?: Denial; observer?: Denial } = {}): User {
  const current = currentActor(store, actor, denials.revoked)
  return isObserver(current) ? deny(denials.observer ?? { message: '观察者仅能读取明确授权的内容', code: 'READ_ONLY_OBSERVER' }) : current
}
/** A usable manager. */
export function managerActor(store: Store, actor: Pick<User, 'id'>, denial: Denial = { message: '此操作需要管理者权限' }): User {
  const current = usableAccount(store, actor.id)
  return current && isManager(current) ? current : deny(denial)
}

/** Role checks on the request's account snapshot, for callers that re-read the account separately. */
export function requireManagerRole(actor: Pick<User, 'role'>, message = '此操作需要管理者权限') {
  if (!isManager(actor)) deny({ message })
}
/** Route guard on the session's account; requireAuth has just loaded it from storage. */
export const requireManager: RequestHandler = (req, _res, next) => req.user && isManager(req.user) ? next() : next(new HttpError(403, '此操作需要管理者权限'))
/** Owners edit their own records; managers edit any; observers edit none. */
export function requireOwnerOrManager(actor: Pick<User, 'id' | 'role'>, ownerId: string) {
  if (isObserver(actor)) deny({ message: '观察者不能修改业务记录', code: 'READ_ONLY_OBSERVER' })
  if (!isManager(actor) && actor.id !== ownerId) deny({ message: '不能修改其他成员的记录' })
}
