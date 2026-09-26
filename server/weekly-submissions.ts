import { assertBusinessActor } from './object-access.ts'
import type { AuditEvent, Entity, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { WeeklyRule, WeeklyCycle, WeeklyDuty, WeeklySubmission, WeeklyMissing, WeeklyAdjustment, WeeklyDutyView, WeeklySubmissionView, WeeklyReportSubmission } from '../shared/weekly-submissions.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { DomainBase, manager, own, text, bool, type Input } from './domain-common.ts'
import { WorkService } from './domain-work.ts'
import { Store, HttpError } from './store.ts'
import { addWeekDays, cycleWeek, shanghaiWeek, mondayInstant } from './weekly-submission-clock.ts'
import { resolveWeeklyDeadline } from '../shared/work-calendar.ts'
import { readWorkCalendar } from './work-calendar.ts'
import { projectWeeklyDuty, submissionProgressEvents, weeklyDutyHistory } from './weekly-duty-view.ts'
import type { ProgressEvent } from '../shared/collaboration.ts'
import { notifyFormalSubmission } from './collaboration-notifications.ts'
import { ensureWeeklyPlanReviewRule, syncWeeklyPlanReviewPolicy, weeklyPlanApprovalMetadata, WeeklyPlanReviewService } from './weekly-plan-review.ts'
import { isActiveWeeklyRecord, weeklyPlanFingerprint, weeklyPlanManifest } from '../shared/weekly-record-state.ts'
import type { WeeklyPlanReview } from '../shared/weekly-submissions.ts'
import { isManager, isMember } from './authorization.ts'

const RULE = 'weekly-submission-rule'
const manifest = (rows: WeeklyRecord[]) => rows.map(({ id, version }) => ({ id, version })).sort((a, b) => a.id.localeCompare(b.id))
const equal = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right)

/** Domain clock is injectable; receipt/deadline facts never use client timestamps. */
export class WeeklySubmissionService extends DomainBase {
  constructor(store: Store, private clock: () => Date = () => new Date()) { super(store) }

  private cache: Map<string, Entity[]> | null = null
  private snapshot<T>(operation: () => T): T {
    if (this.cache) return operation()
    this.cache = new Map()
    try { return operation() } finally { this.cache = null }
  }
  private rows<T extends Entity>(collection: string): T[] {
    if (!this.cache) return this.store.list<T>(collection)
    if (!this.cache.has(collection)) this.cache.set(collection, this.store.list<Entity>(collection))
    return this.cache.get(collection) as T[]
  }
  private insert<T extends Entity>(collection: string, input: Omit<T, keyof Entity> & Partial<Entity>): T {
    const row = this.store.insert<T>(collection, input)
    this.cache?.get(collection)?.push(row)
    return row
  }
  private update<T extends Entity>(collection: string, id: string, version: number, patch: Partial<T>): T {
    const row = this.store.update<T>(collection, id, version, patch)
    const cached = this.cache?.get(collection)
    if (cached) { const index = cached.findIndex(value => value.id === id); if (index >= 0) cached[index] = row }
    return row
  }

  getRule(): WeeklyRule {
    return ensureWeeklyPlanReviewRule(this.store, this.clock())
  }

  updateRule(actor: User, input: Input): WeeklyRule {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    this.reconcile()
    return this.snapshot(() => this.store.transaction(() => {
      const before = this.current<WeeklyRule>('weeklyRules', RULE, input)
      const enabled = bool(input.enabled, '启用周提报')
      if (enabled === before.enabled) return before
      const next = addWeekDays(shanghaiWeek(this.clock()), 7)
      const windows = structuredClone(before.windows)
      if (enabled) windows.push({ fromWeek: next, toWeek: null })
      else { const open = [...windows].reverse().find(window => window.toWeek === null); if (open) open.toWeek = next }
      const rule = this.update<WeeklyRule>('weeklyRules', RULE, before.version, { enabled, windows })
      syncWeeklyPlanReviewPolicy(this.store, rule, next, actor.id, this.clock())
      this.audit(actor, 'weeklyRule', RULE, 'update', before, rule, '从下一个完整周生效')
      return rule
    }))
  }

  private activeWeek(rule: WeeklyRule, week: string) {
    return rule.windows.some(window => week >= window.fromWeek && (!window.toWeek || week < window.toWeek))
  }

