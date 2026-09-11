import type { Entity, WeeklyRecord } from '../shared/types.ts'
import type { WeeklyRule, WeeklyCycle, WeeklyDuty, WeeklySubmission, WeeklyMissing, WeeklyAdjustment, WeeklyReportSubmission } from '../shared/weekly-submissions.ts'
import type { BusinessCollections, TransferCollection } from './data-transfer-schema.ts'
import { addWeekDays, fridayDeadline, mondayInstant } from './weekly-submission-clock.ts'

const time = (value: string) => Date.parse(value)
const sameTime = (left: string, right: string) => time(left) === time(right)

export function reportSubmissionIssues(row: WeeklyReportSubmission, issue: (message: string) => void) {
  if (!sameTime(row.deadlineAt, fridayDeadline(row.cycleWeek))) issue('报告提报摘要：截止时间与周期不一致')
  if (row.firstSubmittedAt && time(row.firstSubmittedAt) < time(mondayInstant(row.cycleWeek))) issue('报告提报摘要：提交早于周期开始')
  if (row.status === 'on_time' && (!row.firstSubmittedAt || time(row.firstSubmittedAt) >= time(row.deadlineAt)) || row.status === 'late' && (!row.firstSubmittedAt || time(row.firstSubmittedAt) < time(row.deadlineAt))) issue('报告提报摘要：状态与提交时间不一致')
  if (['due', 'missing'].includes(row.status) && row.firstSubmittedAt !== null || row.status === 'exempt' && !row.exemptionReason.trim()) issue('报告提报摘要：状态与事实不一致')
}

