import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AuditEvent, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { ProgressEvent } from '../shared/collaboration.ts'
import { Domain } from '../server/domain.ts'
import { Store } from '../server/store.ts'
import { TaskViewService } from '../server/task-view.ts'
import { ObjectGrantService } from '../server/object-grants.ts'
import { TaskDeliveryService } from '../server/task-deliveries.ts'
import { workProgressProjector } from '../server/work-progress.ts'
import { rotateOperationEpoch } from '../server/operation-context.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), view = new TaskViewService(store)
  t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id, name: id, email: `${id}@task-access.test`, role, active: true, position: '' })
  const manager = user('manager', 'manager'), member = user('member', 'member'), peer = user('peer', 'member'), observer = user('observer', 'observer')
  const task = domain.createTask(member, { title: '同一任务', isTemporary: true, temporaryReason: '测试', dueDate: '2026-09-30' })
  return { store, domain, view, manager, member, peer, observer, task }
}

test('member progress filters other-owner weekly facts and historical task audits before computing latest execution', t => {
  const f = fixture(t)
  const row = f.store.insert<WeeklyRecord>('weeklyRecords', { taskId: f.task.id, ownerId: f.peer.id, monthlyPlanId: null, weekStart: '2026-09-21', commitment: '他人承诺', actualOutcome: '不能泄露的他人成果', evidenceUrl: '', blocker: '', nextAction: '', status: 'done', submitted: true })
  f.store.insert<ProgressEvent>('progressEvents', { taskId: f.task.id, weeklyRecordId: row.id, ownerId: f.peer.id, actorId: f.peer.id, mutationId: 'foreign', source: 'weeklyRecord', noteType: 'progress', note: row.actualOutcome, noChangeReason: '', nextAction: '', proxyReason: '', changes: [{ field: 'weeklyRecord.actualOutcome', before: '', after: row.actualOutcome }], meaningfulOwnerProgress: true, occurredAt: '2026-09-22T01:00:00.000Z', auditEventIds: [] })
  f.store.insert<AuditEvent>('events', { entityType: 'task', entityId: f.task.id, actorId: f.peer.id, action: 'update', reason: '私密原因', before: null, after: { ...f.task, ownerId: f.peer.id, currentProgress: '不能泄露的原负责人进展' } })
  const member = f.view.view(f.member, f.task.id)
  assert.equal(member.progress.latestExecution, null)
  assert.equal(member.progress.historicalExecution.length, 0)
  assert.equal(member.taskHistory.items.some(item => item.detail.includes('私密')), false)
  assert.equal(JSON.stringify(f.domain.bootstrap(f.member).taskProgress).includes('不能泄露'), false)
  assert.ok(JSON.stringify(workProgressProjector(f.store, f.manager, new Date('2026-09-22T08:00:00.000Z'))(f.task)).includes('不能泄露'))
  assert.throws(() => workProgressProjector(f.store, f.observer), { status: 403 })
})

test('task parent goal follows historical membership projection and unavailable parents remain references', t => {
  const f = fixture(t)
  let plan = f.domain.createPlan(f.manager, { month: '2026-09', title: '原来可见的目标', category: '研发', ownerId: f.member.id, collaboratorIds: [], expectedOutcome: '成果', acceptanceCriteria: '验证', dueDate: '2026-09-30', priority: 'medium' })
  plan = f.domain.updatePlan(f.manager, plan.id, { version: plan.version, ownerId: f.peer.id, title: '后来其他成员的目标' })
  // Legacy task references may survive a historical membership without current participation.
  f.store.update<Task>('tasks', f.task.id, f.task.version, { monthlyPlanId: plan.id })
  assert.equal(f.view.view(f.member, f.task.id).monthlyPlan?.title, '原来可见的目标')
  assert.equal(f.view.view(f.manager, f.task.id).monthlyPlan?.title, '后来其他成员的目标')
  const foreign = f.store.insert<MonthlyPlan>('plans', { ...plan, id: 'unseen-parent', ownerId: f.peer.id, title: '从未可见的父目标' })
  const current = f.store.get<Task>('tasks', f.task.id)!
  f.store.update<Task>('tasks', current.id, current.version, { monthlyPlanId: foreign.id })
  assert.equal(f.view.view(f.member, f.task.id).monthlyPlan?.title, '历史月度目标引用')
})

