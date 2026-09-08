import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import type { Publication, WeeklyRecord } from '../shared/types.ts'

function fixture() {
  const store = new Store(':memory:')
  const domain = new Domain(store)
  const manager = domain.setup({ name: '负责人', email: 'manager@example.test', password: 'password123' })
  const member = domain.createUser(manager, { name: '张成员', email: 'member@example.test', password: 'password123', position: '算法', role: 'member' })
  const other = domain.createUser(manager, { name: '李成员', email: 'other@example.test', password: 'password123', position: '测试', role: 'member' })
  const project = domain.createProject(manager, { name: '研发', code: 'RD', description: '', ownerId: manager.id })
  const planInput = { month: '2026-09', title: '交付模型', projectId: project.id, category: '项目研发', collaboratorIds: [], expectedOutcome: '完成验证报告', acceptanceCriteria: '准确率达到约定值', dueDate: '2026-09-30' }
  return { store, domain, manager, member, other, project, planInput }
}

test('monthly review/publication retains submission, guards ownership and optimistic versions', () => {
  const f = fixture(); const { domain: d, store, manager, member, other } = f
  try {
    let plan = d.createPlan(member, f.planInput)
    assert.throws(() => d.updatePlan(other, plan.id, { version: plan.version, title: '越权' }), { status: 403 })
    plan = d.submitPlan(member, plan.id, { version: plan.version })
    assert.throws(() => d.updatePlan(member, plan.id, { version: plan.version, title: '改动' }), { status: 403 })
    plan = d.reviewPlan(manager, plan.id, { version: plan.version, decision: 'return', comment: '补充样本' })
    assert.equal(plan.reviewComment, '补充样本')
    plan = d.updatePlan(member, plan.id, { version: plan.version, title: '交付新模型' })
    assert.throws(() => d.updatePlan(member, plan.id, { version: 1, title: '旧页面' }), { status: 409 })
    plan = d.submitPlan(member, plan.id, { version: plan.version })
    plan = d.reviewPlan(manager, plan.id, { version: plan.version, decision: 'approve', comment: '' })
    d.publishMonth(manager, '2026-09', { planIds: [plan.id] })
    plan = store.get('plans', plan.id)!
    assert.equal(plan.status, 'published')
    assert.equal(plan.acceptanceStatus, 'pending')
    assert.throws(() => d.updatePlan(manager, plan.id, { version: plan.version, dueDate: '2026-09-25' }), { status: 400 })
    plan = d.updatePlan(manager, plan.id, { version: plan.version, dueDate: '2026-09-25', reason: '调整交付窗口' })
    const publications = store.list<Publication>('publications')
    assert.equal(publications.length, 2)
    assert.equal(publications[0].plans[0].dueDate, '2026-09-30')
    assert.equal(publications[1].plans[0].dueDate, '2026-09-25')
    const submissions = d.planHistory(member, plan.id).filter(event => event.action === 'submit')
    assert.equal(submissions.length, 2)
    assert.equal((submissions[0].after as { title: string }).title, '交付模型')
  } finally { store.close() }
})

