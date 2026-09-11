import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { exportBusinessData } from '../server/data-transfer.ts'
import { ExistingPlanWriter } from '../server/existing-plan-writer.ts'
import { ImportService, type HistoricalRecord } from '../server/import-service.ts'
import { createApp } from '../server/app.ts'
import type { AuditEvent, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { ImportBatch } from '../shared/import-types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), imports = new ImportService(store)
  const manager = domain.setup({ name: 'Manager', email: 'manager@scope.test', password: 'Scope-password-123!' })
  const member = domain.createUser(manager, { name: 'Member A', email: 'a@scope.test', password: 'Scope-password-123!', role: 'member' })
  const peer = domain.createUser(manager, { name: 'Member B', email: 'b@scope.test', password: 'Scope-password-123!', role: 'member' })
  const input = { month: '2026-09', title: 'Shared team goal', category: 'Research', expectedOutcome: 'Team deliverable', acceptanceCriteria: 'Team acceptance', dueDate: '2026-09-30', ownerId: member.id, collaboratorIds: [peer.id] }
  const publish = (plan: MonthlyPlan) => {
    plan = domain.submitPlan(manager, plan.id, { version: plan.version })
    plan = domain.reviewPlan(manager, plan.id, { version: plan.version, decision: 'approve' })
    domain.publishMonth(manager, plan.month, { planIds: [plan.id] })
    return store.get<MonthlyPlan>('plans', plan.id)!
  }
  const plan = publish(domain.createPlan(manager, input))
  const work = (owner: User, goal = plan) => {
    const task = domain.createTask(owner, { monthlyPlanId: goal.id, title: `${owner.name} private task`, description: `${owner.name} private source`, dueDate: goal.dueDate })
    const week = domain.createWeeklyRecord(owner, { taskId: task.id, weekStart: '2026-09-07', commitment: `${owner.name} private commitment`, submitted: true })
    return { task, week }
  }
  t.after(() => { imports.close(); store.close() })
  return { store, domain, imports, manager, member, peer, input, plan, publish, work }
}

test('shared goal owner and participants only read their own tasks and weeks through bootstrap and dependency exports', t => {
  const f = fixture(t), a = f.work(f.member), b = f.work(f.peer)
  for (const [actor, own, hidden] of [[f.member, a, b], [f.peer, b, a]] as const) {
    const visible = f.domain.bootstrap(actor)
    assert.deepEqual(visible.tasks.map(task => task.id), [own.task.id])
    assert.deepEqual(visible.weeklyRecords.map(week => week.id), [own.week.id])
    assert.equal(visible.plans[0].id, f.plan.id)
    for (const type of ['all', 'plans', 'tasks', 'weeklyRecords'] as const) {
      const packet = exportBusinessData(f.store, actor, { type })
      assert.ok(packet.collections.tasks.every(task => task.ownerId === actor.id))
      assert.ok(packet.collections.weeklyRecords.every(week => week.ownerId === actor.id))
      assert.ok(!JSON.stringify(packet).includes(hidden.task.title))
      assert.ok(!JSON.stringify(packet).includes(hidden.week.commitment))
    }
  }
  assert.equal(f.domain.bootstrap(f.manager).tasks.length, 2)
  assert.equal(exportBusinessData(f.store, f.manager).collections.weeklyRecords.length, 2)
})

test('former participants receive authorized historical goal snapshots with no later content or transition prose', t => {
  const f = fixture(t)
  const privateBefore = f.domain.createPlan(f.manager, { ...f.input, title: 'BEFORE_JOIN_SECRET', collaboratorIds: [] })
  let joined = f.domain.updatePlan(f.manager, privateBefore.id, { version: privateBefore.version, title: 'Authorized shared version', collaboratorIds: [f.peer.id], reason: 'BEFORE_JOIN_SECRET' })
  joined = f.publish(joined)
  let removed = f.domain.updatePlan(f.manager, joined.id, { version: joined.version, collaboratorIds: [], title: 'AFTER_EXIT_SECRET', expectedOutcome: 'AFTER_EXIT_SECRET', reason: 'AFTER_EXIT_SECRET' })
  removed = f.domain.updatePlan(f.manager, removed.id, { version: removed.version, actualOutcome: 'ignored', title: 'LATER_SECRET', reason: 'LATER_SECRET' })
  const visible = f.domain.bootstrap(f.peer)
  assert.equal(visible.plans.find(plan => plan.id === joined.id)!.title, joined.title)
  const history = f.domain.planHistory(f.peer, joined.id)
  assert.ok(history.length > 0)
  for (const value of [visible, history, exportBusinessData(f.store, f.peer)]) {
    const json = JSON.stringify(value)
    for (const secret of ['BEFORE_JOIN_SECRET', 'AFTER_EXIT_SECRET', 'LATER_SECRET']) assert.ok(!json.includes(secret), secret)
  }
  assert.ok(JSON.stringify(f.domain.planHistory(f.manager, joined.id)).includes('LATER_SECRET'))
  assert.ok(!history.some(event => event.entityId !== joined.id))
  assert.ok(history.some(event => event.after === null))
})

