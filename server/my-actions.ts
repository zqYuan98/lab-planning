import { createHash } from 'node:crypto'
import { actionKinds, type ActionItem, type ActionKind, type MyActions } from '../shared/my-actions.ts'
import type { MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { BlockerEpisode, DeadlineChangeRequest, FollowupRequest, TaskTracking } from '../shared/collaboration.ts'
import type { DeliverySeries, TaskDelivery } from '../shared/deliveries.ts'
import type { DecisionRequest } from '../shared/support.ts'
import type { WeeklyDuty } from '../shared/weekly-submissions.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { isActiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { liveObjectActor, readScopeVersion } from './object-access.ts'
import { HttpError, type Store } from './store.ts'
import { WeeklySubmissionService } from './weekly-submissions.ts'
import { collaborationEnabledFor, readCollaborationSettings } from './collaboration-policy.ts'
import { deliveryReviewerAvailable } from './task-deliveries.ts'
import { coordinatorAvailable, decisionOwnerAvailable } from './task-support.ts'
import { getOperationEpoch } from './operation-context.ts'
import { isManager, isObserver } from './authorization.ts'

const deadline = (day: string): string | null => day ? new Date(Date.parse(`${day}T00:00:00+08:00`) + 86400000).toISOString() : null
export class MyActionsService {
  constructor(private store: Store, private clock = () => new Date()) {}
  list(actor: User, input: { kind?: unknown; cursor?: unknown; limit?: unknown } = {}): MyActions {
    actor = liveObjectActor(this.store, actor)
    const now = this.clock().toISOString(), manager = isManager(actor), kind = input.kind === undefined || input.kind === '' || input.kind === 'all' ? undefined : input.kind as ActionKind
    if (kind && !actionKinds.includes(kind)) throw new HttpError(400, '待办类别无效')
    const limit = input.limit === undefined ? 30 : Number(input.limit)
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, '待办分页大小须为 1 至 100')
    const counts = Object.fromEntries(actionKinds.map(kind => [kind, 0])) as MyActions['counts']
    const scope = createHash('sha256').update(JSON.stringify([actor.id, kind || '', readScopeVersion(this.store, actor), getOperationEpoch(this.store)])).digest('hex')
    let after: string | undefined
    if (input.cursor !== undefined) {
      try { const decoded = JSON.parse(Buffer.from(String(input.cursor), 'base64url').toString()); if (decoded.scope !== scope || typeof decoded.after !== 'string') throw new Error(); after = decoded.after }
      catch { throw new HttpError(409, '待办读取范围已变化，请重新加载', 'ACCESS_SCOPE_CHANGED') }
    }
    const items: ActionItem[] = []
    const add = (row: Omit<ActionItem, 'key'>) => { items.push({ ...row, key: `${row.kind}/${row.sourceId}/${row.businessGeneration}` }) }
    if (!isObserver(actor)) {
      const tasks = new Map(this.store.list<Task>('tasks').filter(isActiveTask).map(task => [task.id, task]))
      const managers = this.store.list<User>('users').filter(user => isManager(user) && canUseAccount(user)).map(user => user.id)
      const assign = (sourceId: string, sourceVersion: number, task: Task, createdAt: string, reason: string, section: 'deliveries' | 'support' | 'followups', generation: string) => {
        if (manager) add({ kind: 'assignment', sourceId, sourceVersion, taskId: task.id, businessGeneration: generation, assigneeIds: managers, title: task.title, requiredAction: reason, blockedReason: reason, dueAt: null, createdAt, sharedQueue: true, actionTarget: { page: 'task', id: task.id, section } })
      }
      if (manager) {
        for (const plan of this.store.list<MonthlyPlan>('plans')) {
          const type = plan.status === 'submitted' ? 'monthly_review' : plan.status === 'published' && plan.acceptanceStatus === 'submitted' ? 'monthly_acceptance' : null
          if (type) add({ kind: type, sourceId: plan.id, sourceVersion: plan.version, businessGeneration: String(plan.version), assigneeIds: managers, title: plan.title,
            requiredAction: type === 'monthly_review' ? '审核月度目标' : '验收月度成果', dueAt: deadline(plan.dueDate), createdAt: plan.createdAt, sharedQueue: true,
            actionTarget: { page: 'monthly', id: plan.id, month: plan.month, action: type === 'monthly_review' ? 'review' : 'result' } })
        }
        const cycles = new Set(this.store.list<WeeklyDuty>('weeklyDuties').filter(duty => duty.kind === 'plan').map(duty => duty.cycleWeek))
        const weekly = new WeeklySubmissionService(this.store, this.clock)
        for (const week of cycles) for (const duty of weekly.preview(actor, week)?.duties || []) {
          if (!duty.planReviewRequired || duty.planReviewStatus !== 'pending' || !duty.latestSubmission) continue
          add({ kind: 'weekly_review', sourceId: duty.id, sourceVersion: duty.version, businessGeneration: duty.latestSubmission.id, assigneeIds: managers, title: `${this.store.get<User>('users', duty.ownerId)?.name || '成员'} · ${duty.contentWeek} 周计划`, requiredAction: '审核最新有效周计划', dueAt: duty.deadlineAt, createdAt: duty.latestSubmission.submittedAt, sharedQueue: true,
            actionTarget: { page: 'weekly', id: duty.latestSubmission.id, cycleWeek: duty.cycleWeek, ownerId: duty.ownerId, kind: 'plan', action: 'review' } })
        }
      }
      for (const series of this.store.list<DeliverySeries>('deliverySeries')) {
        const task = tasks.get(series.taskId), delivery = this.store.get<TaskDelivery>('taskDeliveries', series.headSubmissionId)
        if (!task || !delivery || series.status !== 'pending_review') continue
        if (!deliveryReviewerAvailable(this.store, series, delivery)) { assign(series.id, series.version, task, delivery.submittedAt, '成果待指定有效验收人', 'deliveries', series.headSubmissionId); continue }
        if (series.reviewerId === actor.id) add({ kind: 'delivery_review', sourceId: delivery.id, sourceVersion: series.version, businessGeneration: delivery.id, taskId: task.id, assigneeIds: [actor.id], title: series.title, requiredAction: '验收个人成果', dueAt: deadline(delivery.dueDateSnapshot), createdAt: delivery.submittedAt, sharedQueue: false, actionTarget: { page: 'task', id: task.id, section: 'deliveries' } })
      }
      for (const request of this.store.list<FollowupRequest>('followupRequests')) {
        const task = tasks.get(request.taskId)
        if (!task || request.status !== 'open') continue
        if (!collaborationEnabledFor(this.store, task.ownerId)) { assign(request.id, request.version, task, request.createdAt, '催办处理功能已关闭，请核对后恢复', 'followups', String(request.generation)); continue }
        const tracking = this.store.get<TaskTracking>('taskTrackings', task.id), weekly = request.weeklyRecordId ? this.store.get<WeeklyRecord>('weeklyRecords', request.weeklyRecordId) : null
        if (request.ownerId !== task.ownerId || !tracking || tracking.ownerId !== task.ownerId || tracking.state === 'closed' || tracking.generation !== request.generation || task.status === 'done'
          || request.weeklyRecordId && (!weekly || !isActiveWeeklyRecord(weekly) || !weekly.submitted || weekly.taskId !== task.id || weekly.ownerId !== task.ownerId)) {
          assign(request.id, request.version, task, request.createdAt, '催办关联或督办代次已变化，请管理者核对并恢复或关闭', 'followups', String(request.generation)); continue
        }
        if (request.ownerId === actor.id) add({ kind: 'followup_response', sourceId: request.id, sourceVersion: request.version, businessGeneration: String(request.generation), taskId: task.id, assigneeIds: [actor.id], title: task.title, requiredAction: '回应催办要求', dueAt: request.dueAt, createdAt: request.createdAt, sharedQueue: false, actionTarget: { page: 'task', id: task.id, section: 'followups' } })
      }
      for (const request of this.store.list<DeadlineChangeRequest>('deadlineChangeRequests')) {
        const task = tasks.get(request.taskId)
        if (!task || request.status !== 'open') continue
        if (!collaborationEnabledFor(this.store, task.ownerId) || !readCollaborationSettings(this.store).deadlineApprovalEnabled) { assign(request.id, request.version, task, request.createdAt, '延期审批功能已关闭，请核对后恢复', 'followups', String(request.generation)); continue }
        const tracking = this.store.get<TaskTracking>('taskTrackings', task.id)
        if (request.ownerId !== task.ownerId || !tracking || tracking.ownerId !== task.ownerId || request.generation !== tracking.generation || request.dueDateVersion !== tracking.dueDateVersion || task.dueDate !== request.originalDueDate) {
          assign(request.id, request.version, task, request.createdAt, '延期申请依据或督办代次已变化，请管理者核对后重新处理', 'followups', String(request.generation)); continue
        }
        if (manager) add({ kind: 'deadline_review', sourceId: request.id, sourceVersion: request.version, businessGeneration: String(request.generation), taskId: task.id, assigneeIds: managers, title: task.title, requiredAction: '批准或退回延期申请', dueAt: deadline(request.originalDueDate), createdAt: request.createdAt, sharedQueue: true, actionTarget: { page: 'task', id: task.id, section: 'followups', action: 'deadline' } })
      }
      for (const episode of this.store.list<BlockerEpisode>('blockerEpisodes')) {
        const task = tasks.get(episode.parentTaskId)
        if (!task || episode.resolvedAt || episode.managementClosedAt) continue
        if (!coordinatorAvailable(this.store, episode)) { assign(episode.id, episode.version, task, episode.createdAt, '支持事项待重新分派协调人', 'support', String(episode.generation)); continue }
        if (episode.coordinationState === 'responded' && !episode.reviewAt) continue
        const later = !!episode.reviewAt && episode.reviewAt > now
        if (episode.coordinatorId === actor.id || manager && !!episode.reviewAt) add({ kind: later ? 'revisit' : 'support', sourceId: episode.id, sourceVersion: episode.version, businessGeneration: String(episode.generation), taskId: task.id, assigneeIds: episode.coordinatorId ? [episode.coordinatorId] : managers, title: task.title, requiredAction: later ? '等待约定时间复查支持事项' : '回应或复查支持事项', dueAt: episode.reviewAt || episode.responseDueAt || null, createdAt: episode.createdAt, sharedQueue: manager && episode.coordinatorId !== actor.id,
          actionTarget: { page: 'support', id: episode.id, section: 'support' } })
      }
      for (const request of this.store.list<DecisionRequest>('decisionRequests')) {
        const task = tasks.get(request.taskId)
        if (!task || request.status !== 'open') continue
        if (!decisionOwnerAvailable(this.store, request)) { assign(request.id, request.version, task, request.createdAt, '决策事项待重新指定责任人', 'support', String(request.generation)); continue }
        if (request.decisionOwnerId === actor.id) add({ kind: 'decision', sourceId: request.id, sourceVersion: request.version, businessGeneration: String(request.generation), taskId: task.id, assigneeIds: [actor.id], title: request.question, requiredAction: '记录决策结论', dueAt: request.responseDueAt, createdAt: request.createdAt, sharedQueue: false, actionTarget: { page: 'task', id: task.id, section: 'support' } })
      }
    }
    for (const item of items) counts[item.kind]++
    items.sort((a, b) => Number(!!b.dueAt && b.dueAt <= now) - Number(!!a.dueAt && a.dueAt <= now) || (a.dueAt || '\uffff').localeCompare(b.dueAt || '\uffff') || a.createdAt.localeCompare(b.createdAt) || a.key.localeCompare(b.key))
    const filtered = kind ? items.filter(item => item.kind === kind) : items
    const index = after ? filtered.findIndex(item => item.key === after) : -1
    if (after && index < 0) throw new HttpError(409, '待办状态已变化，请重新加载', 'ACTION_LIST_CHANGED')
    const page = filtered.slice(index + 1, index + 1 + limit)
    return { items: page, counts, totalCount: items.length, filteredCount: filtered.length, nextCursor: index + 1 + limit < filtered.length ? Buffer.from(JSON.stringify({ scope, after: page.at(-1)!.key })).toString('base64url') : null, asOf: now }
  }
}
