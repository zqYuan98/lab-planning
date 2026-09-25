import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { WeeklyCalendarService } from '../server/weekly-calendar-service.ts'
import { resolveWeeklyDeadline } from '../shared/work-calendar.ts'
import { isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { weeklyPlanApprovalMetadata } from '../server/weekly-plan-review.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import { rotateOperationEpoch } from '../server/operation-context.ts'
import type { User, Task, WeeklyRecord, AuditEvent } from '../shared/types.ts'
import type { WeeklyRule, WeeklyCycle, WeeklyDuty } from '../shared/weekly-submissions.ts'

const holidays = Object.fromEntries([
  ...['2026-09-25', '2026-09-26', '2026-09-27', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'].map(day => [day, false]),
  ['2026-10-10', true],
]) as Record<string, boolean>

function fixture() {
  const store = new Store(':memory:')
  let now = new Date('2026-09-24T01:00:00Z')
  const actor = (id: string, role: User['role']) => store.restoreEntity<User>('users', {
    id, role, name: id, email: `${id}@example.test`, active: true, position: '', version: 1,
    createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
  })
  const manager = actor('manager', 'manager'), member = actor('member', 'member')
  const service = new WeeklySubmissionService(store, () => now)
  const calendar = new WeeklyCalendarService(store, () => now)
  const rule = service.getRule()
  store.update<WeeklyRule>('weeklyRules', rule.id, rule.version, { effectiveWeek: '2026-09-21', windows: [{ fromWeek: '2026-09-21', toWeek: null }] })
  const configure = (overrides = holidays) => calendar.updatePolicy(manager, {
    version: service.getRule().version, mode: 'last_workday', calendarOverrides: overrides,
    calendarVersion: store.get<{ version: number }>('collaborationSettings', 'collaboration')?.version ?? 0,
  })
  return { store, manager, member, service, calendar, configure, set: (date: string) => { now = new Date(date) } }
}

test('deadline policy follows holidays and working weekends, while existing and late-created historical cycles stay fixed', () => {
  const f = fixture()
  try {
    const old = f.service.view(f.member, '2026-09-21')
    const rule = f.configure()
    assert.equal(rule.deadlinePolicies?.[0].fromWeek, '2026-09-28')
    assert.equal(f.service.view(f.member, '2026-09-21').deadlineAt, old.deadlineAt)
    f.set('2026-09-28T01:00:00Z')
    const next = f.service.view(f.member, '2026-09-28')
    assert.equal(next.deadlineAt, '2026-09-30T08:00:00.000Z')
    assert.ok(next.duties.every(duty => duty.deadlineAt === next.deadlineAt))
    assert.equal(f.service.reportSummary('monthly', '2026-09').filter(row => row.cycleWeek === next.week).length, 2)
    assert.equal(next.workCalendar, undefined)
    assert.deepEqual(next.cycle?.rosterIds, [f.member.id])
    f.configure({ ...holidays, '2026-09-30': false })
    assert.equal(f.service.view(f.member, '2026-09-28').deadlineAt, next.deadlineAt)
    f.set('2026-10-05T01:00:00Z')
    assert.equal(f.service.view(f.member, '2026-10-05').deadlineAt, '2026-10-10T08:00:00.000Z')
    assert.equal(resolveWeeklyDeadline(rule, '2026-09-21').deadlineAt, '2026-09-25T08:00:00.000Z')
  } finally { f.store.close() }
})

test('whole holiday week has no duties or misses and does not strand next-week plans in mandatory review', () => {
  const f = fixture()
  try {
    const task = f.store.insert<Task>('tasks', { ownerId: f.member.id, title: '假期后的计划', monthlyPlanId: null, description: '', dueDate: '', status: 'todo', isTemporary: true, temporaryReason: '测试' })
    const record = f.store.insert<WeeklyRecord>('weeklyRecords', { ownerId: f.member.id, taskId: task.id, monthlyPlanId: null, weekStart: '2026-10-05', commitment: '继续推进', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', submitted: true, status: 'planned', planApproval: { required: true, approvedSubmissionId: null, approvedFingerprint: null } })
    f.configure(Object.fromEntries(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map(day => [day, false])))
    assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', record.id)!), true)
    assert.equal(weeklyPlanApprovalMetadata(f.store, f.member.id, '2026-10-05')?.suspended, true)
    f.set('2026-10-04T12:00:00Z')
    const view = f.service.view(f.member, '2026-09-28')
    assert.equal(view.deadlineAt, null)
    assert.deepEqual(view.deadlinePolicy?.workingDays, [])
    assert.deepEqual(view.duties, [])
    assert.equal(f.store.list<{ cycleWeek: string }>('weeklyMissing').filter(row => row.cycleWeek === view.week).length, 0)
    assert.equal(f.service.reportSummary('weekly', view.week).length, 0)
  } finally { f.store.close() }
})

test('saving the shared calendar through collaboration schedules only next-week policy and retains the prior snapshot', () => {
  const f = fixture()
  try {
    f.configure()
    f.set('2026-09-28T01:00:00Z')
    const before = f.service.view(f.member, '2026-09-28')
    const calendar = f.service.view(f.manager, '2026-09-28').workCalendar!
    const settings = new CollaborationService(f.store, () => new Date('2026-09-28T02:00:00Z'))
    settings.updateSettings(f.manager, { version: calendar.version, requestId: 'calendar-update-1', calendarOverrides: { ...holidays, '2026-10-10': false } })
    assert.equal(f.service.view(f.member, '2026-09-28').deadlineAt, before.deadlineAt)
    f.set('2026-10-05T01:00:00Z')
    assert.equal(f.service.view(f.member, '2026-10-05').deadlineAt, '2026-10-09T08:00:00.000Z')
    assert.equal(f.service.getRule().deadlinePolicies?.length, 2)
  } finally { f.store.close() }
})

test('late reconciliation uses the historical policy snapshot rather than the latest shared calendar', () => {
  const f = fixture()
  try {
    f.configure()
    f.set('2026-10-05T01:00:00Z')
    f.configure({})
    const historical = f.service.view(f.member, '2026-09-28')
    assert.equal(historical.deadlineAt, '2026-09-30T08:00:00.000Z')
    assert.equal(f.service.view(f.member, '2026-10-05').deadlineAt, '2026-10-10T08:00:00.000Z')
  } finally { f.store.close() }
})

test('old October cycle is explicitly extended to the working Saturday before its old cutoff', () => {
  const f = fixture()
  try {
    f.set('2026-10-08T01:00:00Z')
    f.configure()
    const old = f.service.view(f.manager, '2026-10-05')
    assert.equal(old.deadlineAt, '2026-10-09T08:00:00.000Z')
    const preview = f.calendar.previewRepair(f.manager, { week: old.week })
    assert.equal(preview.deadlineAt, '2026-10-10T08:00:00.000Z')
    assert.equal(preview.eligible, true)
    f.calendar.repair(f.manager, { week: old.week, token: preview.token, reason: '调休周核对' })
    f.set('2026-10-09T08:00:00Z')
    assert.ok(f.service.view(f.member, old.week).duties.every(row => row.status === 'due' && !row.missingAtDeadline))
  } finally { f.store.close() }
})

test('repair preview expires on calendar changes or restored operation context without altering the cycle', () => {
  const f = fixture()
  try {
    f.configure()
    f.set('2026-09-28T01:00:00Z')
    const view = f.service.view(f.manager, '2026-09-28')
    const preview = f.calendar.previewRepair(f.manager, { week: view.week })
    rotateOperationEpoch(f.store)
    assert.throws(() => f.calendar.repair(f.manager, { week: view.week, token: preview.token, reason: '修复' }), /预览/)
    assert.deepEqual(f.store.get('weeklyCycles', view.week), view.cycle)
    const next = f.calendar.previewRepair(f.manager, { week: view.week })
    f.configure({ ...holidays, '2026-09-30': false })
    assert.throws(() => f.calendar.repair(f.manager, { week: view.week, token: next.token, reason: '修复' }), /预览/)
    assert.deepEqual(f.store.get('weeklyCycles', view.week), view.cycle)
  } finally { f.store.close() }
})

test('repair refuses to reactivate a frozen no-duty week and preserves suspended review', () => {
  const f = fixture()
  try {
    const off = Object.fromEntries(['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'].map(day => [day, false]))
    f.configure(off)
    f.set('2026-09-28T01:00:00Z')
    assert.equal(f.service.view(f.member, '2026-09-28').deadlineAt, null)
    f.configure({ ...off, '2026-09-30': true })
    const preview = f.calendar.previewRepair(f.manager, { week: '2026-09-28' })
    assert.equal(preview.eligible, false)
    assert.match(preview.reasons.join(' '), /有\/无义务/)
    assert.throws(() => f.calendar.repair(f.manager, { week: preview.week, token: preview.token, reason: '恢复工作' }), /有\/无义务/)
    assert.equal(f.service.view(f.member, preview.week).deadlineAt, null)
    assert.equal(weeklyPlanApprovalMetadata(f.store, f.member.id, '2026-10-05')?.suspended, true)
  } finally { f.store.close() }
})

test('period review source manifests protect a cycle even before any compliance result is included', () => {
  const f = fixture()
  try {
    f.configure()
    f.set('2026-09-28T01:00:00Z')
    f.service.view(f.member, '2026-09-28')
    const preview = f.calendar.previewRepair(f.manager, { week: '2026-09-28' })
    f.store.insert('periodReviewSnapshots', { weeklyCompliance: [], sourceManifest: [{ collection: 'weeklyCycles', id: '2026-09-28' }] } as never)
    assert.equal(f.calendar.previewRepair(f.manager, { week: preview.week }).eligible, false)
    assert.throws(() => f.calendar.repair(f.manager, { week: preview.week, token: preview.token, reason: '修复' }), /预览/)
  } finally { f.store.close() }
})

test('calendar configuration preserves CAS and repeated pending updates replace rather than duplicate a policy week', () => {
  const f = fixture()
  try {
    const first = f.configure()
    assert.throws(() => f.calendar.updatePolicy(f.member, { version: first.version, mode: 'last_workday' }), /管理者/)
    assert.throws(() => f.calendar.updatePolicy(f.manager, { version: first.version, mode: 'last_workday', calendarVersion: 0, calendarOverrides: {} }), /日历已变化/)
    assert.throws(() => f.configure({ '2026-02-30': false }), /有效日期/)
    const second = f.configure({ ...holidays, '2026-09-30': false })
    assert.equal(second.deadlinePolicies?.length, 1)
    assert.ok(second.deadlinePolicies![0].version > first.deadlinePolicies![0].version)
    assert.throws(() => f.calendar.updatePolicy(f.manager, { version: first.version, mode: 'friday' }), /数据已更新/)
  } finally { f.store.close() }
})

test('repair failure rolls back cycle, every duty, audit events and idempotency receipt together', () => {
  const f = fixture()
  try {
    f.configure()
    f.set('2026-09-28T01:00:00Z')
    const initial = f.service.view(f.manager, '2026-09-28')
    f.store.update<WeeklyCycle>('weeklyCycles', initial.week, initial.cycle!.version, { deadlineAt: '2026-10-02T08:00:00.000Z', deadlinePolicy: undefined })
    for (const duty of initial.duties) f.store.update<WeeklyDuty>('weeklyDuties', duty.id, duty.version, { deadlineAt: '2026-10-02T08:00:00.000Z', deadlinePolicy: undefined })
    const before = ['weeklyCycles', 'weeklyDuties', 'events', 'weeklyDeadlineRepairReceipts'].map(name => f.store.list(name))
    const preview = f.calendar.previewRepair(f.manager, { week: initial.week })
    const insert = f.store.insert.bind(f.store)
    f.store.insert = ((collection, value) => {
      if (collection === 'events' && (value as unknown as AuditEvent).entityType === 'weeklyDuty') throw new Error('injected audit failure')
      return insert(collection, value)
    }) as typeof f.store.insert
    assert.throws(() => f.calendar.repair(f.manager, { week: initial.week, token: preview.token, reason: '事务故障测试' }), /injected/)
    assert.deepEqual(['weeklyCycles', 'weeklyDuties', 'events', 'weeklyDeadlineRepairReceipts'].map(name => f.store.list(name)), before)
  } finally { f.store.close() }
})

test('repair preview is read-only, binds state, repairs only open empty-history cycles, and repeating it does not add audit events', () => {
  const f = fixture()
  try {
    f.configure()
    f.set('2026-09-28T01:00:00Z')
    const view = f.service.view(f.manager, '2026-09-28')
    const cycle = view.cycle!
    f.store.update<WeeklyCycle>('weeklyCycles', cycle.id, cycle.version, { deadlineAt: '2026-10-02T08:00:00.000Z', deadlinePolicy: undefined })
    for (const duty of view.duties) f.store.update<WeeklyDuty>('weeklyDuties', duty.id, duty.version, { deadlineAt: '2026-10-02T08:00:00.000Z', deadlinePolicy: undefined })
    const before = f.store.workspaceRevision()
    const preview = f.calendar.previewRepair(f.manager, { week: view.week })
    assert.equal(f.store.workspaceRevision(), before)
    assert.equal(preview.eligible, true)
    assert.equal(preview.deadlineAt, '2026-09-30T08:00:00.000Z')
    const result = f.calendar.repair(f.manager, { week: view.week, token: preview.token, reason: '国庆工作日历核对' })
    assert.equal(result.unchanged, true)
    assert.equal(f.service.view(f.member, view.week).deadlineAt, preview.deadlineAt)
    assert.equal(f.store.get<WeeklyCycle>('weeklyCycles', view.week)?.frozenAt, cycle.frozenAt)
    const count = f.store.list('events').length
    f.calendar.repair(f.manager, { week: view.week, token: preview.token, reason: '国庆工作日历核对' })
    assert.equal(f.store.list('events').length, count)
  } finally { f.store.close() }
})

test('repair rejects historical facts, stale previews, unauthorized actors and elapsed new deadlines', () => {
  const f = fixture()
  try {
    f.configure()
    f.set('2026-09-28T01:00:00Z')
    const view = f.service.view(f.manager, '2026-09-28')
    assert.throws(() => f.calendar.previewRepair(f.member, { week: view.week }), /管理者/)
    const preview = f.calendar.previewRepair(f.manager, { week: view.week })
    assert.throws(() => f.calendar.repair(f.manager, { week: view.week, token: 'tampered', reason: '修复' }), /预览/)
    const duty = view.duties[0]
    f.service.submit(f.member, { dutyId: duty.id, version: duty.version, manifest: duty.manifest, note: '暂无安排', requestId: 'receipt', draftAction: 'retain' })
    assert.equal(f.calendar.previewRepair(f.manager, { week: view.week }).eligible, false)
    assert.throws(() => f.calendar.repair(f.manager, { week: view.week, token: preview.token, reason: '修复' }), /预览|历史|提交/)
    f.set('2026-09-30T08:00:00Z')
    assert.equal(f.calendar.previewRepair(f.manager, { week: view.week }).eligible, false)
  } finally { f.store.close() }
})
