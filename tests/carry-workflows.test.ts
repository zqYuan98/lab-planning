import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { CarryWorkflowService } from '../server/carry-workflows.ts'
import { getOperationEpoch, rotateOperationEpoch } from '../server/operation-context.ts'
import type { AuditEvent, Entity, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { WeeklySubmission } from '../shared/weekly-submissions.ts'
import type { CarryApplyPreview, CarryWorkflowView } from '../shared/carry-workflows.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), service = new CarryWorkflowService(store)
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id, name: id, role, email: `${id}@carry.test`, active: true, position: '' })
  const manager = user('manager', 'manager'), second = user('second', 'manager'), member = user('member', 'member'), observer = user('observer', 'observer')
  const source = domain.createPlan(manager, { month: '2026-09', title: '长期研究', ownerId: member.id, category: '算法研究', expectedOutcome: '研究报告', acceptanceCriteria: '专家评审', dueDate: '2026-09-30' })
  const epoch = getOperationEpoch(store)
  const command = (extra: Record<string, unknown> = {}) => ({ operationEpoch: epoch, requestId: randomUUID(), ...extra })
  const startInput = (extra: Record<string, unknown> = {}) => command({ sourcePlanId: source.id, sourceVersion: source.version, targetMonth: '2026-10', dueDate: '2026-10-31', remainingWork: '完成余下实验', reason: '后续研究跨期', ...extra })
  const task = (extra: Record<string, unknown> = {}) => domain.createTask(manager, { title: '持续执行任务', ownerId: member.id, monthlyPlanId: source.id, dueDate: '2026-10-20', ...extra })
  const publish = (view: CarryWorkflowView) => {
    let plan = store.get<MonthlyPlan>('plans', view.target.id)!
    plan = domain.submitPlan(manager, plan.id, { version: plan.version })
    plan = domain.reviewPlan(manager, plan.id, { version: plan.version, decision: 'approve' })
    domain.publishMonth(manager, plan.month, { planIds: [plan.id] })
    return service.detail(manager, view.workflow.id)
  }
  const ready = () => publish(service.create(manager, startInput()))
  const selection = (tasks: Task[], extra: Record<string, unknown> = {}) => ({ selectedTaskIds: tasks.map(task => task.id), targetWeek: '2026-10-05', commitments: Object.fromEntries(tasks.map(task => [task.id, '继续验证'])), ...extra })
  const applyInput = (preview: CarryApplyPreview, extra: Record<string, unknown> = {}) => command({ ...preview.selection, workflowVersion: preview.view.workflow.version, manifest: preview.manifest, fingerprint: preview.fingerprint, reason: '核对后关联与排周', ...extra })
  const provisional = (task: Task, extra: Partial<WeeklyRecord> = {}) => store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, monthlyPlanId: source.id, ownerId: task.ownerId, weekStart: '2026-10-05', commitment: '原周承诺', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'planned', submitted: false, ...extra })
  const snapshot = () => ['plans', 'tasks', 'weeklyRecords', 'events', 'carryWorkflows', 'carryWorkflowRequests', 'monthlyCarryRequests', 'publications', 'notifications', 'notificationDeliveries', 'weeklySubmissions', 'reports'].map(key => store.list(key))
  t.after(() => store.close())
  return { store, domain, service, manager, second, member, observer, source, epoch, command, startInput, task, publish, ready, selection, applyInput, provisional, snapshot }
}

test('source preview is pure, includes all candidate versions, and manager authorization is always current', t => {
  const f = fixture(t), task = f.task(), record = f.provisional(task), before = f.snapshot()
  const result = f.service.preview(f.manager, { sourcePlanId: f.source.id, targetMonth: '2026-10' })
  assert.deepEqual(f.snapshot(), before); assert.equal(result.taskManifest[0].id, task.id); assert.equal(result.recordManifest[0].id, record.id)
  for (const actor of [f.member, f.observer]) {
    assert.throws(() => f.service.preview(actor, { sourcePlanId: f.source.id, targetMonth: '2026-10' }), { status: 403 })
    assert.throws(() => f.service.list(actor), { status: 403 })
    assert.throws(() => f.service.create(actor, f.startInput()), { status: 403 })
  }
  f.store.update<User>('users', f.manager.id, f.manager.version, { role: 'member' })
  assert.throws(() => f.service.preview(f.manager, { sourcePlanId: f.source.id, targetMonth: '2026-10' }), { status: 403 })
})

