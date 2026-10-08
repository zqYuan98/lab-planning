import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { calendarWorkingDay, calendarWorkingDaysInWeek, effectiveCalendarOverrides, getWorkWeekCalendar } from '../shared/china-work-calendar.ts'
import { resolveWeeklyDeadline, shiftDay } from '../shared/work-calendar.ts'
import { adjacentWorkday, dayAt, workdayCount } from '../server/collaboration-calendar.ts'
import { Store } from '../server/store.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { WeeklyCalendarService } from '../server/weekly-calendar-service.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import type { User } from '../shared/types.ts'
import type { WeeklyCycle, WeeklyDeadlinePolicy, WeeklyRule } from '../shared/weekly-submissions.ts'

const metadata = { version: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }
function fixture(t: TestContext, now = '2026-09-24T01:00:00.000Z') {
  const store = new Store(':memory:'); t.after(() => store.close())
  const manager = store.restoreEntity<User>('users', { ...metadata, id: 'manager', name: '主管', email: 'manager@calendar.test', position: '', role: 'manager', active: true })
  const member = store.restoreEntity<User>('users', { ...metadata, id: 'member', name: '成员', email: 'member@calendar.test', position: '', role: 'member', active: true })
  let clock = new Date(now)
  const service = new WeeklySubmissionService(store, () => clock), calendar = new WeeklyCalendarService(store, () => clock)
  const legacy = (deadlinePolicies?: WeeklyDeadlinePolicy[]) => store.restoreEntity<WeeklyRule>('weeklyRules', {
    ...metadata, id: 'weekly-submission-rule', enabled: true, effectiveWeek: '2026-09-21', timezone: 'Asia/Shanghai',
    windows: [{ fromWeek: '2026-09-21', toWeek: null }], planReviewEffectiveWeek: '2026-09-21', managerSubmissionEffectiveWeek: '2026-09-21',
    ...(deadlinePolicies ? { deadlinePolicies } : {}),
  })
  return { store, manager, member, service, calendar, legacy, set: (value: string) => { clock = new Date(value) } }
}

