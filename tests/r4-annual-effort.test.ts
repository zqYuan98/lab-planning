import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { annualGoalProgress } from '../shared/annual-goals.ts'
import { isEffortDays, summarizeEffort } from '../shared/effort.ts'
import { weeklyPlanFingerprint } from '../shared/weekly-record-state.ts'
import type { AnnualGoal, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { DirectoryWorkspaceService } from '../server/directory-workspace.ts'
import { PeriodWorkspaceService } from '../server/period-workspace.ts'
import { TaskViewService } from '../server/task-view.ts'
import { getOperationEpoch } from '../server/operation-context.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { schemas, rowReferences, parsePacket, hasR4BusinessFields } from '../server/data-transfer-schema.ts'
import { ImportService } from '../server/import-service.ts'
import { editableDraftValues } from '../src/draft-v3.ts'

const goal = { id: 'goal', year: 2026, progress: 37, progressMode: 'linked' } as AnnualGoal
const p = (id: string, extra: Partial<MonthlyPlan> = {}) => ({ id, annualGoalId: goal.id, month: '2026-09', sourcePlanId: null, status: 'published', acceptanceStatus: 'pending', ...extra }) as MonthlyPlan
test('annual chain denominator excludes merged sources and other years, de-duplicates splits, defends cycles and missing sources', () => {
  const plans = [p('root'), p('next', { sourcePlanId: 'root', month: '2026-10' }), p('split', { sourcePlanId: 'root', acceptanceStatus: 'accepted' }), p('merged', { status: 'merged', acceptanceStatus: 'accepted' }), p('last-year', { month: '2025-09', acceptanceStatus: 'accepted' }), p('unrelated', { annualGoalId: 'other', acceptanceStatus: 'accepted' }), p('missing', { sourcePlanId: 'lost' }), p('cycle-a', { sourcePlanId: 'cycle-b' }), p('cycle-b', { sourcePlanId: 'cycle-a', acceptanceStatus: 'accepted' })]
  const summary = annualGoalProgress(goal, plans)
  assert.equal(summary.chainCount, 3); assert.equal(summary.acceptedChainCount, 2); assert.equal(summary.autoProgress, 67); assert.equal(summary.linkedPlanCount, 6)
  assert.equal(annualGoalProgress(goal, []).effectiveProgress, null)
  const manual = annualGoalProgress({ ...goal, progressMode: undefined }, plans)
  assert.equal(manual.effectiveProgress, 37); assert.equal(manual.manualOverride, true); assert.equal(manual.autoProgress, 67)
  const mergedCarry = [p('a'), p('b', { month: '2026-10', sourcePlanId: 'a', status: 'merged', mergedIntoId: 'c' }), p('d', { month: '2026-10', status: 'merged', mergedIntoId: 'c' }), p('c', { month: '2026-10', mergedFromIds: ['b', 'd'], acceptanceStatus: 'accepted' })]
  assert.equal(annualGoalProgress(goal, mergedCarry).chainCount, 1)
  assert.equal(annualGoalProgress(goal, mergedCarry).autoProgress, 100)
})

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store)
  t.after(() => store.close())
  const manager = domain.setup({ name: '管理者', email: 'manager@r4.test', password: 'R4-password-2026!' })
  const member = domain.createUser(manager, { name: '成员', email: 'member@r4.test', password: 'R4-password-2026!', role: 'member' })
  const peer = domain.createUser(manager, { name: '其他成员', email: 'peer@r4.test', password: 'R4-password-2026!', role: 'member' })
  const goal = domain.createAnnualGoal(manager, { title: '年度方向', year: 2026, target: '交付成果', progress: 37 })
  const plan = (extra: Record<string, unknown> = {}) => domain.createPlan(manager, { title: '月目标', month: '2026-09', ownerId: member.id, category: '研发', dueDate: '2026-09-30', expectedOutcome: '可核验结果', acceptanceCriteria: '通过评审', annualGoalId: goal.id, ...extra })
  const task = (extra: Record<string, unknown> = {}) => domain.createTask(member, { title: '临时事项', isTemporary: true, temporaryReason: '临时支持', dueDate: '', ...extra })
  return { store, domain, manager, member, peer, goal, plan, task }
}

