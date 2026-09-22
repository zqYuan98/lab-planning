import type { BlockerEpisode, DeadlineChangeRequest, FollowupRequest, TaskTracking } from '../shared/collaboration.ts'
import type { Task, User, WeeklyRecord } from '../shared/types.ts'
import { readCollaborationSettings, taskTrackingEligible, validManagerIds } from './collaboration-policy.ts'
import { HttpError, type Store } from './store.ts'

export function enrollTaskTracking(store: Store, task: Task, actor: User, now: Date, source: TaskTracking['source'], options: { activeFrom?: string; managerRecipientIds?: string[] } = {}): TaskTracking {
  if (!taskTrackingEligible(store, task, now)) throw new HttpError(409, '该任务当前不能纳入督办，请核对试点范围、负责人及正式发布状态')
  const old = store.get<TaskTracking>('taskTrackings', task.id)
  if (old && old.state !== 'closed') return old
  const iso = now.toISOString(), settings = readCollaborationSettings(store)
  const fields: Omit<TaskTracking, 'id' | 'version' | 'createdAt' | 'updatedAt'> = {
    taskId: task.id, ownerId: task.ownerId, generation: (old?.generation ?? 0) + 1, state: 'active',
    enrolledAt: iso, activeFrom: options.activeFrom ?? iso, reminderBaselineAt: iso, enrolledBy: actor.id, source,
    managerRecipientIds: options.managerRecipientIds === undefined ? old?.managerRecipientIds ?? [] : validManagerIds(store, options.managerRecipientIds),
    ruleVersion: settings.version, dueDateVersion: old?.dueDateVersion ?? 1, currentDueDate: task.dueDate,
    lastMeaningfulOwnerProgressAt: old?.lastMeaningfulOwnerProgressAt ?? null,
    lastRecordedProgressAt: old?.lastRecordedProgressAt ?? null, pauseReason: '', reviewAt: null, closedAt: null, closedReason: '',
  }
  return old ? store.update<TaskTracking>('taskTrackings', task.id, old.version, fields) : store.insert<TaskTracking>('taskTrackings', { id: task.id, ...fields })
}
export function endTaskRequests(store: Store, taskId: string, now: Date, actorId: string | null, reason: string, status: 'cancelled' | 'superseded' = 'cancelled', recordId?: string): void {
  for (const request of store.list<FollowupRequest>('followupRequests')) if (request.taskId === taskId && request.status === 'open' && (!recordId || request.weeklyRecordId === recordId)) {
    store.update<FollowupRequest>('followupRequests', request.id, request.version, { status, closedAt: now.toISOString(), closedBy: actorId, closeReason: reason })
  }
  if (!recordId) for (const request of store.list<DeadlineChangeRequest>('deadlineChangeRequests')) if (request.taskId === taskId && request.status === 'open') {
    store.update<DeadlineChangeRequest>('deadlineChangeRequests', request.id, request.version, { status, decidedAt: now.toISOString(), decidedBy: actorId, decisionNote: reason })
  }
}
/** The task cancellation transaction owns this cleanup; historical progress and receipts stay immutable. */
export function cancelTaskCollaboration(store: Store, taskId: string, now: Date, actorId: string, reason: string): void {
  const closureReason = `任务已作废：${reason}`
  const tracking = store.get<TaskTracking>('taskTrackings', taskId)
  if (tracking && tracking.state !== 'closed') store.update<TaskTracking>('taskTrackings', tracking.id, tracking.version, {
    state: 'closed', closedAt: now.toISOString(), closedReason: closureReason, reviewAt: null,
  })
  endTaskRequests(store, taskId, now, actorId, closureReason)
  for (const episode of store.list<BlockerEpisode>('blockerEpisodes')) if (episode.parentTaskId === taskId && !episode.resolvedAt) {
    store.update<BlockerEpisode>('blockerEpisodes', episode.id, episode.version, {
      resolvedAt: now.toISOString(), resolvedBy: actorId, closureReason,
    })
  }
}
export function weeklyActiveFrom(record: WeeklyRecord, now: Date): string {
  const start = new Date(`${record.weekStart}T00:00:00+08:00`).toISOString()
  return start > now.toISOString() ? start : now.toISOString()
}
