import type { Entity, WeeklyRecord, Report, AuditEvent } from '../shared/types.ts'
import type { WeeklyRule, WeeklyCycle, WeeklyDuty, WeeklySubmission, WeeklyMissing, WeeklyAdjustment, WeeklyReportSubmission, WeeklyPlanReview, WeeklyDeadlineSnapshot } from '../shared/weekly-submissions.ts'
import { canonical, planFingerprintParts, type BusinessCollections, type TransferCollection } from './data-transfer-schema.ts'
import { isWeeklyPlanReviewCycle, weeklyPlanFingerprint } from '../shared/weekly-record-state.ts'
import { addWeekDays, fridayDeadline, mondayInstant } from './weekly-submission-clock.ts'
import { snapshotDeadline, workingDaysInWeek } from '../shared/work-calendar.ts'

const time = (value: string) => Date.parse(value)
const sameTime = (left: string, right: string) => time(left) === time(right)

/** A frozen fact is interpreted from its own inputs, including legacy Friday facts. */
function deadlineIssues(week: string, deadlineAt: string | null, snapshot: WeeklyDeadlineSnapshot | undefined, allowRest: boolean, label: string, issue: (message: string) => void) {
  if (!snapshot) {
    if (deadlineAt === null || !sameTime(deadlineAt, fridayDeadline(week))) issue(`${label}：截止时间与固定周五周期不一致`)
    return
  }
  const days = snapshot.workingDays, nextWeek = addWeekDays(week, 7)
  if (days.some((day, index) => day < week || day >= nextWeek || index > 0 && days[index - 1] >= day)) issue(`${label}：工作日快照须为周期内有序且唯一的日期`)
  if (snapshot.policyVersion === 0 && snapshot.mode !== 'last_workday') issue(`${label}：显式修复必须使用最后工作日策略`)
  const expected = snapshotDeadline(week, snapshot)
  if (expected === null ? !allowRest || deadlineAt !== null : deadlineAt === null || !sameTime(deadlineAt, expected)) issue(`${label}：截止时间与冻结工作日快照不一致`)
}

/** Used for current rows and audit before/after independently of today's policy. */
export function weeklyDeadlineRowIssues(name: TransferCollection, input: unknown, issue: (message: string) => void) {
  if (name === 'weeklyCycles') {
    const cycle = input as WeeklyCycle
    deadlineIssues(cycle.week, cycle.deadlineAt, cycle.deadlinePolicy, true, `weeklyCycles/${cycle.id}`, issue)
    if (cycle.id !== cycle.week) issue(`weeklyCycles/${cycle.id}：周期身份不一致`)
  }
  if (name === 'weeklyDuties') {
    const duty = input as WeeklyDuty
    deadlineIssues(duty.cycleWeek, duty.deadlineAt, duty.deadlinePolicy, false, `weeklyDuties/${duty.id}`, issue)
    if (duty.contentWeek !== addWeekDays(duty.cycleWeek, duty.kind === 'results' ? 0 : 7)) issue(`weeklyDuties/${duty.id}：内容周不一致`)
  }
  if (name === 'weeklyRules') {
    const rule = input as WeeklyRule
    for (let index = 0; index < (rule.deadlinePolicies?.length ?? 0); index++) {
      const policy = rule.deadlinePolicies![index], previous = rule.deadlinePolicies![index - 1]
      if (policy.fromWeek < rule.effectiveWeek || previous && (previous.fromWeek >= policy.fromWeek || previous.version >= policy.version)) issue('weeklyRules：截止策略版本或生效周顺序无效')
    }
  }
  if (name === 'events') {
    const event = input as AuditEvent
    if (event.action !== 'deadline_repair' || !['weeklyCycle', 'weeklyDuty'].includes(event.entityType)) return
    const before = event.before as WeeklyCycle | WeeklyDuty | null, after = event.after as WeeklyCycle | WeeklyDuty | null
    if (!before || !after || !event.reason.trim() || before.id !== event.entityId || after.id !== event.entityId || after.version !== before.version + 1 || after.deadlinePolicy?.policyVersion !== 0) {
      issue(`events/${event.id}：截止修复审计身份、原因或版本不一致`)
      return
    }
    const unchanged = (row: WeeklyCycle | WeeklyDuty) => Object.fromEntries(Object.entries(row).filter(([key]) => !['version', 'updatedAt', 'deadlineAt', 'deadlinePolicy'].includes(key)))
    if (canonical(unchanged(before)) !== canonical(unchanged(after))) issue(`events/${event.id}：截止修复不得改动名单、义务身份或冻结时间`)
  }
}

