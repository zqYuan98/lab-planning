import type { WeeklyRecord } from './types'
import type { WeeklyRule } from './weekly-submissions'

export function isActiveWeeklyRecord(record: WeeklyRecord): boolean { return !record.deletion }

/** Stable, browser-safe planning identity. Progress, storage versions and approval metadata are deliberately excluded. */
export function weeklyPlanFingerprint(record: WeeklyRecord): string {
  return JSON.stringify([record.taskId, record.ownerId, record.weekStart, record.monthlyPlanId, record.commitment])
}

export function isEffectiveWeeklyRecord(record: WeeklyRecord): boolean {
  return isActiveWeeklyRecord(record) && record.submitted && (!record.planApproval?.required
    || record.planApproval.suspended === true || !!record.planApproval.approvedSubmissionId && record.planApproval.approvedFingerprint === weeklyPlanFingerprint(record))
}

export function isWeeklyPlanReviewCycle(rule: WeeklyRule, cycleWeek: string): boolean {
  return !!rule.planReviewEffectiveWeek && cycleWeek >= rule.planReviewEffectiveWeek
    && rule.windows.some(window => cycleWeek >= window.fromWeek && (!window.toWeek || cycleWeek < window.toWeek))
}

export function weeklyPlanManifest(records: WeeklyRecord[]) {
  return records.filter(isActiveWeeklyRecord).map(record => ({ id: record.id, fingerprint: weeklyPlanFingerprint(record), submitted: record.submitted })).sort((a, b) => a.id.localeCompare(b.id))
}

/** Receipt changes describe reviewed business content, not a later approval's storage-version increment. */
export function weeklyResultManifest(records: WeeklyRecord[]) {
  return records.filter(isActiveWeeklyRecord).map(record => ({ id: record.id, fingerprint: JSON.stringify([
    weeklyPlanFingerprint(record), record.submitted, record.status, record.actualOutcome, record.evidenceUrl,
    record.blocker, record.blockerImpact ?? '', record.supportNeeded ?? '', record.nextAction,
  ]) })).sort((a, b) => a.id.localeCompare(b.id))
}
