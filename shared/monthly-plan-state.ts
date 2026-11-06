import type { MonthlyPlan } from './types'

/** Deleted proposals remain stored for history and must never become current work. */
export function isActiveMonthlyPlan(plan: Pick<MonthlyPlan, 'deletion'>): boolean {
  return !plan.deletion
}
