import type { AuditEvent, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { ProgressEvent } from '../shared/collaboration.ts'
import type { ExecutionProgress, WorkProgress } from '../shared/work-progress.ts'
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { HttpError, type Store } from './store.ts'
import { assertBusinessActor } from './object-access.ts'
import { meaningfulText } from './collaboration-store.ts'

const clean = (value: unknown) => typeof value === 'string' ? value.trim() : ''
const time = (value: string | null | undefined) => value && Number.isFinite(Date.parse(value)) ? value : null
// IDs are opaque. UTF-8 byte ordering matches SQLite BINARY and is locale-independent,
// including imported IDs containing punctuation or non-ASCII characters.
const evidenceIdOrder = (a: string, b: string) => Buffer.compare(Buffer.from(a), Buffer.from(b))
const order = (a: ExecutionProgress, b: ExecutionProgress) => (b.occurredAt || '').localeCompare(a.occurredAt || '') || (b.recordedAt || '').localeCompare(a.recordedAt || '') || evidenceIdOrder(a.sourceId, b.sourceId)

export interface WorkProgressSources { records: WeeklyRecord[]; progressEvents: ProgressEvent[]; audits: AuditEvent[] }

/** One set of reads and grouping per response. updatedAt is never evidence of progress. */
export function workProgressProjector(store: Store, actor: User, now = new Date(), sources?: WorkProgressSources) {
  actor = assertBusinessActor(store, actor)
  const manager = actor.role === 'manager'
  const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
  const records = sources?.records ?? store.list<WeeklyRecord>('weeklyRecords')
  const progressEvents = sources?.progressEvents ?? store.list<ProgressEvent>('progressEvents')
  const audits = sources?.audits ?? store.entityTypeEvents(['task', 'weeklyRecord'])
  const recordsByTask = new Map<string, WeeklyRecord[]>(), eventsByTask = new Map<string, ProgressEvent[]>(), auditsByTask = new Map<string, AuditEvent[]>()
  const append = <T>(map: Map<string, T[]>, key: string, value: T) => { const rows = map.get(key); if (rows) rows.push(value); else map.set(key, [value]) }
  const recordTasks = new Map<string, string>()
  for (const record of records) { append(recordsByTask, record.taskId, record); recordTasks.set(record.id, record.taskId) }
  for (const event of progressEvents) append(eventsByTask, event.taskId, event)
  // Iterate the original audit order once so sorting ties never change evidence precedence.
  for (const event of audits) {
    const taskId = event.entityType === 'task' ? event.entityId : event.entityType === 'weeklyRecord' ? recordTasks.get(event.entityId) : undefined
    if (taskId !== undefined) append(auditsByTask, taskId, event)
  }
  return (task: Task): WorkProgress => {
    if (!manager && task.ownerId !== actor.id) throw new HttpError(404, '任务不存在或无权访问')
    const visibleRecords = (recordsByTask.get(task.id) ?? []).filter(row => (manager || row.ownerId === actor.id) && isActiveWeeklyRecord(row) && isEffectiveWeeklyRecord(row) && row.weekStart <= today)
    const recordMap = new Map(visibleRecords.map(row => [row.id, row]))
    const taskAudits = (auditsByTask.get(task.id) ?? []).filter(event => (event.entityType === 'task' || recordMap.has(event.entityId)) && (manager || (event.after as Task | WeeklyRecord | null)?.ownerId === actor.id))
    const taskEvents = (eventsByTask.get(task.id) ?? []).filter(event => (manager || event.ownerId === actor.id) && (!event.weeklyRecordId || recordMap.has(event.weeklyRecordId)))
    const known: ExecutionProgress[] = [], unknown: ExecutionProgress[] = []
    const recordedAudits = new Set(taskEvents.flatMap(event => event.auditEventIds))
    const textFor = (changes: {field: string; after: string}[]) => clean(changes.find(change => ['weeklyRecord.actualOutcome', 'task.currentProgress', 'task.completionNote'].includes(change.field) && clean(change.after))?.after)
    for (const event of taskEvents) {
      if (event.noteType === 'no_change') continue
      const text = clean(event.note) || textFor(event.changes)
      if (!text) continue
      const record = event.weeklyRecordId ? recordMap.get(event.weeklyRecordId) : undefined
      const row: ExecutionProgress = { text, sourceType: record ? 'weeklyRecord' : event.source === 'progress' || event.source === 'followup' ? 'progress' : 'task', sourceId: event.id,
        ...(record ? { weekStart: record.weekStart } : {}), occurredAt: time(event.occurredAt), recordedAt: time(event.createdAt), actorId: event.actorId,
        proxy: event.actorId !== event.ownerId, evidenceQuality: time(event.occurredAt) ? 'recorded' : 'unknown' }
      ;(row.occurredAt ? known : unknown).push(row)
    }
    for (const event of taskAudits) {
      if (recordedAudits.has(event.id) || !event.after) continue
      const before = (event.before || {}) as Record<string, unknown>, after = event.after as Record<string, unknown>
      const fields = event.entityType === 'task' ? ['currentProgress', 'completionNote'] : ['actualOutcome']
      const field = fields.find(name => clean(after[name]) && clean(before[name]) !== clean(after[name]))
      if (!field) continue
      const record = event.entityType === 'weeklyRecord' ? recordMap.get(event.entityId) : undefined
      const row: ExecutionProgress = { text: clean(after[field]), sourceType: event.entityType as 'task' | 'weeklyRecord', sourceId: event.id,
        ...(record ? { weekStart: record.weekStart } : {}), occurredAt: time(event.createdAt), recordedAt: time(event.createdAt), actorId: event.actorId,
        proxy: event.actorId !== task.ownerId, evidenceQuality: time(event.createdAt) ? 'audit_reconstructed' : 'unknown' }
      ;(row.occurredAt ? known : unknown).push(row)
    }
    const unknownFact = (text: string, sourceType: 'task' | 'weeklyRecord', sourceId: string, field: string, weekStart?: string) => {
      const matches = (value: unknown) => meaningfulText(value) === meaningfulText(text)
      const recorded = taskEvents.some(event => time(event.occurredAt) && (sourceType === 'task' || event.weeklyRecordId === sourceId)
        && event.changes.some(change => change.field === `${sourceType}.${field}` && matches(change.after)))
        || taskAudits.some(event => event.entityType === sourceType && event.entityId === sourceId && time(event.createdAt) && event.after
          && matches((event.after as unknown as Record<string, unknown>)[field]) && !matches((event.before as unknown as Record<string, unknown> | null)?.[field]))
      if (!text || recorded || known.some(row => matches(row.text) && row.sourceType === sourceType && row.weekStart === weekStart) || unknown.some(row => matches(row.text) && row.sourceId === sourceId)) return
      unknown.push({ text, sourceType, sourceId, ...(weekStart ? { weekStart } : {}), occurredAt: null, recordedAt: null, actorId: task.ownerId, proxy: false, evidenceQuality: 'unknown' })
    }
    unknownFact(clean(task.currentProgress), 'task', task.id, 'currentProgress')
    unknownFact(clean(task.completionNote), 'task', task.id, 'completionNote')
    for (const row of visibleRecords) unknownFact(clean(row.actualOutcome), 'weeklyRecord', row.id, 'actualOutcome', row.weekStart)
    const overallText = clean(task.currentProgress)
    const overallEvent = taskEvents.filter(event => event.changes.some(change => change.field === 'task.currentProgress' && meaningfulText(change.after) === meaningfulText(overallText)))
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || evidenceIdOrder(b.id, a.id))[0]
    const overallAudit = taskAudits.filter(event => event.entityType === 'task' && event.after && clean((event.after as Task).currentProgress) === overallText && clean((event.before as Task | null)?.currentProgress) !== overallText)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || evidenceIdOrder(b.id, a.id))[0]
    return { overallProgress: overallText ? { text: overallText, changedAt: time(overallEvent?.occurredAt || overallAudit?.createdAt), evidenceRef: overallEvent?.id || overallAudit?.id || null } : null,
      latestExecution: known.sort(order)[0] || null, historicalExecution: unknown.sort((a, b) => (b.weekStart || '').localeCompare(a.weekStart || '') || evidenceIdOrder(a.sourceId, b.sourceId)).slice(0, 20) }
  }
}
