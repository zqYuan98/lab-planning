import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../server/store.ts'
import { GoalOwnerService } from '../server/goal-owner.ts'
import { readScopeVersion, canPerformAction } from '../server/object-access.ts'
import { TaskViewService } from '../server/task-view.ts'
import { getOperationEpoch } from '../server/operation-context.ts'
import { applyMigrations } from '../server/storage-migrations.ts'
import type { MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close())
  getOperationEpoch(store)
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id, name: id, email: `${id}@owner.invalid`, role, position: '', active: true })
  const manager = user('manager', 'manager'), lead = user('lead', 'member'), worker = user('worker', 'member'), peer = user('peer', 'member'), observer = user('observer', 'observer')
  const plan = store.insert<MonthlyPlan>('plans', { id: 'goal', month: '2026-09', title: '共同目标', projectId: null, category: '', ownerId: lead.id, collaboratorIds: [worker.id, peer.id], expectedOutcome: '成果', acceptanceCriteria: '验收', dueDate: '2026-09-30', priority: 'medium', status: 'published', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', reviewComment: '' })
  const task = store.insert<Task>('tasks', { id: 'task', title: '关联任务', monthlyPlanId: plan.id, ownerId: worker.id, description: '私有背景不能经派生入口读取', dueDate: '2026-09-30', status: 'doing', isTemporary: false, temporaryReason: '', evidenceUrl: 'https://private.invalid/evidence', decisionNeeded: '私有协调', currentProgress: '此前无关项目正文' })
  const weekly = (id: string, patch: Partial<WeeklyRecord> = {}) => store.insert<WeeklyRecord>('weeklyRecords', { id, taskId: task.id, ownerId: worker.id, monthlyPlanId: plan.id, weekStart: '2026-09-21', commitment: '本周承诺', actualOutcome: '共享周进展', evidenceUrl: 'https://private.invalid/evidence', blocker: '', nextAction: '继续', status: 'doing', submitted: true, ...patch })
  return { store, service: new GoalOwnerService(store), manager, lead, worker, peer, observer, plan, task, weekly }
}

test('goal owner reads only current linked task and submitted progress projections, without acquiring private APIs or writes', t => {
  const f = fixture(t)
  f.weekly('visible'); f.weekly('draft', { submitted: false, actualOutcome: '私密草稿' })
  f.weekly('former-link', { monthlyPlanId: 'former-goal', actualOutcome: '此前目标进展' })
  f.weekly('former-owner', { ownerId: f.peer.id, actualOutcome: '此前负责人进展' })
  f.weekly('deleted', { deletion: { deletedAt: new Date().toISOString(), deletedBy: f.worker.id, reason: '移除' } })
  const tasks = f.service.tasks(f.lead, f.plan.id, {})
  assert.equal(tasks.total, 1); assert.equal(tasks.items[0].id, f.task.id)
  const rows = f.service.weekly(f.lead, f.plan.id, f.task.id, {})
  assert.deepEqual(rows.items.map(row => row.id), ['visible'])
  const wire = JSON.stringify([tasks, rows])
  for (const privateValue of ['私有背景', 'private.invalid', '私有协调', '此前无关', '私密草稿', '此前目标', '此前负责人']) assert.equal(wire.includes(privateValue), false, privateValue)
  assert.equal(canPerformAction(f.store, f.lead, 'write', 'task', f.task.id), false)
  assert.throws(() => new TaskViewService(f.store).view(f.lead, f.task.id), { status: 404 })
  for (const actor of [f.worker, f.peer, f.observer]) assert.throws(() => f.service.tasks(actor, f.plan.id, {}), { status: actor.role === 'observer' ? 403 : 404 })
  assert.equal(f.service.tasks(f.manager, f.plan.id, {}).total, 1)
  assert.ok(f.store.list('objectReadAudits').length >= 6)
})

test('read audit persists every page without invalidating cursors, while task/owner changes revoke reads and scope', t => {
  const f = fixture(t)
  for (let index = 0; index < 65; index++) f.store.insert<Task>('tasks', { ...f.task, id: `extra-${index}` })
  const revision = f.store.workspaceRevision(), scope = readScopeVersion(f.store, f.lead)
  const first = f.service.tasks(f.lead, f.plan.id, { limit: 50 })
  assert.equal(f.store.workspaceRevision(), revision)
  const second = f.service.tasks(f.lead, f.plan.id, { limit: 50, cursor: first.nextCursor })
  assert.equal(first.total, 66); assert.equal(first.items.length + second.items.length, 66)
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 66)
  assert.equal(f.store.workspaceRevision(), revision)
  f.store.update<Task>('tasks', f.task.id, f.task.version, { monthlyPlanId: null })
  assert.notEqual(readScopeVersion(f.store, f.lead), scope)
  assert.throws(() => f.service.weekly(f.lead, f.plan.id, f.task.id, {}), { status: 404 })
  assert.throws(() => f.service.tasks(f.lead, f.plan.id, { limit: 50, cursor: first.nextCursor }), { status: 409 })
  f.store.update<MonthlyPlan>('plans', f.plan.id, f.plan.version, { ownerId: f.peer.id })
  assert.throws(() => f.service.tasks(f.lead, f.plan.id, {}), { status: 404 })
  assert.equal(f.service.tasks(f.peer, f.plan.id, {}).total, 65)
  f.store.update<User>('users', f.peer.id, f.peer.version, { active: false })
  assert.throws(() => f.service.tasks(f.peer, f.plan.id, {}), { status: 403 })
})

