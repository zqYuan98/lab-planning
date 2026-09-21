import type { CollaborationTaskStatusSummary } from './collaboration'
import type { Task, User, WeeklyRecord } from './types'
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord } from './weekly-record-state'

/**
 * Show the current week when present, otherwise the most recent past week.
 * A new current-week plan deliberately takes precedence over an older completed week.
 * Drafts belong to their owner; a manager's summary only includes others' submitted rows.
 */
export function summarizeCollaborationTask(
  task: Task,
  records: readonly WeeklyRecord[],
  actor: Pick<User, 'id' | 'role'>,
  now = new Date(),
): CollaborationTaskStatusSummary {
  if (actor.role !== 'manager' && actor.id !== task.ownerId) return { weeklySummary: null, overallStatusNeedsConfirmation: false }
  // Keep the same fixed Beijing calendar as the server's collaboration-calendar helpers.
  const today = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
  const date = new Date(`${today}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
  const weekStart = date.toISOString().slice(0, 10)
  const record = records.filter(row => isActiveWeeklyRecord(row) && row.taskId === task.id && row.ownerId === task.ownerId &&
    row.weekStart <= weekStart && (row.ownerId === actor.id || isEffectiveWeeklyRecord(row)))
    .sort((a, b) => b.weekStart.localeCompare(a.weekStart) || b.updatedAt.localeCompare(a.updatedAt) ||
      b.version - a.version || a.id.localeCompare(b.id))[0]
  if (!record) return { weeklySummary: null, overallStatusNeedsConfirmation: false }
  return {
    weeklySummary: {
      recordId: record.id, weekStart: record.weekStart, status: record.status,
      actualOutcome: record.actualOutcome, submitted: isEffectiveWeeklyRecord(record), isCurrentWeek: record.weekStart === weekStart,
      isImported: !!record.importSource,
      ...(record.planApproval?.required && record.submitted && !isEffectiveWeeklyRecord(record) ? { planReviewPending: true } : {}),
    },
    overallStatusNeedsConfirmation: record.status === 'done' && task.status !== 'done',
  }
}
