import test from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { OverviewWorkspaceService, overviewRow } from '../server/overview-workspace.ts'
import { buildOverview } from '../shared/overview-data.ts'
import { buildWorkspace, filterWorkRows, summarizeWorkRows } from '../shared/overview-workspace-data.ts'
import { performanceFixture, performanceNow } from '../scripts/r2-performance-fixture.ts'
import { legacyBootstrap } from './fixtures/r2-baseline/domain.ts'
import type { AuditEvent, MonthlyPlan, Publication, Task, User, WeeklyRecord } from '../shared/types.ts'
import { OverviewMemberTable, OverviewProjectView, Board } from '../src/components/overview/WorkspaceViews.tsx'

const date = '2026-09-24', clock = () => new Date(performanceNow)
test('personal overview keeps frozen-reader counts and trends while returning only three focus summaries', t => {
  const f = performanceFixture(3); t.after(() => f.store.close())
  const service = new OverviewWorkspaceService(f.store, clock)
  for (const actor of [f.actors.member, f.actors.manager]) {
    const old = buildOverview(legacyBootstrap(f.store, actor, true, false, clock()), date), result = service.personal(actor)
    for (const key of ['plans', 'published', 'pending', 'approved', 'reviewScope', 'records', 'submitted', 'blocked', 'notDone', 'accepted', 'awaitingAcceptance', 'returned', 'drafts', 'missingMembers'] as const) assert.equal(result.counts[key], old[key].length, `${actor.role}:${key}`)
    assert.deepEqual(result.monthTrend, old.monthTrend)
    assert.deepEqual(result.weekTrend, old.weekTrend)
    assert.deepEqual(result.weeks, old.weeks)
    assert.deepEqual(result.focusPlans.map(plan => plan.id), old.focusPlans.slice(0, 3).map(plan => plan.id))
    assert.ok(result.focusPlans.length <= 3 && result.focusRecords.length <= 3)
    assert.ok(!('plans' in result) && !('tasks' in result) && !('weeklyRecords' in result) && !('reports' in result))
    assert.ok(Buffer.byteLength(JSON.stringify(result)) < 100 * 1024)
  }
  assert.throws(() => service.personal(f.actors.observer), { status: 403 })
  assert.throws(() => service.personal(f.actors.member, { extra: 'unexpected' }), { status: 400 })
})

test('department all/month/week results match legacy projection and keep counts outside paging', t => {
  const f = performanceFixture(3); t.after(() => f.store.close())
  const service = new OverviewWorkspaceService(f.store, clock), baseline = legacyBootstrap(f.store, f.actors.manager, true, false, clock())
  for (const period of ['all', 'month', 'week'] as const) for (const includeInactive of [false, true]) {
    const expected = buildWorkspace(baseline, { period, date, includeInactive }, date)
    const result = service.department(f.actors.manager, { period, date, includeInactive, limit: 1 })
    const { risk: _risk, ...counts } = result.summary
    assert.deepEqual(counts, summarizeWorkRows(expected.rows), `${period}:${includeInactive}`)
    assert.equal(result.total, expected.rows.length)
    assert.equal(result.items.length, Math.min(1, expected.rows.length))
    assert.deepEqual(result.members.map(member => member.id).sort(), expected.members.map(member => member.id).sort())
    for (const item of result.items) assert.deepEqual(item, overviewRow(expected.rows.find(row => row.id === item.id)!))
    const all = [...result.items]
    let cursor = result.nextCursor
    while (cursor) { const next = service.department(f.actors.manager, { period, date, includeInactive, limit: 1, cursor }); assert.deepEqual(next.summary, result.summary); all.push(...next.items); cursor = next.nextCursor }
    assert.deepEqual(all.map(row => row.id).sort(), expected.rows.map(row => row.id).sort())
    assert.equal(result.groups.project.reduce((total, group) => total + group.summary.total, 0), result.total)
    assert.ok(result.members.every(member => member.preview.length <= 3))
    assert.ok(result.members.some(member => !member.summary.total), 'enabled zero-task members remain visible')
  }
  for (const patch of [{ status: 'blocked' }, { ownerId: f.actors.member.id }, { riskOnly: true }, { q: '执行' }, { projectId: '__none__' }] as const) {
    const old = buildWorkspace(baseline, { period: 'all', date }, date), filtered = filterWorkRows(old.rows, { ...patch, query: 'q' in patch ? patch.q : '' })
    const result = service.department(f.actors.manager, { period: 'all', date, ...patch })
    assert.equal(result.total, filtered.length, JSON.stringify(patch))
  }
  assert.throws(() => service.department(f.actors.member, {}), { status: 403 })
  assert.throws(() => service.department(f.actors.observer, {}), { status: 403 })
  assert.throws(() => service.department(f.actors.manager, { date: '2026-02-30' }), { status: 400 })
  const unfiltered = service.department(f.actors.manager, { period: 'all', date })
  for (const patch of [{ ownerId: 'all' }, { projectId: 'all' }, { status: 'all' }]) {
    const result = service.department(f.actors.manager, { period: 'all', date, ...patch })
    assert.equal(result.total, unfiltered.total)
    assert.deepEqual(result.members, unfiltered.members, 'explicit all keeps enabled zero-task members')
  }
})

