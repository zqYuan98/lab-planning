import assert from 'node:assert/strict'
import test from 'node:test'
import { assignmentAttempt, entryLocation, navigationUrl, notificationNavigation } from '../src/notification-navigation'

test('external entry selects messages without treating an identifier as authentication', () => {
  assert.deepEqual(entryLocation({ pathname: '/entry', search: '?notificationId=ntf_123' }), { page: 'messages', intent: { id: 'ntf_123' } })
  assert.deepEqual(entryLocation({ pathname: '/entry', search: '?notificationId=https://evil.example' }), { page: 'messages', intent: undefined })
  assert.deepEqual(entryLocation({ pathname: '/work', search: '' }), { page: 'messages' })
})

test('next-week plan keeps the authoritative submission cycle distinct from content week', () => {
  assert.deepEqual(notificationNavigation({ type: 'weeklySubmission', id: 'duty', kind: 'plan', weekStart: '2026-09-21', cycleWeek: '2026-09-14' }), {
    page: 'weekly', intent: { action: 'review', weekStart: '2026-09-21', cycleWeek: '2026-09-14', kind: 'plan' },
  })
  assert.deepEqual(notificationNavigation({ type: 'plan', id: 'plan_1', month: '2026-08' }), { page: 'monthly', intent: { id: 'plan_1', month: '2026-08' } })
})

test('atomic weekly submit keeps retry key until payload changes or a new form begins', () => {
  let sequence = 0
  const createId = () => `request-${++sequence}`
  const initial = assignmentAttempt(null, { task: { title: 'one' }, record: { weekStart: '2026-09-14' } }, createId)
  assert.equal(assignmentAttempt(initial, { task: { title: 'one' }, record: { weekStart: '2026-09-14' } }, createId), initial)
  assert.equal(sequence, 1)
  const changed = assignmentAttempt(initial, { task: { title: 'two' }, record: { weekStart: '2026-09-14' } }, createId)
  assert.notEqual(changed.requestId, initial.requestId)
  const reopened = assignmentAttempt(null, { task: { title: 'one' }, record: { weekStart: '2026-09-14' } }, createId)
  assert.notEqual(reopened.requestId, initial.requestId)
})

test('collaboration and report detail links survive browser refresh without changing the target type', () => {
  for (const type of ['followup', 'digest', 'deadlineRequest', 'report'] as const) {
    const destination = notificationNavigation({ type, id: `${type}_123` })
    assert.equal(destination.page, type === 'report' ? 'reports' : 'collaboration')
    assert.deepEqual(entryLocation(new URL(navigationUrl(destination.page, destination.intent), 'https://workspace.test')), destination)
  }
  assert.deepEqual(entryLocation({ pathname: '/work', search: '?view=collaboration&targetType=users&id=https://evil.example' }), { page: 'collaboration', intent: {} })
})

test('business target refresh preserves the item and submission cycle using allowlisted URLs', () => {
  const destination = notificationNavigation({ type: 'weeklySubmission', id: 'duty', kind: 'plan', weekStart: '2026-09-21', cycleWeek: '2026-09-14' })
  const url = new URL(navigationUrl(destination.page, destination.intent), 'https://workspace.test')
  assert.deepEqual(entryLocation(url), destination)
  assert.deepEqual(entryLocation({ pathname: '/work', search: '?view=weekly&weekStart=2026-99-99&cycleWeek=2026-09-15&kind=evil&action=publish&id=https://evil.example' }), { page: 'weekly', intent: {} })
  assert.deepEqual(entryLocation({ pathname: '/work', search: '?view=team&return=https://evil.example' }), { page: 'messages' })
})
