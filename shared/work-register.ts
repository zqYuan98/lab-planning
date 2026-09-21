import type { Bootstrap, MonthlyPlan, Task, WeeklyRecord, WorkSource } from './types'
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord } from './weekly-record-state'

export type WorkRegisterView = 'active' | 'leader' | 'unscheduled' | 'week' | 'waiting' | 'done' | 'source-review' | 'completion-review'

export const workRegisterViewLabels: Record<WorkRegisterView, string> = {
  active: '全部在手', leader: '领导交办', unscheduled: '待安排',
  week: '本周推进', waiting: '待反馈', done: '已完成',
  'source-review': '来源待核对', 'completion-review': '完成待核对',
}
export const workSourceLabels = { leader: '领导交办', self: '自主安排', coordination: '协同事项' } as const
export const workPriorityLabels = { high: '高', medium: '中', low: '低' } as const
const statusLabels: Record<Task['status'], string> = { todo: '未开始', doing: '进行中', blocked: '受阻', done: '已完成' }
const priorityOrder = { high: 0, medium: 1, low: 2 }

interface WorkRegisterRowBase {
  id: string
  title: string
  dueDate: string
  priority?: Task['priority']
  createdAt: string
  source?: WorkSource
  sourceLabel: string
  assignedBy: string
  isActive: boolean
  needsCompletionReview: boolean
  currentWeekRecord?: WeeklyRecord
  latestRecord?: WeeklyRecord
  displayStatus: string
  progress: string
  progressSource: 'task' | 'weekly' | 'plan' | 'none'
  progressWeekStart?: string
  isOverdue: boolean
  isUnscheduled: boolean
  needsCoordination: boolean
}
export type WorkRegisterRow = WorkRegisterRowBase & (
  { kind: 'task'; task: Task; plan?: never } |
  { kind: 'plan'; plan: MonthlyPlan; task?: never }
)
export interface WorkRegisterResult {
  owner: { id: string; name: string }
  today: string
  weekStart: string
  view: WorkRegisterView
  query: string
  rows: WorkRegisterRow[]
  /** View counts cover all of the owner's tasks before applying keyword search. */
  counts: Record<WorkRegisterView, number> & { coordination: number }
}
export interface WorkRegisterReportRow {
  readonly id: string
  readonly title: string
  readonly itemType: string
  readonly source: string
  readonly assignedBy: string
  readonly assignedOn: string
  readonly requestedOutcome: string
  readonly status: string
  readonly progress: string
  readonly nextAction: string
  readonly dueDate: string
  readonly priority: string
  readonly estimatedEffort: string
  readonly decisionNeeded: string
  readonly waitingForFeedback: string
  readonly schedule: string
}
export interface WorkRegisterReportSnapshot {
  readonly owner: Readonly<{ id: string; name: string }>
  readonly generatedAt: string
  readonly today: string
  readonly weekStart: string
  readonly view: WorkRegisterView
  readonly query: string
  readonly rangeLabel: string
  readonly totalCount: number
  readonly unknownDueDateCount: number
  readonly coordinationCount: number
  readonly rows: readonly WorkRegisterReportRow[]
}

/** Calendar dates are evaluated in Beijing even when the browser uses another timezone. */
export function workRegisterToday(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now)
  const part = (type: string) => parts.find(item => item.type === type)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}

function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
}