  private rosterAt(week: string): { rosterIds: string[]; needsReview: boolean } {
    const asOf = mondayInstant(week)
    const events = this.rows<AuditEvent>('events').filter(event => event.entityType === 'user').sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const rosterIds: string[] = []
    let needsReview = false
    for (const user of this.rows<User>('users')) {
      if (user.createdAt > asOf) continue
      let snapshot: User | undefined
      if (user.updatedAt <= asOf) snapshot = user
      else {
        const history = events.filter(event => event.entityId === user.id)
        snapshot = history.filter(event => event.createdAt <= asOf).at(-1)?.after as User | undefined
        if (!snapshot) snapshot = history.find(event => event.createdAt > asOf)?.before as User | undefined
      }
      if (!snapshot || !snapshot.id || snapshot.id !== user.id) { needsReview = true; continue }
      if (isMember(snapshot) && canUseAccount(snapshot)) rosterIds.push(user.id)
    }
    return { rosterIds: rosterIds.sort(), needsReview }
  }

  private ensureDuty(ownerId: string, cycle: WeeklyCycle, kind: 'results' | 'plan'): WeeklyDuty {
    const week = cycle.week
    if (!cycle.deadlineAt) throw new HttpError(409, '该周期无提报义务')
    const existing = this.rows<WeeklyDuty>('weeklyDuties').find(d => d.ownerId === ownerId && d.cycleWeek === week && d.kind === kind)
    return existing ?? this.insert<WeeklyDuty>('weeklyDuties', { ownerId, cycleWeek: week, kind, contentWeek: kind === 'results' ? week : addWeekDays(week, 7), deadlineAt: cycle.deadlineAt,
      ...(cycle.deadlinePolicy ? { deadlinePolicy: structuredClone(cycle.deadlinePolicy) } : {}) })
  }

  reconcile(): void {
    this.snapshot(() => this.store.transaction(() => {
      const rule = this.getRule(), now = this.clock().toISOString(), current = shanghaiWeek(this.clock())
      for (let week = rule.effectiveWeek; week <= current; week = addWeekDays(week, 7)) {
        if (!this.activeWeek(rule, week)) continue
        let cycle = this.store.get<WeeklyCycle>('weeklyCycles', week)
        if (!cycle) cycle = this.insert<WeeklyCycle>('weeklyCycles', { id: week, week, ...resolveWeeklyDeadline(rule, week), ...this.rosterAt(week), confirmedBy: null, confirmationReason: '', frozenAt: now })
        if (cycle.needsReview || !cycle.deadlineAt) continue
        for (const ownerId of cycle.rosterIds) for (const kind of ['results', 'plan'] as const) {
          const duty = this.ensureDuty(ownerId, cycle, kind)
          this.recordMissing(duty, now)
        }
      }
    }))
  }

  private history(duty: WeeklyDuty) {
    return weeklyDutyHistory(duty, this.rows<WeeklySubmission>('weeklySubmissions'), this.rows<WeeklyAdjustment>('weeklyAdjustments'))
  }

  private recordMissing(duty: WeeklyDuty, now: string) {
    if (now < duty.deadlineAt) return
    const cycle = this.store.get<WeeklyCycle>('weeklyCycles', duty.cycleWeek)
    if (!cycle || cycle.needsReview || !cycle.rosterIds.includes(duty.ownerId)) return
    const history = this.history(duty)
    if (history.valid.some(row => row.submittedAt < duty.deadlineAt)) return
    // A pre-cutoff exemption excuses the duty; later exemption preserves the miss.
    const priorExemptions = history.adjustments.filter(row => row.occurredAt < duty.deadlineAt && ['exempt', 'revoke_exemption'].includes(row.action))
    if (priorExemptions.at(-1)?.action === 'exempt' && history.exemptionReason) return
    if (!this.rows<WeeklyMissing>('weeklyMissing').some(row => row.dutyId === duty.id)) {
      this.insert<WeeklyMissing>('weeklyMissing', { dutyId: duty.id, ownerId: duty.ownerId, cycleWeek: duty.cycleWeek, kind: duty.kind, deadlineAt: duty.deadlineAt, detectedAt: now })
    }
  }

  private records(duty: WeeklyDuty) {
    return this.rows<WeeklyRecord>('weeklyRecords').filter(row => isActiveWeeklyRecord(row) && row.ownerId === duty.ownerId && row.weekStart === duty.contentWeek).sort((a, b) => a.id.localeCompare(b.id))
  }

