import type { BlockerAction, BlockerEpisode, CollaborationSettings, CollaborationTaskView, DeadlineChangeRequest, DeadlineDecisionResult, FollowupRequest, FollowupResponse, FollowupResult, ProgressContent, ProgressResult, TaskTracking, TrackingPreview } from '../shared/collaboration.ts'
import type { AuditEvent, Task, User, WeeklyRecord } from '../shared/types.ts'
import { summarizeCollaborationTask } from '../shared/collaboration-task-summary.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { WorkService } from './domain-work.ts'
import { date } from './domain-common.ts'
import { HttpError, Store } from './store.ts'
import { COLLABORATION_SETTINGS_ID, collaborationEnabledFor, collaborationTask, defaultFollowupDueAt, effectiveManagerIds, liveCollaborationActor, readCollaborationSettings, taskTrackingEligible, validManagerIds } from './collaboration-policy.ts'
import { collaborationCommand, collaborationId, ensureVersion, meaningfulText, requiredText, taskBusinessEvent, utcTime } from './collaboration-store.ts'
import { endTaskRequests, enrollTaskTracking } from './collaboration-tracking.ts'
import { withCollaborationMutation } from './collaboration-hooks.ts'
import { TaskSupportService } from './task-support.ts'
import { scheduleWeeklyCalendarChange } from './weekly-calendar-service.ts'

export { readCollaborationSettings, effectiveManagerIds, taskTrackingEligible } from './collaboration-policy.ts'
type Input = Record<string, unknown>