function monday(today: string): string {
  if (!isCalendarDay(today)) throw new RangeError('工作清单日期格式无效')
  const date = new Date(`${today}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  return date.toISOString().slice(0, 10)
}

function matchesView(row: WorkRegisterRow, view: WorkRegisterView): boolean {
  const active = row.isActive
  switch (view) {
    case 'active': return active
    case 'leader': return active && row.source === 'leader'
    case 'unscheduled': return active && row.isUnscheduled
    case 'week': return active && !!row.currentWeekRecord
    case 'waiting': return active && row.kind === 'task' && row.task.waitingForFeedback === true
    case 'done': return !active
    case 'source-review': return active && !row.source
    case 'completion-review': return row.needsCompletionReview
  }
}

/** Explicit business source wins; a recorded manager assignment is reliable legacy evidence. */
export function workRegisterTaskSource(task: Task): WorkSource | undefined {
  return task.workSource ?? (!task.importSource && task.workOrigin?.kind === 'assigned' ? 'leader' : undefined)
}

/** Keep historical storage untouched until the owner confirms the overall outcome. */
export function workRegisterNeedsCompletionReview(task: Task): boolean {
  return task.status === 'done' && !!task.importSource && !task.completionNote?.trim()
}

export const workRegisterPlanStatusLabels: Record<MonthlyPlan['status'], string> = {
  draft: '草稿', returned: '退回修改', submitted: '待审核', approved: '审核通过，待发布', published: '已发布', merged: '已合并',
}

export function buildWorkRegister(
  data: Pick<Bootstrap, 'tasks' | 'weeklyRecords' | 'user'> & Partial<Pick<Bootstrap, 'plans' | 'users'>>,
  options: { view?: WorkRegisterView; query?: string; today?: string } = {},
): WorkRegisterResult {
  const today = options.today ?? workRegisterToday()
  const weekStart = monday(today)
  const view = options.view ?? 'active'
  const query = options.query?.trim() ?? ''
  const ownTasks = new Map<string, Task>()
  for (const task of data.tasks) {
    if (task.ownerId !== data.user.id) continue
    const previous = ownTasks.get(task.id)
    if (!previous || task.version > previous.version ||
      (task.version === previous.version && task.updatedAt > previous.updatedAt)) ownTasks.set(task.id, task)
  }
  const recordsByTask = new Map<string, WeeklyRecord[]>()
  for (const record of data.weeklyRecords) {
    if (!isActiveWeeklyRecord(record) || record.ownerId !== data.user.id || !ownTasks.has(record.taskId)) continue
    const records = recordsByTask.get(record.taskId) ?? []
    records.push(record)
    recordsByTask.set(record.taskId, records)
  }
  const allRows = [...ownTasks.values()].map((task): WorkRegisterRow => {
    const records = (recordsByTask.get(task.id) ?? []).sort((a, b) =>
      b.weekStart.localeCompare(a.weekStart) || b.updatedAt.localeCompare(a.updatedAt) ||
      b.version - a.version || a.id.localeCompare(b.id))
    const currentWeekRecord = records.find(record => record.weekStart === weekStart)
    const progressRecord = records.find(record => record.weekStart <= weekStart && !!record.actualOutcome.trim())
    const explicitProgress = (task.status === 'done' ? task.completionNote?.trim() : '') || task.currentProgress?.trim() || ''
    const progress = explicitProgress || progressRecord?.actualOutcome || ''
    const needsCompletionReview = workRegisterNeedsCompletionReview(task)
    const active = task.status !== 'done' || needsCompletionReview
    const source = workRegisterTaskSource(task)
    return {
      kind: 'task', id: task.id, title: task.title, dueDate: task.dueDate, priority: task.priority, createdAt: task.createdAt,
      source, sourceLabel: source ? `${workSourceLabels[source]}${!task.workSource ? '（按下发记录）' : ''}` : '来源待核对',
      assignedBy: task.assignedBy || (!task.workSource && source === 'leader' ? data.users?.find(user => user.id === task.workOrigin?.actorId)?.name ?? '' : ''),
      isActive: active, needsCompletionReview,
      task, currentWeekRecord, latestRecord: records[0], displayStatus: needsCompletionReview ? '整体完成待核对' : statusLabels[task.status], progress,
      progressSource: explicitProgress ? 'task' : progressRecord ? 'weekly' : 'none',
      progressWeekStart: !explicitProgress ? progressRecord?.weekStart : undefined,
      isOverdue: active && isCalendarDay(task.dueDate) && task.dueDate < today,
      isUnscheduled: !records.some(record => record.weekStart >= weekStart),
      needsCoordination: active && (task.status === 'blocked' || task.waitingForFeedback === true || !!task.decisionNeeded?.trim() || !!task.supportNeeded?.trim()),
    }
  })
  // A goal is a real planning item, not a fabricated task. Only its owner is responsible
  // for this coverage row; another person's task must never hide the owner's obligation.
  const linkedPlanIds = new Set([...ownTasks.values()].map(task => task.monthlyPlanId).filter(Boolean))
  const ownPlans = new Map<string, MonthlyPlan>()
  for (const plan of data.plans ?? []) {
    if (plan.ownerId !== data.user.id || plan.visibility) continue
    const previous = ownPlans.get(plan.id)
    if (!previous || plan.version > previous.version || (plan.version === previous.version && plan.updatedAt > previous.updatedAt)) ownPlans.set(plan.id, plan)
  }
  for (const plan of ownPlans.values()) {
    if (plan.status === 'merged' || plan.acceptanceStatus === 'accepted' || linkedPlanIds.has(plan.id)) continue
    allRows.push({ kind: 'plan', plan, id: plan.id, title: plan.title, dueDate: plan.dueDate, priority: plan.priority, createdAt: plan.createdAt,
      source: plan.workSource, sourceLabel: plan.workSource ? workSourceLabels[plan.workSource] : '来源待核对', assignedBy: plan.assignedBy || '',
      isActive: true, needsCompletionReview: false, displayStatus: workRegisterPlanStatusLabels[plan.status],
      progress: plan.actualOutcome || '', progressSource: plan.actualOutcome ? 'plan' : 'none',
      isOverdue: isCalendarDay(plan.dueDate) && plan.dueDate < today, isUnscheduled: true, needsCoordination: false,
    })
  }
  allRows.sort((a, b) =>
    (a.priority ? priorityOrder[a.priority] : 3) - (b.priority ? priorityOrder[b.priority] : 3) ||
    (isCalendarDay(a.dueDate) ? a.dueDate : '9999-99-99').localeCompare(isCalendarDay(b.dueDate) ? b.dueDate : '9999-99-99') ||
    a.createdAt.localeCompare(b.createdAt) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id))
  const counts: WorkRegisterResult['counts'] = { active: 0, leader: 0, unscheduled: 0, week: 0, waiting: 0, done: 0, coordination: 0, 'source-review': 0, 'completion-review': 0 }
  for (const row of allRows) {
    for (const key of Object.keys(workRegisterViewLabels) as WorkRegisterView[]) if (matchesView(row, key)) counts[key]++
    if (row.needsCoordination) counts.coordination++
  }
  const search = query.toLocaleLowerCase()
  const rows = allRows.filter(row => matchesView(row, view) && (!search || [row.title, row.sourceLabel, row.assignedBy, row.progress, row.displayStatus, ...(row.kind === 'plan' ? [
    row.plan.expectedOutcome, row.plan.acceptanceCriteria, row.plan.temporaryReason, row.plan.category, row.plan.assignedOn, '月度目标 待建立个人任务',
  ] : [row.task.description, row.task.assignedOn, row.task.temporaryReason,
    row.task.requestedOutcome, row.task.currentProgress, row.task.nextAction,
    row.task.decisionNeeded, row.task.estimatedEffort, row.task.blockerReason, row.task.supportNeeded,
  ])].filter(Boolean).join('\n').toLocaleLowerCase().includes(search)))
  return { owner: { id: data.user.id, name: data.user.name }, today, weekStart, view, query, rows, counts }
}

/** Only copied display values survive in the snapshot; no task or weekly-record references remain. */
export function createWorkRegisterSnapshot(
  result: WorkRegisterResult,
  options: { generatedAt?: string } = {},
): WorkRegisterReportSnapshot {
  const generatedAt = options.generatedAt ?? new Date().toISOString()
  if (!Number.isFinite(new Date(generatedAt).getTime())) throw new RangeError('汇报生成时间格式无效')
  const rows = result.rows.map((row): WorkRegisterReportRow => row.kind === 'plan' ? Object.freeze({
    id: row.id, title: row.title, itemType: '月度目标（待建立个人任务）', source: row.sourceLabel,
    assignedBy: row.assignedBy || '未注明', assignedOn: row.plan.assignedOn || '待确认',
    requestedOutcome: row.plan.expectedOutcome || '未填写', status: row.displayStatus, progress: row.progress || '未填写',
    nextAction: row.plan.status === 'published' ? '建立个人任务后安排周工作' : '建立个人任务；目标发布前仅可保存周草稿',
    dueDate: isCalendarDay(row.dueDate) ? row.dueDate : '待确认', priority: row.priority ? workPriorityLabels[row.priority] : '未注明',
    estimatedEffort: '待建立个人任务后填写', decisionNeeded: row.plan.status === 'published' ? '未填写' : `目标${row.displayStatus}，尚未发布`,
    waitingForFeedback: '未记录', schedule: '待建立个人任务',
  }) : Object.freeze({
    id: row.id,
    title: row.title,
    itemType: '个人任务',
    source: row.sourceLabel,
    assignedBy: row.assignedBy || '未注明',
    assignedOn: row.task.assignedOn || '待确认',
    requestedOutcome: row.task.requestedOutcome || '未填写',
    status: row.displayStatus,
    progress: [
      row.needsCompletionReview ? '原导入状态为已完成，缺少整件任务完成说明；需本人确认是否仍需推进。' : '',
      row.progressSource === 'weekly' ? `${row.progress}（参考 ${row.progressWeekStart} 周记录）` : row.progress,
      row.task.status === 'blocked' && row.task.blockerReason?.trim() ? `受阻原因：${row.task.blockerReason}` : '',
    ].filter(Boolean).join('\n') || '未填写',
    nextAction: row.task.nextAction || '未填写',
    dueDate: isCalendarDay(row.task.dueDate) ? row.task.dueDate : '待确认',
    priority: row.task.priority ? workPriorityLabels[row.task.priority] : '未注明',
    estimatedEffort: row.task.estimatedEffort || '未填写',
    decisionNeeded: [
      row.task.decisionNeeded || '',
      row.task.supportNeeded?.trim() ? `需要支持：${row.task.supportNeeded}` : '',
    ].filter(Boolean).join('\n') || '未填写',
    waitingForFeedback: row.task.status !== 'done' && row.task.waitingForFeedback ? '待反馈' : '否',
    schedule: row.needsCompletionReview ? '先核对整件任务是否完成' : row.task.status === 'done' ? '任务已结束' : row.isUnscheduled ? '未排期' : row.currentWeekRecord
      ? `本周 ${result.weekStart}${isEffectiveWeeklyRecord(row.currentWeekRecord) ? '' : row.currentWeekRecord.planApproval?.required && row.currentWeekRecord.submitted ? '（待审核）' : '（草稿）'}` : '已安排未来周',
  }))
  return Object.freeze({
    owner: Object.freeze({ ...result.owner }), generatedAt, today: result.today, weekStart: result.weekStart,
    view: result.view, query: result.query,
    rangeLabel: `${workRegisterViewLabels[result.view]}${result.query ? ` · 关键词：${result.query}` : ''}`,
    totalCount: rows.length,
    unknownDueDateCount: result.rows.filter(row => !isCalendarDay(row.dueDate)).length,
    coordinationCount: result.rows.filter(row => row.needsCoordination).length,
    rows: Object.freeze(rows),
  })
}