test('create is atomic and canonical-idempotent; existing target requires exact source/month, split is explicit', t => {
  const f = fixture(t), input = f.startInput(), first = f.service.create(f.manager, input), before = f.snapshot()
  assert.equal(f.service.create(f.manager, { ...input, remainingWork: '  完成余下实验  ' }).workflow.id, first.workflow.id)
  assert.deepEqual(f.snapshot(), before)
  assert.throws(() => f.service.create(f.manager, { ...input, reason: '其他内容' }), { code: 'IDEMPOTENCY_MISMATCH' })
  assert.throws(() => f.service.create(f.manager, f.startInput()), { status: 409 })
  const reference = f.service.create(f.second, f.startInput({ targetPlanId: first.target.id }))
  assert.equal(reference.target.id, first.target.id); assert.equal(f.store.list('plans').length, 2)
  assert.throws(() => f.service.create(f.manager, f.startInput({ targetPlanId: first.target.id, targetMonth: '2026-11' })), { status: 409 })
  const split = f.service.create(f.manager, f.startInput({ split: true }))
  assert.notEqual(split.target.id, first.target.id)
})

test('waiting status is derived from real publication; approved or returned cannot apply', t => {
  const f = fixture(t), task = f.task(), created = f.service.create(f.manager, f.startInput())
  let target = f.domain.submitPlan(f.manager, created.target.id, { version: created.target.version })
  target = f.domain.reviewPlan(f.manager, target.id, { version: target.version, decision: 'return', comment: '补充验收范围' })
  assert.equal(f.service.detail(f.second, created.workflow.id).target.reviewComment, '补充验收范围')
  assert.throws(() => f.service.previewApply(f.manager, created.workflow.id, f.selection([task])), { status: 409 })
  target = f.domain.submitPlan(f.manager, target.id, { version: target.version })
  target = f.domain.reviewPlan(f.manager, target.id, { version: target.version, decision: 'approve' })
  assert.equal(f.service.detail(f.manager, created.workflow.id).workflow.status, 'awaiting_publication')
  assert.throws(() => f.service.previewApply(f.manager, created.workflow.id, f.selection([task])), { status: 409 })
  f.domain.publishMonth(f.manager, target.month, { planIds: [target.id] })
  assert.equal(f.service.detail(f.manager, created.workflow.id).workflow.status, 'ready')
  assert.equal(f.service.list(f.second, { sourcePlanId: f.source.id })[0].workflow.actorId, f.manager.id)
})

test('selection survives another manager resuming; apply keeps original task identity and creator, receipts name current operator', t => {
  const f = fixture(t), task = f.task(), ready = f.ready()
  const selected = f.service.saveSelection(f.second, ready.workflow.id, f.command({ workflowVersion: ready.workflow.version, ...f.selection([task]) }))
  assert.deepEqual(f.service.detail(f.manager, ready.workflow.id).workflow.selectedTaskIds, [task.id])
  const preview = f.service.previewApply(f.second, selected.workflow.id, f.selection([task])), input = f.applyInput(preview)
  const result = f.service.apply(f.second, ready.workflow.id, input), after = f.snapshot()
  assert.equal(result.workflow.status, 'completed'); assert.equal(result.workflow.actorId, f.manager.id)
  assert.equal(result.workflow.stepReceipts.at(-1)!.actorId, f.second.id)
  assert.equal(f.store.list<Task>('tasks').length, 1); assert.equal(f.store.get<Task>('tasks', task.id)!.monthlyPlanId, ready.target.id)
  assert.equal(result.workflow.result!.createdRecordIds.length, 1)
  assert.equal(f.service.apply(f.second, ready.workflow.id, input).workflow.status, 'completed'); assert.deepEqual(f.snapshot(), after)
  f.store.update<User>('users', f.second.id, f.second.version, { active: false })
  assert.throws(() => f.service.apply(f.second, ready.workflow.id, input), { status: 403 })
})

