import { createHash } from 'node:crypto'
import type { AuditEvent, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import { taskSections, type EditableObject, type TaskHistoryItem, type TaskHistoryPage, type TaskView } from '../shared/task-view.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { isActiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { CollaborationService } from './collaboration-service.ts'
import { ObjectAccessService, activeGrant, canReadObject, assertBusinessActor, liveObjectActor, readScopeVersion } from './object-access.ts'
import { HttpError, type Store } from './store.ts'
import { getOperationEpoch } from './operation-context.ts'
import { planReference, visiblePlan } from './plan-visibility.ts'

const taskFields = ['title', 'description', 'dueDate', 'status', 'completionNote', 'evidenceUrl', 'blockerReason', 'blockerImpact', 'supportNeeded', 'nextAction', 'workSource', 'assignedBy', 'assignedOn', 'requestedOutcome', 'priority', 'estimatedEffort', 'remainingEffortDays', 'currentProgress', 'decisionNeeded', 'waitingForFeedback']
const weeklyFields = ['plannedEffortDays', 'actualEffortDays', 'commitment', 'actualOutcome', 'evidenceUrl', 'blocker', 'nextAction', 'status', 'submitted', 'blockerImpact', 'supportNeeded']
const pick = (row: object, fields: string[]) => Object.fromEntries(fields.filter(field => field in row).map(field => [field, (row as Record<string, unknown>)[field]]))

export class TaskViewService {
  constructor(private store: Store) {}
  private task(actor: User, id: string): Task {
    actor = assertBusinessActor(this.store, actor)
    const task = this.store.get<Task>('tasks', id)
    if (!task || actor.role !== 'manager' && task.ownerId !== actor.id) throw new HttpError(404, '任务不存在或无权访问')
    return task
  }
  view(actor: User, id: string, input: { section?: unknown; weeklyRecordId?: unknown } = {}): TaskView {
    actor = liveObjectActor(this.store, actor)
    if (input.section !== undefined && !taskSections.includes(input.section as typeof taskSections[number])) throw new HttpError(400, '任务详情区域无效')
    if (input.weeklyRecordId !== undefined && typeof input.weeklyRecordId !== 'string') throw new HttpError(400, '周记录定位无效')
    if (actor.role === 'observer') {
      const view = new ObjectAccessService(this.store).taskView(actor, id)
      if (input.weeklyRecordId && !view.weeklyRecords.some(row => row.id === input.weeklyRecordId)) throw new HttpError(404, '周记录不存在或无权访问')
      const task = view.task
      return { task, ownerName: this.store.get<User>('users', task.ownerId)?.name || '成员', weeklyRecords: view.weeklyRecords,
        authorizedDeliveries: view.deliveries, authorizedDeliverySummary: view.deliverySummary,
        monthlyPlan: view.monthReference ? { ...view.monthReference, month: this.store.get<MonthlyPlan>('plans', view.monthReference.id)?.month || '' } : null,
        progress: { overallProgress: task.currentProgress ? { text: task.currentProgress, changedAt: null, evidenceRef: null } : null, latestExecution: null, historicalExecution: view.weeklyRecords.filter(row => row.actualOutcome).map(row => ({ text: row.actualOutcome, sourceType: 'weeklyRecord', sourceId: row.id, weekStart: row.weekStart, occurredAt: null, recordedAt: null, actorId: row.ownerId, proxy: false, evidenceQuality: 'unknown' })) },
        allowedActions: [], readOnlyReason: task.cancellation ? '任务已作废，仅可读取授权历史' : view.readOnlyReason,
        tracking: null, progressEvents: [], followups: [], responses: [], blockerEpisodes: [], blockerActions: [], deadlineRequests: [], effectiveManagerIds: [], enabled: false, eligible: false, weeklySummary: null, overallStatusNeedsConfirmation: false,
        taskHistory: this.history(actor, id) }
    }
    const task = this.task(actor, id), view = new CollaborationService(this.store).taskView(actor, id, { includeProgress: false })
    const weeklyRecords = this.store.selectJson<WeeklyRecord>(`SELECT data FROM entities WHERE collection='weeklyRecords' AND json_extract(data,'$.taskId')=? AND (?=1 OR json_extract(data,'$.ownerId')=?) ORDER BY rowid`, [id, actor.role === 'manager' ? 1 : 0, actor.id])
    if (input.weeklyRecordId && !weeklyRecords.some(row => row.id === input.weeklyRecordId)) throw new HttpError(404, '周记录不存在或不属于当前任务')
    const rawPlan = task.monthlyPlanId ? this.store.get<MonthlyPlan>('plans', task.monthlyPlanId) : null
    const plan = rawPlan ? visiblePlan(this.store, actor, rawPlan) ?? planReference(rawPlan) : null
    return { ...view, task, ownerName: this.store.get<User>('users', task.ownerId)?.name || '成员', weeklyRecords: weeklyRecords.sort((a, b) => b.weekStart.localeCompare(a.weekStart) || a.id.localeCompare(b.id)),
      monthlyPlan: plan ? { id: plan.id, title: plan.title, month: plan.month } : null, progress: this.store.workspaceTaskProgress([task], actor.id, actor.role === 'manager', new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10))[task.id],
      allowedActions: isActiveTask(task) ? ['edit_task', 'update_weekly', 'submit_delivery', ...(actor.role === 'manager' ? ['manage_support', 'manage_grants'] : [])] : [],
      readOnlyReason: isActiveTask(task) ? null : '任务已作废，历史内容保留且不可继续编辑', taskHistory: this.history(actor, id) }
  }
  history(actor: User, taskId: string, input: { cursor?: unknown; limit?: unknown } = {}): TaskHistoryPage {
    return this.store.transaction(() => {
      actor = liveObjectActor(this.store, actor)
      const limit = input.limit === undefined ? 30 : Number(input.limit)
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, '历史分页大小须为 1 至 100')
      const epoch = getOperationEpoch(this.store)
      const scope = createHash('sha256').update(JSON.stringify([actor.id, taskId, limit, readScopeVersion(this.store, actor), epoch, this.store.workspaceRevision()])).digest('hex')
      let after: { createdAt: string; id: string } | undefined
      if (input.cursor !== undefined) {
        try {
          if (typeof input.cursor !== 'string' || input.cursor.length > 4096) throw new Error()
          const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString())
          if (cursor.scope !== scope || typeof cursor.id !== 'string' || typeof cursor.createdAt !== 'string' || !Number.isFinite(Date.parse(cursor.createdAt))) throw new Error()
          after = { createdAt: cursor.createdAt, id: cursor.id }
        } catch { throw new HttpError(409, '历史数据或读取范围已变化，请重新加载', 'ACCESS_SCOPE_CHANGED') }
      }
      const observer = actor.role === 'observer'
      if (observer ? !canReadObject(this.store, actor, 'task', taskId) : !this.task(actor, taskId)) throw new HttpError(404, '任务不存在或无权访问')
      const grant = observer ? activeGrant(this.store, actor, 'task', taskId) : undefined
      if (observer && !grant) throw new HttpError(404, '任务不存在或无权访问')
      const rows = this.store.taskHistoryPage(taskId, actor.id, actor.role === 'manager', limit + 1, after, grant), selected = rows.slice(0, limit)
      const titles: Record<string, string> = { task: '任务', weeklyRecord: '周执行', deliverySeries: '交付项', taskDelivery: '成果提交', deliveryDecision: '验收决定', blockerEpisode: '支持事项', blockerAction: '支持处理', decisionRequest: '决策事项' }
      const items: TaskHistoryItem[] = selected.map(event => ({ id: event.id, kind: event.action, at: event.createdAt, actorId: observer ? '' : event.actorId, title: observer ? event.action : `${titles[event.entityType]} · ${event.action}`, detail: observer ? this.store.get<User>('users', event.actorId)?.name ?? '成员' : actor.role !== 'manager' && event.entityType === 'taskDelivery' ? '' : event.reason || '' }))
      const last = selected.at(-1)
      return { items, nextCursor: rows.length > limit && last ? Buffer.from(JSON.stringify({ scope, createdAt: last.createdAt, id: last.id })).toString('base64url') : null }
    })
  }
  editableTask(actor: User, taskId: string): EditableObject {
    const task = this.task(actor, taskId)
    if (!isActiveTask(task)) throw new HttpError(409, '任务已作废，本地内容仅可复制', 'TASK_CANCELLED')
    return { version: task.version, values: pick(task, taskFields), operationEpoch: getOperationEpoch(this.store) }
  }
  editableWeekly(actor: User, recordId: string): EditableObject {
    actor = assertBusinessActor(this.store, actor)
    const record = this.store.get<WeeklyRecord>('weeklyRecords', recordId)
    if (!record || actor.role !== 'manager' && record.ownerId !== actor.id) throw new HttpError(404, '周记录不存在或无权访问')
    const task = this.editableTask(actor, record.taskId)
    if (!isActiveWeeklyRecord(record)) throw new HttpError(409, '周安排已删除，本地内容仅可复制', 'WEEKLY_RECORD_DELETED')
    return { version: record.version, values: pick(record, weeklyFields), operationEpoch: getOperationEpoch(this.store),
      relatedTask: { id: record.taskId, version: task.version, status: task.values.status as Task['status'], completionNote: String(task.values.completionNote || '') } }
  }
}