test('annual relation validates year, preserves omission, clears null and handles merge ambiguity and cross-year carry', t => {
  const f = fixture(t), d = f.domain
  assert.throws(() => f.plan({ month: '2027-01', dueDate: '2027-01-31' }), /同年度/)
  let a = f.plan(), b = f.plan({ annualGoalId: null })
  a = d.updatePlan(f.manager, a.id, { version: a.version, title: '修改标题' })
  assert.equal(a.annualGoalId, f.goal.id)
  assert.throws(() => d.updateAnnualGoal(f.manager, f.goal.id, { version: f.goal.version, year: 2027 }), /关联/)
  const carry = (period: string) => d.carryPlan(f.manager, a.id, { requestId: crypto.randomUUID(), sourceVersion: a.version, operationEpoch: getOperationEpoch(f.store), month: period, dueDate: `${period}-28`, reason: '剩余工作' })
  assert.equal(carry('2026-10').annualGoalId, f.goal.id)
  assert.equal(carry('2027-01').annualGoalId, null)
  a = d.submitPlan(f.manager, a.id, { version: a.version }); b = d.submitPlan(f.manager, b.id, { version: b.version })
  const input = { planIds: [a.id, b.id], title: '合并成果', reason: '共同交付' }
  assert.throws(() => d.mergePlans(f.manager, input), /明确选择/)
  const merged = d.mergePlans(f.manager, { ...input, annualGoalId: null })
  assert.equal(merged.annualGoalId, null)
  let link = f.plan(); link = d.updatePlan(f.manager, link.id, { version: link.version, annualGoalId: null }); assert.equal(link.annualGoalId, null)
})

test('annual list and detail use complete authorized scope independently of paging and redact merged prose', t => {
  const f = fixture(t), directory = new DirectoryWorkspaceService(f.store)
  for (let i = 0; i < 7; i++) {
    const plan = f.plan({ title: `visible ${i}` })
    if (i < 3) f.store.update<MonthlyPlan>('plans', plan.id, plan.version, { acceptanceStatus: 'accepted' })
  }
  f.plan({ title: 'secret peer goal', ownerId: f.peer.id })
  const formerly = f.plan({ title: 'old membership' })
  f.domain.updatePlan(f.manager, formerly.id, { version: formerly.version, ownerId: f.peer.id })
  const page = directory.goals(f.member, { year: '2026', limit: '1' })
  assert.equal(page.items[0].progressSummary.chainCount, 7)
  const detail = directory.goalDetail(f.member, f.goal.id, { limit: '2' })
  assert.equal(detail.total, 7); assert.equal(detail.items.length, 2); assert.equal(detail.goal.progressSummary.autoProgress, 43)
  assert.ok(!JSON.stringify(detail).includes('secret')); assert.ok(!JSON.stringify(detail).includes('old membership'))
  const second = directory.goalDetail(f.member, f.goal.id, { limit: '2', cursor: detail.nextCursor! })
  assert.deepEqual(second.goal.progressSummary, detail.goal.progressSummary)
  assert.equal(directory.goalDetail(f.manager, f.goal.id, {}).total, 9)
  f.store.update<User>('users', f.member.id, f.member.version, { active: false })
  assert.throws(() => directory.goalDetail(f.member, f.goal.id, {}), /账号|登录|权限/)
})

test('effort allows zero, null, half days; omission preserves; weekly carry clears; reviewed fingerprint is unchanged', t => {
  const f = fixture(t), d = f.domain
  for (const value of [-1, 0.25, Infinity, NaN, '1', false, {}]) assert.equal(isEffortDays(value), false)
  for (const value of [0, null, 0.5, 6]) assert.equal(isEffortDays(value), true)
  let task = f.task({ remainingEffortDays: 3.5, estimatedEffort: '保留投入备注' })
  task = d.updateTask(f.member, task.id, { version: task.version, remainingEffortDays: 0 })
  assert.equal(task.remainingEffortDays, 0)
  task = d.updateTask(f.member, task.id, { version: task.version, currentProgress: '已开始' })
  assert.equal(task.remainingEffortDays, 0)
  task = d.updateTask(f.member, task.id, { version: task.version, remainingEffortDays: null })
  assert.equal(task.remainingEffortDays, null); assert.equal(task.estimatedEffort, '保留投入备注')
  assert.throws(() => d.updateTask(f.member, task.id, { version: task.version, remainingEffortDays: 1.1 }), { status: 400 })
  let record = d.createWeeklyRecord(f.member, { taskId: task.id, weekStart: '2026-09-07', commitment: '验证', plannedEffortDays: 2.5, actualEffortDays: 0 })
  const fp = weeklyPlanFingerprint(record)
  record = d.updateWeeklyRecord(f.member, record.id, { version: record.version, plannedEffortDays: null, actualEffortDays: 4 })
  assert.equal(record.plannedEffortDays, null); assert.equal(weeklyPlanFingerprint(record), fp)
  record = d.updateWeeklyRecord(f.member, record.id, { version: record.version, actualOutcome: '推进' })
  assert.equal(record.actualEffortDays, 4)
  const carried = d.carryWeeklyRecord(f.member, record.id, { weekStart: '2026-09-14' })
  assert.equal(carried.plannedEffortDays, undefined); assert.equal(carried.actualEffortDays, undefined)
  const editable = new TaskViewService(f.store).editableTask(f.member, task.id)
  assert.equal(editable.values.remainingEffortDays, null)
})

