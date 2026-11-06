import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AuditEvent, Entity, MonthlyPlan, Publication, Task, User, WeeklyRecord } from '../shared/types.ts'
import { isActiveMonthlyPlan } from '../shared/monthly-plan-state.ts'
import { Domain } from '../server/domain.ts'
import { Store } from '../server/store.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { getOperationEpoch } from '../server/operation-context.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store)
  t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.restoreEntity<StoredUser>('users', {
    id, version: 1, createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z',
    name: id, email: `${id}@plan-delete.test`, role, active: true, position: '', credentialVersion: 1, passwordHash: 'unused-test-credentials',
  })
  const manager = user('manager', 'manager'), member = user('member', 'member'), peer = user('peer', 'member'), observer = user('observer', 'observer')
  const input = { month: '2026-11', title: '重复的月度目标', category: '部门工作', expectedOutcome: '交付研究报告', acceptanceCriteria: '提交评审', dueDate: '2026-11-30' }
  const plan = (actor = manager, extra: Record<string, unknown> = {}) => domain.createPlan(actor, { ...input, ...(actor.role === 'member' ? { isTemporary: true, temporaryReason: '成员补充提报' } : {}), ...extra })
  const remove = (actor: User, row: MonthlyPlan) => domain.deletePlan(actor, row.id, { version: row.version, reason: '与已导入目标重复，保留已导入目标' })
  return { store, domain, manager, member, peer, observer, input, plan, remove }
}

test('manager can delete each unpublished review state without erasing status, audit, source or retained goal', t => {
  const f = fixture(t), retained = f.plan()
  for (const status of ['draft', 'returned', 'submitted', 'approved'] as const) {
    let plan = f.plan(f.manager, { ownerId: f.member.id })
    if (status !== 'draft') plan = f.domain.submitPlan(f.manager, plan.id, { version: plan.version })
    if (status === 'returned' || status === 'approved') plan = f.domain.reviewPlan(f.manager, plan.id, { version: plan.version, decision: status === 'returned' ? 'return' : 'approve', comment: '重复待核对' })
    const source = f.store.insert<Entity & { sourceIdentity: string; planId: string; sourceKey: string }>('dingtalkSourceItems', { sourceIdentity: `source-${status}`, planId: plan.id, sourceKey: status })
    const beforeHistory = f.domain.planHistory(f.manager, plan.id)
    assert.deepEqual(f.domain.planDeletionPreview(f.manager, plan.id), { plan, canDelete: true, blockers: [] })
    const deleted = f.remove(f.manager, plan)
    assert.equal(deleted.status, status)
    assert.equal(deleted.version, plan.version + 1)
    assert.equal(deleted.deletion?.deletedBy, f.manager.id)
    assert.equal(isActiveMonthlyPlan(deleted), false)
    assert.deepEqual(f.store.get('plans', plan.id), deleted)
    assert.deepEqual(f.store.get('dingtalkSourceItems', source.id), source)
    assert.deepEqual(f.store.get('plans', retained.id), retained)
    const history = f.domain.planHistory(f.manager, plan.id)
    assert.deepEqual(history.slice(0, -1), beforeHistory)
    assert.equal(history.at(-1)?.action, 'delete')
    assert.deepEqual(history.at(-1)?.before, plan)
    assert.deepEqual(history.at(-1)?.after, deleted)
    assert.equal(f.domain.planDeletionPreview(f.manager, plan.id).canDelete, false)
    assert.throws(() => f.remove(f.manager, deleted), { status: 409 })
  }
})

test('members can delete their own temporary drafts and returned plans; peers, observers and pending review are blocked', t => {
  const f = fixture(t)
  const draft = f.plan(f.member, { collaboratorIds: [f.peer.id] })
  for (const actor of [f.peer, f.observer]) {
    assert.throws(() => f.domain.planDeletionPreview(actor, draft.id), { status: 403 })
    assert.throws(() => f.remove(actor, draft), { status: 403 })
  }
  assert.equal(f.domain.planDeletionPreview(f.member, draft.id).canDelete, true)
  f.remove(f.member, draft)
  const proposed = f.plan(f.member)
  const submitted = f.domain.submitPlan(f.member, proposed.id, { version: proposed.version })
  assert.equal(f.domain.planDeletionPreview(f.member, proposed.id).canDelete, false)
  assert.throws(() => f.remove(f.member, submitted), { status: 409 })
  const returned = f.domain.reviewPlan(f.manager, proposed.id, { version: submitted.version, decision: 'return', comment: '重复目标，请本人核对删除' })
  const deleted = f.remove(f.member, returned)
  assert.equal(deleted.deletion?.deletedBy, f.member.id)
  assert.equal(f.domain.planHistory(f.member, deleted.id).at(-1)?.action, 'delete')
})

