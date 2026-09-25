import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AuditEvent, Entity, MonthlyPlan, Project, Publication, Task, User, WeeklyRecord } from '../shared/types.ts'
import { Store } from '../server/store.ts'
import { readImportContext, readImportDirectory } from '../server/import-context.ts'
import { readBusinessExportSources } from '../server/business-export-read.ts'
import { exportBusinessData } from '../server/data-transfer.ts'
import { ImportService } from '../server/import-service.ts'
import { createImportRouter, closeImportServices } from '../server/import-routes.ts'
import { TaskDeliveryService } from '../server/task-deliveries.ts'
import { TaskSupportService } from '../server/task-support.ts'
import { participates } from '../server/plan-visibility.ts'
import { legacyBootstrap } from './fixtures/r2-baseline/domain.ts'

const at = '2026-09-24T04:00:00.000Z'
function fixture(t: TestContext) {
  const store = new Store(':memory:')
  t.after(() => { closeImportServices(store); store.close() })
  const put = <T extends Entity>(collection: string, row: Omit<T, keyof Entity> & Partial<Entity>) => store.restoreEntity<T>(collection, { version: 1, createdAt: at, updatedAt: at, ...row } as T)
  const user = (id: string, role: User['role']) => put<User>('users', { id, name: id, role, email: `${id}@internal-read.invalid`, position: '', active: true })
  const manager = user('manager', 'manager'), member = user('member', 'member'), peer = user('peer', 'member'), observer = user('observer', 'observer')
  const project = put<Project>('projects', { id: 'project', name: '项目名称', code: 'IMPORT-PROJECT', description: '', ownerId: member.id, status: 'active' })
  const plan = (id: string, patch: Partial<MonthlyPlan> = {}) => put<MonthlyPlan>('plans', { id, month: '2026-09', title: id, projectId: project.id, category: '', ownerId: member.id, collaboratorIds: [], expectedOutcome: '授权成果', acceptanceCriteria: '验收标准', dueDate: '2026-09-30', priority: 'medium', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', ...patch })
  const task = (id: string, patch: Partial<Task> = {}) => put<Task>('tasks', { id, title: id, monthlyPlanId: null, ownerId: member.id, description: '', dueDate: '2026-09-30', status: 'doing', isTemporary: false, temporaryReason: '', ...patch })
  const weekly = (task: Task, id: string, patch: Partial<WeeklyRecord> = {}) => put<WeeklyRecord>('weeklyRecords', { id, taskId: task.id, monthlyPlanId: task.monthlyPlanId, ownerId: task.ownerId, weekStart: '2026-09-21', commitment: id, actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'doing', submitted: true, ...patch })
  const audit = (id: string, entityType: string, entityId: string, before: unknown, after: unknown, patch: Partial<AuditEvent> = {}) => put<AuditEvent>('events', { id, entityType, entityId, actorId: manager.id, action: 'update', reason: '隐私审核说明', before, after, ...patch })
  return { store, put, manager, member, peer, observer, project, plan, task, weekly, audit }
}

test('import compatibility context equals the frozen reader without reading unrelated work collections', t => {
  const f = fixture(t), current = f.plan('current'), historical = f.plan('historical', { ownerId: f.peer.id, version: 4 })
  f.audit('membership', 'plan', historical.id, { ...historical, version: 2, ownerId: f.member.id, title: '过去本人内容' }, historical)
  f.plan('merged', { status: 'merged' })
  const archived = f.put<Project>('projects', { ...f.project, id: 'archived', code: 'ARCHIVED', status: 'archived' })
  f.plan('archived-project', { projectId: archived.id })
  const owned = f.task('owned', { monthlyPlanId: current.id })
  f.audit('create-owned', 'task', owned.id, null, owned, { action: 'create' })
  f.weekly(owned, 'weekly')
  const missing = { ...owned, id: 'missing', title: '历史保留任务', monthlyPlanId: historical.id }
  f.audit('missing', 'task', missing.id, missing, { ...missing, title: '同版本不覆盖' })
  f.weekly(missing, 'missing-weekly')
  const cancelled = f.task('cancelled', { cancellation: { cancelledAt: at, cancelledBy: f.manager.id, reason: '作废' } })
  f.weekly(cancelled, 'cancelled-weekly')
  f.weekly({ ...missing, id: 'deleted-only' }, 'deleted', { deletion: { deletedAt: at, deletedBy: f.member.id, reason: '删除' } })
  f.task('private', { ownerId: f.peer.id })
  for (const actor of [f.manager, f.member, f.peer]) {
    const baseline = legacyBootstrap(f.store, actor), plans = actor.role === 'manager' ? baseline.plans : baseline.plans.filter(plan => {
      const current = f.store.get<MonthlyPlan>('plans', plan.id)
      return current && current.visibility !== 'reference' && participates(current, actor.id) && current.status !== 'merged'
        && (!current.projectId || baseline.projects.some(project => project.id === current.projectId && project.status === 'active'))
    })
    const list = f.store.list.bind(f.store)
    const guard = t.mock.method(f.store, 'list', <T>(collection: string): T[] => {
      assert.ok(!['tasks', 'plans', 'weeklyRecords', 'events', 'publications', 'annualGoals', 'reports', 'progressEvents', 'settings'].includes(collection), `unexpected full read ${collection}`)
      return list<T>(collection)
    })
    assert.deepEqual(readImportContext(f.store, actor), { users: baseline.users, projects: baseline.projects, plans, tasks: baseline.tasks })
    guard.mock.restore()
  }
  assert.throws(() => readImportContext(f.store, f.observer), { status: 403 })
  f.store.update<User>('users', f.member.id, f.member.version, { role: 'observer' })
  assert.throws(() => readImportContext(f.store, f.member), { status: 403 }, 'stale role cannot bypass current authorization')
})

test('business export sources preserve the entire authorized set, tombstones, historical snapshots and safe references', t => {
  const f = fixture(t), hidden = f.plan('hidden', { ownerId: f.peer.id }), historical = f.plan('historical', { ownerId: f.peer.id, version: 5 })
  const oldPlan = { ...historical, ownerId: f.member.id, version: 2, title: '本人历史目标' }
  f.audit('membership', 'plan', historical.id, oldPlan, historical)
  f.put<Publication>('publications', { id: 'publication', month: '2026-09', revision: 1, actorId: f.manager.id, reason: '发布原因', plans: [oldPlan] })
  const owned = f.task('owned', { monthlyPlanId: hidden.id })
  f.weekly(owned, 'deleted-weekly', { deletion: { deletedAt: at, deletedBy: f.member.id, reason: '删除' } })
  const missing = { ...owned, id: 'missing', monthlyPlanId: historical.id, version: 3 }
  f.audit('missing-first', 'task', missing.id, missing, { ...missing, title: '等版本后置不覆盖' })
  f.weekly(missing, 'missing-weekly')
  const cancelled = f.task('cancelled', { cancellation: { cancelledAt: at, cancelledBy: f.manager.id, reason: '作废' } })
  f.weekly(cancelled, 'cancelled-weekly')
  f.task('private', { ownerId: f.peer.id })
  for (const actor of [f.manager, f.member, f.peer]) {
    const baseline = legacyBootstrap(f.store, actor, false, true)
    const expected = Object.fromEntries(['users', 'projects', 'annualGoals', 'plans', 'tasks', 'weeklyRecords', 'publications', 'reports'].map(key => [key, baseline[key as keyof typeof baseline]]))
    const list = f.store.list.bind(f.store)
    const guard = t.mock.method(f.store, 'list', <T>(collection: string): T[] => {
      assert.ok(!['progressEvents', 'settings', 'operationContexts', 'objectGrants', 'events'].includes(collection), `unexpected derived-data read ${collection}`)
      return list<T>(collection)
    })
    assert.deepEqual(readBusinessExportSources(f.store, actor), expected)
    guard.mock.restore()
  }
  assert.throws(() => readBusinessExportSources(f.store, f.observer), { status: 403 })
})

test('export includes rows past the interactive page limit and their complete authorized dependency closure', t => {
  const f = fixture(t), plan = f.plan('tail-plan')
  for (let index = 0; index < 125; index++) {
    const task = f.task(`task-${index}`, { monthlyPlanId: plan.id })
    f.weekly(task, `weekly-${index}`)
  }
  const full = exportBusinessData(f.store, f.member)
  assert.equal(full.collections.tasks.length, 125)
  assert.equal(full.collections.weeklyRecords.length, 125)
  const filtered = exportBusinessData(f.store, f.member, { type: 'weeklyRecords', month: '2026-09', projectId: f.project.id })
  assert.ok(filtered.collections.weeklyRecords.some(row => row.id === 'weekly-124'))
  assert.ok(filtered.collections.tasks.some(row => row.id === 'task-124'))
  assert.ok(filtered.collections.plans.some(row => row.id === plan.id))
  assert.ok(filtered.collections.projects.some(row => row.id === f.project.id))
  assert.ok(filtered.collections.users.some(row => row.id === f.member.id))
})

test('import matching reads only its directory and the compatibility HTTP route uses the dedicated context', async t => {
  const f = fixture(t), service = new ImportService(f.store)
  t.after(() => service.close())
  const directory = readImportDirectory(f.store, f.member)
  assert.equal(directory.users.length, 4)
  const list = f.store.list.bind(f.store)
  const guard = t.mock.method(f.store, 'list', <T>(collection: string): T[] => {
    assert.ok(!['plans', 'tasks', 'weeklyRecords', 'events', 'progressEvents', 'reports', 'annualGoals', 'publications'].includes(collection), `name matching unnecessarily reads ${collection}`)
    return list<T>(collection)
  })
  const batch = service.structured(f.member, { sourceKey: 'precise-directory', mode: 'history', rows: [{ kind: 'monthly', title: '匹配来源', ownerName: f.member.name, projectName: f.project.code, month: '2026-09', dueDate: '2026-09-30' }] })
  assert.equal(batch.rows[0].ownerId, f.member.id)
  assert.equal(batch.rows[0].projectId, f.project.id)
  guard.mock.restore()
  const app = express()
  app.use((req, _res, next) => { req.user = f.member; next() })
  app.use(createImportRouter(f.store))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/context`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), readImportContext(f.store, f.member))
})

test('historical task snapshots never authorize a later owner delivery or decision export', t => {
  const f = fixture(t), task = f.task('legacy-reassigned'), deliveries = new TaskDeliveryService(f.store, () => new Date(at))
  f.weekly(task, 'original-owner-weekly')
  const original = deliveries.submit(f.member, task.id, { requestId: 'original-submission', taskVersion: task.version, previousRevision: 0,
    actualOutcome: '原责任人成果', evidenceRefs: [], acceptanceCriteria: '原验收标准', reviewerId: f.manager.id })
  const returned = deliveries.decide(f.manager, original.delivery.id, { requestId: 'original-return', seriesVersion: original.series.version,
    action: 'review', conclusion: 'returned', note: '原结果需补齐' })
  // Existing migration history can retain an old owner's weekly record even though
  // ordinary task edits now forbid reassignment. It is still a supported export input.
  const current = f.store.update<Task>('tasks', task.id, task.version, { ownerId: f.peer.id })
  f.audit('legacy-owner-change', 'task', task.id, task, current)
  const revised = deliveries.submit(f.peer, task.id, { requestId: 'new-owner-submission', taskVersion: current.version, seriesId: original.series.id,
    seriesVersion: returned.series.version, previousRevision: 1, previousSubmissionId: original.delivery.id,
    actualOutcome: 'PRIVATE-NEW-OWNER-OUTCOME', evidenceRefs: ['PRIVATE-NEW-OWNER-EVIDENCE'], acceptanceCriteria: 'PRIVATE-NEW-OWNER-CRITERIA', reviewerId: f.manager.id })
  deliveries.decide(f.manager, revised.delivery.id, { requestId: 'new-owner-review', seriesVersion: revised.series.version,
    action: 'review', conclusion: 'accepted', note: 'PRIVATE-NEW-OWNER-REVIEW' })
  const decision = new TaskSupportService(f.store, () => new Date(at)).createDecision(f.manager, { requestId: 'new-owner-decision', taskId: task.id,
    taskVersion: current.version, blockerEpisodeId: null, question: 'PRIVATE-NEW-OWNER-QUESTION', options: ['PRIVATE-NEW-OWNER-OPTION'],
    decisionOwnerId: f.manager.id, responseDueAt: '2026-09-25T04:00:00.000Z', reason: 'PRIVATE-NEW-OWNER-REASON' })
  const assertNoRawObjects = () => {
    for (const type of ['all', 'tasks', 'weeklyRecords'] as const) {
      const packet = exportBusinessData(f.store, f.member, { type })
      assert.equal(packet.collections.tasks.find(row => row.id === task.id)?.ownerId, f.member.id, 'own frozen task remains as the weekly dependency')
      for (const collection of ['deliverySeries', 'taskDeliveries', 'deliveryDecisions', 'decisionRequests'] as const) assert.equal(packet.collections[collection].length, 0, `${type}:${collection}`)
      assert.doesNotMatch(JSON.stringify(packet), /PRIVATE-NEW-OWNER/)
    }
  }
  assertNoRawObjects()
  for (const actor of [f.manager, f.peer]) {
    const packet = exportBusinessData(f.store, actor, { type: 'tasks' })
    assert.equal(packet.collections.deliverySeries.length, 1)
    assert.deepEqual(packet.collections.taskDeliveries.map(row => row.id), [original.delivery.id, revised.delivery.id])
    assert.deepEqual(packet.collections.taskDeliveries, [original.delivery, revised.delivery], 'immutable submission snapshots remain intact')
    assert.equal(packet.collections.deliveryDecisions.length, 2)
    assert.equal(packet.collections.decisionRequests[0]?.id, decision.id)
    assert.match(JSON.stringify(packet), /PRIVATE-NEW-OWNER-OUTCOME/)
  }
  f.store.update<User>('users', f.peer.id, f.peer.version, { active: false })
  const inactiveOwner = exportBusinessData(f.store, f.manager, { type: 'tasks' })
  assert.equal(inactiveOwner.collections.taskDeliveries.length, 2, 'deactivated responsibility does not truncate manager history')
  assert.equal(inactiveOwner.collections.users.find(row => row.id === f.peer.id)?.active, false)
  assert.throws(() => exportBusinessData(f.store, f.peer), { status: 403 })
  f.store.delete('tasks', current.id, current.version)
  assertNoRawObjects()
  const managerHistory = exportBusinessData(f.store, f.manager, { type: 'tasks' })
  assert.equal(managerHistory.collections.taskDeliveries.length, 2, 'manager keeps the complete history even without a live task')
  assert.equal(managerHistory.collections.decisionRequests[0]?.id, decision.id)
})