test('observer initial history exposes a continuation and restores invalidate saved cursors', t => {
  const f = fixture(t)
  for (let i = 0; i < 35; i++) f.store.insert<AuditEvent>('events', { id: `history-${String(i).padStart(2, '0')}`, entityType: 'task', entityId: f.task.id, actorId: f.member.id, action: `update-${i}`, reason: '不应公开的理由', before: f.task, after: f.task })
  new ObjectGrantService(f.store).grant(f.manager, { requestId: 'task-history-grant', subjectId: f.observer.id, objectType: 'task', objectId: f.task.id, objectVersion: f.task.version, capabilities: ['read'], historyPolicy: 'all_history', reason: '允许历史' })
  const first = f.view.view(f.observer, f.task.id).taskHistory
  assert.equal(first.items.length, 30)
  assert.ok(first.nextCursor)
  const second = f.view.history(f.observer, f.task.id, { cursor: first.nextCursor })
  assert.equal(second.items.length, 6)
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 36)
  assert.equal(JSON.stringify(first).includes('不应公开'), false)
  rotateOperationEpoch(f.store)
  assert.throws(() => f.view.history(f.observer, f.task.id, { cursor: first.nextCursor }), { status: 409, code: 'ACCESS_SCOPE_CHANGED' })
})

test('authorized task history includes delivery submission and decision facts without raw audit snapshots', t => {
  const f = fixture(t), deliveries = new TaskDeliveryService(f.store)
  const submitted = deliveries.submit(f.member, f.task.id, { requestId: 'history-submit-command', taskVersion: f.task.version, previousRevision: 0, actualOutcome: '成果', evidenceRefs: [], acceptanceCriteria: '通过', reviewerId: f.manager.id })
  deliveries.decide(f.manager, submitted.delivery.id, { requestId: 'history-review-command', seriesVersion: submitted.series.version, action: 'review', conclusion: 'accepted', note: '符合要求' })
  const history = f.view.history(f.member, f.task.id)
  assert.ok(history.items.some(row => row.title === '成果提交 · submit'))
  assert.ok(history.items.some(row => row.title === '验收决定 · review'))
  assert.ok(history.items.every(row => !('before' in row) && !('after' in row)))
})

test('weekly completion conflict exposes the authorized related task version for an explicitly reviewed retry', t => {
  const f = fixture(t)
  const weekly=f.domain.createWeeklyRecord(f.member,{taskId:f.task.id,weekStart:'2026-09-21',commitment:'阶段交付'})
  const changed=f.domain.updateTask(f.member,f.task.id,{version:f.task.version,status:'doing',currentProgress:'服务器已更新任务'})
  const input={version:weekly.version,status:'done',actualOutcome:'整个任务已经交付',completeTask:true,taskVersion:f.task.version}
  assert.throws(()=>f.domain.updateWeeklyRecord(f.member,weekly.id,input),{status:409,code:'VERSION_CONFLICT'})
  const current=f.view.editableWeekly(f.member,weekly.id)
  assert.deepEqual(current.relatedTask,{id:f.task.id,version:changed.version,status:'doing',completionNote:''})
  assert.throws(()=>f.view.editableWeekly(f.peer,weekly.id),{status:404})
  const saved=f.domain.updateWeeklyRecord(f.member,weekly.id,{...input,version:current.version,taskVersion:current.relatedTask!.version})
  assert.equal(saved.status,'done')
  assert.equal(f.store.get<Task>('tasks',f.task.id)?.completionNote,input.actualOutcome)
})