test('relink moves only never-submitted active drafts; frozen receipts and withdrawn audit remain historical; cross-month weeks intersect', t => {
  const f = fixture(t), task = f.task(), ready = f.ready()
  const crossing = f.provisional(task, { weekStart: '2026-09-28' })
  const oldMonth = f.provisional(task, { weekStart: '2026-09-21' })
  const withdrawnAudit = f.provisional(task, { weekStart: '2026-10-12' })
  f.store.insert<AuditEvent>('events', { entityType: 'weeklyRecord', entityId: withdrawnAudit.id, actorId: f.member.id, action: 'update', reason: '', before: { ...withdrawnAudit, submitted: true }, after: withdrawnAudit })
  const withdrawnFrozen = f.provisional(task, { weekStart: '2026-10-19' })
  f.store.insert<WeeklySubmission>('weeklySubmissions', { dutyId: 'duty', ownerId: f.member.id, cycleWeek: '2026-10-12', kind: 'plan', submittedAt: '2026-10-16T00:00:00Z', actorId: f.member.id, reason: '', note: '', requestId: 'receipt', records: [{ ...withdrawnFrozen, submitted: true }], retainedDraftIds: [], retainedDraftManifest: [] })
  const deleted = f.provisional(task, { weekStart: '2026-10-26', deletion: { deletedAt: '2026-10-01T00:00:00Z', deletedBy: f.manager.id, reason: '删除' } })
  const oldPublication = f.store.list('publications'), original = f.store.get('plans', f.source.id), frozen = f.store.list('weeklySubmissions')
  const preview = f.service.previewApply(f.manager, ready.workflow.id, f.selection([task], { targetWeek: '2026-09-30' }))
  assert.equal(preview.selection.targetWeek, '2026-09-28'); assert.deepEqual(preview.impacts[0].relinkDrafts.map(row => row.id), [crossing.id])
  const result = f.service.apply(f.manager, ready.workflow.id, f.applyInput(preview))
  assert.deepEqual(result.workflow.result!.reusedRecordIds, [crossing.id]); assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', crossing.id)!.commitment, '原周承诺')
  for (const row of [oldMonth, withdrawnAudit, withdrawnFrozen, deleted]) assert.deepEqual(f.store.get('weeklyRecords', row.id), row)
  assert.deepEqual(f.store.get('plans', f.source.id), original); assert.deepEqual(f.store.list('publications'), oldPublication); assert.deepEqual(f.store.list('weeklySubmissions'), frozen)
})

test('existing target-week arrangement is reused without changing its commitment; conflicting historical ownership is rejected', t => {
  const f = fixture(t), task = f.task(), ready = f.ready(), existing = f.provisional(task, { monthlyPlanId: ready.target.id, submitted: true })
  const preview = f.service.previewApply(f.manager, ready.workflow.id, f.selection([task]))
  assert.equal(preview.impacts[0].commitment, existing.commitment)
  f.service.apply(f.manager, ready.workflow.id, f.applyInput(preview))
  assert.deepEqual(f.store.get('weeklyRecords', existing.id), existing)
  const second = f.task(), workflow = f.service.create(f.manager, f.startInput({ targetPlanId: ready.target.id }))
  f.provisional(second, { submitted: true })
  assert.throws(() => f.service.previewApply(f.manager, workflow.workflow.id, f.selection([second])), { code: 'TARGET_WEEK_CONFLICT' })
})

test('all manifest membership and version changes, including frozen submission set, demand a fresh preview', t => {
  const f = fixture(t), task = f.task(), ready = f.ready(), draft = f.provisional(task)
  const cases: (() => void)[] = [
    () => { f.provisional(task, { weekStart: '2026-10-12' }) },
    () => { const row = f.store.get<WeeklyRecord>('weeklyRecords', draft.id)!; f.store.update<WeeklyRecord>('weeklyRecords', row.id, row.version, { nextAction: '新进展' }) },
    () => { f.task({ title: '新增来源任务' }) },
    () => { f.store.insert<WeeklySubmission>('weeklySubmissions', { dutyId: 'late', ownerId: f.member.id, cycleWeek: '2026-10-12', kind: 'plan', submittedAt: '2026-10-16T00:00:00Z', actorId: f.member.id, reason: '', note: '', requestId: 'late', records: [{ ...draft, id: 'historical-missing-id' }], retainedDraftIds: [], retainedDraftManifest: [] }) },
    () => { const rows = f.store.list<WeeklyRecord>('weeklyRecords'); const row = rows.find(row => row.id !== draft.id)!; f.store.delete('weeklyRecords', row.id, row.version) },
  ]
  for (const change of cases) {
    const preview = f.service.previewApply(f.manager, ready.workflow.id, f.selection([task])); change(); const before = f.snapshot()
    assert.throws(() => f.service.apply(f.manager, ready.workflow.id, f.applyInput(preview)), { code: 'CARRY_PREVIEW_CHANGED' })
    assert.deepEqual(f.snapshot(), before)
  }
})

