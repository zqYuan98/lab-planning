import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { TestDomain as Domain } from './fixtures/legacy-domain.ts'
import type { AuditEvent, MonthlyPlan, Publication, Task, User } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store)
  t.after(() => store.close())
  const user = (id: string, role: User['role'] = 'member') => store.insert<User>('users', { id, name: id, email: `${id}@transfer.test`, role, active: true, position: '' })
  const manager = user('manager', 'manager'), oldOwner = user('old-owner'), newOwner = user('new-owner'), peer = user('peer')
  let plan = domain.createPlan(manager, { title: '移交月度部署成果', month: '2026-09', ownerId: oldOwner.id, collaboratorIds: [peer.id], category: '研发', expectedOutcome: '完成部署', acceptanceCriteria: '现场验证通过', dueDate: '2026-09-30' })
  plan = domain.submitPlan(manager, plan.id, { version: plan.version })
  plan = domain.reviewPlan(manager, plan.id, { version: plan.version, decision: 'approve' })
  domain.publishMonth(manager, plan.month, { planIds: [plan.id] })
  plan = store.get<MonthlyPlan>('plans', plan.id)!
  const task = (owner = oldOwner) => domain.createTask(owner, { title: '待部署任务', monthlyPlanId: plan.id, dueDate: '2026-09-30' })
  const state = () => ['plans', 'tasks', 'events', 'publications', 'notifications', 'notificationDeliveries'].map(collection => store.list(collection))
  return { store, domain, manager, oldOwner, newOwner, peer, plan, task, state }
}

test('cancelled tasks retain their original history without blocking published goal ownership transfer', t => {
  const f = fixture(t), task = f.task()
  const cancelled = f.domain.cancelTask(f.manager, task.id, { version: task.version, reason: '不再执行，保留历史' })
  const previousPublications = f.store.list<Publication>('publications')
  const taskHistory = f.store.entityEvents('task', task.id)
  const changed = f.domain.updatePlan(f.manager, f.plan.id, { version: f.plan.version, ownerId: f.newOwner.id, collaboratorIds: [], reason: '调整成果负责人' })
  assert.equal(changed.ownerId, f.newOwner.id)
  assert.deepEqual(changed.collaboratorIds, [])
  assert.equal(changed.id, f.plan.id)
  assert.equal(f.store.list('plans').length, 1)
  assert.deepEqual(f.store.get<Task>('tasks', task.id), cancelled)
  assert.deepEqual(f.store.entityEvents('task', task.id), taskHistory)
  assert.deepEqual(f.store.list<Publication>('publications').slice(0, -1), previousPublications)
  assert.equal(f.store.list<Publication>('publications').at(-1)!.plans.find(plan => plan.id === changed.id)!.ownerId, f.newOwner.id)
  const event = f.store.list<AuditEvent>('events').filter(event => event.entityId === f.plan.id).at(-1)!
  assert.equal(event.action, 'published_change')
  assert.equal((event.before as MonthlyPlan).ownerId, f.oldOwner.id)
  assert.equal((event.after as MonthlyPlan).ownerId, f.newOwner.id)
  assert.throws(() => f.domain.planResult(f.oldOwner, changed.id, { version: changed.version, acceptanceStatus: 'submitted', actualOutcome: '旧负责人不再允许提交成果' }), { status: 403 })
})

test('cancelled collaborator tasks do not force that collaborator to remain on the goal', t => {
  const f = fixture(t), task = f.task(f.peer)
  const cancelled = f.domain.cancelTask(f.manager, task.id, { version: task.version, reason: '协作工作不再需要' })
  const changed = f.domain.updatePlan(f.manager, f.plan.id, { version: f.plan.version, collaboratorIds: [], reason: '移出已结束的参与关系' })
  assert.equal(changed.ownerId, f.oldOwner.id)
  assert.deepEqual(changed.collaboratorIds, [])
  assert.deepEqual(f.store.get('tasks', task.id), cancelled)
})

test('an uncancelled task still blocks owner removal even alongside cancelled work or after completion', t => {
  const f = fixture(t), cancelledTask = f.task(), retainedTask = f.task()
  f.domain.cancelTask(f.manager, cancelledTask.id, { version: cancelledTask.version, reason: '重复任务不再使用' })
  const transfer = () => f.domain.updatePlan(f.manager, f.plan.id, { version: f.plan.version, ownerId: f.newOwner.id, collaboratorIds: [], reason: '移交' })
  let before = f.state()
  assert.throws(transfer, { status: 400 })
  assert.deepEqual(f.state(), before)
  f.domain.updateTask(f.oldOwner, retainedTask.id, { version: retainedTask.version, status: 'done', completionNote: '整体完成，仍保留有效关联' })
  before = f.state()
  assert.throws(transfer, { status: 400 })
  assert.deepEqual(f.state(), before)
  const changed = f.domain.updatePlan(f.manager, f.plan.id, { version: f.plan.version, ownerId: f.newOwner.id, collaboratorIds: [f.oldOwner.id], reason: '移交负责人并保留原执行人' })
  assert.equal(changed.ownerId, f.newOwner.id)
  assert.deepEqual(changed.collaboratorIds, [f.oldOwner.id])
})
