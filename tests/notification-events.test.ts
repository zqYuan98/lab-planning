import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { WorkService } from '../server/domain-work.ts'
import { MonthlyService } from '../server/domain-plans.ts'
import { getNotification, openNotification } from '../server/notifications.ts'
import type { Notification } from '../shared/notifications.ts'
import type { MonthlyPlan, User } from '../shared/types.ts'

function fixture() {
  const store = new Store(':memory:'), work = new WorkService(store), monthly = new MonthlyService(store)
  function user(id: string, role: User['role'] = 'member') {
    return store.insert<User>('users', { name: id, email: `${id}@example.test`, position: '', active: true, role })
  }
  const manager = user('manager', 'manager'), member = user('member'), other = user('other'), added = user('added')
  const notifications = (recipientId?: string) => store.list<Notification>('notifications').filter(row => !recipientId || row.recipientId === recipientId)
  const taskInput = (owner = member) => ({ title: '本周验证安排', ownerId: owner.id, dueDate: '2026-09-25', isTemporary: true, temporaryReason: '临时验证工作' })
  const recordInput = (taskId: string, submitted = true) => ({ taskId, weekStart: '2026-09-14', commitment: '完成验证并交付报告', submitted })
  function plan(owner = member, collaboratorIds: string[] = []) {
    return monthly.create(manager, { month: '2026-09', title: '月度验证目标', ownerId: owner.id, collaboratorIds, category: '研发', expectedOutcome: '可核验的测试报告', acceptanceCriteria: '通过质量审核', dueDate: '2026-09-30' })
  }
  function publish(plans: MonthlyPlan[]) {
    for (const row of plans) {
      const submitted = monthly.submit(manager, row.id, { version: row.version })
      monthly.review(manager, row.id, { version: submitted.version, decision: 'approve' })
    }
    monthly.publish(manager, '2026-09', { planIds: plans.map(row => row.id) })
    return plans.map(row => store.get<MonthlyPlan>('plans', row.id)!)
  }
  return { store, work, monthly, manager, member, other, added, notifications, taskInput, recordInput, plan, publish }
}

test('unpublished monthly plans and draft weekly rows cannot announce work assignments', () => {
  const f = fixture()
  try {
    const plan = f.plan()
    const task = f.work.createTask(f.manager, { ...f.taskInput(), monthlyPlanId: plan.id, isTemporary: false })
    let draft = f.work.createWeeklyRecord(f.manager, f.recordInput(task.id, false))
    assert.equal(f.notifications().length, 0)
    f.work.updateTask(f.manager, task.id, { reason: '测试场景确认承诺调整', version: task.version, dueDate: '2026-09-26' })
    draft = f.work.updateWeeklyRecord(f.manager, draft.id, { version: draft.version, commitment: '草稿进一步补充' })
    assert.equal(f.notifications().length, 0)
    f.publish([plan])
    assert.equal(f.notifications().length, 1, 'formal monthly publication is notified independently')
    f.work.updateWeeklyRecord(f.manager, draft.id, { version: draft.version, submitted: true })
    const assignment = f.notifications().at(-1)!
    assert.equal(assignment.kind, 'work_assigned')
    assert.deepEqual(assignment.targets, [{ type: 'weeklyRecord', id: draft.id, weekStart: '2026-09-14' }])
  } finally { f.store.close() }
})

test('first weekly draft publication notifies once; progress and withdrawn drafts stay quiet', () => {
  const f = fixture()
  try {
    const task = f.work.createTask(f.manager, f.taskInput())
    let record = f.work.createWeeklyRecord(f.manager, f.recordInput(task.id, false))
    assert.equal(f.notifications().length, 1)
    record = f.work.updateWeeklyRecord(f.manager, record.id, { version: record.version, submitted: true })
    assert.equal(f.notifications().at(-1)?.kind, 'work_assigned')
    record = f.work.updateWeeklyRecord(f.manager, record.id, { version: record.version, status: 'doing', actualOutcome: '开始第一轮验证' })
    assert.equal(f.notifications().length, 2)
    record = f.work.updateWeeklyRecord(f.manager, record.id, { version: record.version, commitment: '补充第二轮验证结果' })
    assert.equal(f.notifications().at(-1)?.kind, 'work_changed')
    record = f.work.updateWeeklyRecord(f.manager, record.id, { version: record.version, submitted: false })
    f.work.updateWeeklyRecord(f.manager, record.id, { version: record.version, commitment: '尚未发布的草稿调整' })
    assert.equal(f.notifications().length, 3)
  } finally { f.store.close() }
})

