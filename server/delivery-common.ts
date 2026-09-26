import type { AuditEvent, Task, User } from '../shared/types.ts'
import type { Notification, NotificationTarget } from '../shared/notifications.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { collaborationCommand, collaborationId } from './collaboration-store.ts'
import { HttpError, type Store } from './store.ts'
import { isManager, isObserver } from './authorization.ts'

export type Input = Record<string, unknown>
export function businessActor(store: Store, actor: User, managerOnly = false): User {
  const current = store.get<User>('users', actor.id)
  if (!current || !canUseAccount(current) || isObserver(current) || managerOnly && !isManager(current)) throw new HttpError(403, '当前账号没有此业务操作权限')
  return current
}
export function ownedTask(store: Store, actor: User, id: string, writable = false): Task {
  const task = store.get<Task>('tasks', id)
  if (!task || !isManager(actor) && task.ownerId !== actor.id) throw new HttpError(404, '任务不存在或无权访问')
  if (writable) activeTask(task)
  return task
}
export function activeTask(task: Task): void { if (!isActiveTask(task)) throw new HttpError(409, '任务已作废，只能查看历史', 'TASK_CANCELLED') }
export function cas(actual: number, expected: unknown): void {
  if (!Number.isInteger(expected) || actual !== expected) throw new HttpError(409, '数据已更新，请刷新后核对', 'VERSION_CONFLICT')
}
export function command<T>(store: Store, actor: User, name: string, input: Input, now: Date, operation: (id: string) => T, current: (result: T) => T = result => result): T {
  try { return current(collaborationCommand(store, actor, name, input, now, operation)) }
  catch (error) {
    if (error instanceof HttpError && error.status === 409 && error.message.includes('提交标识已用于')) error.code = 'IDEMPOTENCY_MISMATCH'
    throw error
  }
}
export function audit(store: Store, actor: User, entityType: string, entityId: string, action: string, before: unknown, after: unknown, reason = '') {
  return store.insert<AuditEvent>('events', { entityType, entityId, actorId: actor.id, action, before, after, reason })
}
/** Base responsibility inbox is independent of optional external collaboration delivery. */
export function inbox(store: Store, actor: User, mutationId: string, recipientIds: (string | null | undefined)[], kind: string, title: string, body: string, target: NotificationTarget, now: Date) {
  for (const recipientId of new Set(recipientIds)) {
    const recipient = recipientId ? store.get<User>('users', recipientId) : null
    if (!recipient || !canUseAccount(recipient) || isObserver(recipient) || recipient.id === actor.id) continue
    const id = collaborationId('delivery-support-inbox', mutationId, recipient.id)
    if (!store.get('notifications', id)) store.insert<Notification>('notifications', { id, eventKey: mutationId, recipientId: recipient.id, kind,
      title, body, targets: [target], actionable: false, openedAt: null, acknowledgedAt: null, supersededAt: null, actorId: actor.id, eventTime: now.toISOString() })
  }
}
export function activePeople(store: Store, managerOnly = false) {
  return store.list<User>('users').filter(user => canUseAccount(user) && !isObserver(user) && (!managerOnly || isManager(user)))
}