test('personal overview excludes unapproved accounts for members while preserving the manager scope', t => {
  const f = performanceFixture(1); t.after(() => f.store.close())
  const service = new OverviewWorkspaceService(f.store, clock)
  const before = service.personal(f.actors.member).counts.missingMembers
  for (const registrationStatus of ['pending', 'rejected'] as const) f.store.restoreEntity<User>('users', {
    ...f.actors.member, id: `active-${registrationStatus}`, email: `${registrationStatus}@overview.invalid`,
    name: `未审核-${registrationStatus}`, active: true, registrationStatus,
  })
  for (const actor of [f.actors.member, f.actors.manager]) {
    const expected = buildOverview(legacyBootstrap(f.store, actor, true, false, clock()), date)
    assert.equal(service.personal(actor).counts.missingMembers, expected.missingMembers.length)
  }
  assert.equal(service.personal(f.actors.member).counts.missingMembers, before, 'pending and rejected accounts do not reveal themselves through member counts')
  const expectedDepartment = buildWorkspace(legacyBootstrap(f.store, f.actors.manager, true, false, clock()), { period: 'all', date }, date)
  assert.deepEqual(service.department(f.actors.manager, { period: 'all', date }).members.map(row => row.id).sort(), expectedDepartment.members.map(row => row.id).sort())
})

test('boundary weeks use the weekly record goal month; deleted work and changed approval stay excluded', t => {
  const f = performanceFixture(1); t.after(() => f.store.close())
  const manager = f.actors.manager, owner = f.actors.member, basePlan = f.store.list<MonthlyPlan>('plans')[0], baseTask = f.store.list<Task>('tasks')[0], baseRecord = f.store.list<WeeklyRecord>('weeklyRecords')[0]
  const august = f.store.restoreEntity<MonthlyPlan>('plans', { ...basePlan, id: 'august-boundary', month: '2026-08', ownerId: owner.id })
  const september = f.store.restoreEntity<MonthlyPlan>('plans', { ...basePlan, id: 'september-boundary', month: '2026-09', ownerId: owner.id })
  const task = f.store.restoreEntity<Task>('tasks', { ...baseTask, id: 'boundary-task', title: '边界任务', ownerId: owner.id, monthlyPlanId: september.id, dueDate: '2026-09-30' })
  f.store.restoreEntity<WeeklyRecord>('weeklyRecords', { ...baseRecord, id: 'august-record', taskId: task.id, ownerId: owner.id, weekStart: '2026-08-31', monthlyPlanId: august.id, status: 'done', commitment: '八月承诺', planApproval: undefined })
  const review = f.store.restoreEntity<WeeklyRecord>('weeklyRecords', { ...baseRecord, id: 'september-record', taskId: task.id, ownerId: owner.id, weekStart: '2026-09-07', monthlyPlanId: september.id, commitment: '修改后的九月承诺', planApproval: { required: true, approvedSubmissionId: 'old', approvedFingerprint: 'not-current' } })
  const service = new OverviewWorkspaceService(f.store, clock), result = service.department(manager, { period: 'month', date, ownerId: owner.id })
  const row = result.items.find(row => row.id === task.id)!
  assert.equal(row.status, 'draft')
  assert.equal(row.draftCount, 1)
  assert.equal(row.officialCount, 0)
  assert.equal(row.planId, september.id)
  const cursor = service.department(manager, { limit: 1 }).nextCursor!
  f.store.update<WeeklyRecord>('weeklyRecords', review.id, review.version, { deletion: { deletedAt: performanceNow, deletedBy: manager.id, reason: '删除' } })
  assert.throws(() => service.department(manager, { limit: 1, cursor }), { status: 409 })
  f.store.update<User>('users', manager.id, manager.version, { role: 'member' })
  assert.throws(() => service.department(manager, {}), { status: 403 }, 'stale manager object never preserves authority')
})

