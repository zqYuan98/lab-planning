import type { AuditEvent, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import { HttpError } from './store.ts'
import { DomainBase, bool, choice, date, manager, monday, own, participates, text, type Input } from './domain-common.ts'

export class WorkService extends DomainBase {
  private overlapsMonth(weekStart: string, month: string) {
    const end = new Date(`${weekStart}T00:00:00Z`)
    end.setUTCDate(end.getUTCDate() + 6)
    return month >= weekStart.slice(0, 7) && month <= end.toISOString().slice(0, 7)
  }
  private usablePlan(id: string, ownerId: string, published = false) {
    const plan = this.need<MonthlyPlan>('plans', id)
    if (plan.status === 'merged') throw new HttpError(400, '请关联合并后的月计划')
    if (!participates(plan, ownerId)) throw new HttpError(403, '任务负责人必须是月计划负责人或协作者')
    if (published && plan.status !== 'published') throw new HttpError(400, '正式周计划必须关联已发布月计划')
    if (plan.projectId) this.activeProject(plan.projectId)
    return plan
  }
  createTask(actor: User, input: Input): Task {
    return this.store.transaction(() => {
      const ownerId = this.owner(actor, input.ownerId)
      const monthlyPlanId = input.monthlyPlanId ? text(input.monthlyPlanId, '月计划') : null
      const isTemporary = input.isTemporary === undefined ? false : bool(input.isTemporary, '临时工作')
      const temporaryReason = text(input.temporaryReason, '临时工作原因', isTemporary)
      if (!monthlyPlanId && !isTemporary) throw new HttpError(400, '正式个人任务必须关联月计划')
      if (monthlyPlanId && isTemporary) throw new HttpError(400, '已关联月计划的任务不能标记为临时工作')
      if (monthlyPlanId) this.usablePlan(monthlyPlanId, ownerId)
      const task = this.store.insert<Task>('tasks', { title: text(input.title, '任务标题', true, 300), monthlyPlanId, ownerId, description: text(input.description, '任务说明', false), dueDate: date(input.dueDate, '任务截止日期'), status: 'todo', isTemporary, temporaryReason })
      this.audit(actor, 'task', task.id, 'create', null, task, temporaryReason)
      return task
    })
  }
  updateTask(actor: User, id: string, input: Input): Task {
    return this.store.transaction(() => {
      const before = this.need<Task>('tasks', id)
      own(actor, before.ownerId)
      this.current<Task>('tasks', id, input)
      for (const field of ['monthlyPlanId', 'ownerId', 'isTemporary', 'temporaryReason'] as const) {
        if (input[field] !== undefined && input[field] !== before[field]) throw new HttpError(400, '任务归属和临时工作标记不能直接修改，请由管理者调整关联')
      }
      const patch: Partial<Task> = {}
      if (input.title !== undefined) patch.title = text(input.title, '任务标题', true, 300)
      if (input.description !== undefined) patch.description = text(input.description, '任务说明', false, before.importSource ? 20000 : 12000)
      if (input.dueDate !== undefined) patch.dueDate = before.importSource && text(input.dueDate, '任务截止日期', false, 10) === '' ? '' : date(input.dueDate, '任务截止日期')
      if (input.status !== undefined) patch.status = choice(input.status, ['todo', 'doing', 'blocked', 'done'], '任务状态')
      const task = this.store.update<Task>('tasks', id, before.version, patch)
      this.audit(actor, 'task', id, 'update', before, task)
      return task
    })
  }
  relinkTask(actor: User, id: string, input: Input): Task {
    manager(actor)
    return this.store.transaction(() => {
      const before = this.current<Task>('tasks', id, input)
      const monthlyPlanId = text(input.monthlyPlanId, '新的月计划')
      const reason = text(input.reason, '调整关联原因')
      const target = this.usablePlan(monthlyPlanId, before.ownerId, true)
      if (before.monthlyPlanId === monthlyPlanId) throw new HttpError(400, '任务已关联此月计划')
      const task = this.store.update<Task>('tasks', id, before.version, { monthlyPlanId, isTemporary: false })
      this.audit(actor, 'task', id, 'relink', before, task, reason)
      // Legacy/provisional future drafts may have been created before a new month's plan existed.
      // Withdrawing a submitted record does not make its original month provisional again.
      const submittedRecordIds = new Set(this.store.list<AuditEvent>('events')
        .filter(event => event.entityType === 'weeklyRecord' && [event.before, event.after].some(snapshot =>
          !!snapshot && typeof snapshot === 'object' && (snapshot as Partial<WeeklyRecord>).submitted === true))
        .map(event => event.entityId))
      for (const record of this.store.list<WeeklyRecord>('weeklyRecords')) {
        if (record.taskId !== id || record.submitted || submittedRecordIds.has(record.id) || record.monthlyPlanId === monthlyPlanId || !this.overlapsMonth(record.weekStart, target.month)) continue
        const updated = this.store.update<WeeklyRecord>('weeklyRecords', record.id, record.version, { monthlyPlanId })
        this.audit(actor, 'weeklyRecord', record.id, 'relink_draft', record, updated, reason)
      }
      return task
    })
  }
  private fields(input: Input, before?: WeeklyRecord): Pick<WeeklyRecord, 'commitment' | 'actualOutcome' | 'evidenceUrl' | 'blocker' | 'nextAction' | 'status' | 'submitted'> {
    const result = {
      commitment: text(input.commitment ?? before?.commitment, '本周承诺', !before?.importSource),
      actualOutcome: text(input.actualOutcome ?? before?.actualOutcome, '实际成果', false),
      evidenceUrl: text(input.evidenceUrl ?? before?.evidenceUrl, '证据链接', false, 2000),
      blocker: text(input.blocker ?? before?.blocker, '阻塞或未完成原因', false),
      nextAction: text(input.nextAction ?? before?.nextAction, '下一步', false),
      status: choice(input.status ?? before?.status ?? 'planned', ['planned', 'doing', 'blocked', 'done', 'not_done'], '周记录状态'),
      submitted: bool(input.submitted ?? before?.submitted ?? false, '提交状态'),
    }
    if (result.status === 'done' && !result.actualOutcome && !before?.importSource) throw new HttpError(400, '标记完成时需要填写实际成果')
    if (['blocked', 'not_done'].includes(result.status) && !result.blocker && !before?.importSource) throw new HttpError(400, '阻塞或未完成时需要填写原因')
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
    return this.store.transaction(() => {
      const task = this.need<Task>('tasks', text(input.taskId, '个人任务'))
      own(actor, task.ownerId)
      const weekStart = monday(input.weekStart)
      if (this.store.list<WeeklyRecord>('weeklyRecords').some(item => item.taskId === task.id && item.weekStart === weekStart)) throw new HttpError(409, '此任务本周已有记录，请修改已有记录')
      if (!task.monthlyPlanId && (!task.isTemporary || !task.temporaryReason)) throw new HttpError(400, '未关联月计划的任务需要临时工作原因')
      if (task.monthlyPlanId) {
        const plan = this.need<MonthlyPlan>('plans', task.monthlyPlanId)
        if (plan.projectId) this.activeProject(plan.projectId)
      }
      const data = { taskId: task.id, monthlyPlanId: task.monthlyPlanId, ownerId: task.ownerId, weekStart, ...this.fields(input) }
      this.submissionGate(data)
      const record = this.store.insert<WeeklyRecord>('weeklyRecords', data)
      this.audit(actor, 'weeklyRecord', record.id, record.submitted ? 'submit' : 'create', null, record)
      return record
    })
  }
  updateWeeklyRecord(actor: User, id: string, input: Input): WeeklyRecord {
    return this.store.transaction(() => {
      const before = this.need<WeeklyRecord>('weeklyRecords', id)
      own(actor, before.ownerId)
      this.current<WeeklyRecord>('weeklyRecords', id, input)
      for (const field of ['taskId', 'ownerId', 'weekStart', 'monthlyPlanId'] as const) {
        if (input[field] !== undefined && input[field] !== before[field]) throw new HttpError(400, '不能修改周记录的任务、负责人、所属周或历史月计划关联')
      }
      const patch = this.fields(input, before)
      this.submissionGate({ ...before, ...patch })
      const record = this.store.update<WeeklyRecord>('weeklyRecords', id, before.version, patch)
      this.audit(actor, 'weeklyRecord', id, !before.submitted && record.submitted ? 'submit' : 'update', before, record)
      return record
    })
  }
  carryWeeklyRecord(actor: User, id: string, input: Input): WeeklyRecord {
    return this.store.transaction(() => {
      const before = this.need<WeeklyRecord>('weeklyRecords', id)
      own(actor, before.ownerId)
      const weekStart = monday(input.weekStart)
      if (weekStart <= before.weekStart) throw new HttpError(400, '承接周必须晚于原周')
      const record = this.createWeeklyRecord(actor, { taskId: before.taskId, weekStart, commitment: input.commitment ?? (before.nextAction || before.commitment) })
      this.audit(actor, 'weeklyRecord', record.id, 'carry', before, record)
      return record
    })
  }
}
