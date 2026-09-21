import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import { buildWorkRegister, createWorkRegisterSnapshot, workRegisterTaskSource } from '../shared/work-register.ts'
import { Domain } from '../server/domain.ts'
import { Store } from '../server/store.ts'
import { ImportService } from '../server/import-service.ts'
import { workRegisterReportCsv } from '../src/work-register-export.ts'
import { entryLocation, navigationUrl } from '../src/notification-navigation.ts'
import Monthly from '../src/pages/Monthly.tsx'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), imports = new ImportService(store)
  t.after(() => { imports.close(); store.close() })
  const user = (id: string, role: User['role'] = 'member') => store.insert<User>('users', { id, name: id, email: `${id}@complete.invalid`, role, active: true, position: '' })
  return { store, domain, imports, manager: user('manager', 'manager'), member: user('member'), peer: user('peer') }
}

test('unbroken personal coverage includes owned unaccepted goals through approval stages without fabricating tasks', t => {
  const f = fixture(t)
  const create = (title: string, ownerId = f.member.id) => f.domain.createPlan(f.manager, {
    title, ownerId, month: '2026-08', dueDate: '2026-08-31', category: '研发', expectedOutcome: '原目标交付', acceptanceCriteria: '验收标准',
  })
  const goals = ['draft', 'submitted', 'returned', 'approved', 'published', 'merged'].map(status => {
    const plan = create(status)
    return f.store.update<MonthlyPlan>('plans', plan.id, plan.version, { status: status as MonthlyPlan['status'] })
  })
  const accepted = create('验收完成')
  f.store.update<MonthlyPlan>('plans', accepted.id, accepted.version, { status: 'published', acceptanceStatus: 'accepted' })
  const peerGoal = create('仅为协作者的目标', f.peer.id)
  f.store.update<MonthlyPlan>('plans', peerGoal.id, peerGoal.version, { collaboratorIds: [f.member.id] })
  const ownGoalWithPeerTask = create('他人的任务不能覆盖我的责任')
  f.store.update<MonthlyPlan>('plans', ownGoalWithPeerTask.id, ownGoalWithPeerTask.version, { collaboratorIds: [f.peer.id] })
  f.domain.createTask(f.peer, { title: '仅协作者任务', monthlyPlanId: ownGoalWithPeerTask.id, dueDate: '' })
  const data = f.domain.bootstrap(f.member)
  const register = buildWorkRegister(data, { today: '2026-09-20' })
  assert.equal(register.rows.length, 6)
  assert.equal(register.counts.unscheduled, 6)
  assert.ok(register.rows.every(row => row.kind === 'plan' && row.task === undefined))
  assert.equal(register.rows.find(row => row.title === 'approved')?.displayStatus, '审核通过，待发布')
  assert.equal(register.rows.find(row => row.title === 'submitted')?.displayStatus, '待审核')
  assert.ok(!register.rows.some(row => row.title === peerGoal.title || row.title === accepted.title || row.title === 'merged'))
  assert.equal(f.store.list<Task>('tasks').length, 1, 'projection must not create business tasks')
  assert.equal(buildWorkRegister(data, { today: '2027-01-20' }).rows.length, 6, 'pending owned goals persist across months')

  const split = f.domain.createTask(f.member, { title: '实际个人任务', monthlyPlanId: goals[0].id, dueDate: '' })
  const after = buildWorkRegister(f.domain.bootstrap(f.member), { today: '2026-09-20' })
  assert.equal(after.rows.length, 6)
  assert.ok(after.rows.some(row => row.kind === 'task' && row.task.id === split.id))
  assert.ok(!after.rows.some(row => row.kind === 'plan' && row.plan.id === goals[0].id))
  assert.equal(buildWorkRegister(f.domain.bootstrap(f.manager), { today: '2026-09-20' }).rows.length, 0, 'manager personal register must not absorb team responsibilities')
})