test('past publication membership and missing cancelled task history preserve personal and department semantics', t => {
  const f = performanceFixture(1); t.after(() => f.store.close())
  const member = f.actors.member, manager = f.actors.manager, samplePlan = f.store.list<MonthlyPlan>('plans')[0], sampleTask = f.store.list<Task>('tasks')[0], sampleRecord = f.store.list<WeeklyRecord>('weeklyRecords')[0]
  const plan = f.store.restoreEntity<MonthlyPlan>('plans', { ...samplePlan, id: 'snapshot-only', ownerId: manager.id, collaboratorIds: [], title: '后来不可读的新目标', version: 7 })
  const past = { ...plan, ownerId: member.id, version: 2, title: '发布时本人目标', status: 'published' as const }
  f.store.restoreEntity<Publication>('publications', { ...samplePlan, id: 'past-publication', month: '2026-09', revision: 1, plans: [past], actorId: manager.id, reason: '' })
  const cancelled = { ...sampleTask, id: 'missing-cancelled-task', ownerId: member.id, cancellation: { cancelledAt: performanceNow, cancelledBy: manager.id, reason: '历史作废' } }
  f.store.restoreEntity<AuditEvent>('events', { ...samplePlan, id: 'cancelled-history', entityType: 'task', entityId: cancelled.id, actorId: manager.id, action: 'cancel', before: null, after: cancelled, reason: '' })
  f.store.restoreEntity<WeeklyRecord>('weeklyRecords', { ...sampleRecord, id: 'cancelled-orphan-record', taskId: cancelled.id, ownerId: member.id, weekStart: '2026-09-21', monthlyPlanId: plan.id })
  const service = new OverviewWorkspaceService(f.store, clock), expected = buildOverview(legacyBootstrap(f.store, member, true, false, clock()), date), result = service.personal(member)
  assert.equal(result.counts.published, expected.published.length)
  assert.equal(result.counts.records, expected.records.length)
  assert.deepEqual(result.monthTrend, expected.monthTrend)
  assert.ok(!JSON.stringify(result).includes('后来不可读的新目标'))
  assert.ok(!service.department(manager, { period: 'all', date }).items.some(row => row.id === cancelled.id))
})

test('36 month ordinary responses are bounded and group views display complete server totals', t => {
  const f = performanceFixture(36); t.after(() => f.store.close())
  const service = new OverviewWorkspaceService(f.store, clock)
  const result = service.department(f.actors.manager, { period: 'all', date, limit: 50 })
  assert.ok(result.total > 100)
  assert.equal(result.items.length, 50)
  const bytes = Buffer.byteLength(JSON.stringify(result))
  assert.ok(bytes < 100 * 1024, `${bytes} response bytes`)
  assert.ok(result.items.every(row => !('task' in row) && !('record' in row) && !('records' in row)))
  const member = result.members.find(member => member.summary.total > 3)!
  const memberHtml = renderToStaticMarkup(createElement(OverviewMemberTable, { members: [member], columns: ['tasks', 'done'], onOpen() {}, onDrill() {} }))
  assert.ok(memberHtml.includes(`查看全部 ${member.summary.total} 项`))
  const groups = result.groups.project
  const projectHtml = renderToStaticMarkup(createElement(OverviewProjectView, { groups, onDrill() {} }))
  for (const group of groups) assert.ok(projectHtml.includes(`查看 ${group.summary.total} 项`))
  const boardHtml = renderToStaticMarkup(createElement(Board, { rows: result.items, group: 'status', totals: result.groups.status, onOpen() {}, onFilter() {} }))
  assert.ok(boardHtml.includes('查看分组全部任务'))
  t.diagnostic(`36-month department JSON ${bytes} bytes; ${result.total} tasks with 50 rows per response`)
})
