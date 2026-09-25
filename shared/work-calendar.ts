import type { WeeklyDeadlineSnapshot, WeeklyRule } from './weekly-submissions'

export function shiftDay(day: string, count: number): string {
  const date = new Date(`${day}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + count)
  return date.toISOString().slice(0, 10)
}

export function workingDay(day: string, overrides: Record<string, boolean> = {}): boolean {
  if (Object.hasOwn(overrides, day)) return overrides[day]
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
  return weekday >= 1 && weekday <= 5
}

export function workingDaysInWeek(week: string, overrides: Record<string, boolean>): string[] {
  return Array.from({ length: 7 }, (_, offset) => shiftDay(week, offset)).filter(day => workingDay(day, overrides))
}

export function snapshotDeadline(week: string, snapshot: WeeklyDeadlineSnapshot): string | null {
  const day = snapshot.mode === 'friday' ? shiftDay(week, 4) : snapshot.workingDays.at(-1)
  return day ? new Date(`${day}T16:00:00+08:00`).toISOString() : null
}

/** A policy's calendar is immutable; delayed reconciliation uses the policy of that week. */
export function resolveWeeklyDeadline(rule: WeeklyRule, week: string): {
  deadlineAt: string | null; deadlinePolicy?: WeeklyDeadlineSnapshot
} {
  const policy = rule.deadlinePolicies?.filter(row => row.fromWeek <= week).at(-1)
  if (!policy) return { deadlineAt: new Date(`${shiftDay(week, 4)}T16:00:00+08:00`).toISOString() }
  const deadlinePolicy: WeeklyDeadlineSnapshot = {
    policyVersion: policy.version, mode: policy.mode, workingDays: workingDaysInWeek(week, policy.calendarOverrides),
  }
  return { deadlineAt: snapshotDeadline(week, deadlinePolicy), deadlinePolicy }
}
