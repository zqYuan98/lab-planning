import { createHash } from 'node:crypto'
import type { BusinessNotificationEvent, BusinessNotificationKind, BusinessFactValue } from '../shared/collaboration.ts'
import type { Entity, Task, User } from '../shared/types.ts'
import { HttpError, type Store } from './store.ts'
import { effectiveManagerIds, liveCollaborationActor } from './collaboration-policy.ts'
import { publishCollaborationEvents } from './collaboration-notifications.ts'

export const collaborationId = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
export const meaningfulText = (value: unknown): string => typeof value === 'string' ? value.normalize('NFKC').replace(/\s+/gu, ' ').trim() : ''
export function requiredText(value: unknown, label: string, required = true, max = 12000): string {
  if (value === undefined || value === null) { if (!required) return ''; throw new HttpError(400, `请填写${label}`) }
  if (typeof value !== 'string' || value.length > max || required && !value.trim()) throw new HttpError(400, `${label}格式无效`)
  return value.trim()
}
export function ensureVersion(actual: number, expected: unknown) {
  if (!Number.isInteger(expected) || actual !== expected) throw new HttpError(409, '数据已更新，请刷新后重试')
}
export function utcTime(value: unknown, label: string): string {
  const match = typeof value === 'string' ? /^(\d{4}-\d\d-\d\d)T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/.exec(value) : null
  if (!match || !Number.isFinite(Date.parse(value as string)) || !Number.isFinite(Date.parse(`${match[1]}T00:00:00Z`)) || new Date(`${match[1]}T00:00:00Z`).toISOString().slice(0, 10) !== match[1]) throw new HttpError(400, `${label}须包含有效日期、时间及明确时区`)
  return new Date(value as string).toISOString()
}
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => (value as Record<string, unknown>)[key] !== undefined).map(key => [key, canonical((value as Record<string, unknown>)[key])]))
  return typeof value === 'string' ? value.trim() : value
}
interface CommandReceipt extends Entity { actorId: string; command: string; requestId: string; payloadHash: string; result: unknown }
/** Idempotency receipt, business mutation, events and notification intents commit together. */
export function collaborationCommand<T>(store: Store, actor: User, command: string, input: Record<string, unknown>, now: Date, operation: (mutationId: string) => T): T {
  const requestId = requiredText(input.requestId, '提交标识', true, 100)
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new HttpError(400, '提交标识须为 8 至 100 位字母、数字、短横线或下划线')
  const id = collaborationId(actor.id, command.split(':')[0], requestId), payloadHash = collaborationId(command, canonical(input))
  return store.transaction(() => {
    liveCollaborationActor(store, actor)
    const previous = store.get<CommandReceipt>('collaborationCommandReceipts', id)
    if (previous) {
      if (previous.payloadHash !== payloadHash) throw new HttpError(409, '此提交标识已用于不同内容，请重新提交')
      return structuredClone(previous.result) as T
    }
    const result = operation(id)
    publishCollaborationEvents(store, now)
    store.insert<CommandReceipt>('collaborationCommandReceipts', { id, actorId: actor.id, command, requestId, payloadHash, result })
    return result
  })
}
export function insertBusinessEvent(store: Store, input: Omit<BusinessNotificationEvent, keyof Entity>): BusinessNotificationEvent {
  const id = collaborationId(input.mutationId, input.kind, input.subjectType, input.subjectId)
  return store.get<BusinessNotificationEvent>('businessNotificationEvents', id) ?? store.insert<BusinessNotificationEvent>('businessNotificationEvents', { id, ...input })
}
export function taskBusinessEvent(store: Store, task: Task, actor: User, mutationId: string, kind: BusinessNotificationKind,
  now: Date, facts: Record<string, BusinessFactValue>, options: { subjectType?: 'task' | 'weeklyRecord'; subjectId?: string; recipientIds?: string[]; sourceVersion?: number; generation?: number | null } = {}) {
  return insertBusinessEvent(store, {
    kind, mutationId, subjectType: options.subjectType ?? 'task', subjectId: options.subjectId ?? task.id,
    taskId: task.id, ownerId: task.ownerId, actorId: actor.id,
    recipientIds: [...new Set(options.recipientIds ?? effectiveManagerIds(store, task))].filter(id => id !== actor.id),
    occurredAt: now.toISOString(), generation: options.generation ?? null,
    sourceVersion: options.sourceVersion ?? task.version, facts,
  })
}
