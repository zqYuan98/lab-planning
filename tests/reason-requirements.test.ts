import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { TestDomain as Domain } from './fixtures/legacy-domain.ts'

// A reason is asked for only when someone changes or removes another person's work.
// Routine forward steps and edits to one's own work must not demand one.
function fixture() {
  const store = new Store(':memory:')
  const domain = new Domain(store)
  const manager = domain.setup({ name: '负责人', email: 'manager@example.test', password: 'password123' })
  const member = domain.createUser(manager, { name: '张成员', email: 'member@example.test', password: 'password123', position: '算法', role: 'member' })
  const project = domain.createProject(manager, { name: '研发', code: 'RD', description: '', ownerId: manager.id })
  const planInput = { month: '2026-09', title: '交付模型', projectId: project.id, category: '项目研发', collaboratorIds: [], expectedOutcome: '完成验证报告', acceptanceCriteria: '准确率达到约定值', dueDate: '2026-09-30' }
  return { store, domain, manager, member, project, planInput }
}

test('a manager submitting a goal skips self-review, and can still send it back before publishing', () => {
  const f = fixture(), d = f.domain
  try {
    let plan = d.createPlan(f.manager, { ...f.planInput, ownerId: f.member.id })
    plan = d.submitPlan(f.manager, plan.id, { version: plan.version })
    assert.equal(plan.status, 'approved')
    const again = d.reviewPlan(f.manager, plan.id, { version: plan.version, decision: 'approve', comment: '' })
    assert.equal(again.version, plan.version, 'approving twice records nothing new')
    assert.throws(() => d.reviewPlan(f.manager, plan.id, { version: plan.version, decision: 'return', comment: '' }), { status: 400 }, 'sending work back still needs a reason')
    plan = d.reviewPlan(f.manager, plan.id, { version: plan.version, decision: 'return', comment: '补充验收口径' })
    assert.equal(plan.status, 'returned')
  } finally { f.store.close() }
})

test('a member submitting a temporary goal still waits for manager review', () => {
  const f = fixture(), d = f.domain
  try {
    let plan = d.createPlan(f.member, { ...f.planInput, ownerId: f.member.id, isTemporary: true, temporaryReason: '客户临时提出演示需求' })
    plan = d.submitPlan(f.member, plan.id, { version: plan.version })
    assert.equal(plan.status, 'submitted')
  } finally { f.store.close() }
})

test('publishing, changing a published goal and editing your own task need no typed reason', () => {
  const f = fixture(), d = f.domain
  try {
    let plan = d.createPlan(f.manager, { ...f.planInput, ownerId: f.member.id })
    plan = d.submitPlan(f.manager, plan.id, { version: plan.version })
    d.publishMonth(f.manager, plan.month, { planIds: [plan.id], planVersions: { [plan.id]: plan.version } })
    plan = f.store.get<typeof plan>('plans', plan.id)!
    plan = d.updatePlan(f.manager, plan.id, { version: plan.version, dueDate: '2026-09-25' })
    assert.equal(plan.dueDate, '2026-09-25')
    let task = d.createTask(f.member, { title: '验证样本', monthlyPlanId: plan.id, description: '', dueDate: '2026-09-20' })
    task = d.updateTask(f.member, task.id, { version: task.version, title: '验证样本并出报告', dueDate: '2026-09-22' })
    assert.equal(task.title, '验证样本并出报告')
    assert.throws(() => d.updateTask(f.manager, task.id, { version: task.version, dueDate: '2026-09-24' }), { status: 400 }, "changing someone else's commitment needs a reason")
    task = d.updateTask(f.manager, task.id, { version: task.version, dueDate: '2026-09-24', reason: '评审会改期' })
    assert.equal(task.dueDate, '2026-09-24')
  } finally { f.store.close() }
})
