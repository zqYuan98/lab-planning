import type { WeeklyDutyView, SubmissionKind } from '../shared/weekly-submissions'
import type { WeeklyRecord } from '../shared/types'

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
export function recordTarget(record: Pick<WeeklyRecord,'weekStart'|'ownerId'>, cycleWeek: string): WorkTarget {
  const plan = record.weekStart === advanceWeek(cycleWeek,7)
  return { cycleWeek: plan ? cycleWeek : record.weekStart, contentWeek: record.weekStart, ownerId:record.ownerId, kind:plan ? 'plan':'results' }
}
export const submissionLabels = { due:'待整份提交', on_time:'按时提交', missing:'逾期未整份提交', late:'逾期补交', exempt:'已豁免' }
export function submissionProgress(duty: WeeklyDutyView) {
  const filled = duty.records.filter(row => duty.kind === 'plan' ? !!row.commitment?.trim() :
    !!row.actualOutcome?.trim() && (!['blocked','not_done'].includes(row.status) || !!row.blocker?.trim())).length
  return { total:duty.records.length, filled, drafts:duty.records.filter(row=>!row.submitted).length,
    lastUpdatedAt:duty.records.map(row=>row.updatedAt).sort().at(-1) ?? null,
    label:duty.status !== 'due' ? submissionLabels[duty.status] : filled ? '已填写，待整份提交' : duty.records.length ? (duty.kind === 'results' ? '已安排，待填写进展' : '待填写计划') : '尚未填写' }
}
