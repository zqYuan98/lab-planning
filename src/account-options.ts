import { canUseAccount, registrationApproved } from '../shared/auth-policy'
import type { MonthlyPlan, User } from '../shared/types'

export function accountDisplayName(user?: User, fallback = '未指定') {
  if (!user) return fallback
  const status = !registrationApproved(user)
    ? user.registrationStatus === 'rejected' ? '审批未通过' : '待审批'
    : !user.active ? '已停用' : ''
  return `${user.name}${status ? `（${status}）` : ''}`
}

/** Current associations may be retained; unavailable accounts are never new candidates. */
export function assignmentAccounts(users: User[], retainedIds: string[] = []) {
  return users.filter(user => canUseAccount(user) || retainedIds.includes(user.id))
}

/** Explicit history mode includes approved inactive accounts, never pending registrations. */
export function visibleAccounts(users: User[], includeInactive = false) {
  return users.filter(user => canUseAccount(user) || (includeInactive && registrationApproved(user)))
}

/** Historic roster corrections use employment in that period, not today's account availability. */
export function historicalRosterAccounts(users: User[]) {
  return users.filter(user => user.role === 'member' && registrationApproved(user))
}

export function visibleMonthlyPlan(plan: MonthlyPlan, users: User[], includeInactive = false) {
  return visibleAccounts(users, includeInactive).some(user => user.id === plan.ownerId) ||
    users.some(user => canUseAccount(user) && plan.collaboratorIds.includes(user.id))
}
