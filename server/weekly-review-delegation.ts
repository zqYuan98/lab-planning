import type { Entity, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { WeeklyAdjustment, WeeklyDuty, WeeklyPlanReview, WeeklyRule, WeeklySubmission } from '../shared/weekly-submissions.ts'
import type { WholePlanReviewer, WeeklyReviewDelegationSettings, WeeklyReviewDelegationView, WeeklyReviewQueue, WeeklyReviewQueueItem } from '../shared/weekly-review-delegation.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { isActiveWeeklyRecord, isWeeklyPlanReviewCycle, weeklyPlanFingerprint, weeklyPlanManifest } from '../shared/weekly-record-state.ts'
import { assertBusinessActor } from './object-access.ts'
import { DomainBase, manager, type Input } from './domain-common.ts'
import { HttpError, type Store } from './store.ts'
import { cycleWeek } from './weekly-submission-clock.ts'
import { weeklyDutyHistory } from './weekly-duty-view.ts'
import { isManager, isMember } from './authorization.ts'

export const WEEKLY_REVIEW_DELEGATION_SETTINGS_ID = 'weekly-review-delegation'
interface DelegationAudit extends Entity { actorId: string; settingsId: string; beforeVersion: number; afterVersion: number; beforeOwnerIds: string[]; afterOwnerIds: string[] }
export function readWeeklyReviewDelegation(store: Store): WeeklyReviewDelegationSettings {
  return store.get<WeeklyReviewDelegationSettings>('settings', WEEKLY_REVIEW_DELEGATION_SETTINGS_ID)
    ?? { id: WEEKLY_REVIEW_DELEGATION_SETTINGS_ID, version: 0, createdAt: '', updatedAt: '', enabledOwnerIds: [] }
}
export function wholePlanRows(store: Store, duty: WeeklyDuty): WeeklyRecord[] {
  return store.selectJson<WeeklyRecord>("SELECT data FROM entities WHERE collection='weeklyRecords' AND json_extract(data,'$.ownerId')=? AND json_extract(data,'$.weekStart')=?", [duty.ownerId, duty.contentWeek]).filter(isActiveWeeklyRecord)
}
export function wholePlanMatches(receipt: WeeklySubmission, rows: WeeklyRecord[]): boolean {
  return !!receipt.planManifest && JSON.stringify(weeklyPlanManifest(rows)) === JSON.stringify(receipt.planManifest)
}
/** A receipt's proxy actor never determines who opted in. Check every live row, including retained drafts. */
export function resolveWholePlanReviewer(store: Store, duty: WeeklyDuty, receipt: WeeklySubmission, rows = wholePlanRows(store, duty)): WholePlanReviewer {
  const fallback: WholePlanReviewer = { kind: 'manager' }
  if (duty.kind !== 'plan' || receipt.dutyId !== duty.id || receipt.ownerId !== duty.ownerId || receipt.kind !== 'plan'
    || !readWeeklyReviewDelegation(store).enabledOwnerIds.includes(duty.ownerId) || !rows.length || !wholePlanMatches(receipt, rows)) return fallback
  const submitter = store.get<User>('users', duty.ownerId)
  if (!submitter || !isMember(submitter) || !canUseAccount(submitter)) return fallback
  const goalId = rows[0].monthlyPlanId
  if (!goalId || rows.some(row => row.monthlyPlanId !== goalId)) return fallback
  const goal = store.get<MonthlyPlan>('plans', goalId)
  if (!goal || goal.status === 'merged' || goal.mergedIntoId || goal.visibility) return fallback
  const owner = store.get<User>('users', goal.ownerId)
  if (!owner || !isMember(owner) || !canUseAccount(owner) || owner.id === duty.ownerId) return fallback
  for (const row of rows) {
    const task = store.get<Task>('tasks', row.taskId)
    if (row.ownerId !== duty.ownerId || !task || task.cancellation || task.monthlyPlanId !== goal.id || task.ownerId !== duty.ownerId || task.ownerId === owner.id) return fallback
  }
  return { kind: 'goal_owner', reviewerId: owner.id, goalId: goal.id }
}
export function assertWholePlanReviewer(store: Store, actor: User, duty: WeeklyDuty, receipt: WeeklySubmission, rows: WeeklyRecord[]) {
  const reviewer = resolveWholePlanReviewer(store, duty, receipt, rows)
  if (!isManager(actor) && (reviewer.kind !== 'goal_owner' || reviewer.reviewerId !== actor.id)) throw new HttpError(403, '当前未获委托审核此整份计划，请由管理者处理', 'ACCESS_REVOKED')
  return reviewer
}

export class WeeklyReviewDelegationService extends DomainBase {
  settings(actor: User): WeeklyReviewDelegationView {
    actor = assertBusinessActor(this.store, actor); manager(actor)
    return { settings: readWeeklyReviewDelegation(this.store), members: this.store.list<User>('users').filter(user => isMember(user)).map(user => ({ id: user.id, name: user.name, available: canUseAccount(user) })) }
  }
  updateSettings(actor: User, input: Input): WeeklyReviewDelegationSettings {
    actor = assertBusinessActor(this.store, actor); manager(actor)
    return this.store.transaction(() => {
      const before = readWeeklyReviewDelegation(this.store)
      if (input.version !== before.version) throw new HttpError(409, '审核委托配置已变化，请刷新重试', 'VERSION_CONFLICT')
      const ids = input.enabledOwnerIds
      if (!Array.isArray(ids) || ids.length > 1000 || ids.some(id => typeof id !== 'string') || new Set(ids).size !== ids.length) throw new HttpError(400, '请选择不重复的提交成员')
      for (const id of ids) {
        const user = this.store.get<User>('users', id)
        if (!user || !isMember(user) || !canUseAccount(user)) throw new HttpError(400, '只能为当前有效成员启用审核委托')
      }
      const enabledOwnerIds = [...ids].sort()
      const after = before.version ? this.store.update<WeeklyReviewDelegationSettings>('settings', before.id, before.version, { enabledOwnerIds })
        : this.store.insert<WeeklyReviewDelegationSettings>('settings', { id: before.id, enabledOwnerIds })
      this.store.insert<DelegationAudit>('weeklyReviewDelegationAudits', { actorId: actor.id, settingsId: after.id, beforeVersion: before.version, afterVersion: after.version, beforeOwnerIds: before.enabledOwnerIds, afterOwnerIds: after.enabledOwnerIds })
      return after
    })
  }
  queue(actor: User, requestedWeek: unknown, requestedCursor?: unknown): WeeklyReviewQueue {
    actor = assertBusinessActor(this.store, actor)
    const week = cycleWeek(requestedWeek)
    if (requestedCursor !== undefined && (typeof requestedCursor !== 'string' || requestedCursor.length > 200)) throw new HttpError(400, '审核队列分页标识无效')
    const cursor = typeof requestedCursor === 'string' ? requestedCursor : ''
    const rule = this.store.get<WeeklyRule>('weeklyRules', 'weekly-submission-rule')
    const submissions = this.store.selectJson<WeeklySubmission>("SELECT data FROM entities WHERE collection='weeklySubmissions' AND json_extract(data,'$.cycleWeek')=? AND json_extract(data,'$.kind')='plan' ORDER BY rowid", [week])
    const adjustments = this.store.selectJson<WeeklyAdjustment>("SELECT data FROM entities WHERE collection='weeklyAdjustments' AND json_extract(data,'$.cycleWeek')=? ORDER BY rowid", [week])
    const reviews = this.store.selectJson<WeeklyPlanReview>("SELECT data FROM entities WHERE collection='weeklyPlanReviews' AND json_extract(data,'$.cycleWeek')=?", [week])
    const duties = rule && isWeeklyPlanReviewCycle(rule, week) ? this.store.selectJson<WeeklyDuty>("SELECT data FROM entities WHERE collection='weeklyDuties' AND json_extract(data,'$.cycleWeek')=? AND json_extract(data,'$.kind')='plan' AND id>? ORDER BY id", [week, cursor]) : []
    const items: WeeklyReviewQueueItem[] = []
    for (const duty of duties) {
      const history = weeklyDutyHistory(duty, submissions, adjustments), receipt = history.valid.at(-1)
      if (!receipt || history.exemptionReason || reviews.some(review => review.submissionId === receipt.id)) continue
      const rows = wholePlanRows(this.store, duty)
      if (!wholePlanMatches(receipt, rows)) continue
      const reviewer = resolveWholePlanReviewer(this.store, duty, receipt, rows)
      if (!isManager(actor) && (reviewer.kind !== 'goal_owner' || reviewer.reviewerId !== actor.id)) continue
      items.push({ dutyId: duty.id, version: duty.version, ownerId: duty.ownerId, ownerName: this.store.get<User>('users', duty.ownerId)?.name ?? '成员', contentWeek: duty.contentWeek,
        submissionId: receipt.id, submittedAt: receipt.submittedAt, reviewer, retainedDraftCount: receipt.retainedDraftIds.length,
        items: receipt.records.map(snapshot => {
          const row = rows.find(item => item.id === snapshot.id)!
          const approved = row.planApproval?.approvedFingerprint === weeklyPlanFingerprint(row) && !!row.planApproval.approvedSubmissionId || !row.planApproval?.required
          const prior = history.valid.some(previous => previous.id !== receipt.id && previous.records.some(item => item.id === row.id))
          return { recordId: row.id, taskTitle: receipt.planTaskSnapshots?.find(task => task.id === row.taskId)?.title ?? '任务', goalTitle: receipt.planGoalSnapshots?.find(goal => goal.id === row.monthlyPlanId)?.title ?? '未关联目标', commitment: snapshot.commitment,
            change: approved ? 'already-approved' : prior ? 'changed' : 'new' }
        }) })
      if (items.length === 51) break
    }
    const page = items.slice(0, 50)
    this.store.recordObjectRead({ actorId: actor.id, action: 'weekly_review_queue', objectType: 'weeklyCycle', objectId: week, objectIds: page.map(item => item.dutyId), outcome: 'allowed' })
    return { week, items: page, nextCursor: items.length > 50 ? page.at(-1)!.dutyId : null }
  }
}