export function reportSubmissionIssues(row: WeeklyReportSubmission, issue: (message: string) => void) {
  deadlineIssues(row.cycleWeek, row.deadlineAt, row.deadlinePolicy, false, '报告提报摘要', issue)
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
  const reviews = [...available.weeklyPlanReviews.values()] as WeeklyPlanReview[]
  const policySnapshotIssues = (week: string, snapshot: WeeklyDeadlineSnapshot | undefined, label: string) => {
    if (!snapshot || snapshot.policyVersion === 0) return
    const policy = rules.get('weekly-submission-rule')?.deadlinePolicies?.filter(policy => policy.fromWeek <= week).at(-1)
    const expectedDays = policy && workingDaysInWeek(week, policy.calendarOverrides)
    if (!policy || policy.version !== snapshot.policyVersion || policy.mode !== snapshot.mode || canonical(expectedDays) !== canonical(snapshot.workingDays)) issue(`${label}：冻结工作日快照与生效策略不一致`)
  }
  const invalidReceipts = new Set<string>()
  for (const adjustment of available.weeklyAdjustments.values() as Iterable<WeeklyAdjustment>) {
    if (adjustment.action === 'invalidate' && adjustment.submissionId) invalidReceipts.add(adjustment.submissionId)
    if (adjustment.action === 'restore' && adjustment.submissionId) invalidReceipts.delete(adjustment.submissionId)
  }
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
  unique<WeeklyPlanReview>('weeklyPlanReviews', row => row.submissionId)
  unique<WeeklyPlanReview>('weeklyPlanReviews', row => `${row.reviewedBy}/${row.requestId}`)
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
    policySnapshotIssues(cycle.week, cycle.deadlinePolicy, `weeklyCycles/${cycle.id}`)
    if (rule && !rule.windows.some(w => w.fromWeek <= cycle.week && (!w.toWeek || cycle.week < w.toWeek))) issue(`weeklyCycles/${cycle.id}：周期不在规则生效窗口内`)
    if (new Set(cycle.rosterIds).size !== cycle.rosterIds.length) issue(`weeklyCycles/${cycle.id}：名单映射后重复`)
    if (time(cycle.frozenAt) < time(mondayInstant(cycle.week))) issue(`weeklyCycles/${cycle.id}：冻结时间早于周期开始`)
    if (cycle.confirmedBy && (cycle.needsReview || !cycle.confirmationReason.trim()) || !cycle.confirmedBy && cycle.confirmationReason) issue(`weeklyCycles/${cycle.id}：名单确认状态不一致`)
  }
  for (const duty of rows.weeklyDuties) {
    const cycle = cycles.get(duty.cycleWeek)
    if (cycle && (cycle.needsReview || !cycle.rosterIds.includes(duty.ownerId) || cycle.deadlineAt === null || !sameTime(cycle.deadlineAt, duty.deadlineAt) || canonical(cycle.deadlinePolicy) !== canonical(duty.deadlinePolicy))) issue(`weeklyDuties/${duty.id}：应交项与周期名单、截止时间或快照不一致`)
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
    if (row.planManifest) {
      const ids = row.planManifest.map(item => item.id)
      const expectedIds = [...seen, ...row.retainedDraftIds].sort()
      if (row.kind !== 'plan' || new Set(ids).size !== ids.length || [...ids].sort().join('\0') !== expectedIds.join('\0') || ids.join('\0') !== [...ids].sort((a, b) => a.localeCompare(b)).join('\0')) issue(`weeklySubmissions/${row.id}：计划审核清单与提交或草稿清单不一致`)
      for (const item of row.planManifest) {
        const snapshot = row.records.find(record => record.id === item.id)
        const parts = planFingerprintParts(item.fingerprint), current = records.get(item.id)
        if (item.submitted !== !!snapshot || snapshot && item.fingerprint !== weeklyPlanFingerprint(snapshot) || parts && (parts[1] !== row.ownerId || duty && parts[2] !== duty.contentWeek || current && parts[0] !== current.taskId)) issue(`weeklySubmissions/${row.id}：计划审核指纹与记录身份或冻结内容不一致`)
      }
    }
    for (const [name, snapshots, expectedIds] of [
      ['任务', row.planTaskSnapshots, row.records.map(record => record.taskId)],
      ['月目标', row.planGoalSnapshots, row.records.flatMap(record => record.monthlyPlanId ? [record.monthlyPlanId] : [])],
    ] as const) if (snapshots) {
      const ids = snapshots.map(item => item.id)
      if (row.kind !== 'plan' || new Set(ids).size !== ids.length || [...ids].sort().join('\0') !== [...new Set(expectedIds)].sort().join('\0')) issue(`weeklySubmissions/${row.id}：${name}审核上下文与提交条目不一致`)
    }
  }
  for (const row of rows.weeklyPlanReviews) {
    const duty = duties.get(row.dutyId), receipt = receipts.get(row.submissionId), rule = rules.get('weekly-submission-rule')
    if (duty && (duty.kind !== 'plan' || duty.ownerId !== row.ownerId || duty.cycleWeek !== row.cycleWeek)
      || receipt && (receipt.kind !== 'plan' || receipt.dutyId !== row.dutyId || receipt.ownerId !== row.ownerId || receipt.cycleWeek !== row.cycleWeek || !receipt.planManifest)) issue(`weeklyPlanReviews/${row.id}：审核与计划提交身份或清单不一致`)
    if (receipt && time(row.reviewedAt) < time(receipt.submittedAt)) issue(`weeklyPlanReviews/${row.id}：审核时间早于提交时间`)
    if (rule && (!rule.planReviewEffectiveWeek || row.cycleWeek < rule.planReviewEffectiveWeek)) issue(`weeklyPlanReviews/${row.id}：审核发生在审批规则生效前`)
  }
  const approvalIssues = (row: WeeklyRecord, current = false) => {
    const approval = row.planApproval
    if (current && !row.deletion && approval?.suspended) {
      const rule = rules.get('weekly-submission-rule'), cycleWeek = addWeekDays(row.weekStart, -7)
      if (!rule?.planReviewEffectiveWeek || cycleWeek < rule.planReviewEffectiveWeek || isWeeklyPlanReviewCycle(rule, cycleWeek)) issue(`weeklyRecords/${row.id}：当前暂停审核标记与规则生效窗口不一致`)
    }
    if (!approval?.approvedSubmissionId) return
    const receipt = receipts.get(approval.approvedSubmissionId)
    const snapshot = receipt?.records.find(record => record.id === row.id)
    if (!receipt || receipt.kind !== 'plan' || !snapshot || approval.approvedFingerprint !== weeklyPlanFingerprint(snapshot)
      || !reviews.some(review => review.submissionId === receipt.id && review.decision === 'approved')) issue(`weeklyRecords/${row.id}：批准依据缺少对应通过审核的提交快照或计划指纹不一致`)
    if (current && !row.deletion && invalidReceipts.has(approval.approvedSubmissionId)) issue(`weeklyRecords/${row.id}：当前批准依据指向已作废的提交；历史快照可以保留原批准记录`)
  }
  const auditApprovals = (event: AuditEvent) => {
    if (event.entityType === 'weeklyRecord') for (const value of [event.before, event.after]) if (value) approvalIssues(value as WeeklyRecord)
    if (event.entityType === 'weeklyCycle' || event.entityType === 'weeklyDuty') for (const value of [event.before, event.after]) if (value) {
      const row = value as WeeklyCycle | WeeklyDuty
      policySnapshotIssues('week' in row ? row.week : row.cycleWeek, row.deadlinePolicy, `events/${event.id}`)
    }
  }
  for (const row of rows.weeklyRecords) approvalIssues(row, true)
  for (const row of rows.weeklySubmissions) for (const snapshot of row.records) approvalIssues(snapshot)
  for (const event of rows.events) auditApprovals(event)
  for (const report of rows.reports as Report[]) {
    for (const row of [...report.snapshot.weeklyRecords, ...report.snapshot.nextWeeklyRecords]) approvalIssues(row)
    for (const event of report.snapshot.changes) auditApprovals(event)
  }
  for (const row of rows.weeklyMissing) {
    const duty = identity('weeklyMissing', row)
    if (duty && !sameTime(row.deadlineAt, duty.deadlineAt) || !duty && !sameTime(row.deadlineAt, fridayDeadline(row.cycleWeek)) || time(row.detectedAt) < time(row.deadlineAt)) issue(`weeklyMissing/${row.id}：缺交检测早于截止或截止时间不一致`)
  }
  for (const row of rows.weeklyAdjustments) {
    identity('weeklyAdjustments', row)
    const receipt = row.submissionId ? receipts.get(row.submissionId) : undefined
    if (['invalidate', 'restore'].includes(row.action) !== !!row.submissionId || receipt && (receipt.dutyId !== row.dutyId || time(row.occurredAt) < time(receipt.submittedAt))) issue(`weeklyAdjustments/${row.id}：调整与提交记录或时间不一致`)
    if (!row.reason.trim() || time(row.occurredAt) < time(mondayInstant(row.cycleWeek))) issue(`weeklyAdjustments/${row.id}：调整原因或发生时间无效`)
  }
}
