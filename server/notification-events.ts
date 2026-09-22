import type { AuditEvent, Entity, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { NotificationTarget } from '../shared/notifications.ts'
import { enqueueNotification, notificationId } from './notifications.ts'
import type { Store } from './store.ts'
import { captureNotificationFacts, notificationEventChanges } from './notification-content.ts'
import { isSilentImport } from './import-notification-context.ts'
import { collaborationEnabledFor } from './collaboration-policy.ts'
import { isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { isActiveTask } from '../shared/task-state.ts'

const suppressedTasks = new WeakSet<Store>()
export function withTaskNotificationSuppressed<T>(store: Store, operation: () => T): T {
  const already = suppressedTasks.has(store)
  suppressedTasks.add(store)
  try { return operation() } finally { if (!already) suppressedTasks.delete(store) }
}
const planTarget = (plan: MonthlyPlan): NotificationTarget => ({ type: 'plan', id: plan.id, month: plan.month })
const changed = (before: unknown, after: unknown, fields: string[]) => fields.some(field => JSON.stringify((before as Record<string, unknown>)[field]) !== JSON.stringify((after as Record<string, unknown>)[field]))
interface WorkNotificationVersion extends Entity {
  entityType: 'task' | 'weeklyRecord'; entityId: string; recipientId: string; fingerprint: string; eventKey: string
}

/** Explicit live business actions only; imports/restoration never scan or replay audit history. */
export function notifyBusinessEvent(store: Store, actor: User, event: AuditEvent): void {
  if (!event.after || isSilentImport(store)) return
  if (event.entityType === 'task' || event.entityType === 'weeklyRecord') {
    const work = event.after as Task | WeeklyRecord
    const currentTask = store.get<Task>('tasks', event.entityType === 'task' ? work.id : (work as WeeklyRecord).taskId)
    if (currentTask && !isActiveTask(currentTask) || event.entityType === 'task' && !isActiveTask(work as Task)) return
    if (actor.role !== 'manager' || actor.id === work.ownerId || work.importSource && work.importSource.mode !== 'draft' || work.workOrigin?.kind !== 'assigned') return
    if (event.entityType === 'task' && work.importSource?.mode === 'draft' && !store.list<WeeklyRecord>('weeklyRecords').some(row => row.taskId === work.id && isEffectiveWeeklyRecord(row))) return
    // Only effective work is an assignment. A saved weekly draft becomes a
    // first assignment notification when the manager later publishes the row.
    if (work.monthlyPlanId && store.get<MonthlyPlan>('plans', work.monthlyPlanId)?.status !== 'published') return
    if (event.entityType === 'weeklyRecord' && !isEffectiveWeeklyRecord(work as WeeklyRecord)) return
    const firstPublication = event.before === null && ['create', 'submit'].includes(event.action)
      || event.entityType === 'weeklyRecord' && ['submit', 'plan_approve'].includes(event.action) && (!event.before || !isEffectiveWeeklyRecord(event.before as WeeklyRecord))
    if (firstPublication && event.entityType === 'task' && suppressedTasks.has(store)) return
    const fields = event.entityType === 'task' ? ['title', 'description', 'dueDate', 'monthlyPlanId'] : ['commitment']
    const meaningfulChange = !!event.before && ['update', 'submit', 'relink'].includes(event.action) && changed(event.before, work,
      fields)
    if (!firstPublication && !meaningfulChange) return
    const key = notificationId('work-notification-version', event.entityType, work.id)
    const previous = store.get<WorkNotificationVersion>('notificationWorkVersions', key)
    // Draft/progress changes do not alter the last published assignment version.
    // In particular, withdrawing and republishing identical work preserves its
    // confirmation instead of creating another assignment and resetting it.
    const fingerprint = notificationId(JSON.stringify([work.ownerId, ...fields.map(field => (work as unknown as Record<string, unknown>)[field])]))
    if (previous?.fingerprint === fingerprint) return
    const initial = firstPublication && !previous
    const task = event.entityType === 'task' ? work as Task : store.get<Task>('tasks', (work as WeeklyRecord).taskId)
    const target: NotificationTarget = event.entityType === 'task' ? { type: 'task', id: work.id } : { type: 'weeklyRecord', id: work.id, weekStart: (work as WeeklyRecord).weekStart }
    const details = [task?.title ?? '周工作', `下发人：${actor.name}`, event.entityType === 'weeklyRecord' ? `周期：${(work as WeeklyRecord).weekStart} 当周` : '', task?.dueDate ? `截止：${task.dueDate}` : ''].filter(Boolean).join('；')
    const notification = enqueueNotification(store, { eventKey: event.id, recipientId: work.ownerId, kind: initial ? 'work_assigned' : 'work_changed',
      title: initial ? '你有一项新的工作安排' : '你的工作安排有更新',
      body: `${details}。请查看要求并确认知悉。`,
      targets: [target], actionable: true, actorId: actor.id, eventTime: event.createdAt,
      contentFacts: captureNotificationFacts(store, [target], store.get<User>('users', work.ownerId), notificationEventChanges(store, event, target, work.ownerId), initial ? undefined : event.reason) })
    if (notification) {
      const value: Omit<WorkNotificationVersion, keyof Entity> = { entityType: event.entityType, entityId: work.id, recipientId: work.ownerId, fingerprint, eventKey: notification.eventKey }
      if (previous) store.update<WorkNotificationVersion>('notificationWorkVersions', key, previous.version, value)
      else store.insert<WorkNotificationVersion>('notificationWorkVersions', { id: key, ...value })
    }
    return
  }
  if (event.entityType !== 'plan') return
  const plan = event.after as MonthlyPlan
  if (event.action === 'published_change' && event.before) {
    const before = event.before as MonthlyPlan
    if (!changed(before, plan, ['title', 'ownerId', 'collaboratorIds', 'expectedOutcome', 'acceptanceCriteria', 'dueDate'])) return
    const recipients = [...new Set([plan.ownerId, ...plan.collaboratorIds])]
    const previousRecipients = new Set([before.ownerId, ...before.collaboratorIds])
    const requirementsChanged = changed(before, plan, ['title', 'expectedOutcome', 'acceptanceCriteria', 'dueDate'])
    const notified = recipients.filter(id => requirementsChanged || !previousRecipients.has(id) || id === plan.ownerId && before.ownerId !== plan.ownerId)
    for (const recipientId of notified) enqueueNotification(store, { eventKey: event.id, recipientId, kind: 'plan_changed', title: '月度目标已调整', body: `${plan.title} · ${plan.month}。请查看最新分工、成果要求和截止日期。`, targets: [planTarget(plan)], actionable: recipientId === plan.ownerId,
      actorId: actor.id, eventTime: event.createdAt, contentFacts: captureNotificationFacts(store, [planTarget(plan)], store.get<User>('users', recipientId)!, notificationEventChanges(store, event, planTarget(plan), recipientId), event.reason) })
    for (const recipientId of [...previousRecipients].filter(id => !recipients.includes(id))) enqueueNotification(store, {
      eventKey: `${event.id}:removed`, recipientId, kind: 'participation_removed', title: '月度工作分工已调整', body: '你已不再参与一项月度目标，如有疑问请联系管理者。', targets: [], actionable: false,
    })
  }
  if (plan.isTemporary && event.action === 'submit' && !collaborationEnabledFor(store, plan.ownerId)) {
    for (const manager of store.list<User>('users').filter(user => user.role === 'manager' && user.id !== actor.id)) enqueueNotification(store, {
      eventKey: event.id, recipientId: manager.id, kind: 'proposal_review', title: '有临时目标待审核', body: `${plan.title} · ${plan.month}。请查看临时目标提报。`, targets: [planTarget(plan)], actionable: false, actorId: actor.id,
    })
  }
  if (plan.isTemporary && ['approve', 'return'].includes(event.action) && !collaborationEnabledFor(store, plan.ownerId)) enqueueNotification(store, {
    eventKey: event.id, recipientId: plan.ownerId, kind: 'proposal_result', title: event.action === 'approve' ? '临时目标审核通过' : '临时目标已退回',
    body: `${plan.title}。${event.action === 'approve' ? '等待管理者正式发布。' : '请进入系统查看原因并修改。'}`, targets: [planTarget(plan)], actionable: false, actorId: actor.id,
  })
}
export function notifyPublishedPlans(store: Store, plans: MonthlyPlan[], month: string, revision: number): void {
  if (isSilentImport(store)) return
  const recipients = [...new Set(plans.flatMap(plan => [plan.ownerId, ...plan.collaboratorIds]))]
  for (const recipientId of recipients) {
    const assigned = plans.filter(plan => plan.ownerId === recipientId || plan.collaboratorIds.includes(recipientId))
    enqueueNotification(store, { eventKey: `monthly-publish:${month}:${revision}`, recipientId, kind: 'monthly_published', title: `${month} 月度计划已发布`,
      body: `本次发布包含与你相关的 ${assigned.length} 项目标，请查看分工和成果要求。`, targets: assigned.map(planTarget), actionable: assigned.some(plan => plan.ownerId === recipientId) })
  }
}
