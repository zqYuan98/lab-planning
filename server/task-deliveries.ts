import type { DeliveryDecision, DeliveryMutationResult, DeliverySeries, DeliverySeriesView, DeliverySubmissionView, TaskDeliveriesView, TaskDelivery } from '../shared/deliveries.ts'
import type { DeadlineChangeRequest } from '../shared/collaboration.ts'
import type { Task, User } from '../shared/types.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { HttpError, type Store } from './store.ts'
import { collaborationId, requiredText } from './collaboration-store.ts'
import { activePeople, audit, businessActor, cas, command, inbox, ownedTask, type Input } from './delivery-common.ts'
import { WorkService } from './domain-work.ts'
import { isManager } from './authorization.ts'

export function effectiveDeliveryDecision(store: Store, deliveryId: string): DeliveryDecision | null {
  const rows = store.list<DeliveryDecision>('deliveryDecisions').filter(row => row.deliveryId === deliveryId)
  const superseded = new Set(rows.map(row => row.supersedesDecisionId).filter(Boolean))
  return rows.find(row => !superseded.has(row.id)) ?? null
}
export function deliveryReviewerAvailable(store: Store, series: DeliverySeries, delivery: TaskDelivery): boolean {
  return activePeople(store, true).some(user => user.id === series.reviewerId && user.id !== delivery.ownerId)
}
export class TaskDeliveryService {
  constructor(private store: Store, private clock: () => Date = () => new Date()) {}
  private submission(id: string): TaskDelivery { const row = this.store.get<TaskDelivery>('taskDeliveries', id); if (!row) throw new HttpError(404, '提交版本不存在'); return row }
  private series(id: string): DeliverySeries { const row = this.store.get<DeliverySeries>('deliverySeries', id); if (!row) throw new HttpError(404, '成果项不存在'); return row }
  private eligible(ownerId: string) { return activePeople(this.store, true).filter(user => user.id !== ownerId) }
  private reviewer(value: unknown, ownerId: string): string | null {
    const eligible = this.eligible(ownerId)
    if (value === null && !eligible.length) return null
    if (typeof value !== 'string' || !eligible.some(user => user.id === value)) throw new HttpError(400, eligible.length ? '请选择有效且非成果责任人本人的管理者验收' : '暂无合资格验收人，请保留待指定状态')
    return value
  }
  private view(delivery: TaskDelivery): DeliverySubmissionView {
    return { delivery, effectiveDecision: effectiveDeliveryDecision(this.store, delivery.id), decisions: this.store.list<DeliveryDecision>('deliveryDecisions').filter(row => row.deliveryId === delivery.id) }
  }
  private currentResult(actor: User, result: DeliveryMutationResult): DeliveryMutationResult {
    const task = ownedTask(this.store, actor, result.task.id), series = this.series(result.series.id), delivery = this.submission(result.delivery.id)
    return { task, series, delivery, ...(result.decision ? { decision: this.store.get<DeliveryDecision>('deliveryDecisions', result.decision.id)! } : {}) }
  }
  list(actor: User, taskId: string): TaskDeliveriesView {
    actor = businessActor(this.store, actor)
    const task = ownedTask(this.store, actor, taskId), active = isActiveTask(task)
    const items = this.store.list<DeliverySeries>('deliverySeries').filter(row => row.taskId === taskId).map((series): DeliverySeriesView => {
      const current = this.view(this.submission(series.headSubmissionId)), reviewerAvailable = deliveryReviewerAvailable(this.store, series, current.delivery)
      const allowedActions: string[] = []
      if (active) {
        if (series.status !== 'pending_review') allowedActions.push('submit')
        if (isManager(actor)) allowedActions.push('reassign')
        if (series.status === 'pending_review' && (isManager(actor) || actor.id === current.delivery.submittedBy)) allowedActions.push('withdraw')
        if (reviewerAvailable && actor.id === series.reviewerId) {
          if (series.status === 'pending_review') allowedActions.push('review')
          if (this.store.list<DeliveryDecision>('deliveryDecisions').some(row => row.seriesId === series.id)) allowedActions.push('correct')
        }
      }
      const submissions = this.store.list<TaskDelivery>('taskDeliveries').filter(row => row.seriesId === series.id).sort((a, b) => a.revision - b.revision)
      return { series, current, reviewerAvailable, allowedActions, firstSubmittedAt: submissions[0].submittedAt,
        acceptedSubmittedAt: series.status === 'accepted' ? current.delivery.submittedAt : null,
        acceptedAt: series.status === 'accepted' ? current.effectiveDecision?.decidedAt ?? null : null }
    })
    return { items, eligibleReviewers: this.eligible(task.ownerId).map(({ id, name }) => ({ id, name })), canSubmit: active }
  }
  history(actor: User, seriesId: string, query: { cursor?: string; limit?: number } = {}) {
    actor = businessActor(this.store, actor)
    const series = this.series(seriesId); ownedTask(this.store, actor, series.taskId)
    const limit = query.limit ?? 20, cursor = query.cursor ? Number(query.cursor) : Number.MAX_SAFE_INTEGER
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(cursor) || cursor < 1) throw new HttpError(400, '历史分页参数无效')
    const rows = this.store.list<TaskDelivery>('taskDeliveries').filter(row => row.seriesId === seriesId && row.revision < cursor).sort((a, b) => b.revision - a.revision)
    const page = rows.slice(0, limit)
    return { items: page.map(row => this.view(row)), nextCursor: rows.length > limit ? String(page.at(-1)!.revision) : null }
  }
  submit(actor: User, taskId: string, input: Input): DeliveryMutationResult {
    actor = businessActor(this.store, actor); ownedTask(this.store, actor, taskId)
    return command<DeliveryMutationResult>(this.store, actor, `delivery.submit:${taskId}`, input, this.clock(), mutationId => {
      let task = ownedTask(this.store, actor, taskId, true)
      cas(task.version, input.taskVersion)
      const proxyReason = actor.id === task.ownerId ? '' : requiredText(input.proxyReason, '代交原因')
      const actualOutcome = requiredText(input.actualOutcome, '成果说明'), acceptanceCriteriaSnapshot = requiredText(input.acceptanceCriteria, '验收标准')
      const reviewerId = this.reviewer(input.reviewerId, task.ownerId)
      if (!Array.isArray(input.evidenceRefs) || input.evidenceRefs.length > 30) throw new HttpError(400, '证据须为最多 30 项链接或文本说明')
      const evidenceRefs = input.evidenceRefs.map(value => requiredText(value, '证据', true, 4000))
      for (const value of evidenceRefs) if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^https?:\/\//i.test(value)) throw new HttpError(400, '证据链接只支持 http 或 https')
      let before: DeliverySeries | null = null, previous: TaskDelivery | null = null
      if (input.seriesId !== undefined) {
        before = this.series(requiredText(input.seriesId, '成果项'))
        if (before.taskId !== taskId) throw new HttpError(404, '成果项不属于此任务')
        cas(before.version, input.seriesVersion)
        previous = this.submission(before.headSubmissionId)
        if (input.previousRevision !== previous.revision || input.previousSubmissionId !== previous.id) throw new HttpError(409, '成果提交版本已变化，请核对当前版本', 'VERSION_CONFLICT')
        if (before.status === 'pending_review') throw new HttpError(409, '当前版本待验收，请先撤回再提交')
        if (before.status === 'accepted' && input.replaceAccepted !== true) throw new HttpError(400, '请明确确认替代已通过的成果')
      } else {
        if (input.previousRevision !== 0 || input.previousSubmissionId) throw new HttpError(409, '首交须基于第 0 版', 'VERSION_CONFLICT')
        if (this.store.list<DeliverySeries>('deliverySeries').some(row => row.taskId === taskId) && input.newSeries !== true) throw new HttpError(409, '请续交已有成果项，或明确新增不同成果项')
      }
      const now = this.clock(), seriesId = before?.id ?? collaborationId('delivery-series', mutationId)
      const delivery = this.store.insert<TaskDelivery>('taskDeliveries', { id: collaborationId('task-delivery', mutationId), seriesId, taskId,
        revision: (previous?.revision ?? 0) + 1, supersedesId: previous?.id ?? null, taskVersion: task.version, ownerId: task.ownerId, submittedBy: actor.id,
        proxyReason, submittedAt: now.toISOString(), actualOutcome, evidenceRefs, acceptanceCriteriaSnapshot, reviewerIdSnapshot: reviewerId,
        dueDateSnapshot: task.dueDate, deadlineBasisRefs: this.store.list<DeadlineChangeRequest>('deadlineChangeRequests').filter(row => row.taskId === taskId && row.status === 'approved').map(row => row.id) })
      const fields = { taskId, title: before?.title ?? (input.newSeries === true ? requiredText(input.title, '成果项标题', true, 300) : requiredText(input.title ?? task.title, '成果项标题', true, 300)), reviewerId, headSubmissionId: delivery.id, status: 'pending_review' as const }
      const series = before ? this.store.update<DeliverySeries>('deliverySeries', before.id, before.version, fields) : this.store.insert<DeliverySeries>('deliverySeries', { id: seriesId, ...fields })
      if (input.markTaskDone === true) task = new WorkService(this.store).updateTask(actor, task.id, { version: task.version, status: 'done', completionNote: requiredText(input.completionNote, '任务完成说明'), proxyReason })
      audit(this.store, actor, 'taskDelivery', delivery.id, 'submit', null, delivery, proxyReason)
      audit(this.store, actor, 'deliverySeries', series.id, 'submit', before, series)
      inbox(this.store, actor, mutationId, reviewerId ? [reviewerId] : activePeople(this.store, true).map(user => user.id), 'delivery_submitted', `${task.title}：成果待验收`, reviewerId ? actualOutcome : '成果已正式提交，待指定验收人', { type: 'task', id: taskId }, now)
      return { series, delivery, task }
    }, result => this.currentResult(actor, result))
  }
  decide(actor: User, deliveryId: string, input: Input): DeliveryMutationResult {
    actor = businessActor(this.store, actor)
    ownedTask(this.store, actor, this.submission(deliveryId).taskId)
    return command<DeliveryMutationResult>(this.store, actor, `delivery.decide:${deliveryId}`, input, this.clock(), mutationId => {
      const delivery = this.submission(deliveryId), task = ownedTask(this.store, actor, delivery.taskId, true), before = this.series(delivery.seriesId)
      cas(before.version, input.seriesVersion)
      const previous = effectiveDeliveryDecision(this.store, deliveryId), action = input.action
      if (!['review', 'withdraw', 'correct'].includes(String(action))) throw new HttpError(400, '成果决定动作无效')
      if (action === 'correct') {
        if (!previous || input.supersedesDecisionId !== previous.id) throw new HttpError(409, '只能更正所选版本的当前有效决定', 'VERSION_CONFLICT')
      } else if (before.headSubmissionId !== deliveryId || before.status !== 'pending_review' || previous) throw new HttpError(409, '该成果版本已经处理或不是当前待验收版本', 'VERSION_CONFLICT')
      let conclusion: DeliveryDecision['conclusion']
      if (action === 'withdraw') {
        if (!isManager(actor) && actor.id !== delivery.submittedBy) throw new HttpError(403, '只有提交人或管理者可以撤回')
        conclusion = 'withdrawn'
      } else {
        if (!isManager(actor) || actor.id !== before.reviewerId || actor.id === delivery.ownerId || !deliveryReviewerAvailable(this.store, before, delivery)) throw new HttpError(403, '仅当前有效指定验收人可以验收或更正，且不能自验收')
        if (!['accepted', 'returned'].includes(String(input.conclusion))) throw new HttpError(400, '请选择通过或退回')
        conclusion = input.conclusion as 'accepted' | 'returned'
      }
      const note = requiredText(input.note, action === 'correct' ? '更正原因与结论' : conclusion === 'accepted' ? '验收结论' : '处理原因'), now = this.clock()
      const decision = this.store.insert<DeliveryDecision>('deliveryDecisions', { id: collaborationId('delivery-decision', mutationId), seriesId: before.id, deliveryId,
        action: action as DeliveryDecision['action'], conclusion, note, decidedBy: actor.id, decidedAt: now.toISOString(), supersedesDecisionId: action === 'correct' ? previous!.id : null })
      // Historical corrections still participate in the series lock, without changing its current head or state.
      const series = this.store.update<DeliverySeries>('deliverySeries', before.id, before.version, before.headSubmissionId === deliveryId ? { status: conclusion } : {})
      audit(this.store, actor, 'deliveryDecision', decision.id, String(action), previous, decision, note)
      audit(this.store, actor, 'deliverySeries', series.id, before.headSubmissionId === deliveryId ? String(action) : 'historical_correction', before, series, note)
      inbox(this.store, actor, mutationId, [delivery.ownerId, delivery.submittedBy], 'delivery_decided', `${task.title}：成果决定已更新`, note, { type: 'task', id: task.id }, now)
      return { series, delivery, decision, task }
    }, result => this.currentResult(actor, result))
  }
  reassign(actor: User, seriesId: string, input: Input): DeliveryMutationResult {
    actor = businessActor(this.store, actor, true)
    ownedTask(this.store, actor, this.series(seriesId).taskId)
    return command<DeliveryMutationResult>(this.store, actor, `delivery.reassign:${seriesId}`, input, this.clock(), mutationId => {
      const before = this.series(seriesId), delivery = this.submission(before.headSubmissionId), task = ownedTask(this.store, actor, before.taskId, true)
      cas(before.version, input.seriesVersion)
      const reviewerId = this.reviewer(input.reviewerId, delivery.ownerId), reason = requiredText(input.reason, '重新指派原因'), now = this.clock()
      const series = this.store.update<DeliverySeries>('deliverySeries', seriesId, before.version, { reviewerId })
      audit(this.store, actor, 'deliverySeries', seriesId, 'reassign', before, series, reason)
      inbox(this.store, actor, mutationId, [reviewerId, before.reviewerId, delivery.ownerId], 'delivery_reassigned', `${task.title}：验收责任人已调整`, reason, { type: 'task', id: task.id }, now)
      return { series, delivery, task }
    }, result => this.currentResult(actor, result))
  }
}
