import type { User, WeeklyRecord, WorkOrigin } from '../shared/types.ts'
import { assertBusinessActor } from './object-access.ts'
import type { WeeklyDuty, WeeklyPlanReview, WeeklyRule, WeeklySubmission } from '../shared/weekly-submissions.ts'
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord, isWeeklyPlanReviewCycle, weeklyPlanFingerprint, weeklyPlanManifest } from '../shared/weekly-record-state.ts'
import { DomainBase, manager, text, type Input } from './domain-common.ts'
import { HttpError, type Store } from './store.ts'
import { addWeekDays, shanghaiWeek } from './weekly-submission-clock.ts'
import { weeklyDutyHistory } from './weekly-duty-view.ts'
import type { WeeklyAdjustment } from '../shared/weekly-submissions.ts'
import { collaborationWorkMutation } from './collaboration-hooks.ts'
import { endTaskRequests } from './collaboration-tracking.ts'
import type { BlockerEpisode } from '../shared/collaboration.ts'

const RULE = 'weekly-submission-rule'
const unapproved = (): NonNullable<WeeklyRecord['planApproval']> => ({ required: true, approvedSubmissionId: null, approvedFingerprint: null })

/** Keep pause exemptions on the exact prospective cycles, including after the rule resumes later. */
export function syncWeeklyPlanReviewPolicy(store: Store, rule: WeeklyRule, fromCycleWeek: string, actorId: string | null = null, now = new Date()): void {
  if (!rule.planReviewEffectiveWeek) return
  const boundary = addWeekDays(fromCycleWeek > rule.planReviewEffectiveWeek ? fromCycleWeek : rule.planReviewEffectiveWeek, 7)
  const members = new Set(store.list<User>('users').filter(user => user.role === 'member').map(user => user.id))
  for (const row of store.list<WeeklyRecord>('weeklyRecords')) {
    if (!isActiveWeeklyRecord(row) || !members.has(row.ownerId) || row.weekStart < boundary || !row.planApproval && row.workOrigin?.kind === 'assigned' && row.submitted) continue
    const { suspended: _previousSuspension, ...approval } = row.planApproval ?? unapproved()
    const planApproval = { ...approval, ...(isWeeklyPlanReviewCycle(rule, addWeekDays(row.weekStart, -7)) ? {} : { suspended: true as const }) }
    if (JSON.stringify(planApproval) !== JSON.stringify(row.planApproval)) {
      const updated = store.update<WeeklyRecord>('weeklyRecords', row.id, row.version, { planApproval })
      if (isEffectiveWeeklyRecord(row) && !isEffectiveWeeklyRecord(updated)) {
        const reason = '该周期已启用计划审核，周安排待审核'
        endTaskRequests(store, row.taskId, now, actorId, reason, 'cancelled', row.id)
        for (const episode of store.list<BlockerEpisode>('blockerEpisodes')) if (episode.sourceType === 'weeklyRecord' && episode.sourceId === row.id && !episode.resolvedAt) {
          store.update<BlockerEpisode>('blockerEpisodes', episode.id, episode.version, { resolvedAt: now.toISOString(), resolvedBy: actorId, closureReason: reason })
        }
      }
    }
  }
}

/** A persisted prospective boundary prevents a deploy or server restart from re-reviewing historical weeks. */
export function ensureWeeklyPlanReviewRule(store: Store, now = new Date()): WeeklyRule {
  return store.transaction(() => {
    const old = store.get<WeeklyRule>('weeklyRules', RULE)
    if (old?.planReviewEffectiveWeek) return old
    const effectiveWeek = addWeekDays(shanghaiWeek(now), 7)
    const rule = old ? store.update<WeeklyRule>('weeklyRules', RULE, old.version, { planReviewEffectiveWeek: effectiveWeek })
      : store.insert<WeeklyRule>('weeklyRules', { id: RULE, enabled: true, effectiveWeek, timezone: 'Asia/Shanghai', windows: [{ fromWeek: effectiveWeek, toWeek: null }], planReviewEffectiveWeek: effectiveWeek })
    syncWeeklyPlanReviewPolicy(store, rule, effectiveWeek, null, now)
    return rule
  })
}