test('withdrawing and republishing identical weekly work preserves its notification and acknowledgement', () => {
  const f = fixture()
  try {
    const task = f.work.createTask(f.manager, f.taskInput())
    let record = f.work.createWeeklyRecord(f.manager, f.recordInput(task.id, true))
    const original = f.notifications().at(-1)!
    openNotification(f.store, f.member, original.id, true)
    const acknowledgement = getNotification(f.store, f.member, original.id).acknowledgedAt
    const versions = f.store.list<{ entityId: string; fingerprint: string; eventKey: string; version: number }>('notificationWorkVersions')
    const published = versions.find(value => value.entityId === record.id)!
    assert.ok(published)
    record = f.work.updateWeeklyRecord(f.manager, record.id, { version: record.version, submitted: false })
    record = f.work.updateWeeklyRecord(f.manager, record.id, { version: record.version, status: 'doing', actualOutcome: '完成了第一轮' })
    // A new service instance still reads the durable last notified fingerprint.
    record = new WorkService(f.store).updateWeeklyRecord(f.manager, record.id, { version: record.version, submitted: true })
    record = f.work.updateWeeklyRecord(f.manager, record.id, { version: record.version, submitted: true, commitment: record.commitment })
    assert.equal(f.notifications().length, 2, 'only original task and weekly assignments exist')
    assert.equal(getNotification(f.store, f.member, original.id).acknowledgedAt, acknowledgement)
    assert.equal(getNotification(f.store, f.member, original.id).supersededAt, null)
    assert.equal(getNotification(f.store, f.member, original.id).canAcknowledge, false)
    assert.deepEqual(f.store.list<{ entityId: string }>('notificationWorkVersions').find(value => value.entityId === record.id), published)
  } finally { f.store.close() }
})

test('weekly requirements edited as a draft notify only on republish and create one new confirmation', () => {
  const f = fixture()
  try {
    const task = f.work.createTask(f.manager, f.taskInput())
    let record = f.work.createWeeklyRecord(f.manager, f.recordInput(task.id, true))
    const original = f.notifications().at(-1)!
    openNotification(f.store, f.member, original.id, true)
    const previous = f.store.list<{ entityId: string; fingerprint: string }>('notificationWorkVersions').find(value => value.entityId === record.id)!
    record = f.work.updateWeeklyRecord(f.manager, record.id, { version: record.version, submitted: false })
    record = f.work.updateWeeklyRecord(f.manager, record.id, { version: record.version, commitment: '增加独立复核并交付签字报告' })
    assert.equal(f.notifications().length, 2)
    assert.deepEqual(f.store.list<{ entityId: string }>('notificationWorkVersions').find(value => value.entityId === record.id), previous)
    record = f.work.updateWeeklyRecord(f.manager, record.id, { version: record.version, submitted: true })
    assert.equal(f.notifications().length, 3)
    const updated = f.notifications().at(-1)!
    assert.equal(updated.kind, 'work_changed')
    assert.equal(getNotification(f.store, f.member, updated.id).canAcknowledge, true)
    assert.ok(getNotification(f.store, f.member, original.id).acknowledgedAt)
    assert.ok(getNotification(f.store, f.member, original.id).supersededAt)
    assert.notEqual(f.store.list<{ entityId: string; fingerprint: string }>('notificationWorkVersions').find(value => value.entityId === record.id)?.fingerprint, previous.fingerprint)
    openNotification(f.store, f.member, updated.id, true)
    record = f.work.updateWeeklyRecord(f.manager, record.id, { version: record.version, submitted: false })
    record = f.work.updateWeeklyRecord(f.manager, record.id, { version: record.version, submitted: true })
    assert.equal(f.notifications().length, 3)
    assert.equal(getNotification(f.store, f.member, updated.id).canAcknowledge, false)
  } finally { f.store.close() }
})

test('work notification fingerprints roll back with the enclosing business transaction', () => {
  const f = fixture()
  try {
    assert.throws(() => f.store.transaction(() => {
      const task = f.work.createTask(f.manager, f.taskInput())
      f.work.createWeeklyRecord(f.manager, f.recordInput(task.id, true))
      assert.equal(f.store.list('notificationWorkVersions').length, 2)
      throw new Error('simulate enclosing business failure')
    }), /simulate enclosing business failure/)
    for (const collection of ['tasks', 'weeklyRecords', 'notifications', 'notificationDeliveries', 'notificationObligations', 'notificationWorkVersions']) assert.equal(f.store.list(collection).length, 0, collection)
  } finally { f.store.close() }
})

test('atomic new task and published weekly assignment produce one member notification', () => {
  const f = fixture()
  try {
    const input = { requestId: 'weekly-assignment-request-001', task: f.taskInput(), record: f.recordInput('ignored-client-task-id') }
    const result = f.work.createWeeklyAssignment(f.manager, input)
    const repeated = f.work.createWeeklyAssignment(f.manager, input)
    assert.equal(repeated.task.id, result.task.id)
    assert.equal(repeated.record.id, result.record.id)
    assert.equal(f.notifications().length, 1)
    assert.deepEqual(f.notifications()[0].targets, [{ type: 'weeklyRecord', id: result.record.id, weekStart: '2026-09-14' }])
    assert.deepEqual(f.store.list<{ entityType: string; entityId: string }>('notificationWorkVersions').map(value => [value.entityType, value.entityId]), [['weeklyRecord', result.record.id]])
    assert.throws(() => f.work.createWeeklyAssignment(f.manager, { ...input, record: { ...input.record, commitment: '另一个请求内容' } }), { status: 409 })
  } finally { f.store.close() }
})