test('2026 statutory calendar includes all seven holiday periods and six working weekends', () => {
  for (const [start, length] of [['2026-01-01', 3], ['2026-02-15', 9], ['2026-04-04', 3], ['2026-05-01', 5], ['2026-06-19', 3], ['2026-09-25', 3], ['2026-10-01', 7]] as const) {
    for (let offset = 0; offset < length; offset++) assert.equal(calendarWorkingDay(shiftDay(start, offset)), false, shiftDay(start, offset))
  }
  for (const day of ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']) assert.equal(calendarWorkingDay(day), true, day)
  assert.equal(Object.keys(effectiveCalendarOverrides()).length, 39)
  assert.deepEqual(calendarWorkingDaysInWeek('2026-09-28'), ['2026-09-28', '2026-09-29', '2026-09-30'])
  assert.deepEqual(getWorkWeekCalendar('2026-10-05'), { week: '2026-10-05', workingDays: ['2026-10-08', '2026-10-09', '2026-10-10'], officialCalendarAvailable: true })
})

test('company exceptions override both holidays and working weekends; unknown years are explicit', () => {
  const overrides = { '2026-10-07': true, '2026-10-10': false }
  assert.deepEqual(calendarWorkingDaysInWeek('2026-10-05', overrides), ['2026-10-07', '2026-10-08', '2026-10-09'])
  const combined = effectiveCalendarOverrides(overrides)
  assert.equal(combined['2026-10-07'], true)
  assert.equal(combined['2026-10-10'], false)
  assert.deepEqual(Object.keys(combined), Object.keys(combined).sort())
  combined['2026-10-01'] = true
  assert.equal(calendarWorkingDay('2026-10-01'), false, 'callers cannot mutate the builtin calendar')
  assert.equal(getWorkWeekCalendar('2026-12-28').officialCalendarAvailable, false)
  assert.equal(getWorkWeekCalendar('2027-01-04').officialCalendarAvailable, false)
  assert.equal(calendarWorkingDay('2027-01-04'), true)
  assert.equal(calendarWorkingDay('2027-01-09'), false)
})

test('collaboration skips the National Day break when finding and counting workdays', () => {
  assert.equal(adjacentWorkday('2026-09-30', 1), '2026-10-08')
  assert.equal(adjacentWorkday('2026-10-08', -1), '2026-09-30')
  assert.equal(adjacentWorkday('2026-10-09', 1), '2026-10-10')
  assert.equal(workdayCount('2026-09-30', '2026-10-08'), 0)
  assert.equal(workdayCount('2026-09-30', '2026-10-10', {}, true), 3)
})

test('new rules use the national calendar by default and freeze its inputs into each policy', t => {
  const f = fixture(t), rule = f.service.getRule()
  assert.equal(rule.deadlinePolicies?.[0].mode, 'last_workday')
  assert.equal(rule.deadlinePolicies?.[0].fromWeek, '2026-09-28')
  assert.deepEqual(rule.deadlinePolicies?.[0].calendarOverrides, effectiveCalendarOverrides())
  assert.equal(resolveWeeklyDeadline(rule, '2026-09-28').deadlineAt, '2026-09-30T08:00:00.000Z')
  assert.equal(resolveWeeklyDeadline(rule, '2026-10-05').deadlineAt, '2026-10-10T08:00:00.000Z')
  assert.equal(resolveWeeklyDeadline(rule, '2026-02-16').deadlineAt, '2026-02-20T08:00:00.000Z', 'pre-policy history retains Friday semantics')
  assert.deepEqual(f.service.view(f.manager, '2026-10-05').workCalendar?.overrides, {}, 'builtin dates are not stored as company overrides')
  f.set('2026-10-08T01:00:00.000Z')
  const cycle = f.service.view(f.member, '2026-10-05')
  assert.deepEqual(cycle.deadlinePolicy?.workingDays, ['2026-10-08', '2026-10-09', '2026-10-10'])
  assert.ok(cycle.duties.every(duty => duty.deadlineAt === cycle.deadlineAt))
})

test('legacy rules upgrade once from next week and retain frozen and delayed historical Friday periods', t => {
  const f = fixture(t, '2026-10-08T01:00:00.000Z')
  f.legacy()
  const frozen = f.store.restoreEntity<WeeklyCycle>('weeklyCycles', { ...metadata, id: '2026-10-05', week: '2026-10-05', deadlineAt: '2026-10-09T08:00:00.000Z',
    rosterIds: [f.member.id], needsReview: false, confirmedBy: f.manager.id, confirmationReason: '历史确认', frozenAt: '2026-10-05T01:00:00.000Z' })
  const upgraded = f.service.getRule()
  assert.equal(upgraded.deadlinePolicies?.[0].fromWeek, '2026-10-12')
  assert.deepEqual(f.service.getRule(), upgraded)
  assert.equal(f.service.view(f.member, '2026-09-28').deadlineAt, '2026-10-02T08:00:00.000Z')
  assert.deepEqual(f.store.get('weeklyCycles', frozen.id), frozen)
  const preview = f.calendar.previewRepair(f.manager, { week: frozen.week })
  assert.equal(preview.eligible, true)
  assert.equal(preview.deadlineAt, '2026-10-10T08:00:00.000Z')
  assert.deepEqual(f.store.get('weeklyCycles', frozen.id), frozen, 'preview does not silently update the existing cycle')
  f.calendar.repair(f.manager, { week: frozen.week, token: preview.token, reason: '确认国庆后调休工作日' })
  assert.equal(f.service.view(f.member, frozen.week).deadlineAt, '2026-10-10T08:00:00.000Z')
})

test('previous explicit weekday policies remain immutable and their holiday-week snapshots still restore', t => {
  const f = fixture(t)
  const legacy = f.legacy([{ version: 1, fromWeek: '2026-09-21', mode: 'last_workday', calendarOverrides: {} }])
  assert.deepEqual(f.service.getRule().deadlinePolicies, legacy.deadlinePolicies)
  const view = f.service.view(f.member, '2026-09-21')
  assert.equal(view.deadlineAt, '2026-09-25T08:00:00.000Z')
  assert.ok(view.deadlinePolicy?.workingDays.includes('2026-09-25'))
  const packet = exportBusinessData(f.store, f.manager)
  const target = fixture(t)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  assert.deepEqual(target.store.get<WeeklyCycle>('weeklyCycles', view.week)?.deadlinePolicy, view.deadlinePolicy)
})

test('a new default whole-holiday week has no duties or missing facts', t => {
  const f = fixture(t, '2026-02-12T01:00:00.000Z')
  f.service.getRule()
  f.set('2026-02-22T12:00:00.000Z')
  const view = f.service.view(f.member, '2026-02-16')
  assert.equal(view.deadlineAt, null)
  assert.deepEqual(view.deadlinePolicy?.workingDays, [])
  assert.deepEqual(view.duties, [])
  assert.deepEqual(f.store.list('weeklyMissing'), [])
})
