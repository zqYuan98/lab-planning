import type { AuditEvent, ImportProvenance, MonthlyPlan, Project, Publication, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { ImportRow } from '../shared/import-types.ts'
import { importedMonthlyResult, importedWeeklyStatus } from '../shared/import-status.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { choice, date, manager, monday, month, participates, text } from './domain-common.ts'
import { HttpError, Store } from './store.ts'

function overlaps(weekStart: string, period: string) {
  const end = new Date(`${weekStart}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 6)
  return period >= weekStart.slice(0, 7) && period <= end.toISOString().slice(0, 7)
}
function optionalDate(value: unknown, label: string): string {
  const input = text(value, label, false, 10)
  return input ? date(input, label) : ''
}

/** Preview shares the writer's checks; a member may prepare their own records but cannot activate them. */
export function validateExistingRow(store: Store, actor: User, row: ImportRow, rows: ImportRow[] = []): string[] {
  const issues: string[] = []
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
    check(() => { const period = month(row.month); if (dueDate && !dueDate.startsWith(period)) throw new HttpError(400, '截止日期必须在所属月份内') })
    check(() => {
      const result = choice(importedMonthlyResult(row), ['pending', 'submitted', 'accepted', 'not_completed'], '成果状态')
      if (['accepted', 'submitted'].includes(result) && !text(row.actualOutcome, '实际成果', false)) throw new HttpError(400, '已验收或待验收成果必须有实际成果内容')
    })
  } else if (row.kind === 'weekly') {
    let weekStart = ''
    check(() => { weekStart = monday(row.weekStart) })
    check(() => choice(importedWeeklyStatus(row), ['planned', 'doing', 'blocked', 'done', 'not_done'], '周状态'))
    const task = typeof row.taskId === 'string' && row.taskId ? store.get<Task>('tasks', row.taskId) : undefined
    if (row.taskId && (!task || task.ownerId !== row.ownerId)) issues.push('关联任务不存在或负责人不一致')
    const linked = row.linkedRowId ? rows.find(item => item.id === row.linkedRowId && item.kind === 'monthly' && item.selected) : undefined
    if (row.linkedRowId && !linked && !row.monthlyPlanId) issues.push('请选择本批次中有效的月计划行')
    const planId = row.monthlyPlanId || (!linked ? task?.monthlyPlanId : '')
    if (planId) {
      const plan = store.get<MonthlyPlan>('plans', planId)
      if (!plan || plan.status !== 'published') issues.push('关联月计划必须已生效')
      else {
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
    return { batchId: this.batch.id, sourceId: this.batch.sourceId, rowId: text(row.id, '来源记录标识', true, 200), sourceStatus: text(row.sourceStatus, '原文状态', false) }
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
      if (existingPlanId && (!before || before.version !== 1 || !['draft', 'returned', 'submitted', 'approved'].includes(before.status))) throw new HttpError(409, '原月计划已经变化或生效，请核对原记录后处理')
      if (before && (before.ownerId !== row.ownerId || before.month !== row.month)) throw new HttpError(409, '原月计划的负责人或月份与导入资料不一致')
      const period = month(row.month)
      const revision = this.revisions.get(period) ?? this.store.list<Publication>('publications').filter(item => item.month === period).reduce((max, item) => Math.max(max, item.revision), 0) + 1
      const fields: Omit<MonthlyPlan, keyof import('../shared/types.ts').Entity> = {
        month: period, title: text(row.title, '计划标题', true, 300), projectId: text(row.projectId, '项目', false, 200) || null,
        category: text(row.category, '工作类别', false, 100), ownerId: row.ownerId, collaboratorIds: before?.collaboratorIds ?? [],
        expectedOutcome: text(row.expectedOutcome, '预期成果', false), acceptanceCriteria: text(row.acceptanceCriteria, '验收标准', false), dueDate: optionalDate(row.dueDate, '截止日期'),
        priority: before?.priority ?? 'medium', status: 'published', reviewComment: before?.reviewComment ?? '', publishedVersion: revision, sourcePlanId: before?.sourcePlanId ?? null,
        actualOutcome: text(row.actualOutcome, '实际成果', false), acceptanceStatus: importedMonthlyResult(row), acceptanceNote: text(row.blocker, '成果说明', false), importSource: this.provenance(row),
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
      if (existingWeeklyId && (!before || before.version !== 1 || before.submitted)) throw new HttpError(409, '原周记录已经变化或生效，请核对原记录后处理')
      const taskId = row.taskId || before?.taskId || ''
      let task = taskId ? this.store.get<Task>('tasks', taskId) : undefined
      if (taskId && !task) throw new HttpError(404, '关联任务不存在')
      if (before && (before.ownerId !== row.ownerId || before.taskId !== taskId || before.weekStart !== monday(row.weekStart))) throw new HttpError(409, '原周记录的负责人、任务或所属周与导入资料不一致')
      const planId = monthlyPlanId === undefined ? row.monthlyPlanId || task?.monthlyPlanId || '' : monthlyPlanId
      const checkedRow = { ...row, taskId, monthlyPlanId: planId, linkedRowId: planId ? '' : row.linkedRowId }
      this.validate(checkedRow)
      const weekStart = monday(row.weekStart), status = importedWeeklyStatus(row), importSource = this.provenance(row)
      if (task && this.store.list<WeeklyRecord>('weeklyRecords').some(record => record.id !== before?.id && record.taskId === task!.id && record.weekStart === weekStart)) throw new HttpError(409, '此任务本周已有记录，请核对后修改原记录')
      if (!task) {
        const taskStatus = { planned: 'todo', doing: 'doing', blocked: 'blocked', done: 'done', not_done: 'todo' } as const
        task = this.store.insert<Task>('tasks', { title: text(row.title, '任务标题', true, 300), monthlyPlanId: planId || null, ownerId: row.ownerId,
          description: text(row.sourceText, '来源原文', false, 20000), dueDate: optionalDate(row.dueDate, '任务截止日期'), status: taskStatus[status], isTemporary: false, temporaryReason: '', importSource })
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