  private dutyView(duty: WeeklyDuty): WeeklyDutyView {
    return projectWeeklyDuty(duty, { submissions: this.rows<WeeklySubmission>('weeklySubmissions'), adjustments: this.rows<WeeklyAdjustment>('weeklyAdjustments'),
      records: this.rows<WeeklyRecord>('weeklyRecords'), missing: this.rows<WeeklyMissing>('weeklyMissing'), progressEvents: this.rows<ProgressEvent>('progressEvents'),
      rule: this.store.get<WeeklyRule>('weeklyRules', RULE), planReviews: this.rows<WeeklyPlanReview>('weeklyPlanReviews') }, this.clock())
  }

  view(actor: User, requestedWeek: unknown): WeeklySubmissionView {
    actor = assertBusinessActor(this.store, actor)
    return this.snapshot(() => {
    this.reconcile()
    const week = cycleWeek(requestedWeek)
    const rule = this.getRule(), cycle = this.store.get<WeeklyCycle>('weeklyCycles', week) ?? null
    // Never include the departmental roster in member responses.
    const safeCycle = cycle && !isManager(actor) ? { ...cycle, rosterIds: cycle.rosterIds.filter(id => id === actor.id), confirmationReason: '', confirmedBy: null } : cycle
    return { rule, week, nextWeek: addWeekDays(week, 7), ...this.deadlineView(rule, week, cycle), serverNow: this.clock().toISOString(), cycle: safeCycle,
      ...(isManager(actor) ? { workCalendar: readWorkCalendar(this.store) } : {}),
      duties: this.rows<WeeklyDuty>('weeklyDuties').filter(d => d.cycleWeek === week && (isManager(actor) || d.ownerId === actor.id)).map(d => this.dutyView(d)) }
    })
  }

  /** Notification preview must not initialize cycles, duties or missed-deadline facts. */
  preview(actor: User, requestedWeek: unknown): WeeklySubmissionView | undefined {
    actor = assertBusinessActor(this.store, actor)
    return this.snapshot(() => {
      const rule = this.store.get<WeeklyRule>('weeklyRules', RULE)
      if (!rule) return
      const week = cycleWeek(requestedWeek), cycle = this.store.get<WeeklyCycle>('weeklyCycles', week) ?? null
      const safeCycle = cycle && !isManager(actor) ? { ...cycle, rosterIds: cycle.rosterIds.filter(id => id === actor.id), confirmationReason: '', confirmedBy: null } : cycle
      return { rule, week, nextWeek: addWeekDays(week, 7), ...this.deadlineView(rule, week, cycle), serverNow: this.clock().toISOString(), cycle: safeCycle,
        ...(isManager(actor) ? { workCalendar: readWorkCalendar(this.store) } : {}),
        duties: this.rows<WeeklyDuty>('weeklyDuties').filter(duty => duty.cycleWeek === week && (isManager(actor) || duty.ownerId === actor.id)).map(duty => this.dutyView(duty)) }
    })
  }

  private deadlineView(rule: WeeklyRule, week: string, cycle: WeeklyCycle | null) {
    return cycle ? { deadlineAt: cycle.deadlineAt, ...(cycle.deadlinePolicy ? { deadlinePolicy: cycle.deadlinePolicy } : {}) }
      : resolveWeeklyDeadline(rule, week)
  }