test('apply rolls back prior task, record, audit and receipt writes when a later task fails', t => {
  const f = fixture(t), first = f.task({ title: '第一项' }), second = f.task({ title: '第二项' }), ready = f.ready()
  const preview = f.service.previewApply(f.manager, ready.workflow.id, f.selection([first, second])), before = f.snapshot()
  const original = f.store.insert.bind(f.store)
  let records = 0
  f.store.insert = ((collection: string, value: Omit<Entity, keyof Entity> & Partial<Entity>) => {
    if (collection === 'weeklyRecords' && ++records === 2) throw new Error('injected second record failure')
    return original<Entity>(collection, value)
  }) as typeof f.store.insert
  assert.throws(() => f.service.apply(f.manager, ready.workflow.id, f.applyInput(preview)), /injected second record failure/)
  assert.deepEqual(f.snapshot(), before)
})

test('cancel retains created target; replay returns current authorized state; old epoch blocks reads and commands', t => {
  const f = fixture(t), input = f.startInput(), created = f.service.create(f.manager, input)
  const cancel = f.command({ workflowVersion: created.workflow.version, reason: '暂停后续处理' })
  const result = f.service.cancel(f.second, created.workflow.id, cancel)
  assert.equal(result.workflow.status, 'cancelled'); assert.deepEqual(f.store.get('plans', created.target.id), created.target)
  assert.equal(f.service.create(f.manager, input).workflow.status, 'cancelled')
  assert.equal(f.service.cancel(f.second, created.workflow.id, cancel).workflow.status, 'cancelled')
  rotateOperationEpoch(f.store)
  assert.throws(() => f.service.detail(f.manager, created.workflow.id), { code: 'OPERATION_CONTEXT_CHANGED' })
  assert.throws(() => f.service.create(f.manager, input), { code: 'OPERATION_CONTEXT_CHANGED' })
  assert.deepEqual(f.service.list(f.manager), [])
  assert.throws(() => f.service.cancel(f.manager, created.workflow.id, { ...cancel, operationEpoch: getOperationEpoch(f.store) }), { code: 'OPERATION_CONTEXT_CHANGED' })
})

test('source changes are displayed, cancelled/done tasks cannot be selected and wrong-week schedules are rejected', t => {
  const f = fixture(t), task = f.task(), ready = f.ready()
  f.store.update<MonthlyPlan>('plans', f.source.id, f.source.version, { actualOutcome: '已有部分结果' })
  const view = f.service.detail(f.manager, ready.workflow.id)
  assert.equal(view.sourceChanged, true); assert.ok(view.sourceChanges.includes('actualOutcome'))
  assert.throws(() => f.service.previewApply(f.manager, ready.workflow.id, f.selection([task], { targetWeek: '2026-11-09' })), { status: 400 })
  f.store.update<Task>('tasks', task.id, task.version, { status: 'done' })
  assert.throws(() => f.service.previewApply(f.manager, ready.workflow.id, f.selection([task])), { status: 409 })
  const cancelled = f.task(); f.domain.cancelTask(f.manager, cancelled.id, { version: cancelled.version, reason: '重复工作' })
  assert.throws(() => f.service.previewApply(f.manager, ready.workflow.id, f.selection([cancelled])), { status: 409 })
})