export class CollaborationService {
  constructor(private store: Store, private clock: () => Date = () => new Date()) {}
  private enabled(task: Task) {
    if (!collaborationEnabledFor(this.store, task.ownerId)) throw new HttpError(409, '此功能尚未对该成员启用')
  }
  private task(actor: User, id: string, requireEnabled = true): Task {
    const task = collaborationTask(this.store, actor, id)
    if (requireEnabled && !isActiveTask(task)) throw new HttpError(409, '任务已作废，不能继续更新或催办')
    if (requireEnabled) this.enabled(task)
    return task
  }
  private manager(actor: User) { return liveCollaborationActor(this.store, actor, true) }
  private tracking(task: Task): TaskTracking {
    const row = this.store.get<TaskTracking>('taskTrackings', task.id)
    if (!row || row.ownerId !== task.ownerId) throw new HttpError(409, '任务尚未纳入当前督办范围')
    return row
  }
  private audit(actor: User, type: string, id: string, action: string, before: unknown, after: unknown, reason = '') {
    this.store.insert<AuditEvent>('events', { entityType: type, entityId: id, actorId: actor.id, action, reason, before, after })
  }
  private followup(actor: User, id: string): FollowupRequest {
    const row = this.store.get<FollowupRequest>('followupRequests', id)
    if (!row) throw new HttpError(404, '催办请求不存在')
    const task = this.task(actor, row.taskId)
    if (actor.role !== 'manager' && row.ownerId !== actor.id || task.ownerId !== row.ownerId) throw new HttpError(404, '催办请求不存在或负责人已变更')
    return row
  }
  taskView(actor: User, taskId: string, options: { includeProgress?: boolean } = {}): CollaborationTaskView {
    const viewer = liveCollaborationActor(this.store, actor)
    const task = this.task(viewer, taskId, false), manager = viewer.role === 'manager'
    const rows = <T extends { taskId?: string; parentTaskId?: string; ownerId: string }>(collection: string): T[] => this.store.selectJson<T>("SELECT data FROM entities WHERE collection=? AND COALESCE(json_extract(data,'$.taskId'),json_extract(data,'$.parentTaskId'))=? AND (?=1 OR json_extract(data,'$.ownerId')=?) ORDER BY rowid", [collection, task.id, manager ? 1 : 0, actor.id])
    return { task, ...summarizeCollaborationTask(task, this.store.selectJson<WeeklyRecord>("SELECT data FROM entities WHERE collection='weeklyRecords' AND json_extract(data,'$.taskId')=? ORDER BY rowid", [task.id]), viewer, this.clock()), tracking: this.store.get<TaskTracking>('taskTrackings', task.id) ?? null,
      progressEvents: options.includeProgress === false ? [] : rows('progressEvents'), followups: rows('followupRequests'), responses: rows('followupResponses'), blockerEpisodes: rows('blockerEpisodes'), blockerActions: rows('blockerActions'), deadlineRequests: rows('deadlineChangeRequests'),
      effectiveManagerIds: effectiveManagerIds(this.store, task), enabled: isActiveTask(task) && collaborationEnabledFor(this.store, task.ownerId), eligible: taskTrackingEligible(this.store, task, this.clock()) }
  }
  previewTracking(actor: User, taskId: string): TrackingPreview {
    this.manager(actor)
    const task = this.task(actor, taskId, false), row = this.store.get<TaskTracking>('taskTrackings', task.id), now = this.clock()
    const eligible = taskTrackingEligible(this.store, task, now), reasons = eligible ? [] : ['任务须处于试点范围、负责人有效、上级计划已发布且任务尚未完成']
    const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
    const risks = [task.dueDate && task.dueDate < day ? '截止日期已过，恢复不会改写原截止' : '', task.status === 'blocked' ? '任务仍处于阻塞' : '', this.store.list<FollowupRequest>('followupRequests').some(request => request.taskId === task.id && request.status === 'open' && request.dueAt < now.toISOString()) ? '已有催办超过回应期限' : ''].filter(Boolean)
    return { taskId, taskVersion: task.version, trackingVersion: row?.version ?? 0, eligible, reasons, activeFrom: row?.activeFrom ?? now.toISOString(), effectiveManagerIds: effectiveManagerIds(this.store, task), risks }
  }
  updateSettings(actor: User, input: Input): CollaborationSettings {
    actor = this.manager(actor)
    return collaborationCommand(this.store, actor, 'settings', input, this.clock(), () => {
      const before = readCollaborationSettings(this.store)
      ensureVersion(before.version, input.version)
      const booleans = ['enabled', 'autoRulesEnabled', 'deadlineApprovalEnabled', 'dailyManagerEnabled', 'weeklyManagerEnabled', 'memberActionsEnabled'] as const
      const patch: Partial<CollaborationSettings> = {}
      for (const field of booleans) {
        if (input[field] !== undefined && typeof input[field] !== 'boolean') throw new HttpError(400, '功能开关必须为布尔值')
        patch[field] = input[field] === undefined ? before[field] : input[field] as boolean
      }
      const pilots = input.pilotUserIds ?? before.pilotUserIds
      if (!Array.isArray(pilots) || pilots.length > 1000 || pilots.some(id => typeof id !== 'string') || new Set(pilots).size !== pilots.length) throw new HttpError(400, '试点成员列表无效')
      for (const id of pilots) { const user = this.store.get<User>('users', id); if (!user || !canUseAccount(user)) throw new HttpError(400, '试点成员必须是有效账号') }
      patch.pilotUserIds = pilots
      patch.defaultManagerIds = validManagerIds(this.store, input.defaultManagerIds ?? before.defaultManagerIds)
      if (patch.enabled && !pilots.length) throw new HttpError(400, '启用协作功能前请明确选择试点成员')
      const overrides = input.calendarOverrides ?? before.calendarOverrides
      if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).length > 1500) throw new HttpError(400, '工作日历格式无效')
      for (const [key, value] of Object.entries(overrides)) { date(key, '日历日期'); if (typeof value !== 'boolean') throw new HttpError(400, '日历标记必须为布尔值') }
      patch.calendarOverrides = overrides as Record<string, boolean>
      for (const field of ['staleWorkdays', 'blockerWorkdays'] as const) {
        const value = input[field] ?? before[field]
        if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 30) throw new HttpError(400, '工作日阈值须在 1 至 30 天之间')
        patch[field] = Number(value)
      }
      patch.enabledAt = patch.enabled && !before.enabled ? this.clock().toISOString() : before.enabledAt
      const window = this.store.get<{ sendStartHour: number; sendEndHour: number }>('notificationSettings', 'notifications') ?? { sendStartHour: 8, sendEndHour: 20 }
      const allows = (hour: number) => window.sendStartHour <= hour && hour < window.sendEndHour
      if (patch.autoRulesEnabled && !allows(9) && !allows(17)) throw new HttpError(400, '自动规则至少需要允许 09:00 或 17:00，请调整总发送时段')
      if ((patch.dailyManagerEnabled || patch.weeklyManagerEnabled || patch.memberActionsEnabled) && !allows(17.5)) throw new HttpError(400, '摘要需要允许 17:30，请调整总发送时段')
      const row = before.version ? this.store.update<CollaborationSettings>('collaborationSettings', before.id, before.version, patch) : this.store.insert<CollaborationSettings>('collaborationSettings', { ...before, ...patch, id: COLLABORATION_SETTINGS_ID })
      if (JSON.stringify(before.calendarOverrides) !== JSON.stringify(row.calendarOverrides)) scheduleWeeklyCalendarChange(this.store, actor, row.calendarOverrides, this.clock())
      this.audit(actor, 'collaborationSettings', row.id, 'update', before.version ? before : null, row)
      return row
    })
  }
  updateTracking(actor: User, taskId: string, input: Input): TaskTracking {
    actor = this.manager(actor); this.task(actor, taskId)
    return collaborationCommand(this.store, actor, `tracking:${taskId}`, input, this.clock(), mutationId => {
      const now = this.clock(), task = this.task(actor, taskId), old = this.store.get<TaskTracking>('taskTrackings', taskId)
      ensureVersion(task.version, input.taskVersion); ensureVersion(old?.version ?? 0, input.version)
      if (!['active', 'paused', 'closed'].includes(String(input.state))) throw new HttpError(400, '督办状态无效')
      const state = input.state as TaskTracking['state'], reason = requiredText(input.reason, '状态调整原因', state !== 'active' || !!old)
      const recipients = input.managerRecipientIds === undefined ? old?.managerRecipientIds ?? [] : validManagerIds(this.store, input.managerRecipientIds)
      let row: TaskTracking
      if (!old || old.state === 'closed' && state === 'active') {
        if (state !== 'active') throw new HttpError(409, '请先显式纳入督办')
        row = enrollTaskTracking(this.store, task, actor, now, 'manual', { managerRecipientIds: recipients })
      } else {
        if (old.ownerId !== task.ownerId) throw new HttpError(409, '负责人已改变，请重新纳入督办')
        if (state === 'active' && !taskTrackingEligible(this.store, task, now)) throw new HttpError(409, '任务当前不满足恢复条件')
        const reviewAt = state === 'paused' ? utcTime(input.reviewAt, '复查时间') : null
        if (reviewAt && reviewAt <= now.toISOString()) throw new HttpError(400, '暂停复查时间必须在未来')
        row = this.store.update<TaskTracking>('taskTrackings', old.id, old.version, { state, managerRecipientIds: recipients, ruleVersion: readCollaborationSettings(this.store).version,
          pauseReason: state === 'paused' ? reason : '', reviewAt, closedAt: state === 'closed' ? now.toISOString() : null, closedReason: state === 'closed' ? reason : '',
          ...(old.state === 'paused' && state === 'active' ? { reminderBaselineAt: now.toISOString() } : {}) })
      }
      if (state === 'closed') endTaskRequests(this.store, task.id, now, actor.id, reason)
      this.audit(actor, 'taskTracking', row.id, state, old ?? null, row, reason)
      taskBusinessEvent(this.store, task, actor, mutationId, 'tracking_changed', now, { title: task.title, state, reason }, { generation: row.generation })
      return row
    })
  }
  private saveProgress(actor: User, taskId: string, taskVersion: unknown, content: ProgressContent, mutationId: string, source: 'progress' | 'followup', at?: Date): ProgressResult {
    for (const field of ['note', 'noChangeReason', 'nextAction', 'completionNote', 'evidenceUrl', 'blockerReason', 'blockerImpact', 'supportNeeded', 'proxyReason'] as const) if (content[field] !== undefined) requiredText(content[field], '进展内容', false, field === 'evidenceUrl' ? 2000 : 12000)
    if (content.weekly !== undefined && (!content.weekly || typeof content.weekly !== 'object' || Array.isArray(content.weekly))) throw new HttpError(400, '本周进展格式无效')
    // A followup response passes its own instant so its progress event and response share one timestamp.
    const now = at ?? this.clock(), task = this.task(actor, taskId)
    ensureVersion(task.version, taskVersion)
    const noteType = content.noteType ?? 'progress'
    if (!['progress', 'no_change'].includes(noteType)) throw new HttpError(400, '进展类型无效')
    if (noteType === 'no_change' && (!meaningfulText(content.noChangeReason) || !meaningfulText(content.nextAction))) throw new HttpError(400, '暂无变化需要填写原因和下一步')
    const record = content.weeklyRecordId ? this.store.get<WeeklyRecord>('weeklyRecords', content.weeklyRecordId) : undefined
    if (content.weeklyRecordId && (!record || !isActiveWeeklyRecord(record) || record.taskId !== task.id || record.ownerId !== task.ownerId || !record.submitted)) throw new HttpError(409, '周安排已变化或尚未正式生效')
    if (record) ensureVersion(record.version, content.weeklyRecordVersion)
    if (content.weekly && !record) throw new HttpError(400, '更新本周进展须指定有效周记录及版本')
    const work = new WorkService(this.store)
    const result = withCollaborationMutation(this.store, { actor, mutationId, now, input: content, source }, () => {
      const patch: Input = { version: task.version, proxyReason: content.proxyReason }
      if (content.taskStatus !== undefined) patch.status = content.taskStatus
      for (const field of ['completionNote', 'evidenceUrl', 'blockerReason', 'blockerImpact', 'supportNeeded', 'nextAction'] as const) if (content[field] !== undefined) patch[field] = content[field]
      const updatedTask = work.updateTask(actor, task.id, patch)
      const weeklyRecord = record && content.weekly ? work.updateWeeklyRecord(actor, record.id, { version: record.version, ...content.weekly, blockerImpact: content.blockerImpact, supportNeeded: content.supportNeeded, proxyReason: content.proxyReason }) : record ?? null
      return { task: updatedTask, weeklyRecord }
    })
    if (!result.event) throw new HttpError(400, '请填写新的实质进展；暂无变化时请明确选择并填写原因和下一步')
    return { ...result.value, tracking: this.store.get<TaskTracking>('taskTrackings', task.id) ?? null, progressEvent: result.event, followup: null, response: null }
  }
  recordProgress(actor: User, taskId: string, input: Input): ProgressResult {
    this.task(actor, taskId)
    return collaborationCommand(this.store, actor, `progress:${taskId}`, input, this.clock(), mutationId => {
      const target = input.respondTo as { id?: unknown; version?: unknown } | undefined
      if (target) return this.respond(actor, String(target.id), target.version, input.version, input as ProgressContent, mutationId, taskId)
      return this.saveProgress(actor, taskId, input.version, input as ProgressContent, mutationId, 'progress')
    })
  }
  createFollowup(actor: User, taskId: string, input: Input): FollowupResult {
    actor = this.manager(actor); this.task(actor, taskId)
    return collaborationCommand(this.store, actor, `followup.create:${taskId}`, input, this.clock(), mutationId => {
      const now = this.clock(), task = this.task(actor, taskId)
      ensureVersion(task.version, input.version)
      if (!taskTrackingEligible(this.store, task, now)) throw new HttpError(409, '该任务当前无需或不能催办')
      let tracking = this.store.get<TaskTracking>('taskTrackings', task.id)
      if (!tracking || tracking.state === 'closed') {
        if (input.enroll !== true) throw new HttpError(409, '请先预览并明确将该任务纳入督办')
        tracking = enrollTaskTracking(this.store, task, actor, now, 'manual', { managerRecipientIds: input.managerRecipientIds === undefined ? undefined : validManagerIds(this.store, input.managerRecipientIds) })
      }
      if (tracking.state !== 'active') throw new HttpError(409, '督办已暂停，请先明确恢复')
      const existing = this.store.list<FollowupRequest>('followupRequests').find(row => row.taskId === taskId && row.ownerId === task.ownerId && row.status === 'open')
      if (existing) return { request: existing, tracking, existing: true }
      let record: WeeklyRecord | undefined
      if (input.weeklyRecordId) {
        record = this.store.get<WeeklyRecord>('weeklyRecords', String(input.weeklyRecordId))
        if (!record || record.taskId !== task.id || record.ownerId !== task.ownerId || !isEffectiveWeeklyRecord(record)) throw new HttpError(409, '周安排当前不可用或尚未通过审核')
        ensureVersion(record.version, input.weeklyRecordVersion)
      }
      const dueAt = input.dueAt === undefined ? defaultFollowupDueAt(this.store, now) : utcTime(input.dueAt, '回应期限')
      if (dueAt <= now.toISOString()) throw new HttpError(400, '回应期限必须在未来')
      const recipients = input.managerRecipientIds === undefined ? effectiveManagerIds(this.store, task) : validManagerIds(this.store, input.managerRecipientIds)
      const request = this.store.insert<FollowupRequest>('followupRequests', { id: collaborationId('followup', mutationId), taskId, weeklyRecordId: record?.id ?? null,
        ownerId: task.ownerId, requestedBy: actor.id, managerRecipientIds: recipients, generation: tracking.generation, requirement: requiredText(input.requirement, '更新要求'), dueAt,
        status: 'open', respondedAt: null, closedAt: null, closedBy: null, closeReason: '', lastChangedBy: actor.id, changeReason: '' })
      this.audit(actor, 'followupRequest', request.id, 'create', null, request)
      taskBusinessEvent(this.store, task, actor, mutationId, 'followup_requested', now, { title: task.title, followupId: request.id, requirement: request.requirement, dueAt }, { recipientIds: [task.ownerId], generation: tracking.generation, sourceVersion: request.version })
      return { request, tracking, existing: false }
    })
  }
  updateFollowup(actor: User, id: string, input: Input): FollowupRequest {
    actor = this.manager(actor); this.followup(actor, id)
    return collaborationCommand(this.store, actor, `followup.update:${id}`, input, this.clock(), mutationId => {
      const before = this.followup(actor, id), task = this.task(actor, before.taskId), now = this.clock()
      ensureVersion(before.version, input.version)
      if (before.status !== 'open' || !taskTrackingEligible(this.store, task, now) || this.tracking(task).state !== 'active') throw new HttpError(409, '催办已关闭或当前不可修改')
      const dueAt = input.dueAt === undefined ? before.dueAt : utcTime(input.dueAt, '回应期限')
      if (input.dueAt !== undefined && dueAt <= now.toISOString()) throw new HttpError(400, '新的回应期限必须在未来')
      const request = this.store.update<FollowupRequest>('followupRequests', id, before.version, { dueAt, requirement: input.requirement === undefined ? before.requirement : requiredText(input.requirement, '更新要求'), lastChangedBy: actor.id, changeReason: requiredText(input.reason, '修改原因') })
      this.audit(actor, 'followupRequest', id, 'update', before, request, request.changeReason)
      taskBusinessEvent(this.store, task, actor, mutationId, 'followup_changed', now, { title: task.title, followupId: request.id, requirement: request.requirement, dueAt }, { recipientIds: [task.ownerId], generation: request.generation, sourceVersion: request.version })
      return request
    })
  }
  private respond(actor: User, id: string, expected: unknown, taskVersion: unknown, content: ProgressContent, mutationId: string, expectedTaskId?: string): ProgressResult {
    const before = this.followup(actor, id), task = this.task(actor, before.taskId), now = this.clock(), tracking = this.tracking(task)
    if (actor.id !== before.ownerId) throw new HttpError(403, '只有本人可以回应催办；管理者代录请使用核实关闭')
    if (expectedTaskId && before.taskId !== expectedTaskId) throw new HttpError(409, '催办与当前任务不一致')
    ensureVersion(before.version, expected)
    if (before.status !== 'open' || tracking.generation !== before.generation || tracking.state === 'closed' || task.status === 'done') throw new HttpError(409, '催办已结束或工作安排已有变化，请刷新')
    if (before.weeklyRecordId && content.weeklyRecordId !== before.weeklyRecordId) throw new HttpError(409, '回应须携带原周安排及当前版本')
    const result = this.saveProgress(actor, task.id, taskVersion, content, mutationId, 'followup', now)
    const current = this.store.get<FollowupRequest>('followupRequests', id)!
    const request = this.store.update<FollowupRequest>('followupRequests', id, current.version, { status: 'responded', respondedAt: now.toISOString(), closedAt: null, closedBy: null, closeReason: '' })
    const response = this.store.insert<FollowupResponse>('followupResponses', { id: collaborationId('response', mutationId), followupRequestId: id, requestVersion: before.version, taskId: task.id,
      weeklyRecordId: content.weeklyRecordId ?? null, ownerId: task.ownerId, actorId: actor.id, progressEventId: result.progressEvent!.id, respondedAt: now.toISOString(), dueAt: before.dueAt, late: now.toISOString() > before.dueAt, mutationId })
    this.audit(actor, 'followupRequest', id, 'respond', before, request)
    taskBusinessEvent(this.store, result.task, actor, mutationId, 'followup_responded', now, { title: task.title, followupId: id, progressEventId: result.progressEvent!.id, late: response.late, dueAt: before.dueAt }, { recipientIds: before.managerRecipientIds, generation: before.generation, sourceVersion: request.version })
    return { ...result, followup: request, response }
  }
  respondFollowup(actor: User, id: string, input: Input): ProgressResult {
    this.followup(actor, id)
    return collaborationCommand(this.store, actor, `followup.respond:${id}`, input, this.clock(), mutationId => {
      if (!input.progress || typeof input.progress !== 'object' || Array.isArray(input.progress)) throw new HttpError(400, '请填写进展内容')
      return this.respond(actor, id, input.version, input.taskVersion, input.progress as ProgressContent, mutationId)
    })
  }
  closeFollowup(actor: User, id: string, input: Input): FollowupRequest {
    actor = this.manager(actor); this.followup(actor, id)
    return collaborationCommand(this.store, actor, `followup.close:${id}`, input, this.clock(), mutationId => {
      const before = this.followup(actor, id), now = this.clock(), task = this.task(actor, before.taskId)
      ensureVersion(before.version, input.version)
      if (before.status !== 'open') throw new HttpError(409, '该催办已经结束')
      const reason = requiredText(input.reason, '核实关闭原因')
      const row = this.store.update<FollowupRequest>('followupRequests', id, before.version, { status: 'cancelled', closedAt: now.toISOString(), closedBy: actor.id, closeReason: reason })
      this.audit(actor, 'followupRequest', id, 'close', before, row, reason)
      taskBusinessEvent(this.store, task, actor, mutationId, 'followup_closed', now, { title: task.title, followupId: id, reason }, { recipientIds: [task.ownerId], generation: before.generation, sourceVersion: row.version })
      return row
    })
  }
  handleBlocker(actor: User, id: string, input: Input): { episode: BlockerEpisode; action: BlockerAction } {
    return new TaskSupportService(this.store, this.clock).handleBlocker(actor, id, input)
  }
  requestDeadline(actor: User, taskId: string, input: Input): DeadlineChangeRequest {
    const initial = this.task(actor, taskId)
    if (actor.id !== initial.ownerId) throw new HttpError(403, '只有任务本人可以提出延期申请')
    return collaborationCommand(this.store, actor, `deadline.request:${taskId}`, input, this.clock(), mutationId => {
      const task = this.task(actor, taskId), tracking = this.tracking(task), now = this.clock()
      if (!readCollaborationSettings(this.store).deadlineApprovalEnabled || task.workOrigin?.kind !== 'assigned' || !taskTrackingEligible(this.store, task, now) || tracking.state !== 'active') throw new HttpError(409, '该任务未启用延期审批或当前不可申请')
      ensureVersion(task.version, input.version); ensureVersion(tracking.dueDateVersion, input.dueDateVersion)
      if (this.store.list<DeadlineChangeRequest>('deadlineChangeRequests').some(row => row.taskId === taskId && row.status === 'open')) throw new HttpError(409, '该任务已有待处理延期申请')
      const requestedDueDate = date(input.requestedDueDate, '申请截止日期')
      if (requestedDueDate <= task.dueDate) throw new HttpError(400, '延期日期须晚于原截止日期')
      const row = this.store.insert<DeadlineChangeRequest>('deadlineChangeRequests', { id: collaborationId('deadline', mutationId), taskId, ownerId: task.ownerId, requestedBy: actor.id, generation: tracking.generation,
        dueDateVersion: tracking.dueDateVersion, originalDueDate: task.dueDate, requestedDueDate, reason: requiredText(input.reason, '延期原因'), status: 'open', decidedBy: null, decidedAt: null, decisionNote: '' })
      this.audit(actor, 'deadlineChangeRequest', row.id, 'create', null, row)
      taskBusinessEvent(this.store, task, actor, mutationId, 'deadline_requested', now, { title: task.title, deadlineRequestId: row.id, dueDate: task.dueDate, requestedDueDate, reason: row.reason }, { generation: tracking.generation, sourceVersion: row.version })
      return row
    })
  }
  decideDeadline(actor: User, id: string, input: Input): DeadlineDecisionResult {
    actor = this.manager(actor)
    const initial = this.store.get<DeadlineChangeRequest>('deadlineChangeRequests', id)
    if (!initial) throw new HttpError(404, '延期申请不存在')
    this.task(actor, initial.taskId)
    return collaborationCommand(this.store, actor, `deadline.decide:${id}`, input, this.clock(), mutationId => {
      const before = this.store.get<DeadlineChangeRequest>('deadlineChangeRequests', id)!, task = this.task(actor, before.taskId), tracking = this.tracking(task), now = this.clock()
      ensureVersion(before.version, input.version); ensureVersion(tracking.dueDateVersion, input.dueDateVersion)
      if (before.status !== 'open' || before.dueDateVersion !== tracking.dueDateVersion || before.generation !== tracking.generation || before.ownerId !== task.ownerId || task.dueDate !== before.originalDueDate || !readCollaborationSettings(this.store).deadlineApprovalEnabled) throw new HttpError(409, '申请或截止日期已改变，请刷新后重新处理')
      if (!['approved', 'returned'].includes(String(input.decision))) throw new HttpError(400, '请选择批准或退回')
      const decision = input.decision as 'approved' | 'returned', note = requiredText(input.note, '审核意见', decision === 'returned')
      let updatedTask = task
      if (decision === 'approved') {
        updatedTask = withCollaborationMutation(this.store, { actor, mutationId, now, input: {}, source: 'task' }, () => new WorkService(this.store).updateTask(actor, task.id, { version: task.version, dueDate: before.requestedDueDate, reason: before.reason })).value
      }
      const current = this.store.get<DeadlineChangeRequest>('deadlineChangeRequests', id)!
      const row = this.store.update<DeadlineChangeRequest>('deadlineChangeRequests', id, current.version, { status: decision, decidedBy: actor.id, decidedAt: now.toISOString(), decisionNote: note })
      this.audit(actor, 'deadlineChangeRequest', id, 'decide', before, row, note)
      taskBusinessEvent(this.store, updatedTask, actor, mutationId, 'deadline_decided', now, { title: task.title, deadlineRequestId: id, decision, note, dueDate: updatedTask.dueDate }, { recipientIds: [task.ownerId], generation: tracking.generation, sourceVersion: row.version })
      return { request: row, task: updatedTask, tracking: this.store.get<TaskTracking>('taskTrackings', task.id)! }
    })
  }
}
