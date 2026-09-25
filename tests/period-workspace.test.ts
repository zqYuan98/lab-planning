import test from 'node:test'
import assert from 'node:assert/strict'
import { PeriodWorkspaceService } from '../server/period-workspace.ts'
import { performanceFixture, performanceNow } from '../scripts/r2-performance-fixture.ts'
import { legacyBootstrap } from './fixtures/r2-baseline/domain.ts'
import { visibleMonthlyPlan } from '../src/account-options.ts'
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord, weeklyPlanFingerprint } from '../shared/weekly-record-state.ts'
import { weeklyRecordState } from '../src/weekly-submission-flow.ts'
import type { MonthlyPlan, Publication, Task, WeeklyRecord } from '../shared/types.ts'

test('period pages preserve frozen monthly and weekly scope and complete statistics for both business roles', t => {
  const f = performanceFixture(3), service = new PeriodWorkspaceService(f.store); t.after(() => f.store.close())
  for (const actor of [f.actors.manager, f.actors.member]) {
    const old = legacyBootstrap(f.store, actor, true, false, new Date(performanceNow))
    const plans = old.plans.filter(plan => !plan.visibility && plan.month === '2026-09' && visibleMonthlyPlan(plan, old.users))
    const result = service.monthly(actor, { month: '2026-09', limit: 2 })
    assert.equal(result.total, plans.length); assert.equal(result.summary.statuses.all, plans.length)
    const ids = result.items.map(row => row.id); let cursor = result.nextCursor
    while (cursor) { const next = service.monthly(actor, { month: '2026-09', limit: 2, cursor }); ids.push(...next.items.map(row => row.id)); cursor = next.nextCursor }
    assert.deepEqual(ids, plans.map(row => row.id))
    for (const row of plans) assert.deepEqual(service.plan(actor, row.id).plan, row)
    const records = old.weeklyRecords.filter(row => isActiveWeeklyRecord(row) && row.weekStart === '2026-09-07')
    const weekly = service.weekly(actor, { weekStart: '2026-09-07', limit: 2 }), official = records.filter(isEffectiveWeeklyRecord)
    assert.equal(weekly.total, records.length); assert.equal(weekly.summary.official, official.length)
    assert.equal(weekly.summary.done, official.filter(row => row.status === 'done').length)
    assert.equal(service.weekly(actor, { weekStart: '2026-09-07', q: 'nothing-matches', limit: 2 }).summary.official, official.length)
    assert.deepEqual(weekly.items.map(row => row.id), records.slice(0, 2).map(row => row.id))
  }
  assert.throws(() => service.monthly(f.actors.observer, { month: '2026-09' }), { status: 403 })
  assert.throws(() => service.weekly(f.actors.observer, { weekStart: '2026-09-07' }), { status: 403 })
})

test('tail-page deep links and publish candidates are independent of first-page membership', t => {
  const f = performanceFixture(1), service = new PeriodWorkspaceService(f.store); t.after(() => f.store.close())
  const original = f.store.get<MonthlyPlan>('plans', 'plan-2026-09-0')!
  for (let i = 0; i < 115; i++) f.store.restoreEntity('plans', { ...original, id: `approved-${i}`, ownerId: f.actors.member.id, version: 1, status: 'approved', title: `Approved ${i}`, expectedOutcome: 'full text '.repeat(300) })
  const result = service.monthly(f.actors.manager, { month: '2026-09', limit: 10, id: 'approved-114' })
  assert.equal(result.items.length, 10); assert.equal(result.summary.publishable, 115); assert.equal(result.detail?.id, 'approved-114'); assert.equal(result.detail?.expectedOutcome.length, 3000)
  const ids: string[] = []; let cursor: string | null = null
  do { const page = service.candidates(f.actors.manager, { kind: 'plans', purpose: 'publish', month: '2026-09', limit: 40, ...(cursor ? { cursor } : {}) }); ids.push(...page.items.map(row => row.id)); cursor = page.nextCursor } while (cursor)
  assert.equal(ids.length, 115); assert.ok(ids.includes('approved-114'))
  const ownTask = f.store.get<Task>('tasks', 'task-2026-09-00')!
  f.store.restoreEntity('tasks', { ...ownTask, id: 'unscheduled-tail-task', monthlyPlanId: 'approved-114', title: 'not scheduled this week' })
  const candidates = service.candidates(f.actors.member, { kind: 'tasks', purpose: 'weekly', q: 'not scheduled' })
  assert.deepEqual(candidates.items.map(row => row.id), ['unscheduled-tail-task'])
  assert.throws(() => service.candidates(f.actors.member, { kind: 'plans', purpose: 'publish', month: '2026-09' }), { status: 403 })
  const page = service.candidates(f.actors.manager, { kind: 'plans', purpose: 'publish', month: '2026-09', limit: 1 })
  const row = f.store.get<MonthlyPlan>('plans', 'approved-0')!; f.store.update<MonthlyPlan>('plans', row.id, row.version, { title: 'changed' })
  assert.throws(() => service.candidates(f.actors.manager, { kind: 'plans', purpose: 'publish', month: '2026-09', limit: 1, cursor: page.nextCursor }), { status: 409 })
})

