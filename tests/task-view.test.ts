import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { Task, User, WeeklyRecord } from '../shared/types.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { TaskViewService } from '../server/task-view.ts'
import { ObjectGrantService } from '../server/object-grants.ts'
import { getOperationEpoch } from '../server/operation-context.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), view = new TaskViewService(store), grants = new ObjectGrantService(store)
  t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id, role, name: id, email: `${id}@test.invalid`, active: true, position: '' })
  const manager = user('manager', 'manager'), member = user('member', 'member'), other = user('other', 'member'), observer = user('observer', 'observer')
  const task = domain.createTask(member, { title: '统一任务详情', description: '预期成果说明', dueDate: '2026-09-30', currentProgress: '总体说明', isTemporary: true, temporaryReason: 'SECRET_PRIVATE_REASON' })
  let counter = 0
  const grant = (input: Record<string, unknown> = {}) => grants.grant(manager, { requestId: `view-grant-command-${++counter}`, subjectId: observer.id, objectType: 'task', objectId: task.id, objectVersion: store.get<Task>('tasks', task.id)!.version, capabilities: ['read'], reason: '明确只读范围', ...input })
  const weekly = (weekStart: string, submitted = true) => domain.createWeeklyRecord(member, { taskId: task.id, weekStart, commitment: '周阶段承诺', actualOutcome: submitted ? `阶段成果 ${weekStart}` : 'SECRET_PRIVATE_DRAFT', submitted })
  const epoch = getOperationEpoch(store)
  return { store, domain, view, grants, manager, member, other, observer, task, grant, weekly, epoch }
}

test('task detail works with collaboration disabled, retains independent task and weekly status, and validates navigation targets', t => {
  const f = fixture(t), week = f.weekly('2026-09-21')
  const finished = f.domain.updateWeeklyRecord(f.member, week.id, { version: week.version, status: 'done', actualOutcome: '本周阶段完成' })
  const view = f.view.view(f.member, f.task.id, { section: 'weekly', weeklyRecordId: week.id })
  assert.equal(view.task.id, f.task.id)
  assert.equal(view.task.status, 'todo')
  assert.equal(view.weeklyRecords.find(row => row.id === week.id)?.status, 'done')
  assert.equal(view.weeklyRecords.find(row => row.id === week.id)?.version, finished.version)
  assert.equal(view.enabled, false)
  assert.equal(view.allowedActions.includes('edit_task'), true)
  assert.equal(view.readOnlyReason, null)
  assert.equal(view.ownerName, f.member.name)
  assert.throws(() => f.view.view(f.member, f.task.id, { section: 'admin-secrets' }), { status: 400 })
  assert.throws(() => f.view.view(f.member, f.task.id, { weeklyRecordId: ['wrong-type'] }), { status: 400 })
  const otherTask = f.domain.createTask(f.other, { title: '另一成员任务', dueDate: '2026-09-30', isTemporary: true, temporaryReason: '专项' })
  const otherWeek = f.domain.createWeeklyRecord(f.other, { taskId: otherTask.id, weekStart: '2026-09-21', commitment: '不能越权定位', submitted: false })
  assert.throws(() => f.view.view(f.manager, f.task.id, { section: 'weekly', weeklyRecordId: otherWeek.id }), { status: 404 })
  assert.throws(() => f.view.view(f.other, f.task.id), { status: 404 })
})

