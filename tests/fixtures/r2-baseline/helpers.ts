// Exact baseline helper bodies from 65317c6; no live hotpath imports.
import type { User } from '../../../shared/types.ts'
export function safeUser(user: User): User {
  const { id, version, createdAt, updatedAt, name, email, role, position, active } = user
  return { id, version, createdAt, updatedAt, name, email, role, position, active, ...(user.registrationStatus ? { registrationStatus: user.registrationStatus } : {}) }
}

export const meaningfulText = (value: unknown): string => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : ''
