import type { CollaborationTaskView } from '../shared/collaboration'
import type { Entity, Task } from '../shared/types'
import { reconcileVersionedList } from './latest-read'
import { mutationEntities } from './workspace-response'

const arrays = ['progressEvents', 'followups', 'responses', 'blockerEpisodes', 'blockerActions', 'deadlineRequests'] as const
export function reconcileTaskView<T extends CollaborationTaskView>(current: T | null, incoming: T) {
  if (!current || current.task.id !== incoming.task.id) return { value: incoming, stale: false }
  let stale = current.task.version > incoming.task.version
  const value = { ...incoming, task: stale ? current.task : incoming.task }
  if (current.tracking && incoming.tracking && current.tracking.id === incoming.tracking.id && current.tracking.version > incoming.tracking.version) {
    value.tracking = current.tracking; stale = true
  }
  for (const name of arrays) {
    const result = reconcileVersionedList(current[name] as Entity[], incoming[name] as Entity[])
    Object.assign(value, { [name]: result.items }); stale ||= result.stale
  }
  return { value, stale }
}
export function applyTaskViewMutation<T extends CollaborationTaskView>(current: T, payload: unknown): T {
  const entities = mutationEntities(payload)
  const task = entities.tasks?.find(row => row.id === current.task.id) as Task | undefined
  const value = { ...current, task: task && task.version >= current.task.version ? task : current.task }
  const tracking = entities.taskTrackings?.find(row => row.id === current.tracking?.id || (row as { taskId?: string }).taskId === current.task.id)
  if (tracking && (!current.tracking || tracking.version >= current.tracking.version)) value.tracking = tracking as CollaborationTaskView['tracking']
  const record = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
  const additions: Partial<Record<typeof arrays[number], unknown[]>> = {
    followups: entities.followupRequests,
    progressEvents: record.progressEvent ? [record.progressEvent] : [],
    responses: record.response ? [record.response] : [],
    blockerEpisodes: record.episode ? [record.episode] : [],
    blockerActions: record.action && typeof record.action === 'object' ? [record.action] : [],
    deadlineRequests: record.request && typeof record.request === 'object' && 'requestedDueDate' in record.request ? [record.request]
      : 'requestedDueDate' in record ? [record] : [],
  }
  for (const name of arrays) {
    const rows = new Map((current[name] as Entity[]).map(row => [row.id, row]))
    for (const candidate of additions[name] ?? []) {
      if (!candidate || typeof candidate !== 'object') continue
      const row = candidate as Entity & { taskId?: string; parentTaskId?: string }
      if (!row.id || !Number.isInteger(row.version) || (row.taskId ?? row.parentTaskId) !== current.task.id) continue
      if (!rows.has(row.id) || rows.get(row.id)!.version <= row.version) rows.set(row.id, row)
    }
    Object.assign(value, { [name]: [...rows.values()] })
  }
  return value
}
