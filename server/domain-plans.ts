import { assertBusinessActor } from './object-access.ts'
import { createHash } from 'node:crypto'
import type { AnnualGoal, AuditEvent, Entity, MonthlyPlan, Publication, Task, User } from '../shared/types.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { projectPlan, visiblePlanHistory } from './plan-visibility.ts'
import { notifyPublishedPlans } from './notification-events.ts'
import { HttpError } from './store.ts'
import { DomainBase, bool, choice, date, manager, month, own, participates, text, type Input } from './domain-common.ts'
import { assertOperationEpoch } from './operation-context.ts'
import { isManager } from './authorization.ts'
import { LIMITS, PRIORITIES, WORK_SOURCES } from '../shared/entity-rules.ts'

interface MonthlyCarryReceipt extends Entity {
  actorId: string; requestId: string; sourcePlanId: string; sourceVersion: number; payloadHash: string; targetPlanId: string
}

export class MonthlyService extends DomainBase {
  private annualLink(value: unknown, period: string): string | null {
    if (value === null || value === '') return null
    const id = text(value, '年度目标', true, 200), goal = this.need<AnnualGoal>('annualGoals', id)
    if (goal.year !== Number(period.slice(0, 4))) throw new HttpError(400, '月目标只能关联同年度的年度目标')
    return id
  }
  private collaborators(value: unknown, ownerId: string, existingParticipants: string[] = []): string[] {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > 100 || value.some(item => typeof item !== 'string')) throw new HttpError(400, '协作者格式不正确')
    return [...new Set(value as string[])].filter(id => id !== ownerId).map(id => {
      // Retaining an existing responsibility is not assigning new work to a disabled account.
      return existingParticipants.includes(id) ? this.need<User>('users', id).id : this.activeUser(id).id
    })
  }
  private revision(period: string) {
    return Math.max(0, ...this.store.list<Publication>('publications').filter(item => item.month === period).map(item => item.revision)) + 1
  }
  private snapshot(actor: User, period: string, revision: number, reason: string): Publication {
    return this.store.insert<Publication>('publications', { month: period, revision, actorId: actor.id, reason, plans: this.store.list<MonthlyPlan>('plans').filter(item => item.month === period && item.status === 'published') })
  }
  private visible(actor: User, plan: MonthlyPlan) {
    if (!this.planVisible(actor, plan)) throw new HttpError(403, '无权查看此月计划')
  }
  private editable(actor: User, plan: MonthlyPlan) {
    own(actor, plan.ownerId)
    if (isManager(actor)) return
    if (!plan.isTemporary) throw new HttpError(403, '普通月度目标需由管理者维护')
    if (!['draft', 'returned'].includes(plan.status)) throw new HttpError(403, '提交后的临时目标需由管理者退回后修改')
  }
  create(actor: User, input: Input): MonthlyPlan {
    actor = assertBusinessActor(this.store, actor)
    const isTemporary = input.isTemporary === undefined ? false : bool(input.isTemporary, '临时目标标记')
    if (!isTemporary) manager(actor)
    if (input.sourcePlanId !== undefined && input.sourcePlanId !== null && input.sourcePlanId !== '') {
      manager(actor)
      throw new HttpError(400, '来源计划只能通过跨月承接设置')
    }
    return this.store.transaction(() => this.createDraft(actor, input, null))
  }
  /** Internal whitelist shared by normal creation and the validated carry command. */
  private createDraft(actor: User, input: Input, sourcePlanId: string | null): MonthlyPlan {
    const isTemporary = input.isTemporary === undefined ? false : bool(input.isTemporary, '临时目标标记')
    const period = month(input.month)
    const ownerId = this.owner(actor, input.ownerId)
    const projectId = input.projectId ? text(input.projectId, '项目') : null
    if (projectId) this.activeProject(projectId)
    const dueDate = date(input.dueDate, '截止日期')
    if (!dueDate.startsWith(period)) throw new HttpError(400, '月计划截止日期必须在所属月份内')
    const metadata: Pick<MonthlyPlan, 'workSource' | 'assignedBy' | 'assignedOn'> = {}
    if (input.workSource !== undefined) metadata.workSource = choice(input.workSource, WORK_SOURCES, '工作来源')
    if (input.assignedBy !== undefined) metadata.assignedBy = text(input.assignedBy, '交办人', false, LIMITS.assignedBy)
    if (input.assignedOn !== undefined) metadata.assignedOn = input.assignedOn === '' ? '' : date(input.assignedOn, '交办日期')
    const plan = this.store.insert<MonthlyPlan>('plans', {
      ...(input.annualGoalId !== undefined ? { annualGoalId: this.annualLink(input.annualGoalId, period) } : {}),
      month: period, title: text(input.title, '计划标题', true, LIMITS.title), projectId,
      category: text(input.category, '工作类别', !projectId, 100), ownerId,
      collaboratorIds: this.collaborators(input.collaboratorIds, ownerId),
      expectedOutcome: text(input.expectedOutcome, '预期成果'), acceptanceCriteria: text(input.acceptanceCriteria, '验收标准'), dueDate,
      priority: choice(input.priority ?? 'medium', PRIORITIES, '优先级'),
      isTemporary, temporaryReason: isTemporary ? text(input.temporaryReason, '临时目标原因') : '',
      status: 'draft', reviewComment: '', publishedVersion: null, sourcePlanId,
      actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', ...metadata,
    })
    this.audit(actor, 'plan', plan.id, 'create', null, plan)
    return plan
  }
  update(actor: User, id: string, input: Input): MonthlyPlan {
    actor = assertBusinessActor(this.store, actor)
    return this.store.transaction(() => {
      const before = this.need<MonthlyPlan>('plans', id)
      this.editable(actor, before)
      if (input.sourcePlanId !== undefined && input.sourcePlanId !== null && input.sourcePlanId !== '') throw new HttpError(400, '来源计划只能通过跨月承接设置，不能直接修改')
      if (before.status === 'merged') throw new HttpError(409, '已合并的来源提报保留为历史，请编辑合并后的计划')
      this.current<MonthlyPlan>('plans', id, input)
      if (input.month !== undefined && input.month !== before.month) throw new HttpError(400, '所属月份不能直接修改，请使用跨月承接')
      if (input.isTemporary !== undefined && bool(input.isTemporary, '临时目标标记') !== !!before.isTemporary) throw new HttpError(400, '月度目标类型不能直接修改')
      const patch: Partial<MonthlyPlan> = {}
      if (input.annualGoalId !== undefined) patch.annualGoalId = this.annualLink(input.annualGoalId, before.month)
      if (before.isTemporary && input.temporaryReason !== undefined) patch.temporaryReason = text(input.temporaryReason, '临时目标原因')
      if (input.title !== undefined) patch.title = text(input.title, '计划标题', true, LIMITS.title)
      if (input.projectId !== undefined) {
        patch.projectId = input.projectId ? text(input.projectId, '项目') : null
        if (patch.projectId && patch.projectId !== before.projectId) this.activeProject(patch.projectId)
      }
      if (input.category !== undefined) patch.category = text(input.category, '工作类别', false, LIMITS.category)
      if (input.ownerId !== undefined && input.ownerId !== before.ownerId) {
        manager(actor)
        patch.ownerId = this.activeUser(input.ownerId).id
      }
      const ownerId = patch.ownerId ?? before.ownerId
      if (input.collaboratorIds !== undefined) patch.collaboratorIds = this.collaborators(input.collaboratorIds, ownerId, [before.ownerId, ...before.collaboratorIds])
      else if (patch.ownerId) patch.collaboratorIds = before.collaboratorIds.filter(item => item !== ownerId)
      if (input.expectedOutcome !== undefined) patch.expectedOutcome = text(input.expectedOutcome, '预期成果', !before.importSource)
      if (input.acceptanceCriteria !== undefined) patch.acceptanceCriteria = text(input.acceptanceCriteria, '验收标准', !before.importSource)
      if (input.dueDate !== undefined) {
        patch.dueDate = before.importSource && text(input.dueDate, '截止日期', false, 10) === '' ? '' : date(input.dueDate, '截止日期')
        if (patch.dueDate && !patch.dueDate.startsWith(before.month)) throw new HttpError(400, '截止日期必须在所属月份内')
      }
      if (input.priority !== undefined) patch.priority = choice(input.priority, PRIORITIES, '优先级')
      const next = { ...before, ...patch }
      if (!next.projectId && !next.category && !before.importSource) throw new HttpError(400, '没有所属项目时需要填写工作类别')
      if (this.store.list<Task>('tasks').some(task => isActiveTask(task) && task.monthlyPlanId === id && !participates(next, task.ownerId))) throw new HttpError(400, '修改责任人前，请先处理仍关联此计划的个人任务，保留任务负责人为协作者')
      const reason = before.status === 'published' ? text(input.reason, '发布后变更原因') : text(input.reason, '修改原因', false)
      if (before.status === 'published') {
        patch.publishedVersion = this.revision(before.month)
        if ((patch.expectedOutcome !== undefined && patch.expectedOutcome !== before.expectedOutcome) || (patch.acceptanceCriteria !== undefined && patch.acceptanceCriteria !== before.acceptanceCriteria)) {
          patch.acceptanceStatus = 'pending'
          patch.acceptanceNote = ''
        }
      }
      const plan = this.store.update<MonthlyPlan>('plans', id, before.version, patch)
      this.audit(actor, 'plan', id, before.status === 'published' ? 'published_change' : 'update', before, plan, reason)
      if (before.status === 'published') this.snapshot(actor, before.month, plan.publishedVersion!, reason)
      return projectPlan(actor, plan, this.store)
    })
  }
  submit(actor: User, id: string, input: Input): MonthlyPlan {
    actor = assertBusinessActor(this.store, actor)
    return this.store.transaction(() => {
      const before = this.need<MonthlyPlan>('plans', id)
      this.editable(actor, before)
      this.current<MonthlyPlan>('plans', id, input)
      if (!['draft', 'returned'].includes(before.status)) throw new HttpError(400, '只有草稿或退回的计划可以提交')
      if (before.projectId) this.activeProject(before.projectId)
      if (before.isTemporary) text(before.temporaryReason, '临时目标原因')
      const plan = this.store.update<MonthlyPlan>('plans', id, before.version, { status: 'submitted', reviewComment: '' })
      this.audit(actor, 'plan', id, 'submit', before, plan)
      return projectPlan(actor, plan, this.store)
    })
  }
  review(actor: User, id: string, input: Input): MonthlyPlan {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    return this.store.transaction(() => {
      const before = this.current<MonthlyPlan>('plans', id, input)
      if (before.status !== 'submitted') throw new HttpError(400, '只有已提交的月计划可以审核')
      const decision = choice(input.decision, ['approve', 'return'], '审核决定')
      const comment = text(input.comment, '退回原因', decision === 'return')
      const plan = this.store.update<MonthlyPlan>('plans', id, before.version, { status: decision === 'approve' ? 'approved' : 'returned', reviewComment: comment })
      this.audit(actor, 'plan', id, decision, before, plan, comment)
      return plan
    })
  }
  publish(actor: User, periodInput: string, input: Input): Publication {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    const period = month(periodInput)
    if (!Array.isArray(input.planIds) || !input.planIds.length || input.planIds.length > 1000 || input.planIds.some(id => typeof id !== 'string')) throw new HttpError(400, '请选择待发布月计划')
    const ids = [...new Set(input.planIds as string[])]
    const reason = text(input.reason, '发布原因', false) || '部门月计划发布'
    return this.store.transaction(() => {
      const plans = ids.map(id => this.need<MonthlyPlan>('plans', id))
      for (const plan of plans) {
        if (plan.month !== period || plan.status !== 'approved') throw new HttpError(409, '只能发布所属月份内已审核通过的计划，请刷新后重试')
        if (plan.projectId) this.activeProject(plan.projectId)
      }
      const revision = this.revision(period)
      for (const before of plans) {
        const after = this.store.update<MonthlyPlan>('plans', before.id, before.version, { status: 'published', publishedVersion: revision })
        this.audit(actor, 'plan', before.id, 'publish', before, after, reason)
      }
      notifyPublishedPlans(this.store, plans.map(plan => this.need<MonthlyPlan>('plans', plan.id)), period, revision)
      return this.snapshot(actor, period, revision, reason)
    })
  }
  merge(actor: User, input: Input): MonthlyPlan {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    if (!Array.isArray(input.planIds) || input.planIds.some(id => typeof id !== 'string')) throw new HttpError(400, '请选择需要合并的提报')
    const ids = [...new Set(input.planIds as string[])]
    if (ids.length < 2 || ids.length > 50) throw new HttpError(400, '请选择 2 至 50 条提报进行合并')
    const title = text(input.title, '合并后的标题', true, LIMITS.title)
    const reason = text(input.reason, '合并原因')
    return this.store.transaction(() => {
      const sources = ids.map(id => this.need<MonthlyPlan>('plans', id))
      const first = sources[0]
      for (const source of sources) {
        if (!['submitted', 'approved'].includes(source.status)) throw new HttpError(409, '只可合并尚未发布的已提交或审核通过提报')
        const sameScope = first.projectId ? source.projectId === first.projectId : source.projectId === null && source.category === first.category
        if (source.month !== first.month || !sameScope) throw new HttpError(400, '只可合并同月同项目的提报；没有项目时须属于同一工作类别')
      }
      if (first.projectId) this.activeProject(first.projectId)
      if (this.store.list<Task>('tasks').some(task => task.monthlyPlanId && ids.includes(task.monthlyPlanId))) throw new HttpError(400, '所选提报已有关联个人任务，不能直接合并')
      const links = [...new Set(sources.map(source => source.annualGoalId ?? null))]
      if (links.length > 1 && input.annualGoalId === undefined) throw new HttpError(400, '所选目标关联不同年度目标，请明确选择合并后的年度关联或清空')
      const annualGoalId = input.annualGoalId !== undefined ? this.annualLink(input.annualGoalId, first.month) : links[0]
      const responsibilities = (field: 'expectedOutcome' | 'acceptanceCriteria') => sources.map(source => {
        const owner = this.need<User>('users', source.ownerId)
        return `${owner.name}（${source.title}）：${source[field]}`
      }).join('\n\n')
      const combined: Omit<MonthlyPlan, 'id' | 'version' | 'createdAt' | 'updatedAt'> = {
        annualGoalId, month: first.month, title, projectId: first.projectId, category: first.category, ownerId: first.ownerId,
        collaboratorIds: [...new Set(sources.flatMap(source => [source.ownerId, ...source.collaboratorIds]))].filter(id => id !== first.ownerId),
        expectedOutcome: responsibilities('expectedOutcome'), acceptanceCriteria: responsibilities('acceptanceCriteria'),
        dueDate: sources.map(source => source.dueDate).sort().at(-1)!, priority: sources.some(source => source.priority === 'high') ? 'high' : sources.some(source => source.priority === 'medium') ? 'medium' : 'low',
        status: 'approved', reviewComment: reason, publishedVersion: null, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', mergedFromIds: ids,
      }
      // Keep combined fields editable by the normal API and within the same text limits.
      text(combined.expectedOutcome, '合并后的成果描述')
      text(combined.acceptanceCriteria, '合并后的验收标准')
      const target = this.store.insert<MonthlyPlan>('plans', combined)
      this.audit(actor, 'plan', target.id, 'merge_create', sources, target, reason)
      for (const source of sources) {
        const after = this.store.update<MonthlyPlan>('plans', source.id, source.version, { status: 'merged', mergedIntoId: target.id })
        this.audit(actor, 'plan', source.id, 'merge', source, after, reason)
      }
      return target
    })
  }
  result(actor: User, id: string, input: Input): MonthlyPlan {
    actor = assertBusinessActor(this.store, actor)
    return this.store.transaction(() => {
      const before = this.need<MonthlyPlan>('plans', id)
      own(actor, before.ownerId)
      this.current<MonthlyPlan>('plans', id, input)
      if (before.status !== 'published') throw new HttpError(400, '只有已发布计划可以提交或确认月度成果')
      const status = choice(input.acceptanceStatus, ['submitted', 'accepted', 'not_completed'], '验收状态')
      if (!isManager(actor) && (status !== 'submitted' || before.acceptanceStatus === 'accepted')) throw new HttpError(403, '月度成果需由管理者确认，已验收成果需由管理者修改')
      const actualOutcome = text(input.actualOutcome, '实际成果', status !== 'not_completed')
      let acceptanceNote: string
      try { acceptanceNote = text(input.acceptanceNote, status === 'not_completed' ? '未完成原因' : '验收说明', status === 'not_completed') }
      catch (error) {
        if (error instanceof HttpError && error.status === 400) throw new HttpError(400, error.message, undefined, { acceptanceNote: error.message })
        throw error
      }
      const plan = this.store.update<MonthlyPlan>('plans', id, before.version, { actualOutcome, acceptanceStatus: status, acceptanceNote })
      this.audit(actor, 'plan', id, 'result', before, plan, acceptanceNote)
      return projectPlan(actor, plan, this.store)
    })
  }
  history(actor: User, id: string): AuditEvent[] {
    actor = assertBusinessActor(this.store, actor)
    this.visible(actor, this.need<MonthlyPlan>('plans', id))
    return visiblePlanHistory(actor, id, this.store.entityEvents('plan', id), this.store)
  }
  carry(actor: User, id: string, input: Input): MonthlyPlan {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    return this.store.transaction(() => {
      const currentActor = this.store.get<User>('users', actor.id)
      if (!currentActor || !canUseAccount(currentActor)) throw new HttpError(403, '此操作需要有效管理者权限')
      manager(currentActor)
      const requestId = text(input.requestId, '提交标识', true, 100)
      if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw new HttpError(400, '提交标识须为 16 至 100 位字母、数字、短横线或下划线')
      if (!Number.isSafeInteger(input.sourceVersion) || Number(input.sourceVersion) < 1) throw new HttpError(400, '请提供有效的来源版本', undefined, { sourceVersion: '请重新打开承接表单以取得来源版本' })
      const payload = { sourcePlanId: text(id, '来源计划'), sourceVersion: Number(input.sourceVersion), month: month(input.month), dueDate: date(input.dueDate, '截止日期'), reason: text(input.reason, '跨月承接原因') }
      const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex')
      const key = createHash('sha256').update(JSON.stringify(['monthly-carry', currentActor.id, requestId])).digest('hex')
      assertOperationEpoch(this.store, input.operationEpoch)
      const receipt = this.store.get<MonthlyCarryReceipt>('monthlyCarryRequests', key)
      if (receipt) {
        if (receipt.actorId !== currentActor.id || receipt.payloadHash !== payloadHash) throw new HttpError(409, '此提交标识已用于不同承接内容，请核对原结果后重新发起', 'IDEMPOTENCY_MISMATCH')
        const target = this.store.get<MonthlyPlan>('plans', receipt.targetPlanId)
        if (!target) throw new HttpError(409, '原承接目标已不存在，请核对历史记录后重新处理', 'CARRY_TARGET_MISSING')
        this.visible(currentActor, target)
        return projectPlan(currentActor, target, this.store)
      }
      const source = this.need<MonthlyPlan>('plans', payload.sourcePlanId)
      if (source.version !== payload.sourceVersion) throw new HttpError(409, '来源目标已更新，请重新核对后发起承接', 'SOURCE_VERSION_CONFLICT')
      own(currentActor, source.ownerId)
      if (source.status === 'merged') throw new HttpError(400, '请从合并后的月计划发起跨月承接')
      if (payload.month <= source.month) throw new HttpError(400, '承接月份必须晚于来源月份')
      if (source.acceptanceStatus === 'accepted') throw new HttpError(400, '已验收成果不能作为未完成事项承接')
      const plan = this.createDraft(currentActor, {
        ...(source.annualGoalId !== undefined ? { annualGoalId: payload.month.slice(0, 4) === source.month.slice(0, 4) ? source.annualGoalId : null } : {}),
        month: payload.month, dueDate: payload.dueDate, title: source.title, projectId: source.projectId, category: source.category,
        ownerId: source.ownerId, collaboratorIds: source.collaboratorIds, expectedOutcome: source.expectedOutcome,
        acceptanceCriteria: source.acceptanceCriteria, priority: source.priority, isTemporary: source.isTemporary,
        temporaryReason: source.temporaryReason, workSource: source.workSource, assignedBy: source.assignedBy, assignedOn: source.assignedOn,
      }, source.id)
      this.audit(currentActor, 'plan', plan.id, 'carry', source, plan, payload.reason)
      this.store.insert<MonthlyCarryReceipt>('monthlyCarryRequests', { id: key, actorId: currentActor.id, requestId, sourcePlanId: source.id, sourceVersion: source.version, payloadHash, targetPlanId: plan.id })
      return plan
    })
  }
}