test('real monthly and weekly import reaches the register, then task creation retains source and original scheduling identity', t => {
  const f = fixture(t)
  const batch = f.imports.structured(f.manager, { sourceKey: 'full-chain-source', mode: 'existing', rows: [
    { kind: 'monthly', ownerId: f.member.id, title: '临时专项', month: '2026-09', dueDate: '', category: '专项', expectedOutcome: '完整交付材料', acceptanceCriteria: '', isTemporary: true, temporaryReason: '临时会议明确交办', workSource: 'leader', assignedBy: '负责人甲', assignedOn: '2026-09-18' },
    { kind: 'weekly', ownerId: f.member.id, title: '长期事项的本周阶段', weekStart: '2026-09-14', dueDate: '2026-10-30', expectedOutcome: '完成本周调研', actualOutcome: '本周调研完成，下周继续验证', weeklyStatus: 'done', isTemporary: true, temporaryReason: '临时支持', workSource: 'leader', assignedBy: '负责人甲' },
  ] })
  const committed = f.imports.commit(f.manager, batch.id, { version: batch.version })
  const planId = committed.rows[0].result!.id
  const data = f.domain.bootstrap(f.member)
  const before = buildWorkRegister(data, { view: 'leader', today: '2026-09-20' })
  assert.equal(before.rows.length, 2)
  assert.equal(before.rows.find(row => row.title === '长期事项的本周阶段')?.task?.status, 'doing')
  const goal = before.rows.find(row => row.kind === 'plan')!
  assert.equal(goal.assignedBy, '负责人甲')
  const report = createWorkRegisterSnapshot(before)
  assert.equal(report.totalCount, 2)
  assert.equal(report.unknownDueDateCount, 1)
  assert.equal(report.rows.find(row => row.id === planId)?.itemType, '月度目标（待建立个人任务）')
  assert.match(workRegisterReportCsv(report), /完整交付材料/)
  assert.match(workRegisterReportCsv(report), /月度目标（待建立个人任务）/)
  assert.equal(buildWorkRegister(data, { query: '负责人甲', today: '2026-09-20' }).rows.length, 2)
  const detail = renderToStaticMarkup(createElement(Monthly, { data, refresh: async () => {}, notify: () => {}, intent: { id: planId, month: '2026-09' } }))
  assert.match(detail, /已有计划导入/)
  assert.match(detail, /当前已发布/)
  assert.doesNotMatch(detail, /已生效/)

  const task = f.domain.createTask(f.member, { title: '专项执行', monthlyPlanId: planId, dueDate: '' })
  assert.equal(task.workSource, 'leader')
  assert.equal(task.assignedBy, '负责人甲')
  assert.equal(task.assignedOn, '2026-09-18')
  assert.equal(task.requestedOutcome, '完整交付材料')
  const scheduled = f.domain.createWeeklyAssignment(f.member, { requestId: 'complete-task-schedule-20260920', taskId: task.id, record: { weekStart: '2026-09-21', commitment: '完成验证', submitted: true } })
  assert.equal(scheduled.record.taskId, task.id)
  const after = buildWorkRegister(f.domain.bootstrap(f.member), { view: 'leader', today: '2026-09-21' })
  assert.equal(after.rows.length, 2)
  assert.ok(after.rows.every(row => row.kind === 'task'))
  assert.equal(after.rows.find(row => row.id === task.id)?.currentWeekRecord?.id, scheduled.record.id)
  assert.equal(f.store.list<Task>('tasks').length, 2)
})

test('source compatibility trusts explicit metadata and real assignments while leaving ambiguous import recording identity reviewable', t => {
  const f = fixture(t)
  const base = { title: '事项', ownerId: f.member.id, dueDate: '', isTemporary: true, temporaryReason: '支持' }
  const assigned = f.domain.createTask(f.manager, base)
  assert.equal(assigned.workSource, 'leader')
  assert.equal(assigned.assignedBy, f.manager.name)
  const explicit = f.domain.createTask(f.manager, { ...base, workSource: 'coordination', assignedBy: '明确对接人' })
  assert.equal(explicit.workSource, 'coordination')
  assert.equal(explicit.assignedBy, '明确对接人')
  const legacy = { ...assigned, id: 'legacy', workSource: undefined, assignedBy: undefined }
  const imported = { ...legacy, id: 'imported', importSource: { batchId: 'b', sourceId: 's', rowId: 'r', sourceStatus: '', mode: 'draft' as const } }
  assert.equal(workRegisterTaskSource(legacy), 'leader')
  assert.equal(workRegisterTaskSource(imported), undefined)
  const data = { ...f.domain.bootstrap(f.member), tasks: [assigned, explicit, legacy, imported] }
  const leader = buildWorkRegister(data, { view: 'leader', today: '2026-09-20' })
  assert.equal(leader.rows.length, 2)
  assert.equal(leader.rows.find(row => row.id === legacy.id)?.assignedBy, f.manager.name)
  const review = buildWorkRegister(data, { view: 'source-review', today: '2026-09-20' })
  assert.deepEqual(review.rows.map(row => row.id), [imported.id])
  assert.equal(createWorkRegisterSnapshot(review).rows[0].source, '来源待核对')
})

