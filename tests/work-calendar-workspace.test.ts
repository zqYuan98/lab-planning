import test from 'node:test'
import assert from 'node:assert/strict'
import { PeriodWorkspaceService } from '../server/period-workspace.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { Store } from '../server/store.ts'
import { readCollaborationSettings } from '../server/collaboration-policy.ts'
import type { User, Task, WeeklyRecord } from '../shared/types.ts'
import type { CollaborationSettings } from '../shared/collaboration.ts'
import type { WeeklyRule, WeeklyCycle } from '../shared/weekly-submissions.ts'

function fixture() {
  const store = new Store(':memory:')
  const metadata = { version: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }
  const user = store.restoreEntity<User>('users', { ...metadata, id: 'member', role: 'member', active: true, name: '成员', position: '', email: 'member@example.test' })
  const task = store.restoreEntity<Task>('tasks', { ...metadata, id: 'task', title: '返工安排', ownerId: user.id, monthlyPlanId: null, description: '', dueDate: '2026-10-10', status: 'doing', isTemporary: true, temporaryReason: '测试' })
  store.restoreEntity<WeeklyRecord>('weeklyRecords', { ...metadata, id: 'record', ownerId: user.id, taskId: task.id, monthlyPlanId: null, weekStart: '2026-10-05', commitment: '完成验证', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', submitted: true, status: 'doing', plannedEffortDays: 3.5, actualEffortDays: 2 })
  return { store, user }
}

test('weekly workspace exposes holiday workdays to members and uses the same calendar for capacity', t => {
  const { store, user } = fixture(); t.after(() => store.close())
  const service = new PeriodWorkspaceService(store)
  const result = service.weekly(user, { weekStart: '2026-10-05', q: 'no match' })
  assert.equal(result.total, 0)
  assert.deepEqual(result.calendar, { week: '2026-10-05', workingDays: ['2026-10-08', '2026-10-09', '2026-10-10'], officialCalendarAvailable: true })
  assert.equal(result.effortSummary.byOwnerWeek[0].capacityDays, 3)
  assert.equal(result.effortSummary.byOwnerWeek[0].overCapacity, true)
  store.insert<CollaborationSettings>('collaborationSettings', { ...readCollaborationSettings(store), calendarOverrides: { '2026-10-07': true } })
  const custom = service.weekly(user, { weekStart: '2026-10-05' })
  assert.deepEqual(custom.calendar?.workingDays, ['2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10'])
  assert.equal(custom.effortSummary.byOwnerWeek[0].capacityDays, 4)
  assert.equal(custom.effortSummary.byOwnerWeek[0].overCapacity, false)
})

test('live calendar is separate from a frozen legacy cutoff and notification preview stays read-only', t => {
  const { store, user } = fixture(); t.after(() => store.close())
  const metadata = { version: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }
  store.restoreEntity<WeeklyRule>('weeklyRules', { ...metadata, id: 'weekly-submission-rule', enabled: true, effectiveWeek: '2026-10-05', timezone: 'Asia/Shanghai', windows: [{ fromWeek: '2026-10-05', toWeek: null }], planReviewEffectiveWeek: '2026-10-05', managerSubmissionEffectiveWeek: '2026-10-05' })
  store.restoreEntity<WeeklyCycle>('weeklyCycles', { ...metadata, id: '2026-10-05', week: '2026-10-05', deadlineAt: '2026-10-09T08:00:00.000Z', rosterIds: [user.id], confirmedBy: 'manager', confirmationReason: '', frozenAt: '2026-10-05T01:00:00.000Z', needsReview: false })
  const service = new WeeklySubmissionService(store, () => new Date('2026-10-08T01:00:00Z'))
  const revision = store.workspaceRevision()
  const preview = service.preview(user, '2026-10-05')!
  assert.equal(store.workspaceRevision(), revision)
  assert.equal(preview.deadlineAt, '2026-10-09T08:00:00.000Z')
  assert.deepEqual(preview.calendar?.current.workingDays, ['2026-10-08', '2026-10-09', '2026-10-10'])
  assert.equal(preview.calendar?.next.workingDays.length, 5)
  assert.equal(preview.workCalendar, undefined)
  const view = service.view(user, '2026-10-05')
  assert.deepEqual(view.calendar, preview.calendar)
  assert.equal(view.deadlineAt, preview.deadlineAt)
})