test('merged and historical-reference goals never create derived owner access, and query inputs are strict', t => {
  const f = fixture(t)
  assert.throws(() => f.service.tasks(f.lead, f.plan.id, { ownerId: f.peer.id }), { status: 400 })
  assert.throws(() => f.service.tasks(f.lead, f.plan.id, { limit: 101 }), { status: 400 })
  f.store.update<MonthlyPlan>('plans', f.plan.id, f.plan.version, { status: 'merged' })
  assert.throws(() => f.service.tasks(f.lead, f.plan.id, {}), { status: 404 })
})

test('derived scope notices linked submitter availability and task reassignment but ignores profile prose', t => {
  for (const patch of [{ active: false }, { role: 'observer' as const }, { registrationStatus: 'pending' as const }, { registrationStatus: 'rejected' as const }]) {
    const f = fixture(t), before = readScopeVersion(f.store, f.lead)
    f.store.update<User>('users', f.worker.id, f.worker.version, patch)
    assert.notEqual(readScopeVersion(f.store, f.lead), before, JSON.stringify(patch))
  }
  const f = fixture(t), before = readScopeVersion(f.store, f.lead)
  f.store.update<User>('users', f.worker.id, f.worker.version, { name: '更正的显示名称', position: '另一个职务' })
  assert.equal(readScopeVersion(f.store, f.lead), before)
  f.store.update<Task>('tasks', f.task.id, f.task.version, { ownerId: f.peer.id })
  assert.notEqual(readScopeVersion(f.store, f.lead), before)
})

test('progress audit identifies the requested task and authorized goal even when the weekly page is empty', t => {
  const f = fixture(t), revision = f.store.workspaceRevision()
  assert.equal(f.service.weekly(f.lead, f.plan.id, f.task.id, {}).items.length, 0)
  type ReadAudit = { objectType: string; objectId: string; authorizedGoalId: string; objectIds: string[]; outcome: string }
  let log = f.store.list<ReadAudit>('objectReadAudits').at(-1)!
  assert.equal(log.objectType, 'task'); assert.equal(log.objectId, f.task.id); assert.equal(log.authorizedGoalId, f.plan.id); assert.deepEqual(log.objectIds, [])
  assert.equal(f.store.workspaceRevision(), revision)
  const row = f.weekly('record')
  f.service.weekly(f.lead, f.plan.id, f.task.id, {})
  log = f.store.list<ReadAudit>('objectReadAudits').at(-1)!
  assert.deepEqual(log.objectIds, [row.id])
  assert.throws(() => f.service.weekly(f.peer, f.plan.id, f.task.id, {}), { status: 404 })
  log = f.store.list<ReadAudit>('objectReadAudits').at(-1)!
  assert.equal(log.objectId, f.task.id); assert.equal(log.outcome, 'denied'); assert.deepEqual(log.objectIds, [])
})

test('read auditing fails closed and rolled-back audit inserts do not stale business cursors', t => {
  const f = fixture(t), revision = f.store.workspaceRevision(), original = f.store.recordObjectRead.bind(f.store)
  f.store.recordObjectRead = input => { original(input); throw new Error('审计写入之后事务失败') }
  assert.throws(() => f.service.tasks(f.lead, f.plan.id, {}), /事务失败/)
  assert.equal(f.store.list('objectReadAudits').length, 0)
  assert.equal(f.store.workspaceRevision(), revision)
  f.store.recordObjectRead = original
  assert.equal(f.service.tasks(f.lead, f.plan.id, {}).total, 1)
  assert.equal(f.store.workspaceRevision(), revision)
})

test('current goal index is a byte-preserving migration and bounds both task pages and scope joins', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close())
  db.exec('CREATE TABLE entities(collection TEXT NOT NULL,id TEXT NOT NULL,version INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(collection,id)); CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT NOT NULL,applied_at TEXT NOT NULL)')
  for (let version = 1; version <= 4; version++) db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(version, 'existing', '2026-09-24T00:00:00.000Z')
  const frozen = '{ "id":"kept", "monthlyPlanId":"goal", "ownerId":"worker", "title":"不可改写的原件" }'
  db.prepare('INSERT INTO entities VALUES(?,?,?,?)').run('tasks', 'kept', 1, frozen)
  applyMigrations(db); applyMigrations(db)
  assert.equal(db.prepare("SELECT data FROM entities WHERE id='kept'").get()?.data, frozen)
  const f = fixture(t), sql: { statement: string; values: (string | number | null)[] }[] = [], select = f.store.selectRows.bind(f.store)
  f.store.selectRows = (statement, values = []) => { sql.push({ statement, values }); return select(statement, values) }
  f.service.tasks(f.lead, f.plan.id, {})
  const statements = sql.filter(row => row.statement.includes('memberAvailable') || row.statement.includes("t.collection='tasks'"))
  assert.ok(statements.length >= 3)
  for (const row of statements) {
    const detail = db.prepare(`EXPLAIN QUERY PLAN ${row.statement}`).all(...row.values).map(item => item.detail).join('\n')
    assert.match(detail, /task_active_goal_id.*<expr>=\?/, row.statement)
  }
})