test('publication catalog counts authorized snapshots without parsing snapshot prose and detail remains complete', t => {
  const f = performanceFixture(1), service = new PeriodWorkspaceService(f.store); t.after(() => f.store.close())
  const publication = f.store.get<Publication>('publications', 'publication-2026-09')!
  f.store.restoreEntity('publications', { ...publication, id: 'large-publication', revision: 2, plans: publication.plans.map(row => ({ ...row, expectedOutcome: 'frozen original '.repeat(10000) })) })
  f.store.resetReadMetrics()
  const page = service.publications(f.actors.member, { month: '2026-09', limit: 1 })
  assert.equal(page.total, 2); assert.equal(page.items[0].planCount, 1); assert.equal(page.items[0].reason, '')
  assert.ok(f.store.getReadMetrics().parsedBytes < 20_000)
  const detail = service.publication(f.actors.member, 'large-publication')
  assert.equal(detail.publication.plans.length, 1); assert.equal(detail.publication.plans[0].expectedOutcome.length, 160000)
})

test('weekly detail includes an authorized record outside the visible page and preserves full text', t => {
  const f = performanceFixture(1), service = new PeriodWorkspaceService(f.store); t.after(() => f.store.close())
  const record = f.store.get<WeeklyRecord>('weeklyRecords', 'weekly-task-2026-09-15-0')!
  f.store.update<WeeklyRecord>('weeklyRecords', record.id, record.version, { commitment: 'weekly original '.repeat(100) })
  const page = service.weekly(f.actors.member, { weekStart: record.weekStart, id: record.id, limit: 1 })
  assert.equal(page.detail?.record?.id, record.id); assert.equal(page.detail?.record?.commitment.length, 1600)
  assert.equal(service.record(f.actors.member, record.id).record.commitment.length, 1600)
  assert.throws(() => service.record(f.members[1], record.id), { status: 404 })
})

test('historical membership, moved months, inactive owners and missing live tasks retain the frozen projections', t => {
  const f = performanceFixture(2), service = new PeriodWorkspaceService(f.store); t.after(() => f.store.close())
  const plan = f.store.get<MonthlyPlan>('plans', 'plan-2026-09-0')!
  f.store.update<MonthlyPlan>('plans', plan.id, plan.version, { month: '2026-10' })
  const member = f.actors.member, old = legacyBootstrap(f.store, member)
  const history = old.plans.find(row => row.id === plan.id)!
  assert.equal(history.visibility, 'historical')
  assert.deepEqual(service.monthly(member, { month: '2026-09', scope: 'historical' }).items.map(row => row.id), old.plans.filter(row => row.visibility && row.month === '2026-09' && visibleMonthlyPlan(row, old.users)).map(row => row.id))
  assert.ok(!service.monthly(member, { month: '2026-09' }).items.some(row => row.id === plan.id))
  assert.deepEqual(service.plan(member, plan.id).plan, history)
  const missingOwner = f.members[13], historical = legacyBootstrap(f.store, missingOwner).tasks.find(row => row.id === 'task-2026-09-28')!
  const week = service.weekly(missingOwner, { weekStart: '2026-09-07' })
  assert.equal(week.references.tasks.find(row => row.id === historical.id)?.title, historical.title)
  const inactive = f.store.get<import('../shared/types.ts').User>('users', member.id)!
  f.store.update<import('../shared/types.ts').User>('users', inactive.id, inactive.version, { active: false })
  const managerOld = legacyBootstrap(f.store, f.actors.manager)
  const expected = managerOld.weeklyRecords.filter(row => row.weekStart === '2026-09-07' && row.ownerId === member.id)
  assert.equal(service.weekly(f.actors.manager, { weekStart: '2026-09-07', ownerId: member.id }).total, 0)
  assert.equal(service.weekly(f.actors.manager, { weekStart: '2026-09-07', ownerId: member.id, includeInactive: 'true' }).total, expected.length)
  assert.equal(service.weekly(f.actors.manager, { weekStart: '2026-09-07', ownerId: member.id, id: expected[0].id }).detail?.record?.id, expected[0].id)
})