test('weekly totals use effective records, retain missing counts, group by owner week and stay complete across pagination', t => {
  const f = fixture(t), rows: WeeklyRecord[] = []
  for (let i = 0; i < 7; i++) {
    const task = f.task()
    rows.push(f.domain.createWeeklyRecord(f.member, { taskId: task.id, weekStart: '2026-09-07', commitment: `工作${i}`, submitted: true, plannedEffortDays: i === 0 ? null : 1, actualEffortDays: i === 0 ? 0 : undefined }))
  }
  const draft = f.domain.createWeeklyRecord(f.member, { taskId: f.task().id, weekStart: '2026-09-07', commitment: '草稿', plannedEffortDays: 99 })
  const summary = summarizeEffort([...rows, rows[0], draft])
  assert.equal(summary.recordCount, 7); assert.equal(summary.plannedEffortDays, 6); assert.equal(summary.missingPlannedCount, 1); assert.equal(summary.missingActualCount, 6); assert.equal(summary.byOwnerWeek[0].overCapacity, true)
  const service = new PeriodWorkspaceService(f.store)
  const first = service.weekly(f.member, { weekStart: '2026-09-07', limit: '2' })
  const second = service.weekly(f.member, { weekStart: '2026-09-07', limit: '2', cursor: first.nextCursor! })
  assert.equal(first.items.length, 2); assert.deepEqual(first.effortSummary, summary); assert.deepEqual(second.effortSummary, summary)
})

test('migration keeps new numeric and annual fields, references and frozen values; old optional fields remain absent', t => {
  const source = fixture(t), target = fixture(t)
  const plan = source.plan(), task = source.task({ remainingEffortDays: 0 })
  const record = source.domain.createWeeklyRecord(source.member, { taskId: task.id, weekStart: '2026-09-07', commitment: '工作', plannedEffortDays: null, actualEffortDays: 1.5 })
  assert.ok(rowReferences('plans', plan).some(ref => ref.collection === 'annualGoals' && ref.id === source.goal.id))
  assert.equal(schemas.weeklyRecords.safeParse({ ...record, actualEffortDays: 0.1 }).success, false)
  assert.equal(schemas.weeklyRecords.safeParse({ ...record, plannedEffortDays: undefined }).success, true)
  const packet = exportBusinessData(source.store, source.manager), preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  assert.equal(target.store.get<MonthlyPlan>('plans', plan.id)!.annualGoalId, source.goal.id)
  assert.equal(target.store.get<Task>('tasks', task.id)!.remainingEffortDays, 0)
  assert.equal(target.store.get<WeeklyRecord>('weeklyRecords', record.id)!.plannedEffortDays, null)
  assert.equal(target.store.get<WeeklyRecord>('weeklyRecords', record.id)!.actualEffortDays, 1.5)
  assert.equal(target.store.get<AnnualGoal>('annualGoals', source.goal.id)!.progressMode, undefined)
  const invalid = structuredClone(packet)
  invalid.collections.annualGoals.find(goal => goal.id === source.goal.id)!.year = 2027
  const cleanTarget = fixture(t)
  assert.ok(previewRestore(cleanTarget.store, cleanTarget.manager, invalid).issues.some(issue => issue.includes('年份不一致')))
})

