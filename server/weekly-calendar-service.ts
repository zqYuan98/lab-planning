import { createHash, createHmac, randomBytes } from 'node:crypto'
import type { AuditEvent, Entity, Report, User } from '../shared/types.ts'
import type { CollaborationSettings } from '../shared/collaboration.ts'
import type { WeeklyCycle, WeeklyDeadlinePolicy, WeeklyDeadlineRepairPreview, WeeklyDeadlineSnapshot, WeeklyDuty, WeeklyRule } from '../shared/weekly-submissions.ts'
import { snapshotDeadline, workingDaysInWeek } from '../shared/work-calendar.ts'
import { DomainBase, choice, date, manager, text, type Input } from './domain-common.ts'
import { assertBusinessActor } from './object-access.ts'
import { readCollaborationSettings } from './collaboration-policy.ts'
import { ensureWeeklyPlanReviewRule, syncWeeklyPlanReviewPolicy } from './weekly-plan-review.ts'
import { addWeekDays, cycleWeek, shanghaiWeek } from './weekly-submission-clock.ts'
import { readWorkCalendar } from './work-calendar.ts'
import { HttpError, type Store } from './store.ts'

const RULE = 'weekly-submission-rule'
const secrets = new WeakMap<Store, Buffer>()
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const digest = (value: string) => createHash('sha256').update(value).digest('hex')
const operationEpoch = (store: Store) => store.get<{ epoch: string }>('operationContexts', 'business-commands')?.epoch ?? 'uninitialized'

function validOverrides(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 1500) throw new HttpError(400, '工作日历格式无效')
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([day, working]) => {
    date(day, '日历日期')
    if (typeof working !== 'boolean') throw new HttpError(400, '日历标记必须为布尔值')
    return [day, working]
  }))
}

function schedulePolicy(store: Store, actor: User, before: WeeklyRule, mode: WeeklyDeadlinePolicy['mode'], overrides: Record<string, boolean>, now: Date): WeeklyRule {
  const fromWeek = addWeekDays(shanghaiWeek(now), 7)
  const entries = before.deadlinePolicies ?? []
  const last = entries.at(-1)
  if (last?.mode === mode && equal(last.calendarOverrides, overrides)) return before
  if (store.get<WeeklyCycle>('weeklyCycles', fromWeek)) throw new HttpError(409, '下周已生成固定周期，请核对后再调整日历政策')
  const next: WeeklyDeadlinePolicy = { version: Math.max(0, ...entries.map(row => row.version)) + 1, fromWeek, mode, calendarOverrides: structuredClone(overrides) }
  const rule = store.update<WeeklyRule>('weeklyRules', before.id, before.version, { deadlinePolicies: [...entries.filter(row => row.fromWeek < fromWeek), next] })
  syncWeeklyPlanReviewPolicy(store, rule, fromWeek, actor.id, now)
  store.insert<AuditEvent>('events', { entityType: 'weeklyRule', entityId: rule.id, actorId: actor.id, action: 'deadline_policy', before, after: rule, reason: `截止政策从 ${fromWeek} 起生效，既有周期不变` })
  return rule
}

/** A calendar saved through collaboration settings schedules the same prospective policy. */
export function scheduleWeeklyCalendarChange(store: Store, actor: User, overrides: Record<string, boolean>, now: Date): void {
  const rule = store.get<WeeklyRule>('weeklyRules', RULE)
  const latest = rule?.deadlinePolicies?.at(-1)
  if (rule && latest) schedulePolicy(store, actor, rule, latest.mode, validOverrides(overrides), now)
}

interface RepairReceipt extends Entity { actorId: string; week: string; reason: string; epoch: string }

/** Calendar configuration and exceptional open-cycle corrections have separate, audited commands. */
export class WeeklyCalendarService extends DomainBase {
  constructor(store: Store, private clock: () => Date = () => new Date()) { super(store) }

  updatePolicy(actor: User, input: Input): WeeklyRule {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    return this.store.transaction(() => {
      ensureWeeklyPlanReviewRule(this.store, this.clock())
      const before = this.current<WeeklyRule>('weeklyRules', RULE, input)
      const mode = choice(input.mode, ['friday', 'last_workday'] as const, '截止规则')
      let overrides = validOverrides(readWorkCalendar(this.store).overrides)
      if (input.calendarOverrides !== undefined) {
        overrides = validOverrides(input.calendarOverrides)
        const previous = readCollaborationSettings(this.store)
        if (!Number.isInteger(input.calendarVersion) || previous.version !== input.calendarVersion) throw new HttpError(409, '工作日历已变化，请刷新后重新核对', 'VERSION_CONFLICT')
        if (!equal(validOverrides(previous.calendarOverrides), overrides)) {
          const next = previous.version
            ? this.store.update<CollaborationSettings>('collaborationSettings', previous.id, previous.version, { calendarOverrides: overrides })
            : this.store.insert<CollaborationSettings>('collaborationSettings', { ...previous, calendarOverrides: overrides })
          this.audit(actor, 'collaborationSettings', next.id, 'calendar_update', previous.version ? previous : null, next, '更新共享工作日历；周提报从下个完整周生效')
        }
      }
      return schedulePolicy(this.store, actor, before, mode, overrides, this.clock())
    })
  }

  previewRepair(actor: User, input: Input): WeeklyDeadlineRepairPreview {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    return this.store.transaction(() => this.preview(actor, cycleWeek(input.week)))
  }

