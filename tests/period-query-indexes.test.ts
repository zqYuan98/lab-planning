import test from 'node:test'
import assert from 'node:assert/strict'
import { PeriodWorkspaceService } from '../server/period-workspace.ts'
import { collaborationDashboard } from '../server/collaboration-query.ts'
import { evaluateWorkRisks } from '../server/collaboration-rules.ts'
import { TaskViewService } from '../server/task-view.ts'
import { performanceFixture } from '../scripts/r2-performance-fixture.ts'
import { Store } from '../server/store.ts'
import { dayAt } from '../server/collaboration-calendar.ts'
import { enrollTaskTracking } from '../server/collaboration-tracking.ts'
import type { Task, User } from '../shared/types.ts'
import type { CollaborationSettings } from '../shared/collaboration.ts'

/** Record the exact SELECTs a read issues, then ask SQLite how it would run each one. */
function capturePlans(store: Store, read: () => unknown) {
  const statements: { sql: string; values: (string | number | null)[] }[] = []
  // readRows is the single choke point for every read, including Store's own page queries.
  const internals = store as unknown as { readRows: (sql: string, values?: (string | number | null)[]) => unknown[] }
  const original = internals.readRows.bind(store)
  internals.readRows = (sql, values = []) => { if (/^\s*(SELECT|WITH)\b/i.test(sql)) statements.push({ sql, values }); return original(sql, values) }
  try { read() } finally { delete (internals as Partial<typeof internals>).readRows }
  return statements.map(statement => ({ sql: statement.sql, plan: store.explainSelect(statement.sql, statement.values).join('\n') }))
}
const using = (plans: { sql: string; plan: string }[], fragment: string) => plans.filter(row => row.sql.includes(fragment))

test('weekly page reads the selected week through its index instead of all weekly history', t => {
  const f = performanceFixture(3), service = new PeriodWorkspaceService(f.store); t.after(() => f.store.close())
  const plans = capturePlans(f.store, () => service.weekly(f.actors.manager, { weekStart: '2026-09-07' }))
  const main = using(plans, "json_extract(w.data,'$.weekStart')=?")
  assert.equal(main.length, 1)
  assert.match(main[0].plan, /SEARCH w USING INDEX weekly_active_week_owner/)
})

test('monthly page resolves current and historical plan ids through indexes', t => {
  const f = performanceFixture(3), service = new PeriodWorkspaceService(f.store); t.after(() => f.store.close())
  for (const actor of [f.actors.manager, f.actors.member]) {
    const plans = capturePlans(f.store, () => service.monthly(actor, { month: '2026-09' }))
    const main = using(plans, 'INDEXED BY plan_month')
    assert.equal(main.length, 1)
    assert.match(main[0].plan, /USING INDEX plan_month/)
    assert.match(main[0].plan, /USING INDEX plan_event_before_month/)
    assert.match(main[0].plan, /USING INDEX plan_event_after_month/)
    assert.doesNotMatch(main[0].plan, /SEARCH e USING INDEX event_object_created/)
  }
})

test('collaboration reads look up open follow-ups and blockers by task through indexes', t => {
  const f = performanceFixture(3); t.after(() => f.store.close())
  const plans = capturePlans(f.store, () => collaborationDashboard(f.store, f.actors.manager, {}))
  const counts = using(plans, 'AS followup')
  assert.equal(counts.length, 1)
  assert.match(counts[0].plan, /USING INDEX followup_open_task_owner/)
  for (const row of using(plans, "collection='followupRequests' AND json_extract(data,'$.taskId')=?")) assert.match(row.plan, /USING INDEX followup_open_task_owner/)
})

test('risk evaluation reads each tracked task\'s open follow-ups and blockers through indexes', t => {
  const store = new Store(':memory:'); t.after(() => store.close())
  const manager = store.insert<User>('users', { name: '主管', email: 'manager@index.test', role: 'manager', active: true, position: '' })
  const member = store.insert<User>('users', { name: '成员', email: 'member@index.test', role: 'member', active: true, position: '' })
  store.insert<CollaborationSettings>('collaborationSettings', { id: 'collaboration', enabled: true, autoRulesEnabled: true, deadlineApprovalEnabled: false, dailyManagerEnabled: true, weeklyManagerEnabled: true, memberActionsEnabled: false,
    pilotUserIds: [member.id], defaultManagerIds: [manager.id], calendarOverrides: {}, staleWorkdays: 3, blockerWorkdays: 2, enabledAt: dayAt('2026-09-01').toISOString() })
  const task = store.insert<Task>('tasks', { title: '接口验收', ownerId: member.id, monthlyPlanId: null, description: '', dueDate: '2026-09-30', status: 'doing', isTemporary: true, temporaryReason: '专项', workOrigin: { kind: 'assigned', actorId: manager.id, reason: '' } })
  enrollTaskTracking(store, task, manager, dayAt('2026-09-07', '15:00'), 'manual')
  const plans = capturePlans(store, () => evaluateWorkRisks(store, dayAt('2026-09-16', '10:00'), manager))
  const followups = using(plans, "collection='followupRequests'"), blockers = using(plans, "collection='blockerEpisodes'")
  assert.equal(followups.length, 1); assert.equal(blockers.length, 1)
  assert.match(followups[0].plan, /USING INDEX followup_open_task_owner/)
  assert.match(blockers[0].plan, /USING INDEX blocker_parent_owner/)
})

test('task detail reads its weekly records and history by index, never scanning all records or events', t => {
  const f = performanceFixture(3), views = new TaskViewService(f.store); t.after(() => f.store.close())
  const task = f.store.list<Task>('tasks').find(row => row.ownerId === f.actors.member.id)!
  for (const actor of [f.actors.manager, f.actors.member]) {
    const plans = capturePlans(f.store, () => { views.view(actor, task.id, {}); views.history(actor, task.id, {}) })
    const weekly = using(plans, "collection='weeklyRecords' AND json_extract(data,'$.taskId')=?")
    assert.ok(weekly.length > 0)
    for (const row of weekly) assert.doesNotMatch(row.plan, /SCAN|USING INDEX sqlite_autoindex_entities_1 \(collection=\?\)/)
    const history = using(plans, 'WITH related(type,id)')
    assert.ok(history.length > 0)
    for (const row of history) {
      assert.match(row.plan, /SEARCH ev USING INDEX event_object_created/)
      assert.doesNotMatch(row.plan, /SCAN e\b|SEARCH e USING INDEX sqlite_autoindex_entities_1 \(collection=\?\)/)
    }
  }
})
