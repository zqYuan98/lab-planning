import { effortDays } from '../shared/effort.ts'
import { assertBusinessActor } from './object-access.ts'
import type { Entity, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import { submittedWeeklyEvidence } from './carry-workflows-history.ts'
import { createHash } from 'node:crypto'
import { withTaskNotificationSuppressed } from './notification-events.ts'
import { createWorkOrigin } from './work-origin.ts'
import { HttpError, type Store } from './store.ts'
import { DomainBase, bool, choice, date, manager, monday, own, participates, text, type Input } from './domain-common.ts'
import { collaborationWorkMutation, currentCollaborationMutation, validateCollaborationWorkUpdate } from './collaboration-hooks.ts'
import { isSilentImport } from './import-notification-context.ts'
import { isActiveWeeklyRecord, weeklyPlanFingerprint } from '../shared/weekly-record-state.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { weeklyPlanApprovalMetadata } from './weekly-plan-review.ts'
import { cancelTaskCollaboration, endTaskRequests } from './collaboration-tracking.ts'
import type { BlockerEpisode } from '../shared/collaboration.ts'
import { validateWorkChange } from './work-validation.ts'

function progressInput(store: Store, input: Input, type: 'task' | 'weeklyRecord'): Input {
  const context = currentCollaborationMutation(store)
  const effective = { ...input }
  const fields = type === 'task' ? ['completionNote', 'blockerReason', 'blockerImpact', 'supportNeeded'] as const : ['blockerImpact', 'supportNeeded'] as const
  for (const field of fields) if (effective[field] === undefined && context?.[field] !== undefined) effective[field] = context[field]
  return effective
}

function checkedEffort(value: unknown): number | null {
  try { return effortDays(value) } catch (error) { throw new HttpError(400, (error as Error).message) }
}

function taskMetadata(input: Input): Partial<Task> {
  const fields: Partial<Task> = {}
  if (input.remainingEffortDays !== undefined) fields.remainingEffortDays = checkedEffort(input.remainingEffortDays)
  if (input.workSource !== undefined) fields.workSource = choice(input.workSource, ['leader', 'self', 'coordination'], '工作来源')
  if (input.priority !== undefined) fields.priority = choice(input.priority, ['high', 'medium', 'low'], '优先级')
  if (input.assignedBy !== undefined) fields.assignedBy = text(input.assignedBy, '交办人', false, 100)
  if (input.assignedOn !== undefined) fields.assignedOn = input.assignedOn === '' ? '' : date(input.assignedOn, '交办日期')
  for (const [field, label] of [['requestedOutcome', '预期交付'], ['estimatedEffort', '预计剩余投入'], ['currentProgress', '当前进展'], ['decisionNeeded', '需要决策']] as const) {
    if (input[field] !== undefined) fields[field] = text(input[field], label, false)
  }
  if (input.waitingForFeedback !== undefined) fields.waitingForFeedback = bool(input.waitingForFeedback, '待反馈')
  return fields
}

export class WorkService extends DomainBase {
  captureTasks(actor: User, input: Input): { tasks: Task[] } {
    actor = assertBusinessActor(this.store, actor)
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '请填写收件内容')
    const requestId = text(input.requestId, '提交标识', true, 100)
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw new HttpError(400, '提交标识格式不正确')
    if (input.ownerId !== undefined && input.ownerId !== actor.id) throw new HttpError(403, '工作清单只能记录本人的事项')
    if (input.creationKind !== undefined && input.creationKind !== 'self') throw new HttpError(400, '工作清单仅支持本人记录')
    const allowed = new Set(['requestId', 'titles', 'workSource', 'assignedBy', 'assignedOn', 'dueDate', 'requestedOutcome', 'ownerId', 'creationKind'])
    if (Object.keys(input).some(key => !allowed.has(key))) throw new HttpError(400, '收件内容含不支持的字段')
    if (!Array.isArray(input.titles) || input.titles.length < 1 || input.titles.length > 50) throw new HttpError(400, '每次请记录 1–50 件事项')
    const titles = input.titles.map(title => text(title, '事项标题', true, 300))
    const metadata = taskMetadata({ ...input, workSource: input.workSource === undefined ? 'leader' : input.workSource })
    const dueDate = input.dueDate === undefined || input.dueDate === '' ? '' : date(input.dueDate, '任务截止日期')
    this.activeUser(actor.id)
    // Validate the entire batch before looking up a receipt or opening a write transaction.
    const payload = { titles, ...metadata, dueDate }
    const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
    const key = createHash('sha256').update(JSON.stringify([actor.id, requestId])).digest('hex')
    type Receipt = Entity & { actorId: string; payloadHash: string; taskIds: string[] }
    return this.store.transaction(() => {
      const receipt = this.store.get<Receipt>('workRegisterCaptures', key)
      if (receipt) {
        if (receipt.actorId !== actor.id || receipt.payloadHash !== payloadHash) throw new HttpError(409, '此提交标识已用于其他内容，请重新提交')
        const tasks = receipt.taskIds.map(id => this.need<Task>('tasks', id))
        if (tasks.some(task => task.ownerId !== actor.id)) throw new HttpError(403, '工作清单只能读取本人的事项')
        if (tasks.some(task => !isActiveTask(task))) throw new HttpError(409, '原收件任务已作废，请核对后重新记录')
        return { tasks }
      }
      const source = { leader: '领导交办', self: '自行安排', coordination: '协作事项' }[metadata.workSource!]
      const temporaryReason = `${source}${metadata.assignedBy ? `：${metadata.assignedBy}` : ''}${metadata.assignedOn ? `（${metadata.assignedOn}）` : ''}`
      const tasks = withTaskNotificationSuppressed(this.store, () => titles.map(title => this.createTask(actor, {
        title, ...metadata, dueDate, ownerId: actor.id, creationKind: 'self', isTemporary: true, temporaryReason,
      })))
      this.store.insert<Receipt>('workRegisterCaptures', { id: key, actorId: actor.id, payloadHash, taskIds: tasks.map(task => task.id) })
      return { tasks }
    })
  }
  createWeeklyAssignment(actor: User, input: Input): { task: Task; record: WeeklyRecord } {
    actor = assertBusinessActor(this.store, actor)
    const requestId = text(input.requestId, '提交标识', true, 100)
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw new HttpError(400, '提交标识格式不正确')
    if (!input.record || typeof input.record !== 'object' || Array.isArray(input.record)) throw new HttpError(400, '请填写周记录')
    const hasTask = !!input.task && typeof input.task === 'object' && !Array.isArray(input.task)
    if (!!input.taskId === hasTask) throw new HttpError(400, '请选择已有任务或填写新任务')
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Input)[key])])) : value
    const payloadHash = createHash('sha256').update(JSON.stringify(canonical(input))).digest('hex')
    const key = createHash('sha256').update(JSON.stringify([actor.id, requestId])).digest('hex')
    type Receipt = Entity & { actorId: string; payloadHash: string; taskId: string; recordId: string }
    return collaborationWorkMutation(this.store, actor, input, 'task', () => {
      const receipt = this.store.get<Receipt>('weeklyAssignmentRequests', key)
      if (receipt) {
        if (receipt.payloadHash !== payloadHash) throw new HttpError(409, '此提交标识已用于其他内容，请重新提交')
        const task = this.need<Task>('tasks', receipt.taskId), record = this.need<WeeklyRecord>('weeklyRecords', receipt.recordId)
        own(actor, record.ownerId)
        if (!isActiveTask(task)) throw new HttpError(409, '原任务已作废，不能重新安排')
        if (!isActiveWeeklyRecord(record)) throw new HttpError(409, '原周安排已删除，请重新发起安排')
        return { task, record }
      }
      const task = hasTask ? withTaskNotificationSuppressed(this.store, () => this.createTask(actor, input.task as Input)) : this.need<Task>('tasks', text(input.taskId, '个人任务'))
      const recordInput = input.record as Input
      const record = this.createWeeklyRecord(actor, { ...recordInput, taskId: task.id,
        ...(hasTask ? { creationKind: (input.task as Input).creationKind, creationReason: (input.task as Input).creationReason } : {}) })
      this.store.insert<Receipt>('weeklyAssignmentRequests', { id: key, actorId: actor.id, payloadHash, taskId: task.id, recordId: record.id })
      return { task, record }
    }, true)
  }
  private overlapsMonth(weekStart: string, month: string) {
    const end = new Date(`${weekStart}T00:00:00Z`)
    end.setUTCDate(end.getUTCDate() + 6)
    return month >= weekStart.slice(0, 7) && month <= end.toISOString().slice(0, 7)
  }
  private usablePlan(id: string, ownerId: string, published = false) {
    const plan = this.need<MonthlyPlan>('plans', id)
    if (plan.visibility === 'reference') throw new HttpError(400, '历史目标引用不能用于新增任务')
    if (plan.status === 'merged') throw new HttpError(400, '请关联合并后的月计划')
    if (!participates(plan, ownerId)) throw new HttpError(403, '任务负责人必须是月计划负责人或协作者')
    if (published && plan.status !== 'published') throw new HttpError(400, '正式周计划必须关联已发布月计划')
    if (plan.projectId) this.activeProject(plan.projectId)
    return plan
  }
  createTask(actor: User, input: Input): Task {
    actor = assertBusinessActor(this.store, actor)
    return collaborationWorkMutation(this.store, actor, input, 'task', () => {
      const ownerId = this.owner(actor, input.ownerId)
      const monthlyPlanId = input.monthlyPlanId ? text(input.monthlyPlanId, '月计划') : null
      const isTemporary = input.isTemporary === undefined ? false : bool(input.isTemporary, '临时工作')
      const temporaryReason = text(input.temporaryReason, '临时工作原因', isTemporary)
      if (!monthlyPlanId && !isTemporary) throw new HttpError(400, '正式个人任务必须关联月计划')
      if (monthlyPlanId && isTemporary) throw new HttpError(400, '已关联月计划的任务不能标记为临时工作')
      const plan = monthlyPlanId ? this.usablePlan(monthlyPlanId, ownerId) : undefined
      const workOrigin = createWorkOrigin(actor, ownerId, input)
      const metadata = taskMetadata(input)
      // A live manager assignment is reliable source evidence. Import recording identity
      // alone is not; imported records keep their explicitly confirmed source instead.
      const liveAssignment = workOrigin.kind === 'assigned' && !isSilentImport(this.store)
      const inheritedSource = liveAssignment ? 'leader' : plan?.workSource
      if (metadata.workSource === undefined && inheritedSource !== undefined) metadata.workSource = inheritedSource
      if (input.assignedBy === undefined && (liveAssignment || plan?.assignedBy !== undefined)) metadata.assignedBy = liveAssignment ? actor.name : plan!.assignedBy
      if (input.assignedOn === undefined && plan?.assignedOn !== undefined) metadata.assignedOn = plan.assignedOn
      if (input.requestedOutcome === undefined && plan?.expectedOutcome) metadata.requestedOutcome = plan.expectedOutcome
      const task = this.store.insert<Task>('tasks', { ...metadata, workOrigin, title: text(input.title, '任务标题', true, 300), monthlyPlanId, ownerId, description: text(input.description, '任务说明', false), dueDate: input.dueDate === '' ? '' : date(input.dueDate, '任务截止日期'), status: 'todo', isTemporary, temporaryReason })
      this.audit(actor, 'task', task.id, 'create', null, task, temporaryReason)
      return task
    })
  }
  updateTask(actor: User, id: string, input: Input): Task {
    actor = assertBusinessActor(this.store, actor)
    return collaborationWorkMutation(this.store, actor, input, 'task', () => {
      const before = this.need<Task>('tasks', id)
      own(actor, before.ownerId)
      if (!isActiveTask(before)) throw new HttpError(409, '任务已作废，不能继续修改')
      this.current<Task>('tasks', id, input)
      input = progressInput(this.store, input, 'task')
      for (const field of ['monthlyPlanId', 'ownerId', 'isTemporary', 'temporaryReason'] as const) {
        if (input[field] !== undefined && input[field] !== before[field]) throw new HttpError(400, '任务归属和临时工作标记不能直接修改，请由管理者调整关联')
      }
      const patch: Partial<Task> = taskMetadata(input)
      if (input.title !== undefined) patch.title = text(input.title, '任务标题', true, 300)
      if (input.description !== undefined) patch.description = text(input.description, '任务说明', false, before.importSource ? 20000 : 12000)
      if (input.dueDate !== undefined) patch.dueDate = input.dueDate === '' ? '' : date(input.dueDate, '任务截止日期')
      if (input.status !== undefined) patch.status = choice(input.status, ['todo', 'doing', 'blocked', 'done'], '任务状态')
      if (!isSilentImport(this.store) && (['dueDate', 'description', 'requestedOutcome', 'title'] as const).some(field => patch[field] !== undefined && patch[field] !== before[field])) {
        text(input.reason || input.proxyReason, '承诺调整原因')
      }
      for (const field of ['completionNote', 'blockerReason', 'blockerImpact', 'supportNeeded', 'nextAction', 'evidenceUrl'] as const) if (input[field] !== undefined) patch[field] = text(input[field], field === 'completionNote' ? '完成说明' : '进展内容', false, field === 'evidenceUrl' ? 2000 : 12000)
      if (patch.evidenceUrl) {
        try { if (!['http:', 'https:'].includes(new URL(patch.evidenceUrl).protocol)) throw new Error() }
        catch { throw new HttpError(400, '证据链接仅支持完整的 http 或 https 地址') }
      }
      validateWorkChange(before, patch, { type: 'task', authority: isSilentImport(this.store) ? 'trusted-import' : 'human' })
      if (!isSilentImport(this.store) && (patch.status ?? before.status) === 'done') patch.waitingForFeedback = false
      validateCollaborationWorkUpdate(this.store, actor, before, { ...input, ...patch }, 'task')
      const task = this.store.update<Task>('tasks', id, before.version, patch)
      this.audit(actor, 'task', id, 'update', before, task, text(input.reason || input.proxyReason, '修改原因', false))
      return task
    })
  }
  relinkTask(actor: User, id: string, input: Input): Task {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    return collaborationWorkMutation(this.store, actor, input, 'task', () => {
      const before = this.current<Task>('tasks', id, input)
      if (!isActiveTask(before)) throw new HttpError(409, '任务已作废，不能调整关联')
      const monthlyPlanId = text(input.monthlyPlanId, '新的月计划')
      const reason = text(input.reason, '调整关联原因')
      const target = this.usablePlan(monthlyPlanId, before.ownerId, true)
      if (before.monthlyPlanId === monthlyPlanId) throw new HttpError(400, '任务已关联此月计划')
      const task = this.store.update<Task>('tasks', id, before.version, { monthlyPlanId, isTemporary: false })
      this.audit(actor, 'task', id, 'relink', before, task, reason)
      // Legacy/provisional future drafts may have been created before a new month's plan existed.
      // Withdrawing a submitted record does not make its original month provisional again.
      const submittedRecordIds = submittedWeeklyEvidence(this.store).ids
      for (const record of this.store.list<WeeklyRecord>('weeklyRecords')) {
        if (!isActiveWeeklyRecord(record) || record.taskId !== id || record.submitted || submittedRecordIds.has(record.id) || record.monthlyPlanId === monthlyPlanId || !this.overlapsMonth(record.weekStart, target.month)) continue
        const updated = this.store.update<WeeklyRecord>('weeklyRecords', record.id, record.version, { monthlyPlanId })
        this.audit(actor, 'weeklyRecord', record.id, 'relink_draft', record, updated, reason)
      }
      return task
    })
  }
  cancelTask(actor: User, id: string, input: Input): Task {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    return this.store.transaction(() => {
      const before = this.current<Task>('tasks', id, input)
      if (!isActiveTask(before)) throw new HttpError(409, '此任务已经作废，请刷新列表')
      const reason = text(input.reason, '作废原因')
      if (this.store.list<WeeklyRecord>('weeklyRecords').some(record => record.taskId === id && isActiveWeeklyRecord(record))) {
        throw new HttpError(409, '此任务仍有周安排（含草稿），请先核对并删除相关周安排')
      }
      if (this.store.list<{ taskId: string; status: string }>('deliverySeries').some(series => series.taskId === id && series.status === 'pending_review')) {
        throw new HttpError(409, '此任务仍有待验收成果，请先处理或撤回后再作废')
      }
      const now = new Date()
      const task = this.store.update<Task>('tasks', id, before.version, {
        cancellation: { cancelledAt: now.toISOString(), cancelledBy: actor.id, reason },
      })
      cancelTaskCollaboration(this.store, id, now, actor.id, reason)
      this.audit(actor, 'task', id, 'cancel', before, task, reason)
      return task
    })
  }
  private fields(input: Input, before?: WeeklyRecord): Pick<WeeklyRecord, 'commitment' | 'actualOutcome' | 'evidenceUrl' | 'blocker' | 'nextAction' | 'status' | 'submitted' | 'blockerImpact' | 'supportNeeded' | 'plannedEffortDays' | 'actualEffortDays'> {
    const result = {
      ...(input.plannedEffortDays !== undefined ? { plannedEffortDays: checkedEffort(input.plannedEffortDays) } : before?.plannedEffortDays !== undefined ? { plannedEffortDays: before.plannedEffortDays } : {}),
      ...(input.actualEffortDays !== undefined ? { actualEffortDays: checkedEffort(input.actualEffortDays) } : before?.actualEffortDays !== undefined ? { actualEffortDays: before.actualEffortDays } : {}),
      commitment: text(input.commitment ?? before?.commitment, '本周承诺', !before?.importSource),
      actualOutcome: text(input.actualOutcome ?? before?.actualOutcome, '实际成果', false),
      evidenceUrl: text(input.evidenceUrl ?? before?.evidenceUrl, '证据链接', false, 2000),
      blocker: text(input.blocker ?? before?.blocker, '阻塞或未完成原因', false),
      nextAction: text(input.nextAction ?? before?.nextAction, '下一步', false),
      status: choice(input.status ?? before?.status ?? 'planned', ['planned', 'doing', 'blocked', 'done', 'not_done'], '周记录状态'),
      submitted: bool(input.submitted ?? before?.submitted ?? false, '提交状态'),
      ...(input.blockerImpact !== undefined || before?.blockerImpact !== undefined ? { blockerImpact: text(input.blockerImpact ?? before?.blockerImpact, '阻塞影响', false) } : {}),
      ...(input.supportNeeded !== undefined || before?.supportNeeded !== undefined ? { supportNeeded: text(input.supportNeeded ?? before?.supportNeeded, '需要支持', false) } : {}),
    }
    if (result.evidenceUrl) {
      try { if (!['http:', 'https:'].includes(new URL(result.evidenceUrl).protocol)) throw new Error() }
      catch { throw new HttpError(400, '证据链接仅支持完整的 http 或 https 地址') }
    }
    return result
  }
  private submissionGate(record: Pick<WeeklyRecord, 'submitted' | 'monthlyPlanId' | 'weekStart'>) {
    // A null link can only be created from a reasoned temporary task; keep that historical exception after relinking.
    if (record.monthlyPlanId) {
      const plan = this.need<MonthlyPlan>('plans', record.monthlyPlanId)
      if (record.submitted && plan.status !== 'published') throw new HttpError(400, '月计划尚未发布，可先保存周计划草稿')
      if (!this.overlapsMonth(record.weekStart, plan.month)) throw new HttpError(400, '所属周超出月计划月份，请先跨月承接月计划并由管理者调整任务关联')
    }
  }
  createWeeklyRecord(actor: User, input: Input): WeeklyRecord {
    actor = assertBusinessActor(this.store, actor)
    return collaborationWorkMutation(this.store, actor, input, 'weeklyRecord', () => {
      const task = this.need<Task>('tasks', text(input.taskId, '个人任务'))
      own(actor, task.ownerId)
      if (!isActiveTask(task)) throw new HttpError(409, '任务已作废，不能新增周安排')
      this.activeUser(task.ownerId)
      const workOrigin = createWorkOrigin(actor, task.ownerId, input)
      const weekStart = monday(input.weekStart)
      if (this.store.list<WeeklyRecord>('weeklyRecords').some(item => isActiveWeeklyRecord(item) && item.taskId === task.id && item.weekStart === weekStart)) throw new HttpError(409, '此任务本周已有记录，请修改已有记录')
      if (!task.monthlyPlanId && (!task.isTemporary || !task.temporaryReason)) throw new HttpError(400, '未关联月计划的任务需要临时工作原因')
      if (task.monthlyPlanId) {
        const plan = this.need<MonthlyPlan>('plans', task.monthlyPlanId)
        if (plan.projectId) this.activeProject(plan.projectId)
      }
      input = progressInput(this.store, input, 'weeklyRecord')
      const fields = this.fields(input)
      validateWorkChange(undefined, fields, { type: 'weeklyRecord', authority: isSilentImport(this.store) ? 'trusted-import' : 'human' })
      const planApproval = weeklyPlanApprovalMetadata(this.store, task.ownerId, weekStart,
        workOrigin.kind === 'assigned' && !fields.submitted ? { ...workOrigin, kind: 'proxy' } : workOrigin)
      const data = { workOrigin, taskId: task.id, monthlyPlanId: task.monthlyPlanId, ownerId: task.ownerId, weekStart,
        ...(planApproval ? { planApproval } : {}), ...fields }
      this.submissionGate(data)
      validateCollaborationWorkUpdate(this.store, actor, { ...data, id: '', version: 0, createdAt: '', updatedAt: '', status: 'planned', actualOutcome: '', evidenceUrl: '', blocker: '', blockerImpact: '', supportNeeded: '', nextAction: '', submitted: false }, input, 'weeklyRecord')
      const record = this.store.insert<WeeklyRecord>('weeklyRecords', data)
      this.audit(actor, 'weeklyRecord', record.id, record.submitted ? 'submit' : 'create', null, record)
      return record
    })
  }
  updateWeeklyRecord(actor: User, id: string, input: Input, options: { formalSubmission?: boolean } = {}): WeeklyRecord {
    actor = assertBusinessActor(this.store, actor)
    return collaborationWorkMutation(this.store, actor, input, 'weeklyRecord', () => {
      const before = this.need<WeeklyRecord>('weeklyRecords', id)
      own(actor, before.ownerId)
      if (!isActiveWeeklyRecord(before)) throw new HttpError(409, '周安排已删除，不能继续修改')
      const task = this.store.get<Task>('tasks', before.taskId)
      if (task && !isActiveTask(task)) throw new HttpError(409, '任务已作废，不能继续修改周安排')
      this.current<WeeklyRecord>('weeklyRecords', id, input)
      input = progressInput(this.store, input, 'weeklyRecord')
      for (const field of ['taskId', 'ownerId', 'weekStart', 'monthlyPlanId'] as const) {
        if (input[field] !== undefined && input[field] !== before[field]) throw new HttpError(400, '不能修改周记录的任务、负责人、所属周或历史月计划关联')
      }
      const patch: ReturnType<WorkService['fields']> & Pick<Partial<WeeklyRecord>, 'planApproval'> = this.fields(input, before)
      // fields() fills the effective record; only explicitly supplied fields count as a new report.
      const reportedPatch = Object.fromEntries(Object.entries(patch).filter(([field]) => input[field] !== undefined))
      validateWorkChange(before, reportedPatch, { type: 'weeklyRecord', authority: isSilentImport(this.store) ? 'trusted-import' : 'human', formalSubmission: options.formalSubmission })
      validateCollaborationWorkUpdate(this.store, actor, before, { ...input, ...patch }, 'weeklyRecord')
      const planApproval = before.planApproval ?? weeklyPlanApprovalMetadata(this.store, before.ownerId, before.weekStart, before.workOrigin)
      if (planApproval) patch.planApproval = planApproval
      const planChanged = weeklyPlanFingerprint(before) !== weeklyPlanFingerprint({ ...before, ...patch })
      // An owner's revision of an administrator's assignment is a new proposal, not another administrator decision.
      if (actor.role === 'member' && planChanged) {
        const revisedApproval = weeklyPlanApprovalMetadata(this.store, before.ownerId, before.weekStart, { kind: 'self', actorId: actor.id, reason: '' })
        if (revisedApproval) patch.planApproval ??= revisedApproval
      }
      if (!options.formalSubmission && actor.role === 'manager' && actor.id !== before.ownerId && before.workOrigin?.kind === 'assigned'
        && patch.submitted && (!before.submitted || planChanged)) patch.planApproval = undefined
      const completeTask = input.completeTask === undefined ? false : bool(input.completeTask, '同时完成整个任务')
      let completionTask: Task | undefined
      if (completeTask) {
        if (patch.status !== 'done') throw new HttpError(400, '同时完成整个任务时，本周状态必须为已完成')
        if (!patch.actualOutcome) throw new HttpError(400, '同时完成整个任务需要填写实际成果，作为任务完成说明')
        completionTask = this.current<Task>('tasks', before.taskId, { version: input.taskVersion })
        own(actor, completionTask.ownerId)
      }
      this.submissionGate({ ...before, ...patch })
      const record = this.store.update<WeeklyRecord>('weeklyRecords', id, before.version, patch)
      this.audit(actor, 'weeklyRecord', id, !before.submitted && record.submitted ? 'submit' : 'update', before, record, text(input.proxyReason, '代录原因', false))
      // Reuse the task write and its hooks in this same transaction/mutation context.
      // Retain existing completion evidence; an explicit new confirmation may repair a historical gap.
      if (completionTask && (completionTask.status !== 'done' || !completionTask.completionNote?.trim() || completionTask.waitingForFeedback)) this.updateTask(actor, completionTask.id, {
        version: completionTask.version, status: 'done', completionNote: completionTask.status === 'done' && completionTask.completionNote?.trim() ? completionTask.completionNote : patch.actualOutcome,
        waitingForFeedback: false, proxyReason: input.proxyReason,
      })
      return record
    })
  }
  deleteWeeklyRecord(actor: User, id: string, input: Input): WeeklyRecord {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    return this.store.transaction(() => {
      const before = this.current<WeeklyRecord>('weeklyRecords', id, input)
      if (!isActiveWeeklyRecord(before)) throw new HttpError(409, '此周安排已经删除，请刷新列表')
      const reason = text(input.reason, '删除原因')
      const now = new Date()
      const record = this.store.update<WeeklyRecord>('weeklyRecords', id, before.version, {
        deletion: { deletedAt: now.toISOString(), deletedBy: actor.id, reason },
      })
      endTaskRequests(this.store, before.taskId, now, actor.id, `周安排已删除：${reason}`, 'cancelled', id)
      for (const episode of this.store.list<BlockerEpisode>('blockerEpisodes')) {
        if (episode.sourceType === 'weeklyRecord' && episode.sourceId === id && !episode.resolvedAt) {
          this.store.update<BlockerEpisode>('blockerEpisodes', episode.id, episode.version, { resolvedAt: now.toISOString(), resolvedBy: actor.id, closureReason: `周安排已删除：${reason}` })
        }
      }
      this.audit(actor, 'weeklyRecord', id, 'delete', before, record, reason)
      return record
    })
  }
  carryWeeklyRecord(actor: User, id: string, input: Input): WeeklyRecord {
    actor = assertBusinessActor(this.store, actor)
    return this.store.transaction(() => {
      const before = this.need<WeeklyRecord>('weeklyRecords', id)
      own(actor, before.ownerId)
      if (!isActiveWeeklyRecord(before)) throw new HttpError(409, '周安排已删除，不能继续承接')
      const weekStart = monday(input.weekStart)
      if (weekStart <= before.weekStart) throw new HttpError(400, '承接周必须晚于原周')
      const record = this.createWeeklyRecord(actor, { taskId: before.taskId, weekStart, commitment: input.commitment ?? (before.nextAction || before.commitment), creationKind: input.creationKind, creationReason: input.creationReason })
      this.audit(actor, 'weeklyRecord', record.id, 'carry', before, record)
      return record
    })
  }
}