  private preview(actor: User, week: string, expiresAt = this.clock().getTime() + 10 * 60_000): WeeklyDeadlineRepairPreview {
    const cycle = this.need<WeeklyCycle>('weeklyCycles', week)
    const calendar = readWorkCalendar(this.store)
    const deadlinePolicy: WeeklyDeadlineSnapshot = { policyVersion: 0, mode: 'last_workday', workingDays: workingDaysInWeek(week, calendar.overrides) }
    const deadlineAt = snapshotDeadline(week, deadlinePolicy)
    const duties = this.store.list<WeeklyDuty>('weeklyDuties').filter(row => row.cycleWeek === week)
    const facts = ['weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments', 'weeklyPlanReviews'].flatMap(collection => this.store.list<Entity & { cycleWeek?: string }>(collection).filter(row => row.cycleWeek === week))
    const reports = this.store.list<Report>('reports').filter(report => report.snapshot?.weeklySubmissions?.some(row => row.cycleWeek === week))
    const dutyIds = new Set(duties.map(duty => duty.id))
    const reviews = this.store.list<{ id: string; version: number; weeklyCompliance: { cycleWeek: string }[]; sourceManifest: { collection: string; id: string }[] }>('periodReviewSnapshots')
      .filter(row => row.weeklyCompliance.some(duty => duty.cycleWeek === week) || row.sourceManifest.some(ref =>
        ref.collection === 'weeklyCycles' && ref.id === week || ref.collection === 'weeklyDuties' && dutyIds.has(ref.id)))
    const reasons: string[] = []
    const now = this.clock().toISOString()
    if (week !== shanghaiWeek(this.clock())) reasons.push('仅支持当前周期；历史或未来周期不自动修复')
    if (cycle.needsReview) reasons.push('应交名单尚未核对')
    if (cycle.deadlineAt && now >= cycle.deadlineAt || deadlineAt && now >= deadlineAt) reasons.push('原截止或新截止已过，不能追溯改变时效')
    if (facts.length) reasons.push('已有提交、缺交、调整或审核历史，不能自动修复')
    if (reports.length || reviews.length) reasons.push('已有报告或周期复盘快照，不能自动修复')
    if ((cycle.deadlineAt === null) !== (deadlineAt === null)) reasons.push('不能自动切换已生成周期的有/无义务状态，请核对业务过渡；新日历仅对后续完整周生效')
    if (!deadlineAt && duties.length) reasons.push('全休周已有应交项，请先核对业务过渡；自动修复不会删除应交记录')
    if (duties.some(duty => duty.deadlineAt !== cycle.deadlineAt)) reasons.push('周期与应交项截止不一致，请先检查数据')
    const matches = (snapshot: WeeklyDeadlineSnapshot | undefined) => snapshot?.mode === deadlinePolicy.mode && equal(snapshot.workingDays, deadlinePolicy.workingDays)
    const unchanged = cycle.deadlineAt === deadlineAt && matches(cycle.deadlinePolicy) && duties.every(duty => duty.deadlineAt === deadlineAt && matches(duty.deadlinePolicy))
    let secret = secrets.get(this.store)
    if (!secret) { secret = randomBytes(32); secrets.set(this.store, secret) }
    const signature = createHmac('sha256', secret).update(JSON.stringify({ expiresAt, actor: [actor.id, actor.version], epoch: operationEpoch(this.store), cycle, duties, calendar, facts, reports: reports.map(row => [row.id, row.version]), reviews })).digest('hex')
    return { week, cycleVersion: cycle.version, previousDeadlineAt: cycle.deadlineAt, deadlineAt, deadlinePolicy, dutyCount: duties.length,
      eligible: reasons.length === 0, unchanged, reasons, token: `${expiresAt}.${signature}` }
  }

  repair(actor: User, input: Input): WeeklyDeadlineRepairPreview {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    const week = cycleWeek(input.week), reason = text(input.reason, '修复原因'), token = text(input.token, '修复预览标识', true, 200)
    return this.store.transaction(() => {
      const receiptId = digest(token)
      const receipt = this.store.get<RepairReceipt>('weeklyDeadlineRepairReceipts', receiptId)
      if (receipt) {
        if (receipt.actorId !== actor.id || receipt.week !== week || receipt.reason !== reason || receipt.epoch !== operationEpoch(this.store)) throw new HttpError(409, '修复预览已失效，请重新预览')
        return this.preview(actor, week)
      }
      const match = /^(\d{13})\.([a-f0-9]{64})$/.exec(token)
      const expiry = match ? Number(match[1]) : 0
      if (!match || expiry <= this.clock().getTime() || expiry > this.clock().getTime() + 10 * 60_000) throw new HttpError(409, '修复预览已失效，请重新预览')
      const preview = this.preview(actor, week, expiry)
      if (preview.token !== token) throw new HttpError(409, '数据或日历已变化，请重新预览')
      if (!preview.eligible) throw new HttpError(409, preview.reasons.join('；'))
      if (!preview.unchanged) {
        const before = this.need<WeeklyCycle>('weeklyCycles', week)
        const after = this.store.update<WeeklyCycle>('weeklyCycles', week, before.version, { deadlineAt: preview.deadlineAt, deadlinePolicy: preview.deadlinePolicy })
        this.audit(actor, 'weeklyCycle', week, 'deadline_repair', before, after, reason)
        for (const duty of this.store.list<WeeklyDuty>('weeklyDuties').filter(row => row.cycleWeek === week)) {
          const updated = this.store.update<WeeklyDuty>('weeklyDuties', duty.id, duty.version, { deadlineAt: preview.deadlineAt!, deadlinePolicy: preview.deadlinePolicy })
          this.audit(actor, 'weeklyDuty', duty.id, 'deadline_repair', duty, updated, reason)
        }
      }
      this.store.insert<RepairReceipt>('weeklyDeadlineRepairReceipts', { id: receiptId, actorId: actor.id, week, reason, epoch: operationEpoch(this.store) })
      return this.preview(actor, week)
    })
  }
}