  submit(actor: User, input: Input): WeeklySubmission {
    actor = assertBusinessActor(this.store, actor)
    this.reconcile()
    return this.snapshot(() => this.store.transaction(() => {
      const duty = this.need<WeeklyDuty>('weeklyDuties', text(input.dutyId, '提报项'))
      own(actor, duty.ownerId)
      const requestId = text(input.requestId, '提交请求编号', true, 100)
      const previous = this.rows<WeeklySubmission>('weeklySubmissions').find(row => row.dutyId === duty.id && row.requestId === requestId)
      if (previous) {
        if (previous.actorId !== actor.id) throw new HttpError(409, '请求编号已使用')
        return previous
      }
      this.current<WeeklyDuty>('weeklyDuties', duty.id, input)
      const rule = this.getRule(), week = duty.cycleWeek
      const cycle = this.need<WeeklyCycle>('weeklyCycles', week)
      if (week > shanghaiWeek(this.clock()) || !this.activeWeek(rule, week) || cycle.needsReview || !cycle.deadlineAt || !cycle.rosterIds.includes(duty.ownerId)) throw new HttpError(400, '该周期尚未开始、生效、无提报义务或应交名单待核对')
      const rows = this.records(duty)
      if (!Array.isArray(input.manifest) || !equal(input.manifest, manifest(rows))) throw new HttpError(409, '周记录已变化，请刷新核对后重新提交')
      const currentProgressIds = submissionProgressEvents(duty, rows, this.store.list<ProgressEvent>('progressEvents')).map(event => event.id).sort()
      if ((currentProgressIds.length || input.progressEventIds !== undefined) && (!Array.isArray(input.progressEventIds) || !equal(input.progressEventIds, currentProgressIds))) throw new HttpError(409, '关联任务进展已变化，请刷新核对后重新提交')
      const drafts = rows.filter(row => !row.submitted)
      if (drafts.length && !['include', 'retain'].includes(String(input.draftAction))) throw new HttpError(400, '请选择将草稿纳入提交或继续保留')
      const selected = rows.filter(row => row.submitted || input.draftAction === 'include')
      const note = text(input.note, '无工作安排说明', selected.length === 0)
      const reason = text(input.reason, '管理员代录原因', actor.id !== duty.ownerId)
      const work = new WorkService(this.store)
      const snapshots: WeeklyRecord[] = []
      for (let row of selected) {
        if (duty.kind === 'results') {
          text(row.actualOutcome, '每项本周实际进展')
          if (['blocked', 'not_done'].includes(row.status)) text(row.blocker, '未完成或阻塞原因')
        } else text(row.commitment, '每项下周承诺')
        const approval = !row.planApproval ? weeklyPlanApprovalMetadata(this.store, row.ownerId, row.weekStart, row.workOrigin, this.clock()) : undefined
        if (approval) row = this.update<WeeklyRecord>('weeklyRecords', row.id, row.version, { planApproval: approval })
        // Reuse publication/date/status gates even for imported records and existing official rows.
        snapshots.push(work.updateWeeklyRecord(actor, row.id, { version: row.version, submitted: true }, { formalSubmission: true }))
      }
      const planDetails = duty.kind === 'plan' ? {
        planManifest: weeklyPlanManifest(this.store.list<WeeklyRecord>('weeklyRecords').filter(row => row.ownerId === duty.ownerId && row.weekStart === duty.contentWeek)),
        planTaskSnapshots: this.store.list<Task>('tasks').filter(task => snapshots.some(row => row.taskId === task.id)).map(({ id, title, dueDate, description }) => ({ id, title, dueDate, description })),
        planGoalSnapshots: this.store.list<MonthlyPlan>('plans').filter(plan => snapshots.some(row => row.monthlyPlanId === plan.id)).map(({ id, month, title }) => ({ id, month, title })),
      } : {}
      const submittedAt = this.clock().toISOString()
      const receipt = this.insert<WeeklySubmission>('weeklySubmissions', { dutyId: duty.id, ownerId: duty.ownerId, cycleWeek: duty.cycleWeek, kind: duty.kind,
        submittedAt, actorId: actor.id, reason, note, requestId, records: snapshots, ...planDetails, retainedDraftIds: drafts.filter(row => input.draftAction !== 'include').map(row => row.id).sort(), retainedDraftManifest: manifest(drafts.filter(row => input.draftAction !== 'include')), progressEventIds: submissionProgressEvents(duty, snapshots, this.store.list<ProgressEvent>('progressEvents')).map(event => event.id).sort() })
      this.update<WeeklyDuty>('weeklyDuties', duty.id, duty.version, {})
        this.recordMissing(duty, submittedAt)
        notifyFormalSubmission(this.store, receipt)
        return receipt
    }))
  }

  review(actor: User, input: Input): WeeklyPlanReview {
    actor = assertBusinessActor(this.store, actor)
    this.reconcile()
    return new WeeklyPlanReviewService(this.store, this.clock).review(actor, input)
  }