test('legacy self-created ordinary proposals are deletable but assignments, imported and unproven legacy origins are not', t => {
  const f = fixture(t)
  const legacy = () => f.store.insert<MonthlyPlan>('plans', { ...f.input, projectId: null, ownerId: f.member.id, collaboratorIds: [], priority: 'medium', status: 'returned', reviewComment: '重复', publishedVersion: null, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '' })
  const own = legacy()
  f.store.insert<AuditEvent>('events', { entityType: 'plan', entityId: own.id, actorId: f.member.id, action: 'create', before: null, after: own, reason: '' })
  assert.equal(f.domain.planDeletionPreview(f.member, own.id).canDelete, true)
  f.remove(f.member, own)
  const assigned = f.plan(f.manager, { ownerId: f.member.id })
  const imported = legacy()
  f.store.insert<AuditEvent>('events', { entityType: 'plan', entityId: imported.id, actorId: f.member.id, action: 'create', before: null, after: imported, reason: '' })
  const importedWithSource = f.store.update<MonthlyPlan>('plans', imported.id, imported.version, { importSource: { batchId: 'batch', sourceId: 'source', rowId: 'row', sourceStatus: '' } })
  for (const plan of [assigned, importedWithSource, legacy()]) {
    const preview = f.domain.planDeletionPreview(f.member, plan.id)
    assert.equal(preview.canDelete, false)
    assert.ok(preview.blockers.some(reason => reason.includes('管理者')))
    assert.throws(() => f.remove(f.member, plan), { status: 403 })
    assert.equal(f.domain.planDeletionPreview(f.manager, plan.id).canDelete, true)
  }
})

test('fresh actor, reason and version are required and failed audits roll deletion back', t => {
  const f = fixture(t), plan = f.plan()
  for (const version of [undefined, 0, plan.version + 1]) assert.throws(() => f.domain.deletePlan(f.manager, plan.id, { version, reason: '重复' }), { status: 409 })
  assert.throws(() => f.domain.deletePlan(f.manager, plan.id, { version: plan.version, reason: ' ' }), { status: 400 })
  const updated = f.domain.updatePlan(f.manager, plan.id, { version: plan.version, title: '审核期间更新的目标' })
  assert.throws(() => f.remove(f.manager, plan), { status: 409 })
  const originalInsert = f.store.insert.bind(f.store)
  f.store.insert = ((collection: string, row: never) => { if (collection === 'events') throw new Error('audit unavailable'); return originalInsert(collection, row) }) as typeof f.store.insert
  assert.throws(() => f.remove(f.manager, updated), /audit unavailable/)
  f.store.insert = originalInsert
  assert.deepEqual(f.store.get('plans', updated.id), updated)
  f.store.update<User>('users', f.manager.id, f.manager.version, { role: 'member', active: false })
  assert.throws(() => f.domain.planDeletionPreview(f.manager, updated.id), { status: 403 })
  assert.throws(() => f.remove(f.manager, updated), { status: 403 })
})

test('publication, merged status and execution evidence block deletion even when status was reset to draft', t => {
  const f = fixture(t)
  const patches: Partial<MonthlyPlan>[] = [
    { status: 'published' }, { status: 'merged' }, { publishedVersion: 1 }, { actualOutcome: '已有成果' },
    { acceptanceStatus: 'submitted' }, { acceptanceStatus: 'accepted' }, { acceptanceNote: '验收说明' }, { rootCause: '已复盘' }, { remedy: '改进措施' },
  ]
  for (const patch of patches) {
    const draft = f.plan(), plan = f.store.update<MonthlyPlan>('plans', draft.id, draft.version, patch)
    assert.equal(f.domain.planDeletionPreview(f.manager, plan.id).canDelete, false, JSON.stringify(patch))
    assert.throws(() => f.remove(f.manager, plan), { status: 409 }, JSON.stringify(patch))
  }
  const plan = f.plan()
  const publication = f.store.insert<Publication>('publications', { month: plan.month, revision: 1, actorId: f.manager.id, reason: '历史发布', plans: [{ ...plan, status: 'published', publishedVersion: 1 }] })
  assert.throws(() => f.remove(f.manager, plan), { status: 409 })
  assert.deepEqual(f.store.get('publications', publication.id), publication)
  const historical = f.plan()
  f.store.insert<AuditEvent>('events', { entityType: 'plan', entityId: historical.id, actorId: f.manager.id, action: 'publish', before: historical, after: { ...historical, status: 'published', publishedVersion: 2 }, reason: '旧发布记录' })
  assert.throws(() => f.remove(f.manager, historical), { status: 409 }, 'a reset current row cannot erase publication evidence from audit')
})

