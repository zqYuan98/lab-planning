import type { BusinessNotificationEvent, BusinessNotificationKind, FollowupRequest } from '../shared/collaboration.ts'
import type { CollaborationEventConsumption, DigestItem, NotificationDigest } from '../shared/collaboration-notifications.ts'
import type { AuditEvent, Entity, MonthlyPlan, Report, Task, User } from '../shared/types.ts'
import type { Notification, NotificationDelivery, NotificationTarget } from '../shared/notifications.ts'
import type { WeeklySubmission } from '../shared/weekly-submissions.ts'
import type { Store } from './store.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { enqueueNotification, notificationId } from './notifications.ts'
import { readCollaborationSettings } from './collaboration-policy.ts'
import { addDigestItem, createDigest } from './collaboration-digests.ts'
import { shanghaiDate } from './collaboration-calendar.ts'
import { notificationLocalTime, notificationText } from './notification-content.ts'

const labels: Record<BusinessNotificationKind, string> = {
  followup_requested: '请更新进度', followup_changed: '催办要求有更新', followup_responded: '成员已回应催办', followup_closed: '催办已结束',
  progress_recorded: '进展已更新', work_completed: '成员自报完成', work_reopened: '工作重新打开', work_blocked: '工作遇到阻塞', work_unblocked: '阻塞已解除',
  deadline_changed: '截止日期已变更', deadline_requested: '延期申请待处理', deadline_decided: '延期申请有结果', tracking_changed: '督办状态已调整',
  plan_review_requested: '目标待审核', plan_review_decided: '目标审核有结果', plan_result_submitted: '月度成果待验收', plan_result_decided: '月度成果验收结果',
  weekly_submitted: '正式周提报已提交', report_finalized: '报告已定稿',
}
const critical = new Set<BusinessNotificationKind>(['followup_responded', 'work_completed', 'work_reopened', 'work_blocked', 'work_unblocked', 'deadline_changed'])
const approvals = new Set<BusinessNotificationKind>(['deadline_requested', 'plan_review_requested', 'plan_result_submitted'])
const factLabels: Record<string, string> = {
  note: '实际进展', nextAction: '下一步', proxyReason: '管理者代录原因', noChangeReason: '暂无变化原因', reason: '说明',
  requirement: '更新要求', dueAt: '回应期限', oldDueDate: '原截止', newDueDate: '新截止', requestedDueDate: '申请截止',
  blockerReason: '阻塞原因', blockerImpact: '影响', supportNeeded: '需要支持', completionNote: '完成说明', reviewComment: '审核意见',
  decision: '处理结果', status: '状态', actualOutcome: '实际成果', acceptanceNote: '验收说明', cycleWeek: '提报周期', kind: '提报类型',
  dueDate: '任务截止', blocker: '阻塞原因',
}
function eventFactLabel(event: BusinessNotificationEvent, field: string) {
  if (field !== 'dueDate') return factLabels[field]
  if (event.kind === 'deadline_requested') return '原截止'
  if (event.kind === 'deadline_changed' || event.kind === 'deadline_decided' && event.facts.decision === 'approved') return '新截止'
  return event.kind === 'deadline_decided' ? '当时截止' : '任务截止'
}
function eventFactValue(field: string, value: unknown) {
  if (field === 'dueAt' && typeof value === 'string' && Number.isFinite(Date.parse(value))) return notificationLocalTime(new Date(value))
  if (field === 'decision' && typeof value === 'string') return ({ approved: '已批准', returned: '已退回' } as Record<string, string>)[value] ?? notificationText(value)
  return notificationText(String(value))
}
const publicationDeferred = new WeakSet<Store>()
export function withCollaborationPublicationDeferred<T>(store: Store, operation: () => T, now = new Date()): T {
  if (publicationDeferred.has(store)) return operation()
  return store.transaction(() => {
    publicationDeferred.add(store)
    let result: T
    try { result = operation() } finally { publicationDeferred.delete(store) }
    publishCollaborationEvents(store, now)
    return result
  })
}
function targetFor(event: BusinessNotificationEvent): NotificationTarget {
  const followupId = event.facts.followupId ?? event.facts.followupRequestId
  if (event.kind.startsWith('followup_') && typeof followupId === 'string') return { type: 'followup', id: followupId }
  if (event.kind.startsWith('deadline_') && typeof event.facts.deadlineRequestId === 'string') return { type: 'deadlineRequest', id: event.facts.deadlineRequestId }
  if (event.subjectType === 'report') return { type: 'report', id: event.subjectId }
  if (event.subjectType === 'weeklySubmission') return { type: 'weeklySubmission', id: String(event.facts.dutyId ?? event.subjectId), cycleWeek: String(event.facts.cycleWeek ?? '') }
  return { type: event.subjectType, id: event.subjectId }
}
function eventTitle(store: Store, event: BusinessNotificationEvent) {
  if (event.taskId) return store.get<Task>('tasks', event.taskId)?.title ?? '相关工作'
  if (event.subjectType === 'plan') return store.get<MonthlyPlan>('plans', event.subjectId)?.title ?? '月度目标'
  if (event.subjectType === 'report') return store.get<Report>('reports', event.subjectId)?.title ?? '定稿报告'
  return event.kind === 'weekly_submitted' ? `${event.facts.cycleWeek ?? ''} 正式周提报` : labels[event.kind]
}
export function recordLifecycleEvent(store: Store, input: Omit<BusinessNotificationEvent, keyof Entity>) {
  const settings = readCollaborationSettings(store)
  if (!settings.enabled || input.ownerId && !settings.pilotUserIds.includes(input.ownerId)) return
  const id = notificationId('business-event', input.mutationId, input.kind, input.subjectId)
  return store.get<BusinessNotificationEvent>('businessNotificationEvents', id) ?? store.insert<BusinessNotificationEvent>('businessNotificationEvents', { id, ...input })
}

