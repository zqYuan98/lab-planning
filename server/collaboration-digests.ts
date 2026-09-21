import type { CollaborationPreference, DigestItem, NotificationDigest, ReminderOccurrence, WorkRisk } from '../shared/collaboration-notifications.ts'
import type { BusinessNotificationEvent, FollowupRequest, TaskTracking } from '../shared/collaboration.ts'
import type { Entity, Task, User } from '../shared/types.ts'
import type { Notification, NotificationDelivery, NotificationTarget } from '../shared/notifications.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import type { Store } from './store.ts'
import { enqueueNotification, notificationId } from './notifications.ts'
import { notificationText } from './notification-content.ts'
import { readCollaborationSettings, effectiveManagerIds } from './collaboration-policy.ts'
import { automaticRiskCandidates, evaluateWorkRisks, riskTitle } from './collaboration-rules.ts'
import { shanghaiDate, shanghaiTime, weekOf, workdayCount, workingDay } from './collaboration-calendar.ts'

export const digestTitles: Record<NotificationDigest['type'], string> = {
  risk_member: '今日工作提醒', risk_manager: '需要关注的工作风险', critical_manager: '成员工作有重要更新',
  approval_manager: '待审核与验收事项', daily_manager: '今日工作摘要', weekly_manager: '本周工作摘要', member_actions: '我的下一步行动', manual_followup: '请更新进度并回应',
}
export function addDigestItem(store: Store, recipientId: string, sourceId: string, input: Omit<DigestItem, keyof Entity | 'recipientId' | 'sourceId' | 'consumedBy'>): DigestItem {
  const id = notificationId('digest-item', recipientId, sourceId)
  return store.get<DigestItem>('digestItems', id) ?? store.insert<DigestItem>('digestItems', { id, recipientId, sourceId,
    sourceKind: input.sourceKind, target: input.target, taskId: input.taskId, ownerId: input.ownerId, occurredAt: input.occurredAt, generation: input.generation, actionable: input.actionable,
    title: notificationText(input.title), lines: input.lines.map(notificationText), consumedBy: null })
}
export function createDigest(store: Store, recipientId: string, type: NotificationDigest['type'], slot: string, items: DigestItem[], now: Date, external = true) {
  if (!items.length) return
  const settings = readCollaborationSettings(store), day = shanghaiDate(now), id = notificationId('digest', recipientId, type, day, slot)
  const existing = store.get<NotificationDigest>('notificationDigests', id)
  if (existing) {
    const delivery = existing.notificationId ? store.get<NotificationDelivery>('notificationDeliveries', existing.notificationId) : undefined
    if (delivery && !['pending', 'skipped'].includes(delivery.status)) return existing
    const ids = [...new Set([...existing.itemIds, ...items.map(item => item.id)])]
    if (ids.length !== existing.itemIds.length) store.update<NotificationDigest>('notificationDigests', id, existing.version, { itemIds: ids })
    for (const item of items.filter(item => !item.consumedBy)) store.update<DigestItem>('digestItems', item.id, item.version, { consumedBy: id })
    return store.get<NotificationDigest>('notificationDigests', id)!
  }
  const periodStart = type === 'weekly_manager' ? weekOf(day) : day
  const facts = ['daily_manager', 'weekly_manager'].includes(type) ? store.list<BusinessNotificationEvent>('businessNotificationEvents').filter(event => event.recipientIds.includes(recipientId) && shanghaiDate(new Date(event.occurredAt)) >= periodStart && shanghaiDate(new Date(event.occurredAt)) <= day) : []
  const count = (kind: BusinessNotificationEvent['kind']) => new Set(facts.filter(event => event.kind === kind && (kind !== 'progress_recorded' || event.facts.noteType !== 'no_change')).map(event => event.mutationId)).size
  const statistics = ['daily_manager', 'weekly_manager'].includes(type) ? [{ label: '本期实质进展', value: count('progress_recorded') }, { label: '成员自报完成', value: count('work_completed') }, { label: '新阻塞', value: count('work_blocked') }, { label: '催办回应', value: count('followup_responded') }, { label: '正式周提报', value: count('weekly_submitted') }] : undefined
  const digest = store.insert<NotificationDigest>('notificationDigests', { id, recipientId, type, day, slot,
    periodStart, periodEnd: day, itemIds: items.map(item => item.id), generatedAt: now.toISOString(), ruleVersion: settings.version, notificationId: null, statistics })
  const row = enqueueNotification(store, { eventKey: `collaboration:digest:${id}`, recipientId, kind: `collaboration_${type}`, title: digestTitles[type],
    body: '', targets: [{ type: 'digest', id }], actionable: false, eventTime: now.toISOString() }, now)
  if (row) {
    store.update<NotificationDigest>('notificationDigests', id, digest.version, { notificationId: row.id })
    const delivery = store.get<NotificationDelivery>('notificationDeliveries', row.id)
    if (delivery && !external) store.update<NotificationDelivery>('notificationDeliveries', delivery.id, delivery.version, { status: 'skipped', lastError: '已记录站内事项；本次不重复外发或已达当日额度' })
    else if (delivery?.status === 'pending' && ['critical_manager', 'approval_manager'].includes(type)) store.update<NotificationDelivery>('notificationDeliveries', delivery.id, delivery.version, { nextAttemptAt: new Date(now.getTime() + 5 * 60000).toISOString() })
  }
  for (const item of items) store.update<DigestItem>('digestItems', item.id, item.version, { consumedBy: id })
  return store.get<NotificationDigest>('notificationDigests', id)!
}

