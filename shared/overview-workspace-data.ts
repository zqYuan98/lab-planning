import type { Bootstrap, MonthlyPlan, Task, User, WeeklyRecord } from './types'
import { canUseAccount, registrationApproved } from './auth-policy'
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord } from './weekly-record-state'
import { isActiveTask, isTaskCompletionPending } from './task-state'
import { addCalendarDays, shanghaiToday, shiftCalendarMonth, weekMonday } from './overview-data'
import { priorityRank, taskPriority, workKind, type WorkKind } from './task-presentation'

export type WorkPeriod = 'all' | 'month' | 'week'
export type WorkStatus = WeeklyRecord['status'] | 'draft' | 'unscheduled' | 'unknown'
export interface WorkRow {
  id: string
  taskId: string
  title: string
  ownerId: string
  ownerName: string
  projectId: string | null
  projectName: string
  planId: string | null
  planTitle: string
  status: WorkStatus
  /** All-time rows describe the ongoing task; dated views describe that period's weekly facts. */
  statusScope: 'task' | 'period'
  taskStatus?: Task['status']
  needsCompletionReview?: true
  weeklyStatus?: WorkStatus
  weeklyWeekStart?: string
  /** Older unfinished work, explicitly included alongside the selected period. */
  carryover?: true
  dueDate: string
  record?: WeeklyRecord
  task?: Task
  records: WeeklyRecord[]
  draftCount: number
  officialCount: number
  overdue: boolean
  isTemporary: boolean
  priority?: Task['priority']
  workKind?: WorkKind
}

export interface WorkFilters {
  query?: string
  ownerId?: string
  projectId?: string
  status?: WorkStatus | 'all' | 'overdue' | ''
  riskOnly?: boolean
}

function calendarDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

function latestFirst(a: WeeklyRecord, b: WeeklyRecord) {
  return b.weekStart.localeCompare(a.weekStart) || b.version - a.version || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id)
}

function taskCreatedDate(task: Pick<Task, 'createdAt'>) {
  const created = new Date(task.createdAt)
  return Number.isFinite(created.getTime()) ? shanghaiToday(created) : ''
}

/** Old unfinished work remains actionable without rewriting its month or weekly history. */
export function isCarryoverTask(
  task: Pick<Task, 'status' | 'dueDate' | 'createdAt' | 'cancellation' | 'importSource' | 'completionNote'>,
  plan: Pick<MonthlyPlan, 'month'> | undefined,
  startDate: string,
) {
  if (!isActiveTask(task) || task.status === 'done' && !isTaskCompletionPending(task) || !calendarDate(startDate)) return false
  if (plan?.month && plan.month < startDate.slice(0, 7)) return true
  if (calendarDate(task.dueDate) && task.dueDate < startDate) return true
  const created = taskCreatedDate(task)
  return !plan && !task.dueDate && !!created && created < startDate
}

function currentTaskStatus(task: Task | undefined, record: WeeklyRecord | undefined): WorkStatus {
  if (!task || isTaskCompletionPending(task)) return 'unknown'
  if (task.status === 'done' || task.status === 'blocked') return task.status
  const weeklyStatus = record ? isEffectiveWeeklyRecord(record) ? record.status : 'draft' : 'unscheduled'
  if (weeklyStatus === 'blocked' || weeklyStatus === 'not_done') return weeklyStatus
  if (task.status === 'doing') return 'doing'
  // Finishing a weekly commitment does not finish the whole task.
  if (weeklyStatus === 'done') return 'planned'
  return weeklyStatus
}

