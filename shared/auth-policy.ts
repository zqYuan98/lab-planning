import type { User } from './types.ts'

export const PASSWORD_MIN_LENGTH = 8
export const PASSWORD_MAX_LENGTH = 256
export function registrationApproved(user: Pick<User, 'registrationStatus'>) {
  return user.registrationStatus === undefined || user.registrationStatus === 'approved'
}
export function canUseAccount(user: Pick<User, 'active' | 'registrationStatus'>) {
  return user.active === true && registrationApproved(user)
}