export function weeklyPlanApprovalMetadata(store: Store, ownerId: string, weekStart: string, workOrigin?: WorkOrigin, now = new Date()): WeeklyRecord['planApproval'] {
  const rule = store.get<WeeklyRule>('weeklyRules', RULE)
  if (!rule?.planReviewEffectiveWeek || store.get<User>('users', ownerId)?.role !== 'member' || workOrigin?.kind === 'assigned' || weekStart < addWeekDays(rule.planReviewEffectiveWeek, 7)) return
  return { ...unapproved(), ...(isWeeklyPlanReviewCycle(rule, addWeekDays(weekStart, -7)) ? {} : { suspended: true as const }) }
}

export function weeklyPlanReviewRequired(rule: WeeklyRule, duty: WeeklyDuty): boolean {
  return duty.kind === 'plan' && isWeeklyPlanReviewCycle(rule, duty.cycleWeek)
}

export class WeeklyPlanReviewService extends DomainBase {
  constructor(store: Store, private clock: () => Date = () => new Date()) { super(store) }

  review(actor: User, input: Input): WeeklyPlanReview {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    return collaborationWorkMutation(this.store, actor, input, 'weeklyRecord', () => {
      const dutyId = text(input.dutyId, '提报项'), submissionId = text(input.submissionId, '提交版本')
      const requestId = text(input.requestId, '审核请求编号', true, 100)
      const decision = String(input.decision)
      if (decision !== 'approved' && decision !== 'returned') throw new HttpError(400, '请选择通过或退回')
      const reason = text(input.reason, '审核意见', decision === 'returned')
      const prior = this.store.list<WeeklyPlanReview>('weeklyPlanReviews').find(row => row.reviewedBy === actor.id && row.requestId === requestId)
      if (prior) {
        if (prior.dutyId !== dutyId || prior.submissionId !== submissionId || prior.decision !== decision || prior.reason !== reason) throw new HttpError(409, '此审核请求编号已用于其他内容')
        return prior
      }
      const duty = this.current<WeeklyDuty>('weeklyDuties', dutyId, input)
      const rule = ensureWeeklyPlanReviewRule(this.store, this.clock())
      if (!weeklyPlanReviewRequired(rule, duty)) throw new HttpError(400, '该提报项不需要下周计划审核')
      const history = weeklyDutyHistory(duty, this.store.list<WeeklySubmission>('weeklySubmissions'), this.store.list<WeeklyAdjustment>('weeklyAdjustments'))
      const receipt = history.valid.at(-1)
      if (!receipt || receipt.id !== submissionId || history.exemptionReason) throw new HttpError(409, '提交版本已变化、失效或已豁免，请刷新后审核')
      if (this.store.list<WeeklyPlanReview>('weeklyPlanReviews').some(row => row.submissionId === receipt.id)) throw new HttpError(409, '此提交版本已有审核结论，请提交修订版本')
      const rows = this.store.list<WeeklyRecord>('weeklyRecords').filter(row => isActiveWeeklyRecord(row) && row.ownerId === duty.ownerId && row.weekStart === duty.contentWeek)
      if (!receipt.planManifest || JSON.stringify(weeklyPlanManifest(rows)) !== JSON.stringify(receipt.planManifest)) throw new HttpError(409, '计划内容已变化，请成员核对后重新提交')
      const review = this.store.insert<WeeklyPlanReview>('weeklyPlanReviews', { dutyId, ownerId: duty.ownerId, cycleWeek: duty.cycleWeek, submissionId,
        decision, reviewedBy: actor.id, reviewedAt: this.clock().toISOString(), reason, requestId })
      if (decision === 'approved') for (const snapshot of receipt.records) {
        const before = rows.find(row => row.id === snapshot.id)!
        if (!before.planApproval?.required) continue
        const after = this.store.update<WeeklyRecord>('weeklyRecords', before.id, before.version, {
          planApproval: { required: true, approvedSubmissionId: receipt.id, approvedFingerprint: weeklyPlanFingerprint(before) },
        })
        this.audit(actor, 'weeklyRecord', before.id, 'plan_approve', before, after, reason)
      }
      this.store.update<WeeklyDuty>('weeklyDuties', duty.id, duty.version, {})
      this.audit(actor, 'weeklyPlanReview', review.id, decision, null, review, reason)
      return review
    })
  }
}