export function recordPlanLifecycleEvent(store: Store, actor: User, audit: AuditEvent) {
  if (audit.entityType !== 'plan' || !audit.after) return
  const plan = audit.after as MonthlyPlan, before = audit.before as MonthlyPlan | null, settings = readCollaborationSettings(store)
  if (!settings.enabled || !settings.pilotUserIds.includes(plan.ownerId)) return
  let kind: BusinessNotificationKind | undefined
  if (audit.action === 'submit') kind = 'plan_review_requested'
  else if (['approve', 'return'].includes(audit.action)) kind = 'plan_review_decided'
  else if (audit.action === 'result' && plan.acceptanceStatus === 'submitted' && before?.acceptanceStatus !== 'submitted') kind = 'plan_result_submitted'
  else if (audit.action === 'result' && ['accepted', 'not_completed'].includes(plan.acceptanceStatus) && before?.acceptanceStatus !== plan.acceptanceStatus) kind = 'plan_result_decided'
  if (!kind) return
  recordLifecycleEvent(store, { kind, mutationId: audit.id, subjectType: 'plan', subjectId: plan.id, taskId: null, ownerId: plan.ownerId,
    actorId: actor.id, recipientIds: kind.endsWith('requested') || kind === 'plan_result_submitted' ? settings.defaultManagerIds : [plan.ownerId],
    occurredAt: audit.createdAt, generation: null, sourceVersion: plan.version,
    facts: { status: plan.status, reviewComment: plan.reviewComment, actualOutcome: plan.actualOutcome, acceptanceNote: plan.acceptanceNote } })
}

