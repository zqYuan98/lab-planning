import type { AuditEvent, ImportProvenance, MonthlyPlan, Project, Publication, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { ImportRow } from '../shared/import-types.ts'
import { importedMonthlyResult, importedWeeklyStatus } from '../shared/import-status.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { bool, choice, date, manager, monday, month, participates, text } from './domain-common.ts'
import { HttpError, Store } from './store.ts'
import { isActiveWeeklyRecord } from '../shared/weekly-record-state.ts'

function overlaps(weekStart: string, period: string) {
  const end = new Date(`${weekStart}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 6)
  return period >= weekStart.slice(0, 7) && period <= end.toISOString().slice(0, 7)
}
function optionalDate(value: unknown, label: string): string {
  const input = text(value, label, false, 10)
  return input ? date(input, label) : ''
}

export function importWorkMetadata(row: ImportRow): Pick<Task, 'workSource' | 'assignedBy' | 'assignedOn'> {
  return { ...(row.workSource ? { workSource: row.workSource } : {}), ...(row.assignedBy !== undefined ? { assignedBy: row.assignedBy } : {}), ...(row.assignedOn !== undefined ? { assignedOn: row.assignedOn } : {}) }
}

export function importMetadataIssues(store: Store, row: ImportRow): string[] {
  const issues: string[] = []
  const check = (operation: () => unknown) => { try { operation() } catch (error) { issues.push(error instanceof Error ? error.message : '导入来源字段无效') } }
  if (row.workSource !== undefined) check(() => choice(row.workSource, ['leader', 'self', 'coordination'], '工作来源'))
  if (row.assignedBy !== undefined) check(() => text(row.assignedBy, '交办人', false, 100))
  if (row.assignedOn) check(() => date(row.assignedOn, '交办日期'))
  if (row.taskCompleted !== undefined) check(() => bool(row.taskCompleted, '整个任务已完成'))
  if (row.completionNote !== undefined) check(() => text(row.completionNote, '整体完成说明', false))
  if (row.taskCompleted && row.kind !== 'weekly') issues.push('整个任务完成确认仅适用于周任务；月目标请使用成果验收状态')
  if (row.taskCompleted && !row.completionNote?.trim()) issues.push('确认整个任务已完成时请填写整体完成说明')
  if (row.taskCompleted && row.taskId) issues.push('已有任务的整体完成请在原任务中确认，导入不修改已有任务状态')
  if (row.kind === 'weekly' && (row.collaboratorIds?.length || row.collaboratorNames?.length)) issues.push('个人周任务只指定本人负责人；共同目标的协作人请在月度目标中设置')
  if (row.collaboratorIds !== undefined) {
    if (!Array.isArray(row.collaboratorIds) || row.collaboratorIds.length > 100) issues.push('协作人应为不超过100人的列表')
    else for (const id of row.collaboratorIds) {
      const user = typeof id === 'string' ? store.get<User>('users', id) : undefined
      if (!user || !canUseAccount(user)) issues.push('请选择有效协作人')
      if (id === row.ownerId) issues.push('负责人无需重复列为协作人')
    }
  }
  const owner = store.get<User>('users', row.ownerId)
  const namedCollaborators = row.collaboratorNames?.filter(name => name !== owner?.name && name !== owner?.email) ?? []
  if (namedCollaborators.length && row.collaboratorIds === undefined) issues.push('原文协作人尚未全部匹配，请核对并选择对应系统成员')
  if (row.kind === 'weekly' && row.taskId) {
    const task = store.get<Task>('tasks', row.taskId)
    for (const field of ['workSource', 'assignedBy', 'assignedOn'] as const) if (task && row[field] !== undefined && (row[field] || '') !== (task[field] || '')) issues.push('导入不改变已有任务的交办来源，请在原任务中核对修改')
  }
  return [...new Set(issues)]
}

/** Imported classifications may describe new work, but never reclassify an existing task. */
export function temporaryImportIssues(row: ImportRow, task?: Task): string[] {
  const issues: string[] = []
  const check = (operation: () => unknown) => { try { operation() } catch (error) { issues.push(error instanceof Error ? error.message : '临时事项字段无效') } }
  if (row.isTemporary !== undefined) check(() => bool(row.isTemporary, '临时事项标记'))
  if (row.temporaryReason !== undefined) check(() => text(row.temporaryReason, '临时事项原因', false))
  if (row.isTemporary === true) {
    if (row.temporaryReason === undefined || row.temporaryReason === null || (typeof row.temporaryReason === 'string' && !row.temporaryReason.trim())) issues.push('请填写临时交办说明')
    else check(() => text(row.temporaryReason, '临时事项原因'))
  }
  if (row.kind === 'weekly' && (row.isTemporary === true || task?.isTemporary) && (row.monthlyPlanId || row.linkedRowId || task?.monthlyPlanId)) issues.push('独立临时周任务不能同时关联月度目标；请取消关联或改为月度目标下的任务')
  if (row.kind === 'weekly' && task) {
    if (row.isTemporary !== undefined && row.isTemporary !== task.isTemporary) issues.push('不能通过导入修改已有任务的临时类型，请沿用原任务类型')
    if (row.temporaryReason !== undefined && row.temporaryReason !== task.temporaryReason) issues.push('不能通过导入修改已有任务的临时原因，请沿用原任务原因')
  }
  return issues
}

/** Preview shares the writer's checks; a member may prepare their own records but cannot activate them. */
export function validateExistingRow(store: Store, actor: User, row: ImportRow, rows: ImportRow[] = []): string[] {
  const issues: string[] = importMetadataIssues(store, row)
  const check = (operation: () => unknown) => { try { operation() } catch (error) { issues.push(error instanceof Error ? error.message : '资料字段无效') } }
  check(() => choice(row.kind, ['monthly', 'weekly'], '记录类型'))
  check(() => text(row.id, '来源记录标识', true, 200))
  check(() => text(row.title, '工作标题', true, 300))
  check(() => text(row.ownerId, '负责人', true, 200))
  check(() => text(row.category, '工作类别', false, 100))
  check(() => text(row.sourceText, '来源原文', false, 20000))
  for (const field of ['sourceStatus', 'expectedOutcome', 'acceptanceCriteria', 'actualOutcome', 'blocker', 'nextAction'] as const) check(() => text(row[field], field, false))
  if (actor.role !== 'manager' && row.ownerId !== actor.id) issues.push('成员只能准备自己的既有计划，生效须由管理者确认')
  const owner = typeof row.ownerId === 'string' && row.ownerId ? store.get<User>('users', row.ownerId) : undefined
  if (!owner || !canUseAccount(owner)) issues.push('请选择有效负责人')
  if (row.projectId) check(() => {
    const project = store.get<Project>('projects', text(row.projectId, '所属项目', true, 200))
    if (!project || project.status !== 'active') throw new HttpError(400, '请选择有效项目')
  })
  let dueDate = ''
  check(() => { dueDate = optionalDate(row.dueDate, '截止日期') })
  if (row.kind === 'monthly') {
    issues.push(...temporaryImportIssues(row))
    check(() => { const period = month(row.month); if (dueDate && !dueDate.startsWith(period)) throw new HttpError(400, '截止日期必须在所属月份内') })
    check(() => {
      const result = choice(importedMonthlyResult(row), ['pending', 'submitted', 'accepted', 'not_completed'], '成果状态')
      if (['accepted', 'submitted'].includes(result) && !text(row.actualOutcome, '实际成果', false)) throw new HttpError(400, '已验收或待验收成果必须有实际成果内容')
    })
  } else if (row.kind === 'weekly') {
    let weekStart = ''
    check(() => { weekStart = monday(row.weekStart) })
    check(() => choice(importedWeeklyStatus(row), ['planned', 'doing', 'blocked', 'done', 'not_done'], '周状态'))
    const candidate = typeof row.taskId === 'string' && row.taskId ? store.get<Task>('tasks', row.taskId) : undefined
    const task = candidate && (actor.role === 'manager' || candidate.ownerId === actor.id) ? candidate : undefined
    issues.push(...temporaryImportIssues(row, task))
    if (row.taskId && (!task || task.ownerId !== row.ownerId)) issues.push('关联任务不存在或负责人不一致')
    const linked = row.linkedRowId ? rows.find(item => item.id === row.linkedRowId && item.kind === 'monthly' && item.selected) : undefined
    if (row.linkedRowId && !linked && !row.monthlyPlanId) issues.push('请选择本批次中有效的月计划行')
    const planId = row.monthlyPlanId || (!linked ? task?.monthlyPlanId : '')
    if (planId) {
      const candidatePlan = store.get<MonthlyPlan>('plans', planId)
      const plan = candidatePlan && (actor.role === 'manager' || participates(candidatePlan, actor.id)) ? candidatePlan : undefined
      if (!plan || plan.status !== 'published') issues.push('关联月计划必须已生效')
      else {
        if (plan.visibility === 'reference') issues.push('历史目标引用不能用于新增任务')
        if (!participates(plan, row.ownerId)) issues.push('负责人未参与所选月计划')
        if (weekStart && !overlaps(weekStart, plan.month)) issues.push('所属周与月计划月份不相交')
        if (plan.projectId && store.get<Project>('projects', plan.projectId)?.status !== 'active') issues.push('关联月计划的项目已归档或不存在')
      }
    } else if (linked) {
      if (linked.ownerId !== row.ownerId) issues.push('关联月计划行的负责人不一致')
      if (weekStart && /^\d{4}-(0[1-9]|1[0-2])$/.test(linked.month) && !overlaps(weekStart, linked.month)) issues.push('所属周与本批次月计划月份不相交')
    }
  }
  return [...new Set(issues)]
}

/** Use one writer within the caller's outer Store transaction, then finish before committing. */
export class ExistingPlanWriter {
  private revisions = new Map<string, number>()
  private finished = false
  private batch: { id: string; sourceId: string }
  constructor(private store: Store, private actor: User, batch: { id: string; sourceId: string }) {
    this.batch = { id: text(batch.id, '导入批次', true, 200), sourceId: text(batch.sourceId, '来源文件', true, 200) }
    this.authorize()
  }
  private authorize() {
    manager(this.actor)
    const live = this.store.get<User>('users', this.actor.id)
    if (!live || !canUseAccount(live) || live.role !== 'manager') throw new HttpError(403, '只有有效管理者可以确认既有计划生效')
    if (this.finished) throw new HttpError(409, '该导入写入器已完成，请重新开始导入事务')
  }
  private provenance(row: ImportRow): ImportProvenance {
    return { batchId: this.batch.id, sourceId: this.batch.sourceId, rowId: text(row.id, '来源记录标识', true, 200), sourceStatus: text(row.sourceStatus, '原文状态', false), mode: 'existing', notificationMode: 'silent' }
  }
  private untouchedDraft(value: MonthlyPlan | WeeklyRecord, row: ImportRow) {
    const source = value.importSource
    // A current draft has one additional server-only provenance update. Any
    // user edit increments the version again and remains an activation conflict.
    return source?.mode === 'draft' && source.sourceId === this.batch.sourceId && source.rowId === row.id
      ? value.version === 2 : value.version === 1 && !source
  }
  private validate(row: ImportRow) {
    const issues = validateExistingRow(this.store, this.actor, row)
    if (issues.length) throw new HttpError(400, issues.join('；'))
  }
  private audit(entityType: string, entityId: string, before: unknown, after: unknown) {
    this.store.insert<AuditEvent>('events', { entityType, entityId, actorId: this.actor.id, action: 'import_existing', reason: '管理者确认既有资料导入生效', before, after })
  }
  monthly(row: ImportRow, existingPlanId?: string): MonthlyPlan {
    return this.store.transaction(() => {
      this.authorize()
      if (row.kind !== 'monthly') throw new HttpError(400, '此行不是月计划')
      this.validate(row)
      const before = existingPlanId ? this.store.get<MonthlyPlan>('plans', existingPlanId) : undefined
      if (existingPlanId && (!before || !this.untouchedDraft(before, row) || !['draft', 'returned', 'submitted', 'approved'].includes(before.status))) throw new HttpError(409, '原月计划已经变化或生效，请核对原记录后处理')
      if (before && (before.ownerId !== row.ownerId || before.month !== row.month)) throw new HttpError(409, '原月计划的负责人或月份与导入资料不一致')
      const period = month(row.month)
      const revision = this.revisions.get(period) ?? this.store.list<Publication>('publications').filter(item => item.month === period).reduce((max, item) => Math.max(max, item.revision), 0) + 1
      const fields: Omit<MonthlyPlan, keyof import('../shared/types.ts').Entity> = {
        month: period, title: text(row.title, '计划标题', true, 300), projectId: text(row.projectId, '项目', false, 200) || null,
        category: text(row.category, '工作类别', false, 100), ownerId: row.ownerId, collaboratorIds: row.collaboratorIds ?? before?.collaboratorIds ?? [], ...importWorkMetadata(row),
        expectedOutcome: text(row.expectedOutcome, '预期成果', false), acceptanceCriteria: text(row.acceptanceCriteria, '验收标准', false), dueDate: optionalDate(row.dueDate, '截止日期'),
        priority: before?.priority ?? 'medium', status: 'published', reviewComment: before?.reviewComment ?? '', publishedVersion: revision, sourcePlanId: before?.sourcePlanId ?? null,
        actualOutcome: text(row.actualOutcome, '实际成果', false), acceptanceStatus: importedMonthlyResult(row), acceptanceNote: text(row.blocker, '成果说明', false), importSource: this.provenance(row),
        isTemporary: row.isTemporary === true, temporaryReason: row.isTemporary === true ? text(row.temporaryReason, '临时事项原因') : '',
        ...(before?.mergedFromIds ? { mergedFromIds: before.mergedFromIds } : {}),
      }
      const result = before ? this.store.update<MonthlyPlan>('plans', before.id, before.version, fields) : this.store.insert<MonthlyPlan>('plans', fields)
      this.audit('plan', result.id, before ?? null, result)
      this.revisions.set(period, revision)
      return result
    })
  }
  weekly(row: ImportRow, monthlyPlanId?: string, existingWeeklyId?: string): WeeklyRecord {
    return this.store.transaction(() => {
      this.authorize()
      if (row.kind !== 'weekly') throw new HttpError(400, '此行不是周记录')
      const before = existingWeeklyId ? this.store.get<WeeklyRecord>('weeklyRecords', existingWeeklyId) : undefined
      if (existingWeeklyId && (!before || !isActiveWeeklyRecord(before) || !this.untouchedDraft(before, row) || before.submitted)) throw new HttpError(409, '原周记录已经变化或生效，请核对原记录后处理')
      const taskId = row.taskId || before?.taskId || ''
      let task = taskId ? this.store.get<Task>('tasks', taskId) : undefined
      if (taskId && !task) throw new HttpError(404, '关联任务不存在')
      if (before && (before.ownerId !== row.ownerId || before.taskId !== taskId || before.weekStart !== monday(row.weekStart))) throw new HttpError(409, '原周记录的负责人、任务或所属周与导入资料不一致')
      const planId = monthlyPlanId === undefined ? row.monthlyPlanId || task?.monthlyPlanId || '' : monthlyPlanId
      const checkedRow = { ...row, taskId, monthlyPlanId: planId, linkedRowId: planId ? '' : row.linkedRowId }
      // A same-source draft is our own activation, not a request to finish an unrelated task.
      this.validate({ ...checkedRow, ...(before && !row.taskId ? { taskCompleted: false } : {}) })
      const weekStart = monday(row.weekStart), status = importedWeeklyStatus(row), importSource = this.provenance(row)
      if (task?.importSource?.mode === 'draft' && task.importSource.sourceId === this.batch.sourceId && task.importSource.rowId === row.id) task = this.store.update<Task>('tasks', task.id, task.version, { importSource, ...importWorkMetadata(row), ...(row.taskCompleted ? { status: 'done', completionNote: row.completionNote } : {}) })
      if (task && this.store.list<WeeklyRecord>('weeklyRecords').some(record => isActiveWeeklyRecord(record) && record.id !== before?.id && record.taskId === task!.id && record.weekStart === weekStart)) throw new HttpError(409, '此任务本周已有记录，请核对后修改原记录')
      if (!task) {
        const taskStatus = { planned: 'todo', doing: 'doing', blocked: 'blocked', done: 'doing', not_done: 'todo' } as const
        task = this.store.insert<Task>('tasks', { title: text(row.title, '任务标题', true, 300), monthlyPlanId: planId || null, ownerId: row.ownerId,
          description: text(row.sourceText, '来源原文', false, 20000), dueDate: optionalDate(row.dueDate, '任务截止日期'), status: row.taskCompleted ? 'done' : taskStatus[status], isTemporary: row.isTemporary === true, temporaryReason: row.isTemporary === true ? text(row.temporaryReason, '临时事项原因') : '', importSource, ...importWorkMetadata(row), ...(row.taskCompleted ? { completionNote: text(row.completionNote, '整体完成说明') } : {}) })
        this.audit('task', task.id, null, task)
      }
      const fields: Omit<WeeklyRecord, keyof import('../shared/types.ts').Entity> = { taskId: task.id, monthlyPlanId: planId || null, ownerId: row.ownerId, weekStart,
        commitment: text(row.expectedOutcome, '本周承诺', false), actualOutcome: text(row.actualOutcome, '实际成果', false), evidenceUrl: before?.evidenceUrl ?? '',
        blocker: text(row.blocker, '阻塞原因', false), nextAction: text(row.nextAction, '下一步', false), status, submitted: true, importSource }
      const result = before ? this.store.update<WeeklyRecord>('weeklyRecords', before.id, before.version, fields) : this.store.insert<WeeklyRecord>('weeklyRecords', fields)
      this.audit('weeklyRecord', result.id, before ?? null, result)
      return result
    })
  }
  finish(): void {
    if (this.finished) return
    this.store.transaction(() => {
      this.authorize()
      for (const [period, revision] of this.revisions) {
        if (this.store.list<Publication>('publications').some(item => item.month === period && item.revision === revision)) throw new HttpError(409, '月份发布版本已变化，请重新确认导入')
        this.store.insert<Publication>('publications', { month: period, revision, actorId: this.actor.id, reason: '管理者确认既有资料导入生效',
          plans: this.store.list<MonthlyPlan>('plans').filter(plan => plan.month === period && plan.status === 'published') })
      }
    })
    this.finished = true
  }
}
