import type { WeeklyReviewQueue } from '../shared/weekly-review-delegation'

/** Locate a pending action through the existing authorized, paginated queue. */
export function weeklyReviewFocus(queue: WeeklyReviewQueue, cursor: string, dutyId: string):
  { kind: 'open'; dutyId: string } | { kind: 'next'; cursor: string } | { kind: 'unavailable' } {
  if (queue.items.some(item => item.dutyId === dutyId)) return { kind: 'open', dutyId }
  if (queue.nextCursor && queue.nextCursor > cursor) return { kind: 'next', cursor: queue.nextCursor }
  return { kind: 'unavailable' }
}