function riskItem(store: Store, recipientId: string, risks: WorkRisk[], now: Date) {
  const first = risks[0], task = store.get<Task>('tasks', first.taskId)!, owner = store.get<User>('users', first.ownerId)
  return addDigestItem(store, recipientId, `risk:${first.taskId}:${shanghaiDate(now)}:${risks.map(risk => risk.key).sort().join(':')}`, {
    sourceKind: 'risk', taskId: task.id, ownerId: task.ownerId, title: `${task.title} · ${riskTitle(risks)}`, target: { type: 'task', id: task.id },
    lines: [`负责人：${owner?.name ?? '成员'}`, ...risks.map(risk => risk.detail)], occurredAt: now.toISOString(), generation: first.generation, actionable: true,
  })
}

/** Durable risk intents: generation/rule versions never reset shared daily quota. */
export function runCollaborationDigests(store: Store, now = new Date()): void {
  const settings = readCollaborationSettings(store)
  if (!settings.enabled) return
  store.transaction(() => {
    const day = shanghaiDate(now), time = shanghaiTime(now), candidate = automaticRiskCandidates(store, now)
    const existingOccurrences = store.list<ReminderOccurrence>('reminderOccurrences')
    if (candidate) {
      const perRecipient = new Map<string, WorkRisk[]>()
      for (const risk of candidate.risks) {
        const targets = risk.managerOnly ? risk.managerIds : [risk.ownerId]
        // Third overdue workday and sustained unanswered requests enter manager risk summaries.
        for (const recipientId of [...new Set(targets)]) {
          const recipient = store.get<User>('users', recipientId)
          if (!recipient || !canUseAccount(recipient)) continue
          const manager = recipientId !== risk.ownerId || risk.managerOnly
          if (existingOccurrences.some(item => item.taskId === risk.taskId && item.recipientId === recipientId && item.day === day)) continue
          if (manager) {
            const last = existingOccurrences.filter(item => item.taskId === risk.taskId && item.recipientId === recipientId && item.createdFor === 'manager').sort((a, b) => b.day.localeCompare(a.day))[0]
            if (last && workdayCount(last.day, day, settings.calendarOverrides, true) < 2) continue
          }
          perRecipient.set(recipientId, [...(perRecipient.get(recipientId) ?? []), risk])
        }
      }
      for (const [recipientId, risks] of perRecipient) {
        const manager = store.get<User>('users', recipientId)?.role === 'manager' && risks.some(risk => risk.ownerId !== recipientId || risk.managerOnly)
        const grouped = new Map<string, WorkRisk[]>()
        for (const risk of risks) grouped.set(risk.taskId, [...(grouped.get(risk.taskId) ?? []), risk])
        const items = [...grouped.values()].map(values => riskItem(store, recipientId, values, now))
        const digest = createDigest(store, recipientId, manager ? 'risk_manager' : 'risk_member', candidate.slot, items, now)
        for (const values of grouped.values()) for (const risk of values) {
          const item = riskItem(store, recipientId, values, now)
          if (!digest?.itemIds.includes(item.id)) continue
          const id = notificationId('occurrence', recipientId, risk.key, day)
          if (!store.get('reminderOccurrences', id)) store.insert<ReminderOccurrence>('reminderOccurrences', { id, taskId: risk.taskId, recipientId, riskKey: risk.key,
            kinds: [risk.kind], generation: risk.generation, ruleVersion: settings.version, day, slot: candidate.slot, notificationId: digest?.notificationId ?? null,
            createdFor: manager ? 'manager' : 'member', cancelledReason: '' })
        }
      }
    }
    if (!workingDay(day, settings.calendarOverrides)) return
    const pending = store.list<DigestItem>('digestItems').filter(item => !item.consumedBy)
    if (time >= '09:00' && time < '17:30') {
      for (const recipient of store.list<User>('users').filter(user => canUseAccount(user) && user.role === 'manager')) {
        const carryover = pending.filter(item => item.recipientId === recipient.id && shanghaiDate(new Date(item.occurredAt)) < day)
        if (carryover.length) createDigest(store, recipient.id, 'risk_manager', '09:00', carryover, now)
      }
    }
    if (time < '17:30') return
    const friday = new Date(`${day}T00:00:00Z`).getUTCDay() === 5
    for (const recipient of store.list<User>('users').filter(canUseAccount)) {
      const manager = recipient.role === 'manager'
      if (!manager && (!settings.memberActionsEnabled || store.get<CollaborationPreference>('collaborationPreferences', recipient.id)?.memberActionsEnabled === false)) continue
      const fullManagerDigest = manager && (friday && settings.weeklyManagerEnabled || settings.dailyManagerEnabled)
      const type = manager ? friday && settings.weeklyManagerEnabled ? 'weekly_manager' : 'daily_manager' : 'member_actions'
      const fresh = store.list<DigestItem>('digestItems').filter(item => item.recipientId === recipient.id && !item.consumedBy)
      if (manager && !fullManagerDigest) {
        // Minimum management digest remains available for overflow facts, independently of optional daily summaries.
        createDigest(store, recipient.id, 'daily_manager', '17:30', fresh, now)
        continue
      }
      const outstanding = evaluateWorkRisks(store, now).filter(risk => manager ? risk.managerIds.includes(recipient.id) : risk.ownerId === recipient.id && !risk.managerOnly)
      const grouped = new Map<string, WorkRisk[]>()
      for (const risk of outstanding) grouped.set(risk.taskId, [...(grouped.get(risk.taskId) ?? []), risk])
      for (const risks of grouped.values()) {
        const item = riskItem(store, recipient.id, risks, now)
        if (!item.consumedBy && !fresh.some(value => value.id === item.id)) fresh.push(item)
      }
      // A weekly statistical summary may reference already delivered facts, as a new period summary.
      if (type === 'weekly_manager') {
        const prior = store.list<DigestItem>('digestItems').filter(item => item.recipientId === recipient.id && item.consumedBy && item.sourceKind !== 'risk'
          && shanghaiDate(new Date(item.occurredAt)) >= weekOf(day) && !item.sourceId.startsWith('weekly-reference:'))
        for (const item of prior) fresh.push(addDigestItem(store, recipient.id, `weekly-reference:${weekOf(day)}:${item.id}`, { ...item, lines: ['本周期已回告的进展事实', ...item.lines] }))
      }
      createDigest(store, recipient.id, type, '17:30', fresh, now)
    }
  })
}
