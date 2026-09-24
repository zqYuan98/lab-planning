import type { BlockerAction, BlockerEpisode } from '../shared/collaboration.ts'
import type { BlockerView, DecisionRequest, TaskSupportView } from '../shared/support.ts'
import type { Task, User } from '../shared/types.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { HttpError, type Store } from './store.ts'
import { collaborationId, requiredText, utcTime } from './collaboration-store.ts'
import { activePeople, activeTask, audit, businessActor, cas, command, inbox, ownedTask, type Input } from './delivery-common.ts'

export function coordinatorAvailable(store: Store, episode: BlockerEpisode): boolean { return activePeople(store).some(user => user.id === episode.coordinatorId) }
export function decisionOwnerAvailable(store: Store, request: DecisionRequest): boolean { return activePeople(store, true).some(user => user.id === request.decisionOwnerId) }
export class TaskSupportService {
  constructor(private store: Store, private clock: () => Date = () => new Date()) {}
  private episode(id: string): BlockerEpisode { const row = this.store.get<BlockerEpisode>('blockerEpisodes', id); if (!row) throw new HttpError(404, '支持事项不存在'); return row }
  private request(id: string): DecisionRequest { const row = this.store.get<DecisionRequest>('decisionRequests', id); if (!row) throw new HttpError(404, '决策事项不存在'); return row }
  private parent(id: string, writable = false): Task { const task = this.store.get<Task>('tasks', id); if (!task) throw new HttpError(404, '任务不存在'); if (writable) activeTask(task); return task }
  private due(value: unknown) { const due = utcTime(value, '回应期限'); if (due <= this.clock().toISOString()) throw new HttpError(400, '回应期限必须在未来'); return due }
  private person(value: unknown, managerOnly = false) {
    const id = requiredText(value, managerOnly ? '决策责任人' : '协调人')
    if (!activePeople(this.store, managerOnly).some(user => user.id === id)) throw new HttpError(400, managerOnly ? '决策责任人须为有效管理者' : '协调人须为有效业务账号')
    return id
  }
  private canReadEpisode(actor: User, episode: BlockerEpisode, task: Task) {
    if (actor.role !== 'manager' && task.ownerId !== actor.id && episode.coordinatorId !== actor.id) throw new HttpError(404, '支持事项不存在或无权访问')
  }
  private blockerActions(actor: User, episode: BlockerEpisode, task: Task): string[] {
    if (!isActiveTask(task) || episode.managementClosedAt) return []
    const actions = actor.role === 'manager' ? ['assign', 'record', 'respond', 'defer', 'close'] : episode.coordinatorId === actor.id ? ['record', 'respond'] : []
    return actions
  }
  blockerView(actor: User, id: string): BlockerView {
    actor = businessActor(this.store, actor)
    const episode = this.episode(id), task = this.parent(episode.parentTaskId)
    this.canReadEpisode(actor, episode, task)
    const minimalContext = actor.role !== 'manager' && task.ownerId !== actor.id
    const actions = this.store.list<BlockerAction>('blockerActions').filter(row => row.episodeId === id)
    const assignmentIndex = actions.reduce((last, row, index) => row.action === 'assign' ? index : last, -1)
    const visibleActions = minimalContext ? actions.slice(Math.max(0, assignmentIndex)).filter(row => row.actorId === actor.id) : actions
    // Assignment grants one support context, not previous managerial discussions or other coordinators' history.
    const projectedEpisode = minimalContext ? { ...episode, managementNote: undefined, closureReason: '', responseNote: visibleActions.at(-1)?.note ?? '' } : episode
    return { episode: projectedEpisode, actions: visibleActions, task: { id: task.id, title: task.title, ownerId: task.ownerId }, minimalContext,
      coordinatorAvailable: coordinatorAvailable(this.store, episode), allowedActions: this.blockerActions(actor, episode, task) }
  }
  private decisionActions(actor: User, request: DecisionRequest, task: Task): string[] {
    if (!isActiveTask(task) || actor.role !== 'manager') return []
    if (request.status !== 'open') return ['reopen']
    return ['reassign', 'cancel', ...(actor.id === request.decisionOwnerId && decisionOwnerAvailable(this.store, request) ? ['decide'] : [])]
  }
  decisionView(actor: User, id: string) {
    actor = businessActor(this.store, actor)
    const request = this.request(id), task = ownedTask(this.store, actor, request.taskId)
    return { ...request, allowedActions: this.decisionActions(actor, request, task), ownerAvailable: decisionOwnerAvailable(this.store, request) }
  }
  taskView(actor: User, taskId: string): TaskSupportView {
    actor = businessActor(this.store, actor)
    const task = ownedTask(this.store, actor, taskId), manager = actor.role === 'manager', active = isActiveTask(task)
    return { blockers: this.store.list<BlockerEpisode>('blockerEpisodes').filter(row => row.parentTaskId === taskId).map(row => this.blockerView(actor, row.id)),
      decisions: this.store.list<DecisionRequest>('decisionRequests').filter(row => row.taskId === taskId).map(row => this.decisionView(actor, row.id)),
      eligibleCoordinators: manager ? activePeople(this.store).map(({ id, name }) => ({ id, name })) : [],
      eligibleDecisionOwners: manager ? activePeople(this.store, true).map(({ id, name }) => ({ id, name })) : [],
      canCreateDecision: manager && active, canEnrollBlocker: active && task.status === 'blocked' && !this.store.list<BlockerEpisode>('blockerEpisodes').some(row => row.parentTaskId === taskId && row.sourceType === 'task' && !row.resolvedAt) }
  }
  enrollBlocker(actor: User, taskId: string, input: Input): BlockerEpisode {
    actor = businessActor(this.store, actor); ownedTask(this.store, actor, taskId)
    return command(this.store, actor, `blocker.enroll:${taskId}`, input, this.clock(), mutationId => {
      const task = ownedTask(this.store, actor, taskId, true); cas(task.version, input.taskVersion)
      if (task.status !== 'blocked') throw new HttpError(409, '只有当前受阻任务可以纳入支持流程')
      const rows = this.store.list<BlockerEpisode>('blockerEpisodes').filter(row => row.sourceType === 'task' && row.sourceId === taskId)
      if (rows.some(row => !row.resolvedAt)) throw new HttpError(409, '当前阻塞已有支持事项，请直接处理')
      const now = this.clock(), episode = this.store.insert<BlockerEpisode>('blockerEpisodes', { id: collaborationId('blocker-enroll', mutationId), sourceType: 'task', sourceId: taskId, parentTaskId: taskId,
        ownerId: task.ownerId, generation: Math.max(0, ...rows.map(row => row.generation)) + 1, openedAt: now.toISOString(), openedAtKnown: false, openedBy: actor.id,
        resolvedAt: null, resolvedBy: null, reason: requiredText(task.blockerReason, '阻塞原因'), impact: requiredText(task.blockerImpact, '阻塞影响'), supportNeeded: requiredText(task.supportNeeded, '支持诉求'),
        reviewAt: null, closureReason: '', coordinatorId: null, responseDueAt: null, coordinationState: 'unassigned', responseNote: '', managementClosedAt: null, managementNote: '' })
      audit(this.store, actor, 'blockerEpisode', episode.id, 'enroll', null, episode, '确认将历史受阻事项纳入支持，实际发生时间未知')
      inbox(this.store, actor, mutationId, activePeople(this.store, true).map(user => user.id), 'support_unassigned', `${task.title}：支持待分派`, episode.supportNeeded, { type: 'blocker', id: episode.id }, now)
      return episode
    }, result => this.blockerView(actor, result.id).episode)
  }
  assignBlocker(actor: User, id: string, input: Input): { episode: BlockerEpisode; action: BlockerAction } {
    actor = businessActor(this.store, actor, true); this.episode(id)
    return command(this.store, actor, `blocker.assign:${id}`, input, this.clock(), mutationId => {
      const before = this.episode(id), task = this.parent(before.parentTaskId, true); cas(before.version, input.version)
      if (before.managementClosedAt) throw new HttpError(409, '支持事项已管理关闭')
      const coordinatorId = this.person(input.coordinatorId), responseDueAt = this.due(input.responseDueAt), note = requiredText(input.reason, '指派原因'), now = this.clock()
      const episode = this.store.update<BlockerEpisode>('blockerEpisodes', id, before.version, { coordinatorId, responseDueAt, coordinationState: 'awaiting_response', responseNote: '', reviewAt: null })
      const action = this.store.insert<BlockerAction>('blockerActions', { id: collaborationId('blocker-action', mutationId), episodeId: id, taskId: task.id, ownerId: before.ownerId,
        actorId: actor.id, action: 'assign', note, reviewAt: null, occurredAt: now.toISOString(), coordinatorId, responseDueAt })
      audit(this.store, actor, 'blockerEpisode', id, 'assign', before, episode, note)
      inbox(this.store, actor, mutationId, [coordinatorId, before.coordinatorId, task.ownerId], 'support_assigned', `${task.title}：支持责任已分派`, note, { type: 'blocker', id }, now)
      return { episode, action }
    }, result => ({ episode: this.blockerView(actor, result.episode.id).episode, action: result.action }))
  }
  handleBlocker(actor: User, id: string, input: Input): { episode: BlockerEpisode; action: BlockerAction } {
    actor = businessActor(this.store, actor)
    const initial = this.episode(id); this.canReadEpisode(actor, initial, this.parent(initial.parentTaskId))
    return command(this.store, actor, `blocker.handle:${id}`, input, this.clock(), mutationId => {
      const before = this.episode(id), task = this.parent(before.parentTaskId, true); this.canReadEpisode(actor, before, task); cas(before.version, input.version)
      if (!['record', 'respond', 'defer', 'close'].includes(String(input.action))) throw new HttpError(400, '请选择处理进展、回应、延后复查或管理关闭')
      if (!this.blockerActions(actor, before, task).includes(String(input.action))) throw new HttpError(403, '仅当前协调人可以回应，延期复查和管理关闭需要管理者')
      const actionName = input.action as 'record' | 'respond' | 'defer' | 'close', note = requiredText(input.note, '处理说明'), now = this.clock()
      const reviewAt = actionName === 'defer' ? this.due(input.reviewAt) : input.reviewAt ? this.due(input.reviewAt) : null
      const patch: Partial<BlockerEpisode> = { responseNote: note, managementNote: actor.role === 'manager' ? note : before.managementNote,
        coordinationState: actionName === 'close' ? 'management_closed' : actionName === 'respond' ? 'responded' : 'in_progress',
        ...(actionName === 'close' ? { managementClosedAt: now.toISOString(), reviewAt: null } : actionName === 'defer' ? { reviewAt } : actionName === 'respond' ? { reviewAt: null } : {}) }
      const episode = this.store.update<BlockerEpisode>('blockerEpisodes', id, before.version, patch)
      const action = this.store.insert<BlockerAction>('blockerActions', { id: collaborationId('blocker-action', mutationId), episodeId: id, taskId: task.id, ownerId: before.ownerId,
        actorId: actor.id, action: actionName, note, reviewAt, occurredAt: now.toISOString(), coordinatorId: before.coordinatorId ?? null, responseDueAt: before.responseDueAt ?? null })
      audit(this.store, actor, 'blockerEpisode', id, actionName, before, episode, note)
      inbox(this.store, actor, mutationId, [task.ownerId, before.coordinatorId, ...activePeople(this.store, true).map(user => user.id)], 'support_responded', `${task.title}：支持处理已更新`, note, { type: 'blocker', id }, now)
      return { episode, action }
    }, result => ({ episode: this.blockerView(actor, result.episode.id).episode, action: result.action }))
  }
  createDecision(actor: User, input: Input): DecisionRequest {
    actor = businessActor(this.store, actor, true)
    return command(this.store, actor, 'decision.create', input, this.clock(), mutationId => {
      const task = ownedTask(this.store, actor, requiredText(input.taskId, '任务'), true); cas(task.version, input.taskVersion)
      const blockerEpisodeId = input.blockerEpisodeId ? requiredText(input.blockerEpisodeId, '支持事项') : null
      if (blockerEpisodeId && this.episode(blockerEpisodeId).parentTaskId !== task.id) throw new HttpError(400, '关联支持事项不属于此任务')
      if (!Array.isArray(input.options) || input.options.length > 20) throw new HttpError(400, '决策选项须为最多 20 项文本')
      const now = this.clock(), request = this.store.insert<DecisionRequest>('decisionRequests', { id: collaborationId('decision-request', mutationId), taskId: task.id, blockerEpisodeId,
        question: requiredText(input.question, '待决策问题'), options: input.options.map(value => requiredText(value, '决策选项', true, 3000)),
        decisionOwnerId: this.person(input.decisionOwnerId, true), responseDueAt: this.due(input.responseDueAt), status: 'open', result: '', decidedAt: null, decidedBy: null,
        generation: 1, requestedBy: actor.id, reason: requiredText(input.reason, '发起说明', false) })
      audit(this.store, actor, 'decisionRequest', request.id, 'create', null, request, request.reason)
      inbox(this.store, actor, mutationId, [request.decisionOwnerId, task.ownerId], 'decision_requested', `${task.title}：需要决策`, request.question, { type: 'decisionRequest', id: request.id }, now)
      return request
    }, result => { ownedTask(this.store, actor, result.taskId); return this.request(result.id) })
  }
  private changeDecision(actor: User, id: string, input: Input, action: 'decide' | 'reassign' | 'cancel' | 'reopen'): DecisionRequest {
    actor = businessActor(this.store, actor, true); this.request(id)
    return command(this.store, actor, `decision.${action}:${id}`, input, this.clock(), mutationId => {
      const before = this.request(id), task = ownedTask(this.store, actor, before.taskId, true); cas(before.version, input.version)
      if (action === 'reopen' ? before.status === 'open' : before.status !== 'open') throw new HttpError(409, action === 'reopen' ? '决策事项已经开启' : '决策事项已经结束', 'VERSION_CONFLICT')
      const now = this.clock(), reason = requiredText(input.reason, action === 'decide' ? '决策说明' : '操作原因', action !== 'decide')
      let patch: Partial<DecisionRequest>
      if (action === 'decide') {
        if (actor.id !== before.decisionOwnerId || !decisionOwnerAvailable(this.store, before)) throw new HttpError(403, '只有当前有效指定决策责任人可以决定')
        patch = { status: 'decided', result: requiredText(input.result, '决策结果'), decidedAt: now.toISOString(), decidedBy: actor.id, reason }
      } else if (action === 'cancel') patch = { status: 'cancelled', reason }
      else if (action === 'reassign') patch = { decisionOwnerId: this.person(input.decisionOwnerId, true), responseDueAt: input.responseDueAt === undefined ? before.responseDueAt : this.due(input.responseDueAt), reason }
      else patch = { status: 'open', generation: before.generation + 1, result: '', decidedAt: null, decidedBy: null,
        decisionOwnerId: this.person(input.decisionOwnerId ?? before.decisionOwnerId, true), responseDueAt: this.due(input.responseDueAt), reason }
      const request = this.store.update<DecisionRequest>('decisionRequests', id, before.version, patch)
      audit(this.store, actor, 'decisionRequest', id, action, before, request, reason)
      inbox(this.store, actor, mutationId, [request.decisionOwnerId, before.decisionOwnerId, task.ownerId], `decision_${action}`, `${task.title}：决策事项已更新`, request.result || reason, { type: 'decisionRequest', id }, now)
      return request
    }, result => { ownedTask(this.store, actor, result.taskId); return this.request(result.id) })
  }
  decideDecision(actor: User, id: string, input: Input) { return this.changeDecision(actor, id, input, 'decide') }
  reassignDecision(actor: User, id: string, input: Input) { return this.changeDecision(actor, id, input, 'reassign') }
  cancelDecision(actor: User, id: string, input: Input) { return this.changeDecision(actor, id, input, 'cancel') }
  reopenDecision(actor: User, id: string, input: Input) { return this.changeDecision(actor, id, input, 'reopen') }
}