test('dependency checks re-run at commit and preserve tasks and weekly records without cascades', t => {
  const f = fixture(t), plan = f.plan(f.manager, { ownerId: f.member.id })
  assert.equal(f.domain.planDeletionPreview(f.manager, plan.id).canDelete, true)
  const task = f.domain.createTask(f.member, { title: '已拆分任务', monthlyPlanId: plan.id, dueDate: '2026-11-20' })
  const record = f.domain.createWeeklyRecord(f.member, { taskId: task.id, weekStart: '2026-11-02', commitment: '先保存草稿', submitted: false })
  assert.throws(() => f.remove(f.manager, plan), { status: 409 })
  assert.deepEqual(f.store.get('tasks', task.id), task)
  assert.deepEqual(f.store.get('weeklyRecords', record.id), record)
  const deletedRecord = f.domain.deleteWeeklyRecord(f.manager, record.id, { version: record.version, reason: '重复安排' })
  const cancelledTask = f.domain.cancelTask(f.manager, task.id, { version: task.version, reason: '重复任务' })
  assert.equal(f.domain.planDeletionPreview(f.manager, plan.id).canDelete, true)
  f.remove(f.manager, plan)
  assert.deepEqual(f.store.get('tasks', task.id), cancelledTask)
  assert.deepEqual(f.store.get('weeklyRecords', record.id), deletedRecord)
})

test('carry and merge references and evidence on inactive dependencies prevent removal', t => {
  const f = fixture(t)
  for (const relation of ['sourcePlanId', 'mergedIntoId', 'mergedFromIds'] as const) {
    const plan = f.plan(), linked = f.plan()
    f.store.update<MonthlyPlan>('plans', linked.id, linked.version, { [relation]: relation === 'mergedFromIds' ? [plan.id] : plan.id })
    assert.throws(() => f.remove(f.manager, plan), { status: 409 }, relation)
  }
  const workflowPlan = f.plan()
  f.store.insert<Entity & { sourcePlanId: string; targetPlanId: string; status: string }>('carryWorkflows', { sourcePlanId: workflowPlan.id, targetPlanId: 'another-goal', status: 'awaiting_publication' })
  assert.throws(() => f.remove(f.manager, workflowPlan), { status: 409 })
  const evidencePlan = f.plan(f.manager, { ownerId: f.member.id })
  const task = f.domain.createTask(f.member, { title: '已有成果的任务', monthlyPlanId: evidencePlan.id, dueDate: '2026-11-20' })
  const cancelled = f.domain.cancelTask(f.manager, task.id, { version: task.version, reason: '不再执行' })
  f.store.update<Task>('tasks', task.id, cancelled.version, { completionNote: '保留的真实成果' })
  assert.throws(() => f.remove(f.manager, evidencePlan), { status: 409 })
})

test('withdrawn and deleted weekly submissions retain evidence that blocks deletion', t => {
  const f = fixture(t), plan = f.plan(f.manager, { ownerId: f.member.id })
  const task = f.domain.createTask(f.member, { title: '有历史周提报', monthlyPlanId: plan.id, dueDate: '2026-11-20' })
  const record = f.domain.createWeeklyRecord(f.member, { taskId: task.id, weekStart: '2026-11-02', commitment: '历史周计划', submitted: false })
  f.store.insert<AuditEvent>('events', { entityType: 'weeklyRecord', entityId: record.id, actorId: f.member.id, action: 'submit', before: record, after: { ...record, submitted: true }, reason: '' })
  f.domain.deleteWeeklyRecord(f.manager, record.id, { version: record.version, reason: '已撤回旧周安排' })
  f.domain.cancelTask(f.manager, task.id, { version: task.version, reason: '不再执行' })
  assert.ok(f.domain.planDeletionPreview(f.manager, plan.id).blockers.some(reason => reason.includes('提交、成果')))
  assert.throws(() => f.remove(f.manager, plan), { status: 409 })
})

