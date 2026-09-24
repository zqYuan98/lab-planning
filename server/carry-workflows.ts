import { createHash } from 'node:crypto'
import type { Entity, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { CarryApplyPreview, CarryManifest, CarryManifestEntry, CarryPreview, CarrySelection, CarryWorkflow, CarryWorkflowView } from '../shared/carry-workflows.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { isActiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { DomainBase, date, manager, monday, month, participates, text, type Input } from './domain-common.ts'
import { assertBusinessActor } from './object-access.ts'
import { assertOperationEpoch, getOperationEpoch } from './operation-context.ts'
import { MonthlyService } from './domain-plans.ts'
import { WorkService } from './domain-work.ts'
import { HttpError, type Store } from './store.ts'
import { submittedWeeklyEvidence, weekOverlapsMonth } from './carry-workflows-history.ts'

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical((value as Input)[key])])) : value
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value)) ?? 'undefined').digest('hex')
const entry = (row: Entity): CarryManifestEntry => ({ id: row.id, version: row.version, hash: fingerprint(row) })
const entries = (rows: Entity[]) => rows.map(entry).sort((a, b) => a.id.localeCompare(b.id))
interface Receipt extends Entity { operationEpoch: string; actorId: string; requestId: string; payloadHash: string; workflowId: string }
const version = (value: unknown) => {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new HttpError(400, '请提供有效的数据版本')
  return Number(value)
}

