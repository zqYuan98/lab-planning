import type { AuditEvent, Task, User, WeeklyRecord, WorkOrigin } from '../shared/types.ts'
import { choice, text, type Input } from './domain-common.ts'
import { HttpError } from './store.ts'
import { isManager } from './authorization.ts'

export function createWorkOrigin(actor: User, ownerId: string, input: Input): WorkOrigin {
  const kind = choice(input.creationKind ?? (actor.id === ownerId ? 'self' : 'assigned'), ['self', 'assigned', 'proxy'], '安排方式')
  if (actor.id === ownerId && kind !== 'self') throw new HttpError(400, '本人任务请选择自行安排')
  if (actor.id !== ownerId && (!isManager(actor) || kind === 'self')) throw new HttpError(403, '为他人安排任务需要管理者下发或代录')
  return { kind, actorId: actor.id, reason: kind === 'proxy' ? text(input.creationReason, '代录原因') : '' }
}

/** Only initial creation evidence is used; later edits cannot change authorship. No database writes. */
export function workOriginProjector(events: AuditEvent[]) {
  const initial = new Map<string, AuditEvent[]>()
  for (const event of events) {
    if (!['task', 'weeklyRecord'].includes(event.entityType) || event.before !== null || !['create', 'submit'].includes(event.action)) continue
    const key = `${event.entityType}:${event.entityId}`
    initial.set(key, [...(initial.get(key) ?? []), event])
  }
  return <T extends Task | WeeklyRecord>(row: T, entityType: 'task' | 'weeklyRecord'): T => {
    if (row.workOrigin || row.importSource) return row
    const events = initial.get(`${entityType}:${row.id}`) ?? []
    if (events.length !== 1) return row
    const event = events[0], snapshot = event.after as Partial<T> | null
    if (!snapshot || snapshot.id !== row.id || snapshot.ownerId !== row.ownerId || snapshot.importSource || snapshot.createdAt !== row.createdAt || !event.actorId) return row
    return { ...row, workOrigin: snapshot.workOrigin ?? { kind: event.actorId === row.ownerId ? 'self' : 'assigned', actorId: event.actorId, reason: '' } }
  }
}