test('weekly publication gate, result distinction, stable task carry and relink snapshots', () => {
  const f = fixture(); const { domain: d, store, manager, member } = f
  try {
    let plan = d.createPlan(member, f.planInput)
    const task = d.createTask(member, { title: '验证样本', monthlyPlanId: plan.id, description: '', dueDate: '2026-09-20' })
    let week = d.createWeeklyRecord(member, { taskId: task.id, weekStart: '2026-09-09', commitment: '验证 100 条' })
    assert.equal(week.weekStart, '2026-09-07')
    assert.throws(() => d.updateWeeklyRecord(member, week.id, { version: week.version, submitted: true }), { status: 400 })
    plan = d.submitPlan(member, plan.id, { version: plan.version })
    plan = d.reviewPlan(manager, plan.id, { version: plan.version, decision: 'approve', comment: '' })
    d.publishMonth(manager, plan.month, { planIds: [plan.id] })
    week = d.updateWeeklyRecord(member, week.id, { version: week.version, status: 'done', actualOutcome: '完成 100 条验证', submitted: true })
    assert.equal(store.get<any>('plans', plan.id)?.acceptanceStatus, 'pending')
    const carried = d.carryWeeklyRecord(member, week.id, { weekStart: '2026-09-14' })
    assert.equal(carried.taskId, task.id)
    assert.equal(carried.status, 'planned')
    assert.equal(carried.actualOutcome, '')
    assert.equal(carried.submitted, false)
    assert.throws(() => d.createWeeklyRecord(member, { taskId: task.id, weekStart: '2026-09-15', commitment: '重复' }), { status: 409 })
    const next = d.carryPlan(member, plan.id, { month: '2026-10', dueDate: '2026-10-30', reason: '后续验证' })
    assert.equal(next.sourcePlanId, plan.id)
    let approved = d.submitPlan(member, next.id, { version: next.version })
    approved = d.reviewPlan(manager, next.id, { version: approved.version, decision: 'approve', comment: '' })
    d.publishMonth(manager, next.month, { planIds: [next.id] })
    // Represents a provisional draft saved before month-overlap validation was introduced.
    const legacyDraft = store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, monthlyPlanId: plan.id, ownerId: member.id, weekStart: '2026-10-05', commitment: '十月承接草稿', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'planned', submitted: false })
    const relinked = d.relinkTask(manager, task.id, { version: task.version, monthlyPlanId: next.id, reason: '跨月延续' })
    assert.equal(relinked.id, task.id)
    assert.equal(store.get<WeeklyRecord>('weeklyRecords', week.id)?.monthlyPlanId, plan.id)
    const repaired = store.get<WeeklyRecord>('weeklyRecords', legacyDraft.id)!
    assert.equal(repaired.monthlyPlanId, next.id)
    assert.equal(repaired.version, legacyDraft.version + 1)
    assert.ok(store.list<{ entityId: string; action: string }>('events').some(event => event.entityId === legacyDraft.id && event.action === 'relink_draft'))
    d.updateWeeklyRecord(member, repaired.id, { version: repaired.version, submitted: true })
    const thirdWeek = d.carryWeeklyRecord(member, carried.id, { weekStart: '2026-10-12' })
    assert.equal(thirdWeek.monthlyPlanId, next.id)
  } finally { store.close() }
})

test('manager safeguards and project archive preserve history', () => {
  const f = fixture(); const { domain: d, store, manager, member, other } = f
  try {
    const plan = d.createPlan(member, f.planInput)
    assert.throws(() => d.updateUser(manager, manager.id, { version: manager.version, active: false }), { status: 400 })
    assert.throws(() => d.createUser(member, { name: '越权', email: 'bad@example.test', password: 'password123', role: 'manager', position: '' }), { status: 403 })
    const goal = d.createAnnualGoal(manager, { title: '年度方向', year: 2026, target: '独立目标', progress: 27, description: '', ownerId: manager.id })
    assert.equal(goal.progress, 27)
    d.updateProject(manager, f.project.id, { version: f.project.version, status: 'archived' })
    assert.throws(() => d.createPlan(member, f.planInput), { status: 400 })
    assert.equal(d.bootstrap(member).plans[0].id, plan.id)
    assert.equal(d.bootstrap(other).plans.length, 0)
    assert.ok(d.bootstrap(member).users.every(user => !('passwordHash' in user)))
    assert.equal(d.bootstrap(manager).annualGoals[0].progress, 27)
  } finally { store.close() }
})

test('transactions roll back records and nested writes together', () => {
  const store = new Store(':memory:')
  try {
    assert.throws(() => store.transaction(() => {
      store.insert('settings', { id: 'a' })
      store.transaction(() => store.insert('settings', { id: 'b' }))
      throw new Error('abort')
    }))
    assert.equal(store.list('settings').length, 0)
  } finally { store.close() }
})