/** Short synchronous transactions: publication remains in the normal monthly workflow. */
export class CarryWorkflowService extends DomainBase {
  constructor(store: Store) { super(store) }
  private actor(actor: User) { const current = assertBusinessActor(this.store, actor); manager(current); return current }
  private source(id: unknown, targetMonth: string) {
    const source = this.need<MonthlyPlan>('plans', text(id, '来源目标'))
    if (source.status === 'merged' || source.visibility) throw new HttpError(400, '请从有效月度目标发起跨期处理')
    if (source.acceptanceStatus === 'accepted') throw new HttpError(400, '已验收成果不能作为未完成事项承接')
    if (targetMonth <= source.month) throw new HttpError(400, '承接月份必须晚于来源月份')
    return source
  }
  preview(actor: User, input: Input): CarryPreview {
    this.actor(actor)
    return this.store.transaction(() => {
      const targetMonth = month(input.targetMonth), source = this.source(input.sourcePlanId, targetMonth)
      const tasks = this.store.list<Task>('tasks').filter(task => task.monthlyPlanId === source.id)
      const taskIds = new Set(tasks.map(task => task.id))
      const records = this.store.list<WeeklyRecord>('weeklyRecords').filter(row => taskIds.has(row.taskId))
      const history = submittedWeeklyEvidence(this.store)
      return { source, targetMonth, candidates: this.store.list<MonthlyPlan>('plans').filter(plan => plan.sourcePlanId === source.id && plan.month === targetMonth && plan.status !== 'merged' && !plan.visibility),
        tasks, records, taskManifest: entries(tasks), recordManifest: entries(records), previouslySubmittedIds: records.filter(row => row.submitted || history.ids.has(row.id)).map(row => row.id).sort() }
    })
  }
  private request(actor: User, input: Input, payload: unknown) {
    assertOperationEpoch(this.store, input.operationEpoch)
    const requestId = text(input.requestId, '提交标识', true, 100)
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(requestId)) throw new HttpError(400, '提交标识格式不正确')
    const epoch = getOperationEpoch(this.store), key = fingerprint([epoch, actor.id, requestId]), payloadHash = fingerprint(payload)
    const receipt = this.store.get<Receipt>('carryWorkflowRequests', key)
    if (receipt && (receipt.payloadHash !== payloadHash || receipt.actorId !== actor.id || receipt.operationEpoch !== epoch)) {
      throw new HttpError(409, '此提交标识已用于其他内容，请核对原结果', 'IDEMPOTENCY_MISMATCH')
    }
    return { key, requestId, epoch, payloadHash, receipt }
  }
  create(actor: User, input: Input): CarryWorkflowView {
    actor = this.actor(actor)
    const payload = { action: 'create', sourcePlanId: text(input.sourcePlanId, '来源目标'), sourceVersion: version(input.sourceVersion), targetMonth: month(input.targetMonth),
      targetPlanId: input.targetPlanId ? text(input.targetPlanId, '承接目标') : null, dueDate: input.targetPlanId ? '' : date(input.dueDate, '承接截止日期'),
      remainingWork: text(input.remainingWork, '剩余工作'), reason: text(input.reason, '承接原因'), split: input.split === true }
    return this.store.transaction(() => {
      const request = this.request(actor, input, payload)
      if (request.receipt) return this.detail(actor, request.receipt.workflowId)
      const source = this.source(payload.sourcePlanId, payload.targetMonth)
      if (source.version !== payload.sourceVersion) throw new HttpError(409, '来源目标已更新，请重新核对', 'SOURCE_VERSION_CONFLICT')
      let target: MonthlyPlan
      if (payload.targetPlanId) {
        target = this.need<MonthlyPlan>('plans', payload.targetPlanId)
        if (target.sourcePlanId !== source.id || target.month !== payload.targetMonth || target.status === 'merged' || target.visibility) throw new HttpError(409, '承接目标的来源、月份或状态不符合当前流程')
      } else {
        if (!payload.split && this.store.list<MonthlyPlan>('plans').some(plan => plan.sourcePlanId === source.id && plan.month === payload.targetMonth && plan.status !== 'merged')) {
          throw new HttpError(409, '该月已有承接目标，请选择已有目标或明确拆分承接')
        }
        target = new MonthlyService(this.store).carry(actor, source.id, { requestId: `workflow_${request.key}`, sourceVersion: source.version,
          month: payload.targetMonth, dueDate: payload.dueDate, reason: payload.reason, operationEpoch: request.epoch })
      }
      const workflow = this.store.insert<CarryWorkflow>('carryWorkflows', { actorId: actor.id, operationEpoch: request.epoch,
        sourcePlanId: source.id, sourceVersionAtStart: source.version, sourceSnapshot: source, targetMonth: payload.targetMonth, targetPlanId: target.id,
        remainingWork: payload.remainingWork, selectedTaskIds: [], targetWeek: '', status: target.status === 'published' ? 'ready' : 'awaiting_publication',
        stepReceipts: [{ action: 'create', actorId: actor.id, requestId: request.requestId, at: new Date().toISOString() }] })
      this.store.insert<Receipt>('carryWorkflowRequests', { id: request.key, operationEpoch: request.epoch, actorId: actor.id, requestId: request.requestId, payloadHash: request.payloadHash, workflowId: workflow.id })
      this.audit(actor, 'carryWorkflow', workflow.id, 'create', null, workflow, payload.reason)
      return this.detail(actor, workflow.id)
    })
  }
  list(actor: User, input: Input = {}): CarryWorkflowView[] {
    actor = this.actor(actor)
    const sourceId = input.sourcePlanId === undefined ? undefined : text(input.sourcePlanId, '来源目标')
    return this.store.transaction(() => this.store.list<CarryWorkflow>('carryWorkflows')
      .filter(row => row.operationEpoch === getOperationEpoch(this.store) && (!sourceId || row.sourcePlanId === sourceId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(row => this.detail(actor, row.id)))
  }
  detail(actor: User, id: string): CarryWorkflowView {
    this.actor(actor)
    return this.store.transaction(() => {
      const workflow = this.need<CarryWorkflow>('carryWorkflows', id)
      assertOperationEpoch(this.store, workflow.operationEpoch)
      const source = this.need<MonthlyPlan>('plans', workflow.sourcePlanId), target = this.need<MonthlyPlan>('plans', workflow.targetPlanId)
      const allTasks = this.store.list<Task>('tasks'), tasks = allTasks.filter(task => task.monthlyPlanId === source.id || workflow.selectedTaskIds.includes(task.id))
      const taskIds = new Set(tasks.map(task => task.id)), records = this.store.list<WeeklyRecord>('weeklyRecords').filter(row => taskIds.has(row.taskId))
      const terminal = ['completed', 'cancelled'].includes(workflow.status)
      const targetValid = target.status === 'published' && !target.visibility && target.sourcePlanId === source.id && target.month === workflow.targetMonth
      const sourceValid = source.status !== 'merged' && !source.visibility && source.acceptanceStatus !== 'accepted' && workflow.targetMonth > source.month
      const status = terminal ? workflow.status : !sourceValid ? 'preparing' : targetValid ? 'ready' : 'awaiting_publication'
      const sourceChanges = [...new Set([...Object.keys(workflow.sourceSnapshot), ...Object.keys(source)])].filter(key => !['updatedAt', 'version'].includes(key)
        && fingerprint((workflow.sourceSnapshot as unknown as Input)[key]) !== fingerprint((source as unknown as Input)[key]))
      return { workflow: { ...workflow, status }, source, target, tasks, records, sourceChanged: source.version !== workflow.sourceVersionAtStart, sourceChanges, canApply: !terminal && sourceValid && targetValid,
        ...(!sourceValid && !terminal ? { blockedReason: '来源目标已验收、已合并或不再有效，请先核对来源；当前流程不能关联任务。' } : {}) }
    })
  }
  private selection(input: Input): CarrySelection {
    if (!Array.isArray(input.selectedTaskIds) || !input.selectedTaskIds.length || input.selectedTaskIds.length > 100 || input.selectedTaskIds.some(id => typeof id !== 'string')) throw new HttpError(400, '请选择 1 至 100 个持续执行任务')
    const selectedTaskIds = [...new Set(input.selectedTaskIds as string[])].sort(), targetWeek = monday(input.targetWeek)
    const requested = input.commitments && typeof input.commitments === 'object' && !Array.isArray(input.commitments) ? input.commitments as Input : {}
    return { selectedTaskIds, targetWeek, commitments: Object.fromEntries(selectedTaskIds.map(id => [id, text(requested[id], '本周承诺', false)])) }
  }
  previewApply(actor: User, id: string, input: Input): CarryApplyPreview {
    actor = this.actor(actor)
    return this.store.transaction(() => this.buildPreview(actor, id, this.selection(input)))
  }
  saveSelection(actor: User, id: string, input: Input): CarryWorkflowView {
    actor = this.actor(actor)
    const selection = this.selection(input), workflowVersion = version(input.workflowVersion)
    const payload = { action: 'selection', id, workflowVersion, selection }
    return this.store.transaction(() => {
      const request = this.request(actor, input, payload)
      if (request.receipt) return this.detail(actor, request.receipt.workflowId)
      const before = this.need<CarryWorkflow>('carryWorkflows', id)
      assertOperationEpoch(this.store, before.operationEpoch)
      if (before.version !== workflowVersion) throw new HttpError(409, '流程已更新，请重新读取', 'VERSION_CONFLICT')
      this.buildPreview(actor, id, selection)
      const after = this.store.update<CarryWorkflow>('carryWorkflows', id, before.version, { ...selection,
        stepReceipts: [...before.stepReceipts, { action: 'selection', actorId: actor.id, requestId: request.requestId, at: new Date().toISOString() }] })
      this.store.insert<Receipt>('carryWorkflowRequests', { id: request.key, operationEpoch: request.epoch, actorId: actor.id, requestId: request.requestId, payloadHash: request.payloadHash, workflowId: id })
      this.audit(actor, 'carryWorkflow', id, 'selection', before, after)
      return this.detail(actor, id)
    })
  }
  private buildPreview(actor: User, id: string, selection: CarrySelection): CarryApplyPreview {
    const view = this.detail(actor, id), { workflow, source, target } = view
    if (!view.canApply) throw new HttpError(409, view.blockedReason || '承接目标尚未正式发布，或流程已结束，不能关联任务')
    this.source(source.id, workflow.targetMonth)
    if (!weekOverlapsMonth(selection.targetWeek, target.month)) throw new HttpError(400, '目标周必须与承接月份相交')
    const history = submittedWeeklyEvidence(this.store), relatedIds = new Set(view.records.map(record => record.id)), taskIds = new Set(view.tasks.map(task => task.id))
    const submissionEvents = history.events.filter(event => relatedIds.has(event.entityId) || [event.before, event.after].some(snapshot => !!snapshot && typeof snapshot === 'object' && taskIds.has((snapshot as WeeklyRecord).taskId))), submissions = history.submissions.filter(submission => submission.records.some(row => taskIds.has(row.taskId) || relatedIds.has(row.id)))
    const manifest: CarryManifest = { workflow: entry(this.need<CarryWorkflow>('carryWorkflows', id)), source: entry(source), target: entry(target), tasks: entries(view.tasks), records: entries(view.records), submissionEvents: entries(submissionEvents), submissions: entries(submissions) }
    const impacts = selection.selectedTaskIds.map(taskId => {
      const task = view.tasks.find(row => row.id === taskId)
      if (!task || task.monthlyPlanId !== source.id || !isActiveTask(task) || task.status === 'done') throw new HttpError(409, '所选任务已变更归属、已完成或已作废，请重新选择')
      if (!participates(target, task.ownerId)) throw new HttpError(409, `承接目标未包含任务“${task.title}”的负责人`)
      const records = view.records.filter(row => row.taskId === task.id)
      const relinkDrafts = records.filter(row => isActiveWeeklyRecord(row) && !row.submitted && !history.ids.has(row.id) && row.monthlyPlanId !== target.id && weekOverlapsMonth(row.weekStart, target.month))
      const existing = records.filter(row => isActiveWeeklyRecord(row) && row.weekStart === selection.targetWeek)
      if (existing.length > 1) throw new HttpError(409, '目标周存在重复有效安排，请先核对')
      const existingTargetRecord = existing[0] ?? null
      if (existingTargetRecord && (existingTargetRecord.ownerId !== task.ownerId || existingTargetRecord.monthlyPlanId !== target.id && !relinkDrafts.some(row => row.id === existingTargetRecord.id))) {
        throw new HttpError(409, `任务“${task.title}”的目标周已有不同归属的历史安排，请选择其他周`, 'TARGET_WEEK_CONFLICT')
      }
      const commitment = existingTargetRecord?.commitment ?? text(selection.commitments[task.id] || workflow.remainingWork, '本周承诺')
      return { task, relinkDrafts, preservedRecords: records.filter(row => !relinkDrafts.some(draft => draft.id === row.id)), existingTargetRecord, commitment }
    })
    return { view, selection, manifest, fingerprint: fingerprint({ manifest, selection }), impacts }
  }
  apply(actor: User, id: string, input: Input): CarryWorkflowView {
    actor = this.actor(actor)
    const selection = this.selection(input), workflowVersion = version(input.workflowVersion), reason = text(input.reason, '关联与排周原因')
    const payload = { action: 'apply', id, workflowVersion, selection, manifest: input.manifest, fingerprint: text(input.fingerprint, '预览指纹'), reason }
    return this.store.transaction(() => {
      const request = this.request(actor, input, payload)
      if (request.receipt) return this.detail(actor, request.receipt.workflowId)
      const before = this.need<CarryWorkflow>('carryWorkflows', id)
      assertOperationEpoch(this.store, before.operationEpoch)
      if (before.version !== workflowVersion) throw new HttpError(409, '流程已更新，请重新预览', 'VERSION_CONFLICT')
      const preview = this.buildPreview(actor, id, selection)
      if (fingerprint(input.manifest) !== fingerprint(preview.manifest) || payload.fingerprint !== preview.fingerprint) throw new HttpError(409, '任务、周记录或历史提交清单已变化，请重新预览', 'CARRY_PREVIEW_CHANGED')
      const work = new WorkService(this.store)
      const result = { taskIds: [] as string[], relinkedDraftIds: [] as string[], createdRecordIds: [] as string[], reusedRecordIds: [] as string[] }
      for (const impact of preview.impacts) {
        work.relinkTask(actor, impact.task.id, { version: impact.task.version, monthlyPlanId: before.targetPlanId, reason })
        result.taskIds.push(impact.task.id); result.relinkedDraftIds.push(...impact.relinkDrafts.map(row => row.id))
        if (impact.existingTargetRecord) result.reusedRecordIds.push(impact.existingTargetRecord.id)
        else result.createdRecordIds.push(work.createWeeklyRecord(actor, { taskId: impact.task.id, weekStart: selection.targetWeek, commitment: impact.commitment,
          submitted: false, creationKind: actor.id === impact.task.ownerId ? 'self' : 'assigned', reason }).id)
      }
      const after = this.store.update<CarryWorkflow>('carryWorkflows', id, before.version, { selectedTaskIds: selection.selectedTaskIds, targetWeek: selection.targetWeek, status: 'completed', result,
        stepReceipts: [...before.stepReceipts, { action: 'apply', actorId: actor.id, requestId: request.requestId, at: new Date().toISOString() }] })
      this.store.insert<Receipt>('carryWorkflowRequests', { id: request.key, operationEpoch: request.epoch, actorId: actor.id, requestId: request.requestId, payloadHash: request.payloadHash, workflowId: id })
      this.audit(actor, 'carryWorkflow', id, 'apply', before, after, reason)
      return this.detail(actor, id)
    })
  }
  cancel(actor: User, id: string, input: Input): CarryWorkflowView {
    actor = this.actor(actor)
    const payload = { action: 'cancel', id, workflowVersion: version(input.workflowVersion), reason: text(input.reason, '取消原因') }
    return this.store.transaction(() => {
      const request = this.request(actor, input, payload)
      if (request.receipt) return this.detail(actor, request.receipt.workflowId)
      const before = this.need<CarryWorkflow>('carryWorkflows', id)
      assertOperationEpoch(this.store, before.operationEpoch)
      if (before.version !== payload.workflowVersion) throw new HttpError(409, '流程已更新，请刷新', 'VERSION_CONFLICT')
      if (['completed', 'cancelled'].includes(before.status)) throw new HttpError(409, '流程已经结束')
      const after = this.store.update<CarryWorkflow>('carryWorkflows', id, before.version, { status: 'cancelled', stepReceipts: [...before.stepReceipts, { action: 'cancel', actorId: actor.id, requestId: request.requestId, at: new Date().toISOString() }] })
      this.store.insert<Receipt>('carryWorkflowRequests', { id: request.key, operationEpoch: request.epoch, actorId: actor.id, requestId: request.requestId, payloadHash: request.payloadHash, workflowId: id })
      this.audit(actor, 'carryWorkflow', id, 'cancel', before, after, payload.reason)
      return this.detail(actor, id)
    })
  }
}