/** Synchronous projector, safe inside the caller's business transaction. Never performs network I/O. */
export function publishCollaborationEvents(store: Store, now = new Date()): void {
  if (publicationDeferred.has(store)) return
  const settings = readCollaborationSettings(store)
  if (!settings.enabled) return
  store.transaction(() => {
    const day = shanghaiDate(now), manual = new Map<string, DigestItem[]>()
    for (const event of store.list<BusinessNotificationEvent>('businessNotificationEvents')) {
      const receiptId = notificationId('collaboration-event-consumed', event.id)
      if (store.get('collaborationEventConsumptions', receiptId)) continue
      // Restored facts and events before enablement never become an external replay.
      if (!settings.enabledAt || event.occurredAt < settings.enabledAt) {
        store.insert<CollaborationEventConsumption>('collaborationEventConsumptions', { id: receiptId, eventId: event.id, consumedAt: now.toISOString() }); continue
      }
      const target = targetFor(event), owner = store.get<User>('users', event.ownerId), actor = store.get<User>('users', event.actorId)
      const lines = [`当时记录：${labels[event.kind]}；发生于 ${notificationLocalTime(new Date(event.occurredAt))}`, `负责人：${owner?.name ?? '相关成员'}；操作人：${actor?.name ?? '成员'}`,
        ...Object.entries(event.facts).filter(([key, value]) => factLabels[key] && (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')).map(([key, value]) => `${eventFactLabel(event, key)}：${eventFactValue(key, value)}`)]
      const recipients = [...new Set(event.recipientIds)].filter(id => { const user = store.get<User>('users', id); return user && canUseAccount(user) && (id !== event.actorId || event.kind === 'weekly_submitted') })
      for (const recipientId of recipients) {
        if (event.kind === 'deadline_changed' && recipientId === event.ownerId && typeof event.facts.auditEventId === 'string'
          && store.list<Notification>('notifications').some(row => row.eventKey === event.facts.auditEventId && row.recipientId === recipientId && row.kind === 'work_changed')) continue
        const recipient = store.get<User>('users', recipientId)!
        const item = addDigestItem(store, recipientId, event.id, { sourceKind: event.kind, target, taskId: event.taskId, ownerId: event.ownerId,
          title: eventTitle(store, event), lines, occurredAt: event.occurredAt, generation: event.generation, actionable: approvals.has(event.kind) || ['followup_requested', 'followup_changed'].includes(event.kind) })
        if (item.consumedBy) continue
        if (['followup_requested', 'followup_changed'].includes(event.kind)) { manual.set(recipientId, [...(manual.get(recipientId) ?? []), item]); continue }
        if (event.kind === 'progress_recorded' || event.kind === 'tracking_changed' || event.kind === 'weekly_submitted' && recipient.role === 'manager' && recipientId !== event.ownerId) continue
        if (recipient.role === 'manager' && critical.has(event.kind)) {
          const bucket = String(Math.floor(now.getTime() / (5 * 60000))), count = store.list<NotificationDigest>('notificationDigests').filter(row => row.recipientId === recipientId && row.day === day && row.type === 'critical_manager')
          if (count.length < 3 || count.some(row => row.slot === bucket)) createDigest(store, recipientId, 'critical_manager', bucket, [item], now)
          continue // Overflow remains a digest item for the next manager summary.
        }
        if (recipient.role === 'manager' && approvals.has(event.kind)) { createDigest(store, recipientId, 'approval_manager', 'pending', [item], now); continue }
        const notification = enqueueNotification(store, { eventKey: `collaboration:event:${event.id}`, recipientId, kind: `collaboration_${event.kind}`, title: `${labels[event.kind]}：${item.title}`,
          body: lines.join('\n'), targets: [target], actionable: false, actorId: event.actorId, eventTime: event.occurredAt }, now)
        if (notification) {
          store.update<DigestItem>('digestItems', item.id, item.version, { consumedBy: notification.id })
          // A person's own formal submission is a station receipt, not another external success popup.
          if (event.kind === 'weekly_submitted' && recipientId === event.actorId) {
            const delivery = store.get<NotificationDelivery>('notificationDeliveries', notification.id)
            if (delivery) store.update<NotificationDelivery>('notificationDeliveries', delivery.id, delivery.version, { status: 'skipped', lastError: '本人操作成功，保留站内回执' })
          }
        }
      }
      store.insert<CollaborationEventConsumption>('collaborationEventConsumptions', { id: receiptId, eventId: event.id, consumedAt: now.toISOString() })
    }
    for (const [recipientId, items] of manual) {
      const quotas = store.list<Entity & { day: string; recipientId: string; taskIds: string[] }>('followupNotificationQuotas').filter(row => row.day === day && row.recipientId === recipientId)
      const taskIds = [...new Set(items.map(item => item.taskId).filter((id): id is string => !!id))]
      const allowed = quotas.length < 3 && taskIds.every(id => !quotas.some(row => row.taskIds.includes(id)))
      const slot = notificationId(...items.map(item => item.id).sort())
      createDigest(store, recipientId, 'manual_followup', slot, items, now, allowed)
      if (allowed) store.insert<Entity & { day: string; recipientId: string; taskIds: string[] }>('followupNotificationQuotas', { id: notificationId(day, recipientId, slot), day, recipientId, taskIds })
    }
  })
}

export function notifyFormalSubmission(store: Store, receipt: WeeklySubmission) {
  const settings = readCollaborationSettings(store)
  recordLifecycleEvent(store, { kind: 'weekly_submitted', mutationId: receipt.id, subjectType: 'weeklySubmission', subjectId: receipt.id,
    taskId: null, ownerId: receipt.ownerId, actorId: receipt.actorId, recipientIds: [...new Set([receipt.ownerId, ...settings.defaultManagerIds])],
    occurredAt: receipt.submittedAt, generation: null, sourceVersion: receipt.version,
    facts: { dutyId: receipt.dutyId, cycleWeek: receipt.cycleWeek, kind: receipt.kind, proxyReason: receipt.reason, note: receipt.note } })
  publishCollaborationEvents(store, new Date(receipt.submittedAt))
}
