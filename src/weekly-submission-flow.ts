import type { WeeklyDutyView, SubmissionKind } from '../shared/weekly-submissions'
import type { WeeklyRecord } from '../shared/types'
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord } from '../shared/weekly-record-state'
import { shanghaiToday, weekMonday } from './overview-data'

export interface WorkTarget {
  cycleWeek: string; contentWeek: string; ownerId: string; kind: SubmissionKind
  recordId?: string; create?: boolean
}
export interface ReviewRequest extends WorkTarget { token: number }

/** getRandomValues is supported on the deployed LAN HTTP origin; randomUUID is not. */
export function createSubmissionRequestId(source: { getRandomValues(array: Uint8Array): Uint8Array } = globalThis.crypto): string {
  const bytes = source.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
}
export function advanceWeek(week: string, days: number): string {
  const date = new Date(`${week}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0,10)
}
export function recordTarget(record: Pick<WeeklyRecord,'weekStart'|'ownerId'>, cycleWeek: string, currentWeek = weekMonday(shanghaiToday())): WorkTarget {
  const plan = record.weekStart === advanceWeek(cycleWeek,7) || record.weekStart > currentWeek
  return { cycleWeek: plan ? advanceWeek(record.weekStart,-7) : record.weekStart, contentWeek: record.weekStart, ownerId:record.ownerId, kind:plan ? 'plan':'results' }
}
export const submissionLabels = { due:'待整份提交', on_time:'按时提交', missing:'逾期未整份提交', late:'逾期补交', exempt:'已豁免' }
export const planReviewLabels = { not_required:'无需审核', unsubmitted:'待提交审核', pending:'待审核', approved:'计划已通过', returned:'已退回修改', changed:'计划已变化，待重提' }
export const planReviewTones = { not_required:'neutral', unsubmitted:'neutral', pending:'amber', approved:'green', returned:'red', changed:'amber' }
export function weeklyRecordState(record: WeeklyRecord) {
  if (!isActiveWeeklyRecord(record)) return { label:'已删除', tone:'neutral' }
  if (!record.submitted) return { label:'草稿 · 未纳入周统计', tone:'neutral' }
  if (record.planApproval?.suspended) return { label:'本周期无需审核 · 纳入周统计', tone:'neutral' }
  if (record.planApproval?.required && !isEffectiveWeeklyRecord(record)) return { label:record.planApproval.approvedSubmissionId ? '计划有修改 · 待重新审核' : '计划待审核 · 未纳入周统计', tone:'amber' }
  if (record.planApproval?.required) return { label:'计划已审核 · 纳入周统计', tone:'green' }
  if (record.workOrigin?.kind === 'assigned') return { label:'管理员已确认 · 纳入周统计', tone:'blue' }
  return { label:'已纳入周统计', tone:'neutral' }
}
/** Execution-only changes never turn an approved plan back into a review request. */
export function submissionChangeNotice(duty: WeeklyDutyView): string {
  if (duty.kind === 'plan' && duty.planReviewRequired) {
    if (duty.planReviewStatus === 'changed') return '计划条目或承诺已变化，请重新核对并提交审核；原批准版本保留在历史中。'
    if (duty.planReviewStatus === 'returned') return '请按退回意见修改计划，再核对并重新提交审核。'
    if (duty.changedSinceSubmission) return '提交后有执行进展更新，计划审核结论不变；可提交修订保存最新进展。'
    return ''
  }
  return duty.changedSinceSubmission ? '提交后有更新，请重新核对并提交修订。' : ''
}
export function submissionProgress(duty: WeeklyDutyView) {
  const records = duty.records.filter(isActiveWeeklyRecord)
  const filled = records.filter(row => duty.kind === 'plan' ? !!row.commitment?.trim() :
    !!row.actualOutcome?.trim() && (!['blocked','not_done'].includes(row.status) || !!row.blocker?.trim())).length
  return { total:records.length, filled, drafts:records.filter(row=>!row.submitted).length,
    lastUpdatedAt:records.map(row=>row.updatedAt).sort().at(-1) ?? null,
    label:duty.status !== 'due' ? submissionLabels[duty.status] : filled ? '已填写，待整份提交' : records.length ? (duty.kind === 'results' ? '已安排，待填写进展' : '待填写计划') : '尚未填写' }
}
