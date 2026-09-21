import { canUseAccount } from '../shared/auth-policy.ts'
import type { User } from '../shared/types.ts'
import type { WeeklyDutyView, WeeklyRule } from '../shared/weekly-submissions.ts'
import { enqueueNotification } from './notifications.ts'
import { Store } from './store.ts'
import { addWeekDays, shanghaiWeek } from './weekly-submission-clock.ts'
import { WeeklySubmissionService } from './weekly-submissions.ts'

export function currentReminderSlot(now: Date, week = shanghaiWeek(now)): '09:00' | '15:00' | '16:05' | undefined {
  const friday = addWeekDays(week, 4)
  const local = new Date(now.getTime() + 8 * 3_600_000).toISOString()
  if (local.slice(0, 10) !== friday) return
  const time = local.slice(11, 16)
  if (time >= '16:05') return '16:05'
  if (time >= '15:00' && time < '16:00') return '15:00'
  if (time >= '09:00' && time < '15:00') return '09:00'
}

function localTimestamp(now: Date) {
  return `${new Date(now.getTime() + 8 * 3_600_000).toISOString().slice(0, 16).replace('T', ' ')}（北京时间）`
}

const pending = (duty: WeeklyDutyView) => duty.status !== 'exempt' && (!duty.latestSubmission || duty.changedSinceSubmission)
const count = (duties: WeeklyDutyView[]) => `${duties.length}项（${new Set(duties.map(duty => duty.ownerId)).size}人）`

/**
 * Only the latest current Friday slot may create inbox events. A recovered
 * scheduler may produce the 09:00 reminder until 15:00, then only the 15:00
 * reminder until cutoff. The summary is eligible from 16:05 until midnight.
 * Missed earlier slots and previous days/weeks are never replayed.
 * The surrounding SQLite transaction and persisted event keys make repeated
 * ticks and multiple workers idempotent without in-memory scheduler state.
 */
export function runNotificationReminders(store: Store, now: Date = new Date()): void {
  if (!Number.isFinite(now.getTime())) return
  const week = shanghaiWeek(now), slot = currentReminderSlot(now, week)
  if (!slot) return

  store.transaction(() => {
    const rule = store.get<WeeklyRule>('weeklyRules', 'weekly-submission-rule')
    if (!rule?.enabled || !rule.windows.some(window => week >= window.fromWeek && (!window.toWeek || week < window.toWeek))) return

    const users = store.list<User>('users'), activeUsers = users.filter(canUseAccount)
    const managers = activeUsers.filter(user => user.role === 'manager')
    const actor = managers[0] ?? activeUsers[0]
    if (!actor || (slot === '16:05' && managers.length === 0)) return

    const service = new WeeklySubmissionService(store, () => now)
    const view = service.view(actor, week)
    if (!view.cycle || view.cycle.needsReview) return
    // A member view intentionally redacts the departmental roster. When there
    // is no active manager, read each member's own formal obligations instead.
    const duties = managers.length
      ? view.duties.filter(duty => view.cycle!.rosterIds.includes(duty.ownerId))
      : activeUsers.flatMap(user => {
        const personal = user.id === actor.id ? view : service.view(user, week)
        return personal.duties.filter(duty => personal.cycle?.rosterIds.includes(duty.ownerId))
      })
    const deadline = localTimestamp(new Date(view.deadlineAt))
    const timestamp = localTimestamp(now)

    if (slot === '16:05') {
      const missed = duties.filter(duty => duty.missingAtDeadline)
      const outstanding = duties.filter(duty => duty.status !== 'exempt' && !duty.latestSubmission)
      const supplemented = duties.filter(duty => duty.status === 'late')
      const changed = duties.filter(duty => duty.status !== 'exempt' && duty.latestSubmission && duty.changedSinceSubmission)
      const body = [
        `统计时间：${timestamp}`,
        `提报周期：${week} 至 ${addWeekDays(week, 6)}`,
        `截止时间：${deadline}`,
        `截止未交：${count(missed)}`,
        `当前仍欠交：${count(outstanding)}`,
        `已补交：${count(supplemented)}`,
        `内容已更新待重新提交：${count(changed)}`,
        `当前豁免：${count(duties.filter(duty => duty.status === 'exempt'))}`,
      ].join('\n')
      for (const manager of managers) enqueueNotification(store, {
        eventKey: `weekly:${week}:${slot}:${manager.id}`,
        recipientId: manager.id, kind: 'weekly_summary', title: '本周正式提报截止汇总', body,
        targets: [{ type: 'summary', id: week, cycleWeek: week, weekStart: week }], actionable: false,
      }, now)
      return
    }

    for (const recipient of activeUsers) {
      const owed = duties.filter(duty => duty.ownerId === recipient.id && pending(duty))
        .sort((left, right) => (left.kind === 'results' ? 0 : 1) - (right.kind === 'results' ? 0 : 1))
      if (owed.length === 0) continue
      const body = [
        `提醒时间：${timestamp}`,
        `正式提报截止：${deadline}`,
        ...owed.map(duty => `${duty.kind === 'results' ? '本周完成情况' : '下周计划'}（${duty.contentWeek} 至 ${addWeekDays(duty.contentWeek, 6)}）：${duty.latestSubmission ? '已正式提交，内容已更新，请重新核对提交' : '尚未正式提交，请核对并提交'}`),
      ].join('\n')
      enqueueNotification(store, {
        eventKey: `weekly:${week}:${slot}:${recipient.id}`,
        recipientId: recipient.id, kind: 'weekly_reminder', title: '周提报待提交提醒', body,
        targets: owed.map(duty => ({ type: 'weeklySubmission', id: duty.id, cycleWeek: duty.cycleWeek, weekStart: duty.contentWeek, kind: duty.kind })),
        actionable: false,
      }, now)
    }
  })
}