test('failure storing a newly created workflow rolls its target, monthly receipt and audits back', t => {
  const f = fixture(t), before = f.snapshot(), original = f.store.insert.bind(f.store)
  f.store.insert = ((collection: string, value: Partial<Entity>) => {
    if (collection === 'carryWorkflows') throw new Error('injected workflow storage failure')
    return original<Entity>(collection, value)
  }) as typeof f.store.insert
  assert.throws(() => f.service.create(f.manager, f.startInput()), /injected workflow storage failure/)
  assert.deepEqual(f.snapshot(), before)
})

test('new audit evidence, target changes and frozen receipt edits/deletion invalidate a prior manifest', t => {
  const f = fixture(t), task = f.task(), ready = f.ready(), draft = f.provisional(task, { weekStart: '2026-10-12' })
  let receipt: WeeklySubmission
  const mutations = [
    () => { f.store.insert<AuditEvent>('events', { entityType: 'weeklyRecord', entityId: draft.id, actorId: f.member.id, action: 'submit', reason: '', before: null, after: { ...draft, submitted: true } }) },
    () => { const plan = f.store.get<MonthlyPlan>('plans', ready.target.id)!; f.store.update<MonthlyPlan>('plans', plan.id, plan.version, { expectedOutcome: '补充验证' }) },
    () => { receipt = f.store.insert<WeeklySubmission>('weeklySubmissions', { dutyId: 'historic', ownerId: f.member.id, cycleWeek: '2026-10-05', kind: 'plan', submittedAt: '2026-10-09T00:00:00Z', actorId: f.member.id, reason: '', note: '', requestId: 'historic', records: [{ ...draft, submitted: true }], retainedDraftIds: [], retainedDraftManifest: [] }) },
    () => { receipt = f.store.update<WeeklySubmission>('weeklySubmissions', receipt.id, receipt.version, { note: '补充说明' }) },
    () => { f.store.delete('weeklySubmissions', receipt.id, receipt.version) },
  ]
  for (const mutate of mutations) {
    const preview = f.service.previewApply(f.manager, ready.workflow.id, f.selection([task])); mutate()
    assert.throws(() => f.service.apply(f.manager, ready.workflow.id, f.applyInput(preview)), { code: 'CARRY_PREVIEW_CHANGED' })
    assert.equal(f.store.get<Task>('tasks', task.id)!.monthlyPlanId, f.source.id)
  }
})

test('direct task relink also preserves a withdrawn frozen submission after its audit records were absent', t => {
  const f = fixture(t), task = f.task(), ready = f.ready(), draft = f.provisional(task)
  f.store.insert<WeeklySubmission>('weeklySubmissions', { dutyId: 'historic', ownerId: f.member.id, cycleWeek: '2026-09-28', kind: 'plan', submittedAt: '2026-10-02T00:00:00Z', actorId: f.member.id, reason: '', note: '', requestId: 'historic', records: [{ ...draft, submitted: true }], retainedDraftIds: [], retainedDraftManifest: [] })
  f.domain.relinkTask(f.manager, task.id, { version: task.version, monthlyPlanId: ready.target.id, reason: '新月份继续执行' })
  assert.deepEqual(f.store.get('weeklyRecords', draft.id), draft)
})

test('source accepted or merged during waiting cannot resume; newly introduced optional fields appear in the source diff', t => {
  const f = fixture(t), task = f.task(), ready = f.ready(), preview = f.service.previewApply(f.manager, ready.workflow.id, f.selection([task]))
  let source = f.store.update<MonthlyPlan>('plans', f.source.id, f.source.version, { assignedBy: '新交办人', acceptanceStatus: 'accepted' })
  const view = f.service.detail(f.manager, ready.workflow.id)
  assert.ok(view.sourceChanges.includes('assignedBy')); assert.equal(view.canApply, false); assert.ok(view.blockedReason)
  assert.throws(() => f.service.apply(f.manager, ready.workflow.id, f.applyInput(preview)), { status: 409 })
  source = f.store.update<MonthlyPlan>('plans', source.id, source.version, { acceptanceStatus: 'pending', status: 'merged' })
  assert.equal(f.service.detail(f.manager, ready.workflow.id).canApply, false)
  assert.throws(() => f.service.previewApply(f.manager, ready.workflow.id, f.selection([task])), { status: 409 })
  assert.equal(f.store.get<Task>('tasks', task.id)!.monthlyPlanId, source.id)
})