/** Cross-row facts must survive an account remap without creating a different duty or timeline. */
export function weeklyTransferIssues(rows: BusinessCollections, available: Record<TransferCollection, Map<string, Entity>>, issue: (message: string) => void) {
  const rules = available.weeklyRules as Map<string, WeeklyRule>
  const cycles = available.weeklyCycles as Map<string, WeeklyCycle>
  const duties = available.weeklyDuties as Map<string, WeeklyDuty>
  const receipts = available.weeklySubmissions as Map<string, WeeklySubmission>
  const records = available.weeklyRecords as Map<string, WeeklyRecord>
  const unique = <T extends Entity>(name: TransferCollection, key: (row: T) => string) => {
    const seen = new Map<string, string>()
    for (const row of available[name].values() as Iterable<T>) {
      const value = key(row)
      if (seen.has(value) && seen.get(value) !== row.id) issue(`${name} 存在重复业务键：${value}`)
      seen.set(value, row.id)
    }
  }
  unique<WeeklyCycle>('weeklyCycles', row => row.week)
  unique<WeeklyDuty>('weeklyDuties', row => `${row.ownerId}/${row.cycleWeek}/${row.kind}`)
  unique<WeeklySubmission>('weeklySubmissions', row => `${row.dutyId}/${row.requestId}`)
  unique<WeeklyMissing>('weeklyMissing', row => row.dutyId)
  for (const rule of rows.weeklyRules) {
    if (!rule.windows.length || rule.windows[0].fromWeek !== rule.effectiveWeek) issue('weeklyRules：生效周与启用窗口不一致')
    for (let index = 0; index < rule.windows.length; index++) {
      const window = rule.windows[index], previous = rule.windows[index - 1]
      if (window.fromWeek < rule.effectiveWeek || window.toWeek !== null && window.toWeek < window.fromWeek || previous && (!previous.toWeek || previous.toWeek > window.fromWeek)) issue('weeklyRules：启用窗口重叠或时间顺序无效')
    }
    if (rule.enabled !== (rule.windows.at(-1)?.toWeek === null)) issue('weeklyRules：启用状态与窗口不一致')
  }
  for (const cycle of rows.weeklyCycles) {
    const rule = rules.get('weekly-submission-rule')
    if (cycle.id !== cycle.week || !sameTime(cycle.deadlineAt, fridayDeadline(cycle.week))) issue(`weeklyCycles/${cycle.id}：周期或截止时间不一致`)
    if (rule && !rule.windows.some(w => w.fromWeek <= cycle.week && (!w.toWeek || cycle.week < w.toWeek))) issue(`weeklyCycles/${cycle.id}：周期不在规则生效窗口内`)
    if (new Set(cycle.rosterIds).size !== cycle.rosterIds.length) issue(`weeklyCycles/${cycle.id}：名单映射后重复`)
    if (time(cycle.frozenAt) < time(mondayInstant(cycle.week))) issue(`weeklyCycles/${cycle.id}：冻结时间早于周期开始`)
    if (cycle.confirmedBy && (cycle.needsReview || !cycle.confirmationReason.trim()) || !cycle.confirmedBy && cycle.confirmationReason) issue(`weeklyCycles/${cycle.id}：名单确认状态不一致`)
  }
  for (const duty of rows.weeklyDuties) {
    const cycle = cycles.get(duty.cycleWeek)
    if (cycle && (cycle.needsReview || !cycle.rosterIds.includes(duty.ownerId) || !sameTime(cycle.deadlineAt, duty.deadlineAt))) issue(`weeklyDuties/${duty.id}：应交项与周期名单不一致`)
    if (duty.contentWeek !== addWeekDays(duty.cycleWeek, duty.kind === 'results' ? 0 : 7) || !sameTime(duty.deadlineAt, fridayDeadline(duty.cycleWeek))) issue(`weeklyDuties/${duty.id}：内容周或截止时间不一致`)
  }
  const identity = (name: string, row: WeeklySubmission | WeeklyMissing | WeeklyAdjustment) => {
    const duty = duties.get(row.dutyId)
    if (duty && (row.ownerId !== duty.ownerId || row.cycleWeek !== duty.cycleWeek || row.kind !== duty.kind)) issue(`${name}/${row.id}：事实与应交项身份不一致`)
    return duty
  }
  for (const row of rows.weeklySubmissions) {
    const duty = identity('weeklySubmissions', row)
    if (time(row.submittedAt) < time(mondayInstant(row.cycleWeek))) issue(`weeklySubmissions/${row.id}：提交时间早于周期开始`)
    if (row.actorId !== row.ownerId && !row.reason.trim() || !row.records.length && !row.note.trim()) issue(`weeklySubmissions/${row.id}：代录或无工作说明缺失`)
    const seen = new Set<string>()
    for (const snapshot of row.records) {
      if (seen.has(snapshot.id) || !snapshot.submitted || snapshot.ownerId !== row.ownerId || duty && snapshot.weekStart !== duty.contentWeek) issue(`weeklySubmissions/${row.id}：提交快照重复、未正式提交或负责人/内容周不一致`)
      const current = records.get(snapshot.id)
      if (current && (snapshot.ownerId !== current.ownerId || snapshot.taskId !== current.taskId || snapshot.weekStart !== current.weekStart || snapshot.version > current.version)) issue(`weeklySubmissions/${row.id}：快照与周记录身份或版本不一致`)
      seen.add(snapshot.id)
    }
    const manifestIds = row.retainedDraftManifest.map(item => item.id)
    if (new Set(row.retainedDraftIds).size !== row.retainedDraftIds.length || new Set(manifestIds).size !== manifestIds.length || [...manifestIds].sort().join('\0') !== [...row.retainedDraftIds].sort().join('\0')) issue(`weeklySubmissions/${row.id}：保留草稿清单不一致`)
    for (const item of row.retainedDraftManifest) {
      const current = records.get(item.id)
      if (seen.has(item.id) || current && (current.ownerId !== row.ownerId || duty && current.weekStart !== duty.contentWeek || current.version < item.version)) issue(`weeklySubmissions/${row.id}：保留草稿身份或版本不一致`)
    }
  }
  for (const row of rows.weeklyMissing) {
    const duty = identity('weeklyMissing', row)
    if (!sameTime(row.deadlineAt, fridayDeadline(row.cycleWeek)) || duty && !sameTime(row.deadlineAt, duty.deadlineAt) || time(row.detectedAt) < time(row.deadlineAt)) issue(`weeklyMissing/${row.id}：缺交检测早于截止或截止时间不一致`)
  }
  for (const row of rows.weeklyAdjustments) {
    identity('weeklyAdjustments', row)
    const receipt = row.submissionId ? receipts.get(row.submissionId) : undefined
    if (['invalidate', 'restore'].includes(row.action) !== !!row.submissionId || receipt && (receipt.dutyId !== row.dutyId || time(row.occurredAt) < time(receipt.submittedAt))) issue(`weeklyAdjustments/${row.id}：调整与提交记录或时间不一致`)
    if (!row.reason.trim() || time(row.occurredAt) < time(mondayInstant(row.cycleWeek))) issue(`weeklyAdjustments/${row.id}：调整原因或发生时间无效`)
  }
}