test('legacy imported done remains visible until an ordinary owner edit confirms completion or resumes the same task', t => {
  const f = fixture(t)
  const task = f.store.insert<Task>('tasks', { title: '历史阶段成果待核对', ownerId: f.member.id, monthlyPlanId: null, description: '', dueDate: '', status: 'done', isTemporary: true, temporaryReason: '原临时说明', importSource: { batchId: 'old', sourceId: 'source', rowId: 'row', sourceStatus: '本周完成', mode: 'existing' } })
  const week = f.store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, ownerId: f.member.id, monthlyPlanId: null, weekStart: '2026-09-14', commitment: '完成阶段', actualOutcome: '阶段成果完成', status: 'done', submitted: true, evidenceUrl: '', blocker: '', nextAction: '后续继续推进' })
  const before = buildWorkRegister(f.domain.bootstrap(f.member), { today: '2026-09-20' })
  assert.equal(before.rows[0].displayStatus, '整体完成待核对')
  assert.equal(before.counts.active, 1)
  assert.equal(before.counts['completion-review'], 1)
  assert.equal(before.counts.done, 0)
  assert.match(createWorkRegisterSnapshot(before).rows[0].progress, /原导入状态为已完成/)
  assert.equal(f.store.get<Task>('tasks', task.id)?.status, 'done', 'projection must not rewrite historical completion state')
  assert.throws(() => f.domain.updateTask(f.peer, task.id, { version: task.version, status: 'doing' }), { status: 403 })
  const resumed = f.domain.updateTask(f.member, task.id, { version: task.version, status: 'doing', currentProgress: '继续验证' })
  assert.equal(resumed.id, task.id)
  assert.deepEqual(f.store.get<WeeklyRecord>('weeklyRecords', week.id), week)
  assert.equal(buildWorkRegister(f.domain.bootstrap(f.member), { today: '2026-09-20' }).counts['completion-review'], 0)
  assert.throws(() => f.domain.updateTask(f.member, task.id, { version: resumed.version, status: 'done', completionNote: '' }), { status: 400 })
  const confirmed = f.domain.updateTask(f.member, task.id, { version: resumed.version, status: 'done', completionNote: '全部验收结束' })
  const done = buildWorkRegister(f.domain.bootstrap(f.member), { view: 'done', today: '2026-09-20' })
  assert.equal(done.rows[0].id, confirmed.id)
  assert.equal(done.rows[0].progress, '全部验收结束')
  assert.equal(done.counts.active, 0)
})

test('unpublished own manager goal has a personal-task entry and truthful status; deep links preserve creation context', t => {
  const f = fixture(t)
  const plan = f.domain.createPlan(f.manager, { title: '管理者本人目标', ownerId: f.manager.id, month: '2026-09', dueDate: '2026-09-30', category: '研发', expectedOutcome: '目标成果', acceptanceCriteria: '验收通过' })
  const intent = { action: 'create-task' as const, id: plan.id, month: plan.month, weekStart: '2026-09-21' }
  const markup = renderToStaticMarkup(createElement(Monthly, { data: f.domain.bootstrap(f.manager), refresh: async () => {}, notify: () => {}, navigate: () => {}, intent }))
  assert.match(markup, /关联个人任务/)
  assert.match(markup, /关联目标，建立个人任务/)
  assert.match(markup, /尚未发布/)
  assert.match(markup, /建立任务并安排周工作/)
  assert.deepEqual(entryLocation(new URL(navigationUrl('monthly', intent), 'http://localhost')), { page: 'monthly', intent })
  const task = f.domain.createTask(f.manager, { title: '草稿下的真实任务', monthlyPlanId: plan.id, dueDate: '' })
  assert.throws(() => f.domain.createWeeklyRecord(f.manager, { taskId: task.id, weekStart: '2026-09-21', commitment: '推进', submitted: true }), { status: 400 })
  const draft = f.domain.createWeeklyRecord(f.manager, { taskId: task.id, weekStart: '2026-09-21', commitment: '推进', submitted: false })
  assert.equal(draft.taskId, task.id)
  const weeklyIntent = { action: 'create' as const, id: task.id, ownerId: task.ownerId, weekStart: '2026-09-21' }
  assert.deepEqual(entryLocation(new URL(navigationUrl('weekly', weeklyIntent), 'http://localhost')), { page: 'weekly', intent: weeklyIntent })
})