test('merged source prose is projected for member reads and result responses while administrators keep immutable raw provenance', t => {
  const f = fixture(t)
  const submit = (owner: User, secret: string) => {
    const plan = f.domain.createPlan(f.manager, { ...f.input, ownerId: owner.id, collaboratorIds: [], expectedOutcome: secret, acceptanceCriteria: secret })
    return f.domain.submitPlan(f.manager, plan.id, { version: plan.version })
  }
  const first = submit(f.member, 'A_SOURCE_SECRET'), second = submit(f.peer, 'B_SOURCE_SECRET')
  let merged = f.domain.mergePlans(f.manager, { planIds: [first.id, second.id], title: 'Unified team outcome', reason: 'B_SOURCE_SECRET' })
  f.domain.publishMonth(f.manager, merged.month, { planIds: [merged.id] })
  merged = f.store.get<MonthlyPlan>('plans', merged.id)!
  const result = f.domain.planResult(f.member, merged.id, { version: merged.version, acceptanceStatus: 'submitted', actualOutcome: 'Overall team result' })
  assert.equal(result.actualOutcome, 'Overall team result')
  for (const actor of [f.member, f.peer]) {
    const bootstrap = f.domain.bootstrap(actor)
    const goal = bootstrap.plans.find(plan => plan.id === merged.id)!
    for (const item of [goal, bootstrap.publications, f.domain.planHistory(actor, merged.id), result]) {
      assert.ok(!JSON.stringify(item).includes('A_SOURCE_SECRET'))
      assert.ok(!JSON.stringify(item).includes('B_SOURCE_SECRET'))
    }
  }
  assert.ok(f.store.get<MonthlyPlan>('plans', merged.id)!.expectedOutcome.includes('B_SOURCE_SECRET'))
  const raw = f.domain.planHistory(f.manager, merged.id).find(event => event.action === 'merge_create')!
  assert.equal((raw.before as MonthlyPlan[]).length, 2)
  let carried = f.publish(f.domain.carryPlan(f.manager, merged.id, { month: '2026-10', dueDate: '2026-10-30', reason: '跨月继续' }))
  carried = f.publish(f.domain.carryPlan(f.manager, carried.id, { month: '2026-11', dueDate: '2026-11-30', reason: '再次承接' }))
  for (const actor of [f.member, f.peer]) {
    for (const item of [f.domain.bootstrap(actor), f.domain.planHistory(actor, carried.id), exportBusinessData(f.store, actor)]) {
      // Each actor may still read their own original source; peer source must stay private through carries.
      assert.ok(!JSON.stringify(item).includes(actor.id === f.member.id ? 'B_SOURCE_SECRET' : 'A_SOURCE_SECRET'))
    }
  }
})