/** One row per visible task. Dated weekly facts retain the goal link saved on that record. */
export function buildWorkspace(
  data: Bootstrap,
  { period, date, includeInactive = false, includeCarryover = false }: { period: WorkPeriod; date: string; includeInactive?: boolean; includeCarryover?: boolean },
  today = shanghaiToday(),
) {
  const anchor = /^\d{4}-\d{2}$/.test(date) ? `${date}-01` : date
  if (!calendarDate(anchor) || !calendarDate(today)) throw new Error('Invalid calendar date')
  const month = anchor.slice(0, 7)
  const startDate = period === 'all' ? '' : period === 'week' ? weekMonday(anchor) : `${month}-01`
  const endDate = period === 'all' ? '' : period === 'week' ? addCalendarDays(startDate, 6) : addCalendarDays(`${shiftCalendarMonth(month, 1)}-01`, -1)
  const currentWeek = weekMonday(today)
  const within = (value: string) => calendarDate(value) && value >= startDate && value <= endDate
  const manager = data.user.role === 'manager'
  const canRead = (row: { ownerId: string }) => manager || row.ownerId === data.user.id
  const plans = new Map(data.plans.map(plan => [plan.id, plan]))
  const projects = new Map(data.projects.map(project => [project.id, project]))
  const users = new Map([...data.users, data.user].map(user => [user.id, user]))
  const tasks = new Map<string, Task>()
  for (const task of data.tasks.filter(canRead)) {
    const previous = tasks.get(task.id)
    if (!previous || task.version > previous.version || task.version === previous.version && task.updatedAt > previous.updatedAt) tasks.set(task.id, task)
  }
  const cancelledTaskIds = new Set([...tasks.values()].filter(task => !isActiveTask(task)).map(task => task.id))
  for (const id of cancelledTaskIds) tasks.delete(id)
  // The domain enforces task/week uniqueness. Tolerate duplicated historical input as well.
  const recordsByIdentity = new Map<string, WeeklyRecord>()
  for (const record of [...data.weeklyRecords].filter(isActiveWeeklyRecord).filter(canRead).sort(latestFirst)) {
    if (cancelledTaskIds.has(record.taskId)) continue
    const identity = `${record.taskId}\u0000${record.weekStart}`
    if (!recordsByIdentity.has(identity)) recordsByIdentity.set(identity, record)
  }
  const recordsByTask = new Map<string, WeeklyRecord[]>()
  for (const record of recordsByIdentity.values()) {
    if (period !== 'all') {
      if (!calendarDate(record.weekStart) || record.weekStart > endDate || addCalendarDays(record.weekStart, 6) < startDate) continue
      // A boundary week can contain work for either month; use its own goal, never the task's new goal.
      const recordPlan = record.monthlyPlanId ? plans.get(record.monthlyPlanId) : undefined
      if (period === 'month' && recordPlan && recordPlan.month !== month) continue
    }
    const records = recordsByTask.get(record.taskId) ?? []
    records.push(record)
    recordsByTask.set(record.taskId, records)
  }
  const rows: WorkRow[] = []
  for (const taskId of new Set([...tasks.keys(), ...recordsByTask.keys()])) {
    const task = tasks.get(taskId)
    const records = recordsByTask.get(taskId) ?? []
    // Future plans and unapproved edits must not replace the latest effective execution.
    const currentRecords = period === 'all' ? records.filter(row => row.weekStart <= currentWeek) : records
    const record = period === 'all' ? currentRecords.find(isEffectiveWeeklyRecord) ?? currentRecords[0] : records[0]
    // A lone future record can preserve a missing task's identity, never its current execution state.
    const identityRecord = record ?? records[0]
    const taskPlan = task?.monthlyPlanId ? plans.get(task.monthlyPlanId) : undefined
    const createdDate = period !== 'all' && includeCarryover && task ? taskCreatedDate(task) : ''
    const carryover = period !== 'all' && includeCarryover && task && (!createdDate || createdDate <= endDate) && isCarryoverTask(task, taskPlan, startDate)
    if (period !== 'all' && !records.length && !carryover && !(task && (within(task.dueDate) || period === 'month' && taskPlan?.month === month))) continue
    const planId = period === 'all' && task ? task.monthlyPlanId : identityRecord ? identityRecord.monthlyPlanId : task?.monthlyPlanId ?? null
    const plan = planId ? plans.get(planId) : undefined
    const projectId = plan?.projectId ?? null
    const ownerId = period === 'all' && task ? task.ownerId : identityRecord?.ownerId ?? task!.ownerId
    const owner = users.get(ownerId)
    if (owner ? !registrationApproved(owner) || !includeInactive && !canUseAccount(owner) : !includeInactive) continue
    if (!users.has(ownerId)) {
      // Display-only identity: preserve historical work without inventing an enabled account.
      users.set(ownerId, {
        id: ownerId, name: '历史成员', email: '', role: 'member', position: '历史账号',
        active: false, version: 0, createdAt: '', updatedAt: '',
      })
    }
    const weeklyStatus: WorkStatus | undefined = record ? isEffectiveWeeklyRecord(record) ? record.status : 'draft' : undefined
    const status: WorkStatus = period === 'all'
      ? !record && task?.status === 'todo' && records.length ? records.some(isEffectiveWeeklyRecord) ? 'planned' : 'draft' : currentTaskStatus(task, record)
      : weeklyStatus ?? 'unscheduled'
    const dueDate = task?.dueDate ?? ''
    const needsCompletionReview = task && isTaskCompletionPending(task)
    const officialCount = records.filter(isEffectiveWeeklyRecord).length
    rows.push({
      id: taskId, taskId, task, record, records,
      title: task?.title || identityRecord?.commitment || '历史任务',
      ownerId, ownerName: users.get(ownerId)?.name || '历史成员',
      projectId, projectName: projectId ? projects.get(projectId)?.name || '历史项目' : '未关联项目',
      planId, planTitle: plan?.title || (planId ? '历史月度目标' : '未关联目标'),
      status, statusScope: period === 'all' ? 'task' : 'period', taskStatus: task?.status, dueDate,
      ...(needsCompletionReview ? { needsCompletionReview: true } : {}),
      ...(record ? { weeklyStatus, weeklyWeekStart: record.weekStart } : {}),
      ...(carryover ? { carryover: true } : {}),
      officialCount, draftCount: records.length - officialCount,
      // Weekly stage completion never erases the deadline of an unfinished overall task.
      overdue: calendarDate(dueDate) && dueDate < today && (task ? task.status !== 'done' || !!needsCompletionReview : status !== 'done'),
      isTemporary: period === 'all' && task ? task.isTemporary : identityRecord ? identityRecord.monthlyPlanId === null : task?.isTemporary ?? false,
      priority: taskPriority(task, plan),
      workKind: workKind({ isTemporary: Boolean(task?.isTemporary || task?.temporaryReason?.trim() || plan?.isTemporary), monthlyPlanId: planId }),
    })
  }
  const represented = new Set(rows.map(row => row.ownerId))
  const members: User[] = [...users.values()].filter(user =>
    (manager || user.id === data.user.id) && (canUseAccount(user) || includeInactive && registrationApproved(user) && represented.has(user.id)),
  )
  return { rows, members, startDate, endDate }
}