test('editable projections return latest versions, only whitelisted form fields and current operation epoch', t => {
  const f = fixture(t), week = f.weekly('2026-09-21', false)
  const annotated = f.store.update<Task>('tasks', f.task.id, f.task.version, { importSource: { batchId: 'SECRET_IMPORT_BATCH', sourceId: 'source', rowId: 'row', sourceStatus: '历史' }, workOrigin: { kind: 'proxy', actorId: f.manager.id, reason: 'SECRET_PROXY_REASON' } })
  const current = f.domain.updateTask(f.member, annotated.id, { reason: '测试场景确认承诺调整', version: annotated.version, title: '最新任务标题', currentProgress: '服务端最新进展' })
  const task = f.view.editableTask(f.member, f.task.id)
  assert.equal(task.version, current.version)
  assert.equal(task.values.title, '最新任务标题')
  assert.equal(task.values.currentProgress, '服务端最新进展')
  assert.equal(task.operationEpoch, f.epoch)
  for (const key of ['id', 'ownerId', 'monthlyPlanId', 'importSource', 'workOrigin', 'temporaryReason', 'createdAt', 'updatedAt', 'cancellation']) assert.equal(Object.hasOwn(task.values, key), false, key)
  const changed = f.domain.updateWeeklyRecord(f.member, week.id, { version: week.version, commitment: '服务端最新承诺', actualOutcome: '最新周成果' })
  const editable = f.view.editableWeekly(f.member, week.id)
  assert.equal(editable.version, changed.version)
  assert.equal(editable.values.commitment, '服务端最新承诺')
  assert.equal(editable.values.actualOutcome, '最新周成果')
  for (const key of ['taskId', 'ownerId', 'weekStart', 'monthlyPlanId', 'importSource', 'workOrigin', 'deletion', 'planApproval']) assert.equal(Object.hasOwn(editable.values, key), false, key)
  assert.throws(() => f.view.editableTask(f.other, f.task.id), { status: 404 })
  assert.throws(() => f.view.editableWeekly(f.other, week.id), { status: 404 })
  assert.throws(() => f.view.editableTask(f.observer, f.task.id), { status: 403 })
})

test('deleted weekly and cancelled task remain authorized history but cannot provide an editable recovery projection', t => {
  const f = fixture(t), week = f.weekly('2026-09-21', false)
  const deleted = f.domain.deleteWeeklyRecord(f.manager, week.id, { version: week.version, reason: '周安排重复' })
  assert.throws(() => f.view.editableWeekly(f.member, week.id), { status: 409, code: 'WEEKLY_RECORD_DELETED' })
  assert.equal(f.view.view(f.member, f.task.id, { section: 'history', weeklyRecordId: week.id }).weeklyRecords[0].version, deleted.version)
  const cancelled = f.domain.cancelTask(f.manager, f.task.id, { version: f.task.version, reason: '已取消的任务范围' })
  assert.throws(() => f.view.editableTask(f.member, f.task.id), { status: 409, code: 'TASK_CANCELLED' })
  const historical = f.view.view(f.member, f.task.id, { section: 'history' })
  assert.equal(historical.task.version, cancelled.version)
  assert.deepEqual(historical.allowedActions, [])
  assert.match(historical.readOnlyReason!, /作废/)
  assert.equal(historical.taskHistory.items.some(row => row.kind === 'delete'), true)
  assert.equal(historical.taskHistory.items.some(row => row.kind === 'cancel'), true)
})

