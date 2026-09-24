import type { CollaborationSettings, CollaborationTaskStatusSummary, FollowupRequest, TaskTracking } from '../shared/collaboration'
import type { NotificationDigest, WorkRisk } from '../shared/collaboration-notifications'
import type { Task } from '../shared/types'
import { reconcileVersionedList } from './latest-read'
import { mutationEntities, type ConfirmedMutations } from './workspace-response'

export interface FollowupDashboard {
  settings: CollaborationSettings
  preference: { version: number; memberActionsEnabled: boolean }
  tasks: ({ task: Task; tracking: TaskTracking | null; openFollowup: FollowupRequest | null } & CollaborationTaskStatusSummary)[]
  risks: WorkRisk[]
  digests: NotificationDigest[]
}
export function reconcileFollowupDashboard(current: FollowupDashboard | null, incoming: FollowupDashboard, confirmed: ConfirmedMutations) {
  const known = new Map((current?.tasks ?? []).map(row => [row.task.id, row.task]))
  for (const task of (confirmed.tasks ?? []) as Task[]) if (!known.has(task.id) || known.get(task.id)!.version < task.version) known.set(task.id, task)
  const result = reconcileVersionedList([...known.values()], incoming.tasks.map(row => row.task))
  let stale = result.stale
  const tasks = new Map(result.items.map(task => [task.id, task])), previous = new Map((current?.tasks ?? []).map(row => [row.task.id, row]))
  const latest = <T extends { version: number }>(old: T | null | undefined, next: T): T => {
    if (old && old.version > next.version) { stale = true; return old }
    return next
  }
  const value: FollowupDashboard = { ...incoming,
    settings: latest(current?.settings, incoming.settings), preference: latest(current?.preference, incoming.preference),
    tasks: incoming.tasks.filter(row => !tasks.get(row.task.id)?.cancellation).map(row => {
      const old = previous.get(row.task.id)
      const recordedTracking = confirmed.taskTrackings?.find(item => item.id === row.tracking?.id) as TaskTracking | undefined
      const recordedFollowup = confirmed.followupRequests?.find(item => item.id === row.openFollowup?.id) as FollowupRequest | undefined
      const priorTracking = recordedTracking && (!old?.tracking || recordedTracking.version > old.tracking.version) ? recordedTracking : old?.tracking
      const priorFollowup = recordedFollowup && (!old?.openFollowup || recordedFollowup.version > old.openFollowup.version) ? recordedFollowup : old?.openFollowup
      const followup = row.openFollowup ? latest(priorFollowup?.id === row.openFollowup.id ? priorFollowup : null, row.openFollowup) : null
      return { ...row, task: tasks.get(row.task.id)!,
        tracking: row.tracking ? latest(priorTracking?.id === row.tracking.id ? priorTracking : null, row.tracking) : null,
        openFollowup: followup?.status === 'open' ? followup : null,
      }
    }),
  }
  return { value, stale }
}
export function applyFollowupMutation(current: FollowupDashboard, path: string, value: unknown): FollowupDashboard {
  const entities = mutationEntities(value)
  const updates = new Map((entities.tasks ?? []).map(task => [task.id, task as Task]))
  const response = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const tracking = entities.taskTrackings?.[0] as TaskTracking | undefined
  const request = entities.followupRequests?.[0] as FollowupRequest | undefined
  let next = { ...current, tasks: current.tasks.flatMap(row => {
    const changed = updates.get(row.task.id), task = changed && changed.version >= row.task.version ? changed : row.task
    if (task.cancellation) return []
    const nextTracking = tracking?.taskId === task.id && (!row.tracking || tracking.version >= row.tracking.version) ? tracking : row.tracking
    const nextFollowup = request?.taskId === task.id && (!row.openFollowup || request.id !== row.openFollowup.id || request.version >= row.openFollowup.version)
      ? request.status === 'open' ? request : null : row.openFollowup
    return [{ ...row, task, tracking: nextTracking, openFollowup: nextFollowup }]
  }) }
  if (path === '/collaboration/preferences' && typeof response.version === 'number' && response.version >= current.preference.version && typeof response.memberActionsEnabled === 'boolean') {
    next = { ...next, preference: { version: response.version, memberActionsEnabled: response.memberActionsEnabled } }
  }
  return next
}
