import type { WeeklyRecord } from '../shared/types.ts'
import type { WeeklySubmission } from '../shared/weekly-submissions.ts'
import type { Store } from './store.ts'

export function weekOverlapsMonth(weekStart: string, month: string): boolean {
  const end = new Date(`${weekStart}T00:00:00Z`)
  end.setUTCDate(end.getUTCDate() + 6)
  return month >= weekStart.slice(0, 7) && month <= end.toISOString().slice(0, 7)
}

/** A withdrawal never erases submission evidence, including frozen formal receipts. */
export function submittedWeeklyEvidence(store: Store) {
  const events = store.entityTypeEvents(['weeklyRecord']).filter(event => (event.action === 'submit' || [event.before, event.after].some(snapshot =>
      !!snapshot && typeof snapshot === 'object' && (snapshot as Partial<WeeklyRecord>).submitted === true)))
  const submissions = store.list<WeeklySubmission>('weeklySubmissions')
  const ids = new Set(events.map(event => event.entityId))
  for (const submission of submissions) for (const record of submission.records) ids.add(record.id)
  return { events, submissions, ids }
}