test('team goal mutations and monthly imports require manager authority; personal task writes reject owner and goal tampering', t => {
  const f = fixture(t), draft = f.domain.createPlan(f.manager, f.input)
  for (const operation of [
    () => f.domain.createPlan(f.member, f.input),
    () => f.domain.updatePlan(f.member, draft.id, { version: draft.version, title: 'tampered' }),
    () => f.domain.submitPlan(f.member, draft.id, { version: draft.version }),
    () => f.domain.carryPlan(f.member, f.plan.id, { month: '2026-10', dueDate: '2026-10-30', reason: 'tampered' }),
    () => new ExistingPlanWriter(f.store, f.member, { id: 'batch', sourceId: 'source' }),
    () => f.domain.createTask(f.member, { monthlyPlanId: f.plan.id, ownerId: f.peer.id, title: 'tampered', dueDate: f.plan.dueDate }),
  ]) assert.throws(operation, { status: 403 })
  const privateGoal = f.domain.createPlan(f.manager, { ...f.input, ownerId: f.peer.id, collaboratorIds: [] })
  assert.throws(() => f.domain.createTask(f.member, { monthlyPlanId: privateGoal.id, title: 'tampered', dueDate: privateGoal.dueDate }), { status: 403 })
  for (const mode of ['draft', 'existing']) {
    const batch = f.imports.structured(f.member, { sourceKey: mode, mode, rows: [{ kind: 'monthly', ...f.input }] })
    assert.throws(() => f.imports.commit(f.member, batch.id, { version: batch.version }), { status: 403 })
  }
  assert.equal(f.store.list<Task>('tasks').length, 0)
})

test('member can edit and commit the visible subset after an import row is reassigned', t => {
  const f = fixture(t)
  let batch = f.imports.structured(f.member, { sourceKey: 'reassigned-edit', mode: 'history', rows: [
    { kind: 'weekly', title: '本人的资料', ownerId: f.member.id, sourceRow: 1 },
    { kind: 'weekly', title: '重新分配的资料', ownerId: f.member.id, sourceRow: 2 },
  ] })
  batch = f.imports.edit(f.manager, batch.id, { version: batch.version, rows: batch.rows.map((row, index) => index ? { ...row, ownerId: f.peer.id } : row) })
  const visible = f.imports.get(f.member, batch.id)
  assert.equal(visible.rows.length, 1)
  const edited = f.imports.edit(f.member, batch.id, { version: visible.version, rows: visible.rows.map(row => ({ ...row, title: '本人校对后的资料' })) })
  const completed = f.imports.commit(f.member, batch.id, { version: edited.version })
  assert.equal(completed.status, 'committed')
  assert.equal(f.store.list<HistoricalRecord>('historicalRecords').length, 1)
  const admin = f.imports.get(f.manager, batch.id)
  assert.equal(admin.status, 'parsed')
  assert.equal(admin.rows[1].ownerId, f.peer.id)
  assert.equal(admin.rows[1].result, undefined)
  f.imports.commit(f.manager, admin.id, { version: admin.version })
  assert.equal(f.store.list<HistoricalRecord>('historicalRecords').length, 2)
})

test('legacy import results and reassigned historical rows cannot expose peer work through get, history or export', t => {
  const f = fixture(t), a = f.work(f.member), b = f.work(f.peer)
  const batch = f.imports.structured(f.member, { sourceKey: 'legacy', rows: [{ kind: 'weekly', ownerId: f.member.id, title: 'Own source', taskId: a.task.id }] })
  const row = { ...batch.rows[0], taskId: b.task.id, result: { collection: 'weeklyRecords', id: b.week.id } }
  f.store.update<ImportBatch>('importBatches', batch.id, batch.version, { rows: [row, { ...row, id: 'peer-row', ownerId: f.peer.id, sourceText: 'PEER_IMPORTED_SECRET' }] })
  f.store.insert<HistoricalRecord>('historicalRecords', { importedBy: f.member.id, batchId: batch.id, sourceId: batch.sourceId, row: { ...row, ownerId: f.peer.id, sourceText: 'PEER_IMPORTED_SECRET' } })
  const visible = f.imports.get(f.member, batch.id)
  assert.equal(visible.rows.length, 1)
  assert.equal(visible.rows[0].taskId, '')
  assert.equal(visible.rows[0].result, undefined)
  assert.equal(f.imports.history(f.member).length, 0)
  assert.ok(!JSON.stringify(exportBusinessData(f.store, f.member)).includes('PEER_IMPORTED_SECRET'))
  assert.equal(f.imports.get(f.manager, batch.id).rows.length, 2)
  const imported = f.imports.structured(f.manager, { sourceKey: 'imported-omissions', mode: 'existing', rows: [{ kind: 'monthly', ownerId: f.member.id, month: '2026-09', title: 'Imported legacy goal' }] })
  const committed = f.imports.commit(f.manager, imported.id, { version: imported.version })
  const exported = exportBusinessData(f.store, f.member).collections.plans.find(plan => plan.id === committed.rows[0].result!.id)!
  assert.equal(exported.dueDate, '')
  assert.equal(exported.expectedOutcome, '')
  assert.ok(exported.importSource, 'genuine import provenance allows original omitted fields without inventing them')
})