test('observer task detail applies history boundary, submitted-only filtering, evidence capability and no raw audit or private causes', t => {
  const f = fixture(t), old = f.weekly('2026-09-21'), draft = f.weekly('2026-09-28', false)
  const changed = f.domain.updateTask(f.member, f.task.id, { version: f.task.version, evidenceUrl: 'https://evidence.test/PRIVATE_FILE', reason: 'SECRET_AUDIT_REASON' })
  let grant = f.grant()
  const current = f.view.view(f.observer, f.task.id)
  assert.equal(current.task.version, changed.version)
  assert.equal(current.weeklyRecords.length, 0)
  assert.equal(current.taskHistory.items.length, 0)
  assert.deepEqual(current.allowedActions, [])
  assert.ok(current.readOnlyReason)
  assert.equal(current.task.evidenceUrl, undefined)
  assert.equal(JSON.stringify(current).includes('SECRET_'), false)
  assert.throws(() => f.view.view(f.observer, f.task.id, { weeklyRecordId: old.id }), { status: 404 })
  const newer = f.weekly('2026-10-05')
  assert.deepEqual(f.view.view(f.observer, f.task.id).weeklyRecords.map(row => row.id), [newer.id])
  grant = f.grant({ version: grant.version, historyPolicy: 'all_history', capabilities: ['read', 'read_evidence'] })
  const full = f.view.view(f.observer, f.task.id, { section: 'weekly', weeklyRecordId: old.id })
  assert.deepEqual(full.weeklyRecords.map(row => row.id).sort(), [old.id, newer.id].sort())
  assert.equal(full.weeklyRecords.some(row => row.id === draft.id), false)
  assert.equal(full.task.evidenceUrl, 'https://evidence.test/PRIVATE_FILE')
  assert.equal(JSON.stringify(full).includes('SECRET_'), false)
  for (const item of full.taskHistory.items) for (const field of ['before', 'after', 'reason']) assert.equal(Object.hasOwn(item, field), false)
  f.grants.revoke(f.manager, grant.id, { requestId: 'view-revoke-command', version: grant.version, reason: '访问范围已撤回' })
  assert.throws(() => f.view.view(f.observer, f.task.id), { status: 404 })
  assert.throws(() => f.view.history(f.observer, f.task.id), { status: 404 })
})

test('task history pages are read-only and scope-bound to actor, object and grant changes', t => {
  const f = fixture(t)
  let task = f.task
  for (const title of ['第一版', '第二版', '第三版']) task = f.domain.updateTask(f.member, task.id, { reason: '测试场景确认承诺调整', version: task.version, title })
  const before = ['events', 'tasks', 'weeklyRecords', 'objectGrants', 'operationContexts'].map(name => f.store.list(name))
  const first = f.view.history(f.member, task.id, { limit: 1 })
  assert.equal(first.items.length, 1)
  assert.ok(first.nextCursor)
  const second = f.view.history(f.member, task.id, { cursor: first.nextCursor!, limit: 1 })
  assert.notEqual(second.items[0].id, first.items[0].id)
  assert.deepEqual(['events', 'tasks', 'weeklyRecords', 'objectGrants', 'operationContexts'].map(name => f.store.list(name)), before)
  assert.throws(() => f.view.history(f.manager, task.id, { cursor: first.nextCursor! }), { status: 409, code: 'ACCESS_SCOPE_CHANGED' })
  const otherTask = f.domain.createTask(f.member, { title: '另一个本人任务', dueDate: '2026-09-30', isTemporary: true, temporaryReason: '专项' })
  assert.throws(() => f.view.history(f.member, otherTask.id, { cursor: first.nextCursor! }), { status: 409, code: 'ACCESS_SCOPE_CHANGED' })
  const grant = f.grant({ historyPolicy: 'all_history' }), observerPage = f.view.history(f.observer, task.id, { limit: 1 })
  assert.ok(observerPage.nextCursor)
  f.grant({ version: grant.version, historyPolicy: 'current_onward' })
  assert.throws(() => f.view.history(f.observer, task.id, { cursor: observerPage.nextCursor! }), { status: 409, code: 'ACCESS_SCOPE_CHANGED' })
  assert.throws(() => f.view.history(f.member, task.id, { limit: 101 }), { status: 400 })
})

test('editable weekly authorization includes parent task scope even when a historical record still names the prior owner', t => {
  const f = fixture(t), week = f.weekly('2026-09-21', false)
  f.store.update<Task>('tasks', f.task.id, f.task.version, { ownerId: f.other.id })
  assert.throws(() => f.view.editableWeekly(f.member, week.id), { status: 404 })
  assert.throws(() => f.view.editableTask(f.member, f.task.id), { status: 404 })
  assert.equal(f.view.editableWeekly(f.manager, week.id).version, week.version)
  assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', week.id)?.ownerId, f.member.id)
})
