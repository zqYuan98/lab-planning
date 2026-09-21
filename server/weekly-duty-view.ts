import type { WeeklyRecord } from '../shared/types.ts'
import type { WeeklyAdjustment, WeeklyDuty, WeeklyDutyView, WeeklyMissing, WeeklyPlanReview, WeeklyRule, WeeklySubmission } from '../shared/weekly-submissions.ts'
import type { ProgressEvent } from '../shared/collaboration.ts'
import { isActiveWeeklyRecord, isWeeklyPlanReviewCycle, weeklyPlanManifest, weeklyResultManifest } from '../shared/weekly-record-state.ts'

/** A task note affects the cycle containing it, never every historical week of a long task. */
export function submissionProgressEvents(duty: WeeklyDuty, records: WeeklyRecord[], events: ProgressEvent[]): ProgressEvent[] {
  const tasks = new Set(records.map(row => row.taskId)), recordIds = new Set(records.map(row => row.id))
  const end = new Date(`${duty.contentWeek}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 6)
  const endDay = end.toISOString().slice(0, 10)
  return events.filter(event => {
    if (event.ownerId !== duty.ownerId || !tasks.has(event.taskId) || event.noteType === 'no_change' || !event.note.trim() && !event.changes.length) return false
    if (event.weeklyRecordId) return recordIds.has(event.weeklyRecordId)
    const time = Date.parse(event.occurredAt)
    if (!Number.isFinite(time)) return false
    const day = new Date(time + 8 * 3600000).toISOString().slice(0, 10)
    return day >= duty.cycleWeek && day <= endDay
  })
}

export function weeklyDutyHistory(duty: WeeklyDuty, allSubmissions: WeeklySubmission[], allAdjustments: WeeklyAdjustment[]) {
  const submissions = allSubmissions.filter(row => row.dutyId === duty.id), adjustments = allAdjustments.filter(row => row.dutyId === duty.id)
  const invalid = new Set<string>()
  let exemptionReason = ''
  for (const event of adjustments) {
    if (event.action === 'exempt') exemptionReason = event.reason
    if (event.action === 'revoke_exemption') exemptionReason = ''
    if (event.action === 'invalidate' && event.submissionId) invalid.add(event.submissionId)
    if (event.action === 'restore' && event.submissionId) invalid.delete(event.submissionId)
  }
  const valid = submissions.filter(row => !invalid.has(row.id)).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.createdAt.localeCompare(b.createdAt))
  return { submissions, adjustments, valid, exemptionReason }
}

/** Shared pure projection: showing a notification never creates deadline or submission facts. */
export function projectWeeklyDuty(duty: WeeklyDuty, data: { submissions: WeeklySubmission[]; adjustments: WeeklyAdjustment[]; records: WeeklyRecord[]; missing: WeeklyMissing[]; progressEvents?: ProgressEvent[]; rule?: WeeklyRule; planReviews?: WeeklyPlanReview[] }, now: Date): WeeklyDutyView {
  const { submissions, adjustments, valid, exemptionReason } = weeklyDutyHistory(duty, data.submissions, data.adjustments)
  const records = data.records.filter(row => isActiveWeeklyRecord(row) && row.ownerId === duty.ownerId && row.weekStart === duty.contentWeek).sort((a, b) => a.id.localeCompare(b.id))
  const first = valid[0], latest = valid.at(-1)
  const manifest = (rows: WeeklyRecord[]) => rows.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id))
  const official = records.filter(row => row.submitted), drafts = manifest(records.filter(row => !row.submitted))
  const progress = submissionProgressEvents(duty, records, data.progressEvents ?? [])
  const newProgress = latest ? submissionProgressEvents(duty, latest.records, data.progressEvents ?? []).some(event => latest.progressEventIds ? !latest.progressEventIds.includes(event.id) : event.occurredAt > latest.submittedAt) : false
  const planChanged = !!latest && (latest.planManifest ? JSON.stringify(weeklyPlanManifest(records)) !== JSON.stringify(latest.planManifest)
    : JSON.stringify(weeklyPlanManifest(official)) !== JSON.stringify(weeklyPlanManifest(latest.records)) || JSON.stringify(drafts) !== JSON.stringify(latest.retainedDraftManifest))
  const planReviewRequired = duty.kind === 'plan' && !!data.rule && isWeeklyPlanReviewCycle(data.rule, duty.cycleWeek)
  const planReviews = (data.planReviews ?? []).filter(review => review.dutyId === duty.id)
  const latestPlanReview = latest ? planReviews.find(review => review.submissionId === latest.id) ?? null : null
  return { ...duty, status: exemptionReason ? 'exempt' : first ? first.submittedAt < duty.deadlineAt ? 'on_time' : 'late' : now.toISOString() >= duty.deadlineAt ? 'missing' : 'due',
    firstSubmittedAt: first?.submittedAt ?? null, latestSubmittedAt: latest?.submittedAt ?? null, latestSubmission: latest ?? null,
    exemptionReason, records, manifest: manifest(records), submissions, adjustments, missingAtDeadline: data.missing.some(row => row.dutyId === duty.id),
    progressEventIds: progress.map(event => event.id).sort(),
    progressEvents: progress.slice().sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id)),
    planReviewRequired, planReviews, latestPlanReview,
    planReviewStatus: !planReviewRequired ? 'not_required' : !latest ? 'unsubmitted' : planChanged ? 'changed' : latestPlanReview?.decision ?? 'pending',
    changedSinceSubmission: duty.kind === 'plan' ? planChanged : !!latest && (newProgress || JSON.stringify(weeklyResultManifest(official)) !== JSON.stringify(weeklyResultManifest(latest.records)) || JSON.stringify(drafts) !== JSON.stringify(latest.retainedDraftManifest)) }
}
