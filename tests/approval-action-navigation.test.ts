import test from 'node:test'
import assert from 'node:assert/strict'
import { actionNavigation } from '../src/my-actions-flow.ts'
import { entryLocation, navigationUrl } from '../src/notification-navigation.ts'
import { weeklyTaskIntentId } from '../src/weekly-submission-flow.ts'
import { weeklyReviewFocus } from '../src/weekly-review-focus.ts'
import type { WeeklyReviewQueue, WeeklyReviewQueueItem } from '../shared/weekly-review-delegation.ts'

test('monthly action links preserve the exact target and step through refresh and history', () => {
  for (const action of ['submit', 'review', 'publish', 'result']) {
    const next = actionNavigation({ page: 'monthly', id: 'goal-one', month: '2026-11', action })
    const url = new URL(navigationUrl(next.page, next.intent), 'http://localhost')
    const restored = entryLocation(url)
    assert.equal(restored.page, 'monthly')
    assert.equal(restored.intent?.id, 'goal-one')
    assert.equal(restored.intent?.month, '2026-11')
    assert.equal(restored.intent?.action, action)
  }
})

test('delegated action links cannot turn duty identifiers into task reads or expose the submitters private workspace', () => {
  const next = actionNavigation({ page: 'weekly', id: 'duty-123', ownerId: 'private-owner', kind: 'plan', action: 'review-queue', cycleWeek: '2026-11-02' })
  assert.deepEqual(next.intent, { action: 'review-queue', cycleWeek: '2026-11-02', weekStart: '2026-11-02', reviewDutyId: 'duty-123' })
  assert.equal(weeklyTaskIntentId(next.intent), undefined)
  const url = new URL(navigationUrl(next.page, { ...next.intent, id: 'private-task', ownerId: 'private-owner', kind: 'plan' }), 'http://localhost')
  assert.equal(url.searchParams.has('id'), false)
  assert.equal(url.searchParams.has('ownerId'), false)
  url.searchParams.set('ownerId', 'private-owner'); url.searchParams.set('id', 'private-task'); url.searchParams.set('kind', 'plan')
  assert.deepEqual(entryLocation(url), next)
  url.searchParams.set('reviewDutyId', '<invalid>')
  assert.equal(entryLocation(url).intent?.reviewDutyId, undefined)
})

test('review focus locates a target after the first authorized page and handles revoked or already decided work', () => {
  const page = (id: string, nextCursor: string | null): WeeklyReviewQueue => ({ week: '2026-11-02', items: [{ dutyId: id } as WeeklyReviewQueueItem], nextCursor })
  assert.deepEqual(weeklyReviewFocus(page('duty-01', 'duty-50'), '', 'duty-51'), { kind: 'next', cursor: 'duty-50' })
  assert.deepEqual(weeklyReviewFocus(page('duty-51', null), 'duty-50', 'duty-51'), { kind: 'open', dutyId: 'duty-51' })
  assert.deepEqual(weeklyReviewFocus(page('duty-52', null), 'duty-50', 'duty-51'), { kind: 'unavailable' })
  assert.deepEqual(weeklyReviewFocus(page('duty-49', 'duty-50'), 'duty-50', 'duty-51'), { kind: 'unavailable' }, 'stale cursors cannot loop')
})
