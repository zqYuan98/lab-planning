import type { AuditEvent, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { BlockerAction, BlockerEpisode, DeadlineChangeRequest, ProgressContent, ProgressEvent, ProgressFieldChange, TaskTracking } from '../shared/collaboration.ts'
import { randomUUID } from 'node:crypto'
import { collaborationEnabledFor, readCollaborationSettings, taskTrackingEligible } from './collaboration-policy.ts'
import { collaborationId, meaningfulText, requiredText, taskBusinessEvent } from './collaboration-store.ts'
import { endTaskRequests, enrollTaskTracking, weeklyActiveFrom } from './collaboration-tracking.ts'
import { HttpError, type Store } from './store.ts'
import { publishCollaborationEvents, recordPlanLifecycleEvent } from './collaboration-notifications.ts'
import { isSilentImport } from './import-notification-context.ts'
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { isActiveTask } from '../shared/task-state.ts'

interface MutationContext {
  actor: User; mutationId: string; now: Date; input: ProgressContent; source: ProgressEvent['source'];
  events: AuditEvent[]; weeklyAssignment?: boolean; result: ProgressEvent | null
}
const contexts = new WeakMap<Store, MutationContext>()
export function withCollaborationMutation<T>(store: Store, context: Omit<MutationContext, 'events' | 'result'>, operation: () => T): { value: T; event: ProgressEvent | null } {
  const current = contexts.get(store)
  if (current) return { value: operation(), event: current.result }
  const active: MutationContext = { ...context, events: [], result: null }
  contexts.set(store, active)
  try {
    const value = operation()
    active.result = processAudits(store, active)
    return { value, event: active.result }
  } finally { contexts.delete(store) }
}
export function currentCollaborationMutation(store: Store): ProgressContent | undefined { return contexts.get(store)?.input }
export function collaborationWorkMutation<T>(store: Store, actor: User, input: Record<string, unknown>, source: ProgressEvent['source'], operation: () => T, weeklyAssignment = false): T {
  return store.transaction(() => {
    if (isSilentImport(store)) return operation()
    if (contexts.has(store)) return operation()
    const now = new Date()
    const result = withCollaborationMutation(store, { actor, mutationId: randomUUID(), now, input: input as ProgressContent, source, weeklyAssignment }, operation)
    publishCollaborationEvents(store, now)
    return result.value
  })
}
const taskProgressFields = ['status', 'currentProgress', 'completionNote', 'evidenceUrl', 'blockerReason', 'blockerImpact', 'supportNeeded', 'nextAction'] as const
const weeklyProgressFields = ['status', 'actualOutcome', 'evidenceUrl', 'blocker', 'blockerImpact', 'supportNeeded', 'nextAction'] as const
function progressChanges(event: AuditEvent, includePendingWeekly = false): ProgressFieldChange[] {
  if (!event.after || !['task', 'weeklyRecord'].includes(event.entityType) || !event.before && event.entityType === 'task') return []
  if (event.entityType === 'weeklyRecord') {
    const record = event.after as WeeklyRecord
    if (!isEffectiveWeeklyRecord(record) && !(includePendingWeekly && isActiveWeeklyRecord(record) && record.submitted)) return []
  }
  const before = (event.before ?? { status: 'planned' }) as Record<string, unknown>, after = event.after as Record<string, unknown>
  return (event.entityType === 'task' ? taskProgressFields : weeklyProgressFields).flatMap(field => {
    const old = meaningfulText(before[field]), next = meaningfulText(after[field])
    return old === next ? [] : [{ field: `${event.entityType}.${field}`, before: old, after: next }]
  })
}

/** Collaboration policies only; basic work completeness is checked by WorkService. */
export function validateCollaborationWorkUpdate(store: Store, actor: User, before: Task | WeeklyRecord, input: Record<string, unknown>, type: 'task' | 'weeklyRecord') {
  if (isSilentImport(store) || !collaborationEnabledFor(store, before.ownerId)) return
  const context = contexts.get(store)?.input ?? {}
  if (type === 'task') {
    const task = before as Task
    if (input.dueDate !== undefined && input.dueDate !== task.dueDate && actor.id === task.ownerId && !isManager(actor) && task.workOrigin?.kind === 'assigned' && store.get<TaskTracking>('taskTrackings', task.id) && readCollaborationSettings(store).deadlineApprovalEnabled) throw new HttpError(409, '该下达任务改期需要先提出延期申请')
  }
  const prospective = { ...before, ...input }
  const changes = progressChanges({ entityType: type, before, after: prospective } as AuditEvent)
  if (actor.id !== before.ownerId && changes.length && !meaningfulText(input.proxyReason ?? input.reason ?? context.proxyReason)) throw new HttpError(400, '管理者代录进展需要填写代理原因')
}

export function onCollaborationAudit(store: Store, actor: User, event: AuditEvent): void {
  if (isSilentImport(store)) return
  const active = contexts.get(store)
  if (active) { active.events.push(event); return }
  processAudits(store, { actor, mutationId: event.id, now: new Date(event.createdAt), input: {}, source: event.entityType === 'weeklyRecord' ? 'weeklyRecord' : 'task', events: [event], result: null })
  publishCollaborationEvents(store, new Date(event.createdAt))
}

function lifecycle(store: Store, context: MutationContext, event: AuditEvent) {
  const { actor, now } = context
  if (!readCollaborationSettings(store).enabled) return
  if (event.entityType === 'task' || event.entityType === 'weeklyRecord') {
    const work = event.after as Task | WeeklyRecord | null
    const task = event.entityType === 'task' ? work as Task | null : work ? store.get<Task>('tasks', (work as WeeklyRecord).taskId) : undefined
    if (!task || !collaborationEnabledFor(store, task.ownerId)) return
    let tracking = store.get<TaskTracking>('taskTrackings', task.id)
    const published = event.entityType === 'task' || isEffectiveWeeklyRecord(work as WeeklyRecord)
    const firstPublication = !event.before || event.entityType === 'weeklyRecord' && !isEffectiveWeeklyRecord(event.before as WeeklyRecord)
    const freshAssignment = !task.importSource || task.importSource.mode === 'draft' && event.entityType === 'weeklyRecord' && firstPublication
    if (!tracking && published && firstPublication && isManager(actor) && actor.id !== task.ownerId && freshAssignment && work?.workOrigin?.kind === 'assigned' && taskTrackingEligible(store, task, now)) {
      const inBatch = context.weeklyAssignment && event.entityType === 'task'
      if (!inBatch) tracking = enrollTaskTracking(store, task, actor, now, 'assignment', event.entityType === 'weeklyRecord' ? { activeFrom: weeklyActiveFrom(work as WeeklyRecord, now) } : {})
    }
    if (!tracking) return
    if (event.entityType === 'task' && event.before) {
      const before = event.before as Task
      if (before.dueDate !== task.dueDate) {
        tracking = store.update<TaskTracking>('taskTrackings', tracking.id, tracking.version, { currentDueDate: task.dueDate, dueDateVersion: tracking.dueDateVersion + 1 })
        for (const request of store.list<DeadlineChangeRequest>('deadlineChangeRequests')) if (request.taskId === task.id && request.status === 'open') store.update<DeadlineChangeRequest>('deadlineChangeRequests', request.id, request.version, { status: 'superseded', decidedAt: now.toISOString(), decidedBy: actor.id, decisionNote: '任务截止日期已更新' })
        taskBusinessEvent(store, task, actor, context.mutationId, 'deadline_changed', now, { title: task.title, oldDueDate: before.dueDate, dueDate: task.dueDate, reason: event.reason, auditEventId: event.id }, { recipientIds: [task.ownerId, ...importManagerIds(store, task)], generation: tracking.generation })
      }
    }
    if (tracking.state !== 'closed' && (!taskTrackingEligible(store, task, now) || tracking.ownerId !== task.ownerId)) {
      const reason = task.status === 'done' ? '任务已完成' : '任务或负责人已失效'
      store.update<TaskTracking>('taskTrackings', tracking.id, tracking.version, { state: 'closed', closedAt: now.toISOString(), closedReason: reason })
      endTaskRequests(store, task.id, now, actor.id, reason)
    }
    if (event.entityType === 'weeklyRecord' && event.before && isEffectiveWeeklyRecord(event.before as WeeklyRecord) && !isEffectiveWeeklyRecord(work as WeeklyRecord)) endTaskRequests(store, task.id, now, actor.id, isActiveWeeklyRecord(work as WeeklyRecord) ? '周安排已撤回或待重新审核' : '周安排已删除', 'cancelled', work!.id)
  } else if (['plan', 'project', 'user'].includes(event.entityType)) {
    for (const tracking of store.list<TaskTracking>('taskTrackings').filter(row => row.state !== 'closed')) {
      const task = store.get<Task>('tasks', tracking.taskId)
      if (!task || !taskTrackingEligible(store, task, now) || task.ownerId !== tracking.ownerId) {
        store.update<TaskTracking>('taskTrackings', tracking.id, tracking.version, { state: 'closed', closedAt: now.toISOString(), closedReason: '关联事项或负责人已失效' })
        endTaskRequests(store, tracking.taskId, now, actor.id, '关联事项或负责人已失效')
      }
    }
  }
}
import { effectiveManagerIds as importManagerIds } from './collaboration-policy.ts'
import { isManager } from './authorization.ts'

function updateBlocker(store: Store, context: MutationContext, event: AuditEvent, task: Task) {
  if (!event.after) return
  const before = (event.before ?? { status: 'planned' }) as Task | WeeklyRecord, after = event.after as Task | WeeklyRecord
  const tracking = store.get<TaskTracking>('taskTrackings', task.id)
  const current = store.list<BlockerEpisode>('blockerEpisodes').find(row => row.sourceType === event.entityType && row.sourceId === event.entityId && !row.resolvedAt)
  const blocked = isActiveTask(task) && after.status === 'blocked' && (event.entityType !== 'weeklyRecord' || isEffectiveWeeklyRecord(after as WeeklyRecord))
  if (!blocked && current) {
    const note = after.status === 'done' ? '已完成' : '阻塞已解除或周安排已撤回'
    store.update<BlockerEpisode>('blockerEpisodes', current.id, current.version, { resolvedAt: context.now.toISOString(), resolvedBy: context.actor.id, closureReason: note })
    store.insert<BlockerAction>('blockerActions', { episodeId: current.id, taskId: task.id, ownerId: task.ownerId, actorId: context.actor.id, action: 'resolve', note, reviewAt: null, occurredAt: context.now.toISOString() })
  }
  const details = { reason: event.entityType === 'task' ? (after as Task).blockerReason ?? '' : (after as WeeklyRecord).blocker, impact: context.input.blockerImpact ?? after.blockerImpact ?? '', supportNeeded: context.input.supportNeeded ?? after.supportNeeded ?? '' }
  if (blocked && current && (current.reason !== details.reason || current.impact !== details.impact || current.supportNeeded !== details.supportNeeded)) store.update<BlockerEpisode>('blockerEpisodes', current.id, current.version, details)
  if (blocked && !current && (before.status !== 'blocked' || event.entityType === 'weeklyRecord' && !isEffectiveWeeklyRecord(before as WeeklyRecord))) {
    store.insert<BlockerEpisode>('blockerEpisodes', {
      id: collaborationId('blocker', context.mutationId, event.entityType, event.entityId), sourceType: event.entityType as 'task' | 'weeklyRecord', sourceId: event.entityId,
      parentTaskId: task.id, ownerId: task.ownerId, generation: tracking?.generation ?? 0, openedAt: context.now.toISOString(), openedBy: context.actor.id,
      resolvedAt: null, resolvedBy: null, ...details, reviewAt: null, closureReason: '',
      coordinatorId: null, responseDueAt: null, coordinationState: 'unassigned', responseNote: '', openedAtKnown: true,
    })
  }
}
function processAudits(store: Store, context: MutationContext): ProgressEvent | null {
  if (isSilentImport(store)) return null
  for (const event of context.events) {
    if (event.entityType === 'plan') recordPlanLifecycleEvent(store, context.actor, event)
    lifecycle(store, context, event)
  }
  const workEvents = context.events.filter(event => ['task', 'weeklyRecord'].includes(event.entityType) && event.after)
  const first = workEvents[0], firstWork = first?.after as Task | WeeklyRecord | undefined
  const task = firstWork ? store.get<Task>('tasks', first!.entityType === 'task' ? firstWork.id : (firstWork as WeeklyRecord).taskId) : undefined
  if (!task || !isActiveTask(task)) return null
  for (const event of workEvents) {
    const work = event.after as Task | WeeklyRecord
    const eventTask = store.get<Task>('tasks', event.entityType === 'task' ? work.id : (work as WeeklyRecord).taskId)
    if (eventTask) updateBlocker(store, context, event, eventTask)
  }
  const officialChanges = workEvents.flatMap(event => progressChanges(event))
  // The explicit progress API must persist real execution feedback even while its plan is awaiting review.
  const changes = context.source === 'progress' ? workEvents.flatMap(event => progressChanges(event, true)) : officialChanges
  const note = requiredText(context.input.note, '进展说明', false), noChange = context.input.noteType === 'no_change'
  const prior = store.list<ProgressEvent>('progressEvents').filter(row => row.taskId === task.id && row.actorId === context.actor.id).at(-1)
  const newNote = !!meaningfulText(note) && meaningfulText(prior?.note) !== meaningfulText(note)
  if (!changes.length && !newNote && !noChange) return null
  if (noChange && changes.some(change => !change.field.endsWith('.nextAction'))) throw new HttpError(400, '暂无变化不能同时修改执行状态或成果，请选择更新进展')
  if (noChange && (!meaningfulText(context.input.noChangeReason) || !meaningfulText(context.input.nextAction))) throw new HttpError(400, '暂无变化需要填写原因和下一步')
  if (collaborationEnabledFor(store, task.ownerId) && context.actor.id !== task.ownerId && !meaningfulText(context.input.proxyReason)) throw new HttpError(400, '管理者代录进展需要填写代理原因')
  const formalProgress = officialChanges.length > 0 || newNote || noChange
  const meaningfulOwnerProgress = context.actor.id === task.ownerId && !noChange && (officialChanges.length > 0 || newNote)
  const weekly = workEvents.find(event => event.entityType === 'weeklyRecord')?.after as WeeklyRecord | undefined
  const progress = store.insert<ProgressEvent>('progressEvents', {
    id: collaborationId('progress', context.mutationId, task.id), mutationId: context.mutationId, taskId: task.id, weeklyRecordId: weekly?.id ?? context.input.weeklyRecordId ?? null,
    actorId: context.actor.id, ownerId: task.ownerId, source: context.source, noteType: noChange ? 'no_change' : 'progress', note,
    noChangeReason: context.input.noChangeReason?.trim() ?? '', nextAction: context.input.nextAction?.trim() ?? '', proxyReason: context.input.proxyReason?.trim() ?? '',
    changes, meaningfulOwnerProgress, occurredAt: context.now.toISOString(), auditEventIds: context.events.map(event => event.id),
  })
  // Facts belong to base work. Optional tracking and notification derivation remain gated.
  if (!collaborationEnabledFor(store, task.ownerId)) return progress
  const tracking = store.get<TaskTracking>('taskTrackings', task.id)
  if (tracking && formalProgress) store.update<TaskTracking>('taskTrackings', tracking.id, tracking.version, { lastRecordedProgressAt: context.now.toISOString(), ...(meaningfulOwnerProgress ? { lastMeaningfulOwnerProgressAt: context.now.toISOString() } : {}) })
  if (formalProgress) taskBusinessEvent(store, task, context.actor, context.mutationId, 'progress_recorded', context.now, { title: task.title, progressEventId: progress.id, note, noteType: progress.noteType, nextAction: progress.nextAction }, { generation: tracking?.generation })
  for (const event of workEvents) {
    if (event.entityType === 'weeklyRecord' && !isEffectiveWeeklyRecord(event.after as WeeklyRecord)) continue
    const before = (event.before ?? { status: 'planned' }) as Task | WeeklyRecord, after = event.after as Task | WeeklyRecord
    const blockerEdited = after.status === 'blocked' && progressChanges(event).some(change => ['blocker', 'blockerReason', 'blockerImpact', 'supportNeeded'].some(field => change.field.endsWith(`.${field}`)))
    if (before.status === after.status && !blockerEdited) continue
    const kind = after.status === 'done' ? 'work_completed' : before.status === 'done' ? 'work_reopened' : after.status === 'blocked' ? 'work_blocked' : before.status === 'blocked' ? 'work_unblocked' : null
    if (kind) taskBusinessEvent(store, task, context.actor, context.mutationId, kind, context.now,
      { title: task.title, status: after.status, previousStatus: before.status, note: event.entityType === 'task' ? (after as Task).completionNote ?? note : (after as WeeklyRecord).actualOutcome,
        blocker: event.entityType === 'task' ? (after as Task).blockerReason ?? '' : (after as WeeklyRecord).blocker, supportNeeded: context.input.supportNeeded ?? (after as Task).supportNeeded ?? '' },
      { subjectType: event.entityType as 'task' | 'weeklyRecord', subjectId: event.entityId, sourceVersion: after.version, generation: tracking?.generation })
  }
  return progress
}