  adjust(actor: User, input: Input): WeeklyAdjustment {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    this.reconcile()
    return this.snapshot(() => this.store.transaction(() => {
      const duty = this.current<WeeklyDuty>('weeklyDuties', text(input.dutyId, '提报项'), input)
      const action = String(input.action) as WeeklyAdjustment['action']
      if (!['exempt', 'revoke_exemption', 'invalidate', 'restore'].includes(action)) throw new HttpError(400, '无效的调整操作')
      const reason = text(input.reason, '调整原因')
      const submissionId = ['invalidate', 'restore'].includes(action) ? text(input.submissionId, '提交记录') : null
      if (submissionId && this.need<WeeklySubmission>('weeklySubmissions', submissionId).dutyId !== duty.id) throw new HttpError(400, '提交记录不属于此提报项')
      const adjustment = this.insert<WeeklyAdjustment>('weeklyAdjustments', { dutyId: duty.id, ownerId: duty.ownerId, cycleWeek: duty.cycleWeek, kind: duty.kind, action, submissionId, actorId: actor.id, reason, occurredAt: this.clock().toISOString() })
      if (submissionId && duty.kind === 'plan') {
        const receipt = this.need<WeeklySubmission>('weeklySubmissions', submissionId)
        const approved = this.store.list<WeeklyPlanReview>('weeklyPlanReviews').some(review => review.submissionId === submissionId && review.decision === 'approved')
        for (const snapshot of receipt.records) {
          const row = this.store.get<WeeklyRecord>('weeklyRecords', snapshot.id)
          if (!row?.planApproval?.required) continue
          if (action === 'invalidate' && row.planApproval.approvedSubmissionId === submissionId) {
            const updated = this.update<WeeklyRecord>('weeklyRecords', row.id, row.version, { planApproval: { required: true, approvedSubmissionId: null, approvedFingerprint: null } })
            this.audit(actor, 'weeklyRecord', row.id, 'plan_approval_invalidated', row, updated, reason)
          } else if (action === 'restore' && approved && isActiveWeeklyRecord(row) && row.submitted && !row.planApproval.approvedSubmissionId && weeklyPlanFingerprint(row) === weeklyPlanFingerprint(snapshot)) {
            const updated = this.update<WeeklyRecord>('weeklyRecords', row.id, row.version, { planApproval: { required: true, approvedSubmissionId: submissionId, approvedFingerprint: weeklyPlanFingerprint(row) } })
            this.audit(actor, 'weeklyRecord', row.id, 'plan_approve', row, updated, reason)
          }
        }
      }
      this.update<WeeklyDuty>('weeklyDuties', duty.id, duty.version, {})
      this.recordMissing(duty, this.clock().toISOString())
      return adjustment
    }))
  }

  confirmRoster(actor: User, input: Input): WeeklyCycle {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    this.reconcile()
    return this.snapshot(() => this.store.transaction(() => {
      const week = cycleWeek(input.week), cycle = this.current<WeeklyCycle>('weeklyCycles', week, input)
      if (!cycle.needsReview) throw new HttpError(409, '名单已冻结，请对个人应交项办理豁免')
      if (!Array.isArray(input.rosterIds) || input.rosterIds.some(id => typeof id !== 'string') || new Set(input.rosterIds).size !== input.rosterIds.length) throw new HttpError(400, '应交名单格式无效')
      for (const id of input.rosterIds) this.need<User>('users', id)
      const updated = this.update<WeeklyCycle>('weeklyCycles', week, cycle.version, { rosterIds: input.rosterIds as string[], needsReview: false, confirmedBy: actor.id, confirmationReason: text(input.reason, '名单核对原因') })
      this.audit(actor, 'weeklyCycle', week, 'confirm_roster', cycle, updated, updated.confirmationReason)
      this.reconcile()
      return updated
    }))
  }

  reportSummary(type: 'weekly' | 'monthly', period: string): WeeklyReportSubmission[] {
    return this.snapshot(() => {
    this.reconcile()
    return this.rows<WeeklyDuty>('weeklyDuties').filter(d => type === 'weekly' ? d.cycleWeek === period : d.deadlineAt.startsWith(period)).map(duty => {
      const row = this.dutyView(duty)
      return { ownerId: row.ownerId, cycleWeek: row.cycleWeek, kind: row.kind, status: row.status, deadlineAt: row.deadlineAt, firstSubmittedAt: row.firstSubmittedAt, missingAtDeadline: row.missingAtDeadline, exemptionReason: row.exemptionReason,
        ...(row.deadlinePolicy ? { deadlinePolicy: row.deadlinePolicy } : {}) }
    })
    })
  }
}