test('legacy ownership changes only backfill personal task snapshots and unaudited goal links receive minimal references', t => {
  const f = fixture(t), a = f.work(f.member)
  const privatePlan = f.domain.createPlan(f.manager, { ...f.input, ownerId: f.peer.id, collaboratorIds: [], title: 'CURRENT_PRIVATE_GOAL' })
  const reassigned = f.store.update<Task>('tasks', a.task.id, a.task.version, { ownerId: f.peer.id, monthlyPlanId: privatePlan.id, title: 'CURRENT_PRIVATE_TASK', description: 'CURRENT_PRIVATE_TEXT' })
  f.store.insert<AuditEvent>('events', { entityType: 'task', entityId: a.task.id, actorId: f.manager.id, action: 'legacy_reassign', before: a.task, after: reassigned, reason: '' })
  const rawGoal = f.store.insert<MonthlyPlan>('plans', { ...privatePlan, id: 'legacy-unaudited-goal', title: 'UNAUTHORIZED_GOAL_CONTENT' })
  f.store.insert<Task>('tasks', { ...a.task, id: 'legacy-own-task', monthlyPlanId: rawGoal.id })
  const visible = f.domain.bootstrap(f.member)
  assert.equal(visible.tasks.find(task => task.id === a.task.id)!.title, a.task.title)
  assert.equal(visible.tasks.find(task => task.id === a.task.id)!.ownerId, f.member.id)
  assert.equal(visible.plans.find(plan => plan.id === rawGoal.id)!.expectedOutcome, '')
  assert.equal(visible.plans.find(plan => plan.id === rawGoal.id)!.month, rawGoal.month)
  for (const value of [visible, exportBusinessData(f.store, f.member)]) {
    assert.ok(!JSON.stringify(value).includes('CURRENT_PRIVATE'))
    assert.ok(!JSON.stringify(value).includes('UNAUTHORIZED_GOAL_CONTENT'))
  }
  const reference = f.store.insert<MonthlyPlan>('plans', { ...f.plan, id: 'restored-reference', visibility: 'reference' })
  assert.throws(() => f.domain.createTask(f.member, { monthlyPlanId: reference.id, title: 'new task', dueDate: f.plan.dueDate }), { status: 400 })
})

test('HTTP shared-goal scope covers import candidates and rejects guessed task, weekly and monthly mutation IDs', async t => {
  const f = fixture(t), a = f.work(f.member), b = f.work(f.peer)
  const server = createApp({ store: f.store, enableScheduler: false }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let cookie = ''
  const request = async (path: string, body?: unknown, method = body ? 'POST' : 'GET', status = 200) => {
    const response = await fetch(origin + '/api' + path, { method, headers: { origin, cookie, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0]
    const value = await response.json()
    assert.equal(response.status, status, JSON.stringify(value))
    return value
  }
  try {
    await request('/auth/login', { email: f.member.email, password: 'Scope-password-123!' })
    for (const path of ['/bootstrap', '/context', '/data/export?format=json']) {
      const value = await request(path)
      assert.ok(!JSON.stringify(value).includes(b.task.title))
      assert.ok(!JSON.stringify(value).includes(b.week.commitment))
    }
    await request(`/tasks/${b.task.id}`, { version: b.task.version, title: 'tampered' }, 'PATCH', 403)
    await request('/weekly-records', { taskId: b.task.id, weekStart: '2026-09-14', commitment: 'tampered' }, 'POST', 403)
    await request(`/weekly-records/${b.week.id}`, { version: b.week.version, actualOutcome: 'tampered' }, 'PATCH', 403)
    await request(`/weekly-records/${b.week.id}/carry`, { weekStart: '2026-09-14' }, 'POST', 403)
    await request('/tasks', { ownerId: f.peer.id, monthlyPlanId: f.plan.id, title: 'tampered', dueDate: f.plan.dueDate }, 'POST', 403)
    await request(`/plans/${f.plan.id}`, { version: f.plan.version, title: 'tampered' }, 'PATCH', 403)
    assert.equal(f.store.get<Task>('tasks', a.task.id)!.ownerId, f.member.id)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
