// Frozen projector body from git show 65317c6:server/work-origin.ts.
import type { AuditEvent, Task, WeeklyRecord } from '../../../shared/types.ts'
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