test('structured import normalizes effort separately, preserves absent optional fields and forwards draft and existing fields', t => {
  const f = fixture(t), service = new ImportService(f.store); t.after(() => service.close())
  for (const mode of ['draft', 'existing'] as const) {
    let batch = service.structured(f.manager, { sourceKey: `effort-${mode}`, mode, fileName: `effort-${mode}`, rows: [{ kind: 'weekly', sourceRow: 1, title: `数值投入${mode}`, ownerId: f.member.id, weekStart: '2026-09-07', dueDate: '2026-09-11', sourceText: '临时支持', expectedOutcome: '结果', isTemporary: true, temporaryReason: '支持', remainingEffortDays: '2.5', plannedEffortDays: '0', actualEffortDays: '' }] })
    batch = service.edit(f.manager, batch.id, { version: batch.version, mode, rows: batch.rows, completionReview: { confirmed: true, sourceItemCount: 1 } })
    assert.equal(batch.rows[0].remainingEffortDays, 2.5); assert.equal(batch.rows[0].plannedEffortDays, 0); assert.equal(batch.rows[0].actualEffortDays, null)
    const saved = service.commit(f.manager, batch.id, { version: batch.version }), record = f.store.get<WeeklyRecord>('weeklyRecords', saved.rows[0].result!.id)!
    assert.equal(record.plannedEffortDays, 0); assert.equal(record.actualEffortDays, null); assert.equal(f.store.get<Task>('tasks', record.taskId)!.remainingEffortDays, 2.5)
    let monthly = service.structured(f.manager, { sourceKey: `annual-${mode}`, mode, rows: [{ kind: 'monthly', sourceRow: 1, title: `年度关联${mode}`, ownerId: f.member.id, month: '2026-09', dueDate: '2026-09-30', category: '研发', expectedOutcome: '结果', acceptanceCriteria: '评审', annualGoalId: f.goal.id }] })
    monthly = service.commit(f.manager, monthly.id, { version: monthly.version })
    assert.equal(f.store.get<MonthlyPlan>('plans', monthly.rows[0].result!.id)!.annualGoalId, f.goal.id)
  }
})

test('resource conflict comparison preserves zero and clears fields absent on legacy server objects', () => {
  assert.deepEqual(editableDraftValues({ remainingEffortDays: 0, plannedEffortDays: null }, { remainingEffortDays: '9', plannedEffortDays: '3', actualEffortDays: '4' }), { remainingEffortDays: '0', plannedEffortDays: '', actualEffortDays: '' })
})

test('project effort aggregates are snapshot-local and pending/deleted records do not inflate capacity', () => {
  const record = { id: 'one', version: 1, ownerId: 'member', taskId: 'task', weekStart: '2026-09-07', commitment: '交付', monthlyPlanId: 'plan', submitted: true, plannedEffortDays: 0, actualEffortDays: 1.5 } as WeeklyRecord
  const pending = { ...record, id: 'pending', plannedEffortDays: 99, planApproval: { required: true as const, approvedSubmissionId: null, approvedFingerprint: null } }
  const deleted = { ...record, id: 'deleted', plannedEffortDays: 99, deletion: { deletedAt: '', deletedBy: '', reason: '' } }
  const result = summarizeEffort([record, pending, deleted], [{ ...p('plan'), projectId: 'project' }], [{ id: 'project', name: '冻结项目' } as import('../shared/types.ts').Project])
  assert.equal(result.recordCount, 1); assert.equal(result.byProject[0].projectName, '冻结项目'); assert.equal(result.byProject[0].plannedEffortDays, 0); assert.equal(result.byOwnerWeek[0].overCapacity, false)
})

test('format eight fence sees nested R4 fields without upgrading old packets or rewriting absent fields', t => {
  const f = fixture(t), task = f.task()
  const legacy = exportBusinessData(f.store, f.manager)
  assert.ok(legacy.formatVersion < 8); assert.equal(hasR4BusinessFields(legacy.collections), false)
  const parsed = parsePacket(legacy)
  assert.equal(parsed.collections.tasks[0].remainingEffortDays, undefined)
  const event = f.store.list<import('../shared/types.ts').AuditEvent>('events').find(row => row.entityType === 'task' && row.entityId === task.id)!
  f.store.update<import('../shared/types.ts').AuditEvent>('events', event.id, event.version, { after: { ...task, remainingEffortDays: null } })
  const nestedOnly = exportBusinessData(f.store, f.manager)
  assert.equal(nestedOnly.collections.tasks[0].remainingEffortDays, undefined)
  assert.equal(nestedOnly.formatVersion, 8)
  assert.throws(() => parsePacket({ ...nestedOnly, formatVersion: 7 }), /版本 8/)
  const goalPacket = structuredClone(legacy); goalPacket.collections.annualGoals[0].progressMode = 'manual'
  assert.throws(() => parsePacket(goalPacket), /版本 8/)
  assert.equal(parsePacket({ ...goalPacket, formatVersion: 8 }).collections.annualGoals[0].progressMode, 'manual')
})