export function filterWorkRows(rows: WorkRow[], filters: WorkFilters = {}) {
  const query = filters.query?.trim().toLocaleLowerCase() || ''
  return rows.filter(row =>
    (!filters.ownerId || filters.ownerId === 'all' || row.ownerId === filters.ownerId) &&
    (!filters.projectId || filters.projectId === 'all' || (['none', '__none__'].includes(filters.projectId) ? row.projectId === null : row.projectId === filters.projectId)) &&
    (!filters.status || filters.status === 'all' || (filters.status === 'overdue' ? row.overdue : row.status === filters.status)) &&
    (!filters.riskOnly || row.status === 'blocked' || row.status === 'not_done' || row.overdue) &&
    (!query || [row.title, row.ownerName, row.projectName, row.planTitle, row.record?.commitment, row.record?.actualOutcome, row.record?.blocker, row.record?.nextAction].filter(Boolean).join(' ').toLocaleLowerCase().includes(query)),
  )
}

/** Prioritize actionable work in the short member preview without changing its full task list. */
export function previewWorkRows<T extends Pick<WorkRow, 'status' | 'taskStatus' | 'needsCompletionReview' | 'overdue' | 'priority'>>(rows: T[], limit = 3) {
  const completed = (row: T) => !row.needsCompletionReview && (row.taskStatus ? row.taskStatus === 'done' : row.status === 'done')
  const risk = (row: T) => row.overdue || row.status === 'blocked' || row.status === 'not_done'
  return [...rows].sort((a, b) =>
    Number(completed(a)) - Number(completed(b)) ||
    Number(risk(b)) - Number(risk(a)) ||
    priorityRank[a.priority || 'none'] - priorityRank[b.priority || 'none'],
  ).slice(0, limit)
}

export function summarizeWorkRows(rows: Pick<WorkRow, 'status' | 'overdue' | 'officialCount' | 'draftCount'>[]) {
  return {
    total: rows.length,
    planned: rows.filter(row => row.status === 'planned').length,
    done: rows.filter(row => row.status === 'done').length,
    doing: rows.filter(row => row.status === 'doing').length,
    blocked: rows.filter(row => row.status === 'blocked').length,
    notDone: rows.filter(row => row.status === 'not_done').length,
    drafts: rows.filter(row => row.status === 'draft').length,
    unscheduled: rows.filter(row => row.status === 'unscheduled').length,
    unknown: rows.filter(row => row.status === 'unknown').length,
    overdue: rows.filter(row => row.overdue).length,
    officialCount: rows.reduce((total, row) => total + row.officialCount, 0),
    draftCount: rows.reduce((total, row) => total + row.draftCount, 0),
  }
}