test('self-created and manager proxy work remain silent, including later manager edits', () => {
  const f = fixture()
  try {
    const self = f.work.createTask(f.member, f.taskInput())
    f.work.createWeeklyRecord(f.member, f.recordInput(self.id))
    const proxy = f.work.createTask(f.manager, { ...f.taskInput(f.other), creationKind: 'proxy', creationReason: '代录已有工作' })
    const row = f.work.createWeeklyRecord(f.manager, { ...f.recordInput(proxy.id), creationKind: 'proxy', creationReason: '代录已有周安排' })
    f.work.updateTask(f.manager, proxy.id, { reason: '测试场景确认承诺调整', version: proxy.version, dueDate: '2026-09-26' })
    f.work.updateWeeklyRecord(f.manager, row.id, { version: row.version, commitment: '修正代录内容' })
    f.work.updateTask(f.manager, self.id, { reason: '测试场景确认承诺调整', version: self.version, dueDate: '2026-09-27' })
    assert.equal(f.notifications().length, 0)
  } finally { f.store.close() }
})

test('monthly publication groups only each recipient own related goals', () => {
  const f = fixture()
  try {
    const first = f.plan(f.member, [f.other.id]), second = f.plan(f.member), third = f.plan(f.other, [f.added.id])
    f.publish([first, second, third])
    assert.equal(f.notifications().length, 3)
    assert.deepEqual(f.notifications(f.member.id)[0].targets.map(target => target.id), [first.id, second.id])
    assert.deepEqual(f.notifications(f.other.id)[0].targets.map(target => target.id), [first.id, third.id])
    assert.deepEqual(f.notifications(f.added.id)[0].targets.map(target => target.id), [third.id])
    assert.equal(f.notifications(f.added.id)[0].actionable, false)
    assert.equal(f.notifications(f.member.id)[0].eventKey, f.notifications(f.other.id)[0].eventKey)
    assert.notEqual(f.notifications(f.member.id)[0].id, f.notifications(f.other.id)[0].id)
  } finally { f.store.close() }
})

test('collaborator-only changes notify added and removed people without resetting an owner acknowledgement', () => {
  const f = fixture()
  try {
    let [plan] = f.publish([f.plan(f.member, [f.other.id])])
    const original = f.notifications(f.member.id)[0]
    openNotification(f.store, f.member, original.id, true)
    plan = f.monthly.update(f.manager, plan.id, { version: plan.version, collaboratorIds: [f.other.id, f.added.id], reason: '新增支持成员' })
    assert.equal(f.notifications(f.member.id).length, 1)
    assert.equal(f.notifications(f.other.id).length, 1)
    assert.equal(f.notifications(f.added.id).length, 1)
    assert.equal(f.notifications(f.added.id)[0].actionable, false)
    let ownerView = getNotification(f.store, f.member, original.id)
    assert.ok(ownerView.acknowledgedAt)
    assert.equal(ownerView.supersededAt, null)
    plan = f.monthly.update(f.manager, plan.id, { version: plan.version, collaboratorIds: [f.added.id], reason: '调整支持成员' })
    const removed = f.notifications(f.other.id).at(-1)!
    assert.equal(removed.kind, 'participation_removed')
    assert.equal(removed.targets.length, 0)
    assert.doesNotMatch(removed.body, /月度验证目标/)
    assert.equal(f.notifications(f.member.id).length, 1)
    ownerView = getNotification(f.store, f.member, original.id)
    assert.ok(ownerView.acknowledgedAt)
    assert.equal(ownerView.supersededAt, null)
  } finally { f.store.close() }
})

test('promoting a current collaborator to owner creates their first acknowledgement requirement', () => {
  const f = fixture()
  try {
    const [plan] = f.publish([f.plan(f.member, [f.other.id])])
    assert.equal(f.notifications(f.other.id)[0].actionable, false)
    f.monthly.update(f.manager, plan.id, { version: plan.version, ownerId: f.other.id, collaboratorIds: [f.member.id], reason: '变更负责人' })
    const changed = f.notifications(f.other.id).at(-1)!
    assert.equal(changed.kind, 'plan_changed')
    assert.equal(changed.actionable, true)
    assert.equal(getNotification(f.store, f.other, changed.id).canAcknowledge, true)
    assert.equal(f.notifications(f.member.id).length, 1)
  } finally { f.store.close() }
})

test('substantive published goal changes create a new owner acknowledgement requirement', () => {
  const f = fixture()
  try {
    const [plan] = f.publish([f.plan(f.member, [f.other.id])])
    const original = f.notifications(f.member.id)[0]
    openNotification(f.store, f.member, original.id, true)
    f.monthly.update(f.manager, plan.id, { version: plan.version, dueDate: '2026-09-29', reason: '提前验收时间' })
    const changed = f.notifications(f.member.id).at(-1)!
    assert.equal(changed.kind, 'plan_changed')
    assert.equal(getNotification(f.store, f.member, changed.id).canAcknowledge, true)
    assert.ok(getNotification(f.store, f.member, original.id).acknowledgedAt)
    assert.ok(getNotification(f.store, f.member, original.id).supersededAt)
  } finally { f.store.close() }
})