test('deleted plans reject all current mutations and new task or weekly associations while history stays readable', t => {
  const f = fixture(t), plan = f.plan(f.manager, { ownerId: f.member.id })
  const deleted = f.remove(f.manager, plan), input = { version: deleted.version }
  const second = f.plan()
  const commands = [
    () => f.domain.updatePlan(f.manager, plan.id, { ...input, title: '复活' }),
    () => f.domain.submitPlan(f.manager, plan.id, input),
    () => f.domain.reviewPlan(f.manager, plan.id, { ...input, decision: 'approve' }),
    () => f.domain.publishMonth(f.manager, plan.month, { planIds: [plan.id], planVersions: { [plan.id]: deleted.version } }),
    () => f.domain.mergePlans(f.manager, { planIds: [plan.id, second.id], title: '合并', reason: '重复' }),
    () => f.domain.planResult(f.manager, plan.id, { ...input, acceptanceStatus: 'accepted', actualOutcome: '不能写入' }),
    () => f.domain.carryPlan(f.manager, plan.id, { requestId: 'deleted-plan-carry-request', sourceVersion: deleted.version, month: '2026-12', dueDate: '2026-12-31', reason: '不能承接', operationEpoch: getOperationEpoch(f.store) }),
    () => f.domain.createTask(f.member, { title: '不能新增', monthlyPlanId: plan.id, dueDate: '2026-11-20' }),
  ]
  for (const command of commands) assert.throws(command, { status: 409 })
  const task = f.domain.createTask(f.member, { title: '修复异常关联', isTemporary: true, temporaryReason: '无目标', dueDate: '2026-11-20' })
  assert.throws(() => f.domain.relinkTask(f.manager, task.id, { version: task.version, monthlyPlanId: plan.id, reason: '不能关联' }), { status: 409 })
  const staleTask = f.store.update<Task>('tasks', task.id, task.version, { monthlyPlanId: plan.id, isTemporary: false })
  assert.throws(() => f.domain.createWeeklyRecord(f.member, { taskId: task.id, weekStart: '2026-11-02', commitment: '不能新增' }), { status: 409 })
  assert.throws(() => f.domain.updateTask(f.member, task.id, { version: staleTask.version, status: 'doing' }), { status: 409 })
  const staleRecord = f.store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, monthlyPlanId: plan.id, ownerId: f.member.id, weekStart: '2026-11-02', commitment: '异常旧草稿', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'planned', submitted: false })
  assert.throws(() => f.domain.updateWeeklyRecord(f.member, staleRecord.id, { version: staleRecord.version, actualOutcome: '不能改' }), { status: 409 })
  assert.throws(() => f.domain.carryWeeklyRecord(f.member, staleRecord.id, { weekStart: '2026-11-09' }), { status: 409 })
  assert.equal(f.domain.planHistory(f.manager, plan.id).at(-1)?.action, 'delete')
  assert.deepEqual(f.store.get('plans', plan.id), deleted)
})

test('HTTP deletion routes enforce authentication, origin, owner scope and optimistic concurrency', async t => {
  const f = fixture(t), plan = f.plan(f.member)
  const server = createApp({ store: f.store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const cookie = (actor: StoredUser) => `lab_session=${createSession(f.store, actor)}`
  const memberCookie = cookie(f.member), peerCookie = cookie(f.peer)
  const send = (path: string, session: string, method = 'GET', body?: unknown, from = origin) => fetch(`${origin}/api${path}`, { method, headers: { cookie: session, origin: from, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
  assert.equal((await send(`/plans/${plan.id}/deletion-preview`, '')).status, 401)
  assert.equal((await send(`/plans/${plan.id}/deletion-preview`, peerCookie)).status, 403)
  const preview = await send(`/plans/${plan.id}/deletion-preview`, memberCookie)
  assert.equal(preview.status, 200)
  assert.equal((await preview.json() as { canDelete: boolean }).canDelete, true)
  const input = { version: plan.version, reason: '与导入目标重复' }
  assert.equal((await send(`/plans/${plan.id}`, memberCookie, 'DELETE', input, 'https://attacker.example')).status, 403)
  assert.equal((await send(`/plans/${plan.id}`, memberCookie, 'DELETE', { ...input, version: 99 })).status, 409)
  const response = await send(`/plans/${plan.id}`, memberCookie, 'DELETE', input)
  assert.equal(response.status, 200)
  assert.equal((await response.json() as MonthlyPlan).deletion?.deletedBy, f.member.id)
  assert.equal((await send(`/plans/${plan.id}/history`, memberCookie)).status, 200)
})