test('merged submissions preserve both original responsibilities and cannot be edited as active plans', () => {
  const f = fixture(); const { domain: d, store, manager, member, other } = f
  try {
    let a = d.createPlan(member, { ...f.planInput, title: '模型评测', expectedOutcome: '模型准确率报告' })
    let b = d.createPlan(other, { ...f.planInput, title: '系统验证', category: '测试验证', expectedOutcome: '测试覆盖率报告' })
    a = d.submitPlan(member, a.id, { version: a.version })
    b = d.submitPlan(other, b.id, { version: b.version })
    const input = { planIds: [a.id, b.id], title: '联合验收', reason: '两个岗位共同交付同一成果' }
    assert.throws(() => d.mergePlans(member, input), { status: 403 })
    const merged = d.mergePlans(manager, input)
    assert.deepEqual(merged.mergedFromIds, [a.id, b.id])
    assert.equal(merged.ownerId, member.id)
    assert.ok(merged.collaboratorIds.includes(other.id))
    assert.match(merged.expectedOutcome, /张成员（模型评测）：模型准确率报告/)
    assert.match(merged.expectedOutcome, /李成员（系统验证）：测试覆盖率报告/)
    const historical = store.get<typeof a>('plans', a.id)!
    assert.equal(historical.status, 'merged')
    assert.equal(historical.mergedIntoId, merged.id)
    assert.equal(historical.expectedOutcome, a.expectedOutcome)
    assert.throws(() => d.updatePlan(manager, a.id, { version: historical.version, title: '覆盖历史' }), { status: 409 })
    d.publishMonth(manager, merged.month, { planIds: [merged.id] })
    assert.equal(store.list<Publication>('publications')[0].plans.length, 1)
    assert.ok(d.planHistory(other, b.id).some(event => event.action === 'submit'))
    let unscopedA = d.createPlan(member, { ...f.planInput, projectId: null, category: '培训' })
    let unscopedB = d.createPlan(other, { ...f.planInput, projectId: null, category: '申报' })
    unscopedA = d.submitPlan(member, unscopedA.id, { version: unscopedA.version })
    unscopedB = d.submitPlan(other, unscopedB.id, { version: unscopedB.version })
    assert.throws(() => d.mergePlans(manager, { ...input, planIds: [unscopedA.id, unscopedB.id] }), { status: 400 })
  } finally { store.close() }
})

test('weekly submission must overlap its month, and archive rejects new weeks but retains editable history', () => {
  const f = fixture(); const { domain: d, store, manager, member } = f
  try {
    let plan = d.createPlan(member, f.planInput)
    plan = d.submitPlan(member, plan.id, { version: plan.version })
    plan = d.reviewPlan(manager, plan.id, { version: plan.version, decision: 'approve' })
    d.publishMonth(manager, plan.month, { planIds: [plan.id] })
    const task = d.createTask(member, { title: '跨月边界任务', monthlyPlanId: plan.id, description: '', dueDate: '2026-09-30' })
    const overlap = d.createWeeklyRecord(member, { taskId: task.id, weekStart: '2026-08-31', commitment: '九月首周', submitted: true })
    assert.throws(() => d.createWeeklyRecord(member, { taskId: task.id, weekStart: '2026-11-02', commitment: '未来草稿' }), { status: 400 })
    d.updateProject(manager, f.project.id, { version: f.project.version, status: 'archived' })
    assert.throws(() => d.createWeeklyRecord(member, { taskId: task.id, weekStart: '2026-09-07', commitment: '归档后新记录' }), { status: 400 })
    const edited = d.updateWeeklyRecord(member, overlap.id, { version: overlap.version, actualOutcome: '补充历史记录' })
    assert.equal(edited.actualOutcome, '补充历史记录')
  } finally { store.close() }
})

test('historical plan access never grants access to a new owner’s future tasks or drafts', () => {
  const f = fixture(); const { domain: d, store, manager, member, other } = f
  try {
    let plan = d.createPlan(member, f.planInput)
    plan = d.updatePlan(manager, plan.id, { version: plan.version, ownerId: other.id, collaboratorIds: [] })
    const task = d.createTask(other, { title: '新负责人私人草稿', monthlyPlanId: plan.id, dueDate: plan.dueDate })
    const weekly = d.createWeeklyRecord(other, { taskId: task.id, weekStart: '2026-09-07', commitment: '新负责人的未提交承诺' })
    const visible = d.bootstrap(member)
    assert.ok(visible.plans.some(item => item.id === plan.id), 'original submitter retains plan/change provenance')
    assert.ok(d.planHistory(member, plan.id).some(event => event.action === 'update'))
    assert.ok(!visible.tasks.some(item => item.id === task.id))
    assert.ok(!visible.weeklyRecords.some(item => item.id === weekly.id))
    plan = d.submitPlan(other, plan.id, { version: plan.version })
    plan = d.reviewPlan(manager, plan.id, { version: plan.version, decision: 'approve' })
    d.publishMonth(manager, plan.month, { planIds: [plan.id] })
    assert.equal(d.bootstrap(member).publications.length, 0)
  } finally { store.close() }
})