test('source and status filters affect rows while complete weekly approval totals stay fixed', t => {
  const f = performanceFixture(1), service = new PeriodWorkspaceService(f.store); t.after(() => f.store.close())
  const id = 'weekly-task-2026-09-00-0', row = f.store.get<WeeklyRecord>('weeklyRecords', id)!
  f.store.update<WeeklyRecord>('weeklyRecords', id, row.version, { planApproval: { required: true, approvedSubmissionId: null, approvedFingerprint: null }, workOrigin: { kind: 'assigned', actorId: f.actors.manager.id, reason: '' } })
  const full = service.weekly(f.actors.member, { weekStart: row.weekStart })
  const filtered = service.weekly(f.actors.member, { weekStart: row.weekStart, source: 'assigned', status: 'pending' })
  assert.deepEqual(filtered.items.map(row => row.id), [id]); assert.deepEqual(filtered.summary, full.summary); assert.equal(filtered.summary.pending, 1)
  assert.equal(service.weekly(f.actors.member, { weekStart: row.weekStart, source: 'self', status: 'pending' }).total, 0)
  assert.throws(() => service.weekly(f.actors.manager, { weekStart: '2026-02-31' }), { status: 400 })
})

test('approved long commitments keep their real fingerprint and unknown deep links do not become new work', t => {
  const f = performanceFixture(1), service = new PeriodWorkspaceService(f.store); t.after(() => f.store.close())
  const row = f.store.get<WeeklyRecord>('weeklyRecords', 'weekly-task-2026-09-00-0')!, approved = { ...row, commitment: 'long approved commitment '.repeat(120) }
  f.store.update<WeeklyRecord>('weeklyRecords', row.id, row.version, { commitment: approved.commitment, planApproval: { required: true, approvedSubmissionId: 'approved-receipt', approvedFingerprint: weeklyPlanFingerprint(approved) } })
  const page = service.weekly(f.actors.member, { weekStart: row.weekStart }), item = page.items.find(item => item.id === row.id)!
  assert.equal(item.commitment, approved.commitment); assert.equal(isEffectiveWeeklyRecord(item), true); assert.equal(weeklyRecordState(item).label, '计划已审核 · 纳入周统计')
  assert.throws(() => service.weekly(f.actors.member, { weekStart: row.weekStart, id: 'unknown-work' }), { status: 404 })
  assert.throws(() => service.monthly(f.actors.member, { month: '2026-09', id: 'unknown-plan' }), { status: 404 })
  assert.throws(() => service.monthly(f.members[14], { month: '2026-09', id: 'plan-2026-09-0' }), { status: 404 })
  const task = f.store.get<Task>('tasks', 'task-2026-09-00')!
  f.store.update<Task>('tasks', task.id, task.version, { ownerId: f.members[1].id })
  assert.throws(() => service.weekly(f.actors.member, { weekStart: '2026-11-02', id: task.id }), { status: 404 })
  assert.ok(service.weekly(f.actors.member, { weekStart: row.weekStart, id: row.id }).detail?.record)
})
