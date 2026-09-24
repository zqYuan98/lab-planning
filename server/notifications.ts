import { createHash, randomUUID } from 'node:crypto'
import type { Entity, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { Notification, NotificationDelivery, NotificationSettings, NotificationTarget, NotificationView } from '../shared/notifications.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { appOrigin } from './auth.ts'
import { HttpError, Store } from './store.ts'
import { captureNotificationFacts, contentAsText, mergeNotificationChanges, notificationSubject, projectNotificationContent, targetKey } from './notification-content.ts'
import { collaborationTargetAccessible } from './collaboration-content.ts'

interface Identity extends Entity { provider: string; corpId: string; userid: string; userId: string }
interface Obligation extends Entity { recipientId: string; target: NotificationTarget; eventKey: string; acknowledgedAt: string | null }
type Input = Pick<Notification, 'eventKey' | 'recipientId' | 'kind' | 'title' | 'body' | 'targets' | 'actionable'>
  & Partial<Pick<Notification, 'actorId' | 'sourceNotificationId' | 'eventTime' | 'contentFacts'>>
export const notificationId = (...parts: string[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
const obligationId = (userId: string, target: NotificationTarget) => notificationId(userId, target.type, target.id)
export function notificationEnvironmentEnabled() {
  return process.env.DINGTALK_NOTIFICATIONS_ENABLED === 'true' && !!process.env.DINGTALK_DEPLOYMENT_ID?.trim() && appOrigin()?.protocol === 'https:'
}
export function getNotificationSettings(store: Store): NotificationSettings {
  return store.transaction(() => store.get<NotificationSettings>('notificationSettings', 'notifications') ?? store.insert<NotificationSettings>('notificationSettings', {
    id: 'notifications', externalEnabled: false, pilotUserIds: [], sendStartHour: 8, sendEndHour: 20, enabledAt: null, deploymentId: '', activationId: '',
  }))
}
export function currentIdentity(store: Store, userId: string): Identity | undefined {
  return store.list<Identity>('externalIdentities').find(row => row.provider === 'dingtalk' && row.corpId === process.env.DINGTALK_CORP_ID && row.userId === userId)
}
function cancelledTaskTarget(store: Store, target: NotificationTarget): boolean {
  const reference = target.type === 'weeklyRecord' ? store.get<WeeklyRecord>('weeklyRecords', target.id)
    : target.type === 'followup' || target.type === 'deadlineRequest'
      ? store.get<{ taskId: string }>(target.type === 'followup' ? 'followupRequests' : 'deadlineChangeRequests', target.id) : undefined
  const task = target.type === 'task' ? store.get<Task>('tasks', target.id) : reference ? store.get<Task>('tasks', reference.taskId) : undefined
  return !!task && !isActiveTask(task)
}
export function targetAccessible(store: Store, actor: User, target: NotificationTarget): boolean {
  const current = store.get<User>('users', actor.id)
  if (!current || !canUseAccount(current) || current.role === 'observer') return false
  actor = current
  if (cancelledTaskTarget(store, target)) return false
  if (target.type === 'blocker') {
    const row = store.get<{ parentTaskId: string; coordinatorId?: string | null }>('blockerEpisodes', target.id)
    const task = row && store.get<Task>('tasks', row.parentTaskId)
    return !!task && isActiveTask(task) && (actor.role === 'manager' || task.ownerId === actor.id || row?.coordinatorId === actor.id)
  }
  if (target.type === 'decisionRequest') {
    const row = store.get<{ taskId: string }>('decisionRequests', target.id), task = row && store.get<Task>('tasks', row.taskId)
    return !!task && isActiveTask(task) && (actor.role === 'manager' || task.ownerId === actor.id)
  }
  if (target.type === 'feedback') {
    const row = store.get<{ reporterId: string }>('feedback', target.id)
    return !!row && (actor.role === 'manager' || row.reporterId === actor.id)
  }
  if (['followup', 'digest', 'deadlineRequest', 'report'].includes(target.type)) return collaborationTargetAccessible(store, actor, target)
  if (target.type === 'summary') return actor.role === 'manager'
  if (target.type === 'weeklySubmission') {
    const duty = store.get<{ ownerId: string }>('weeklyDuties', target.id)
    return !!duty && (actor.role === 'manager' || duty.ownerId === actor.id)
  }
  if (target.type === 'plan') {
    const row = store.get<MonthlyPlan>('plans', target.id)
    return !!row && row.status !== 'merged' && (actor.role === 'manager' || row.ownerId === actor.id || row.collaboratorIds.includes(actor.id))
  }
  const row = store.get<Task | WeeklyRecord>(target.type === 'task' ? 'tasks' : 'weeklyRecords', target.id)
  return !!row && (target.type !== 'weeklyRecord' || isActiveWeeklyRecord(row as WeeklyRecord)) && (actor.role === 'manager' || row.ownerId === actor.id)
}
function targetOwned(store: Store, actor: User, target: NotificationTarget): boolean {
  if (!['plan', 'task', 'weeklyRecord'].includes(target.type) || !targetAccessible(store, actor, target)) return false
  if (target.type === 'plan') {
    const plan = store.get<MonthlyPlan>('plans', target.id)
    return plan?.ownerId === actor.id && plan.status === 'published'
  }
  const work = store.get<Task | WeeklyRecord>(target.type === 'task' ? 'tasks' : 'weeklyRecords', target.id)
  return work?.ownerId === actor.id && (target.type !== 'weeklyRecord' || isEffectiveWeeklyRecord(work as WeeklyRecord))
    && (!work.monthlyPlanId || store.get<MonthlyPlan>('plans', work.monthlyPlanId)?.status === 'published')
}
export function enqueueNotification(store: Store, input: Input, now = new Date()): Notification | null {
  return store.transaction(() => {
    const actor = store.get<User>('users', input.recipientId)
    if (!actor || !canUseAccount(actor) || actor.role === 'observer') return null
    const id = notificationId(input.eventKey, input.recipientId)
    const previous = store.get<Notification>('notifications', id)
    if (previous) return previous
    const targets = input.targets.filter(target => !cancelledTaskTarget(store, target))
    if (input.targets.length && !targets.length) return null
    input = { ...input, targets }
    const permittedTargets = input.targets.filter(target => targetAccessible(store, actor, target))
    let row = store.insert<Notification>('notifications', { ...input, id, contentSchemaVersion: 1, eventTime: input.eventTime ?? now.toISOString(),
      contentFacts: input.contentFacts ?? captureNotificationFacts(store, permittedTargets, actor), openedAt: null, acknowledgedAt: null, supersededAt: null })
    if (input.actionable) for (const target of input.targets.filter(target => targetOwned(store, actor, target))) {
      const key = obligationId(actor.id, target), before = store.get<Obligation>('notificationObligations', key)
      const fields = { recipientId: actor.id, target, eventKey: row.eventKey, acknowledgedAt: null }
      if (before) store.update<Obligation>('notificationObligations', key, before.version, fields)
      else store.insert<Obligation>('notificationObligations', { id: key, ...fields })
    }
    // Feedback is an independent, private in-app channel, including when external delivery is enabled.
    // Do not create even a skipped delivery: later configuration or manual retry cannot externalize it.
    if (input.kind.startsWith('feedback_') || input.targets.some(target => target.type === 'feedback')) return row
    const settings = getNotificationSettings(store)
    const identity = currentIdentity(store, actor.id)
    const allowed = settings.externalEnabled && notificationEnvironmentEnabled() && settings.deploymentId === process.env.DINGTALK_DEPLOYMENT_ID && settings.pilotUserIds.includes(actor.id)
    const change = ['work_changed', 'plan_changed'].includes(input.kind)
    if (change) for (const previousDelivery of store.list<NotificationDelivery>('notificationDeliveries').filter(item => item.recipientId === actor.id && item.status === 'pending')) {
      const old = store.get<Notification>('notifications', previousDelivery.notificationId)
      if (old && old.kind === input.kind && now.getTime() - Date.parse(old.createdAt) < 5 * 60000 && JSON.stringify(old.targets) === JSON.stringify(input.targets)) {
        if (row.contentFacts && old.contentFacts) row = store.update<Notification>('notifications', row.id, row.version, {
          contentFacts: { ...row.contentFacts, changes: mergeNotificationChanges(old.contentFacts.changes, row.contentFacts.changes) },
        })
        store.update<NotificationDelivery>('notificationDeliveries', previousDelivery.id, previousDelivery.version, { status: 'skipped', lastError: '5 分钟内的变更已合并到最新通知' })
      }
    }
    // Only new events create eligible deliveries. Binding or enabling later never replays the inbox.
    store.insert<NotificationDelivery>('notificationDeliveries', {
      id, notificationId: id, recipientId: actor.id, status: allowed && identity ? 'pending' : 'skipped', attempts: 0,
      nextAttemptAt: new Date(now.getTime() + (change ? 5 * 60000 : 0)).toISOString(), leaseUntil: null, providerTaskId: null, acceptedAt: null,
      lastError: !allowed ? '未启用外发或不在试点范围' : !identity ? '尚未绑定钉钉账号' : '',
      deploymentId: settings.deploymentId, activationId: settings.activationId, identityId: identity?.id ?? '',
    })
    return row
  })
}
function currentObligations(store: Store, actor: User, row: Notification) {
  return row.targets.filter(target => targetOwned(store, actor, target)).flatMap(target => {
    const obligation = store.get<Obligation>('notificationObligations', obligationId(actor.id, target))
    return obligation?.eventKey === row.eventKey ? [obligation] : []
  })
}
export function pendingNotificationTargets(store: Store, actor: User, row: Notification): NotificationTarget[] {
  return currentObligations(store, actor, row).filter(item => !item.acknowledgedAt).map(item => item.target)
}
export function sourceNotification(store: Store, actor: User, row: Notification): Notification | undefined {
  if (row.kind !== 'manual_reminder' || row.recipientId !== actor.id) return
  const id = row.sourceNotificationId ?? /^manual:\d{4}-\d{2}-\d{2}:([a-f0-9]{64})$/.exec(row.eventKey)?.[1]
  if (!id || !/^[a-f0-9]{64}$/.test(id) || id === row.id) return
  const source = store.get<Notification>('notifications', id)
  return source?.recipientId === actor.id && source.kind !== 'manual_reminder' ? source : undefined
}
export function notificationView(store: Store, actor: User, row: Notification, now = new Date()): NotificationView {
  const current = store.get<User>('users', actor.id)
  if (!current || !canUseAccount(current) || current.role === 'observer') throw new HttpError(403, '当前账号不能读取业务消息')
  actor = current
  if (row.recipientId !== actor.id) throw new HttpError(404, '消息不存在')
  let targets = row.targets.filter(target => targetAccessible(store, actor, target))
  const redacted = targets.length !== row.targets.length
  const obligations = currentObligations(store, actor, row)
  const obsolete = row.actionable && obligations.length === 0
  const delivery = store.get<NotificationDelivery>('notificationDeliveries', row.id)
  const source = sourceNotification(store, actor, row)
  const sourceAccessible = !!source?.targets.some(target => targetAccessible(store, actor, target))
  const pendingSourceTargets = source ? pendingNotificationTargets(store, actor, source) : []
  if (row.kind === 'manual_reminder') targets = pendingSourceTargets
  const canAcknowledge = row.actionable && obligations.some(item => !item.acknowledgedAt)
  const projected = projectNotificationContent(store, actor, row, targets, { canAcknowledge, sourceCanAcknowledge: !!pendingSourceTargets.length, now, manualSource: source })
  if (projected.content && (row.actionable || row.kind === 'manual_reminder')) {
    projected.content.items = projected.content.items.map(item => {
      const obligation = obligations.find(value => targetKey(value.target) === targetKey(item.target))
      const previousOwner = row.contentFacts?.subjects.find(value => targetKey(value.target) === targetKey(item.target))?.ownerId === actor.id
      const superseded = previousOwner || targetOwned(store, actor, item.target)
      const acknowledgement = row.kind === 'manual_reminder' ? 'pending' : obligation ? obligation.acknowledgedAt ? 'acknowledged' : 'pending' : superseded ? 'superseded' : 'not_required'
      return { ...item, acknowledgement }
    })
    if (projected.content.items.length > 1) {
      const count = projected.content.items.filter(item => item.acknowledgement === 'pending').length
      projected.content.intro = [projected.content.intro, `其中仍需本人确认 ${count} 项；已更新或仅协作可见的事项不在本次确认范围内。`].filter(Boolean).join('\n')
      projected.content.items = projected.content.items.map(item => ({ ...item, lines: [`确认状态：${({ pending: '待本人确认', acknowledged: '已确认', superseded: '安排已有更新', not_required: '仅供查看，无需确认' } as const)[item.acknowledgement!]}`, ...item.lines] }))
    }
    projected.body = contentAsText(projected.content)
  }
  const confirmationToken = canAcknowledge ? notificationId(row.id, actor.id, JSON.stringify(obligations.map(item => [item.id, item.version, item.eventKey,
    notificationSubject(store, item.target, actor)]))) : undefined
  // Raw snapshots include historical values. Only the permission-projected text leaves this service.
  const { contentFacts: _privateFacts, sourceNotificationId: _sourceId, ...safe } = row
  return { ...safe, targets, ...projected, ...(redacted ? { title: '工作安排已更新' } : {}),
    ...(row.kind === 'manual_reminder' ? { sourceNotificationId: source?.id, sourceCanAcknowledge: !!pendingSourceTargets.length } : {}), confirmationToken,
    supersededAt: obsolete ? row.supersededAt ?? row.updatedAt : null,
    unavailable: !targets.length && !sourceAccessible, canAcknowledge, deliveryStatus: delivery?.status ?? null }
}
export function getNotification(store: Store, actor: User, id: string): NotificationView {
  const row = store.get<Notification>('notifications', id)
  if (!row) throw new HttpError(404, '消息不存在')
  return notificationView(store, actor, row)
}
export function openNotification(store: Store, actor: User, id: string, acknowledge = false, confirmationToken?: string): NotificationView {
  return store.transaction(() => {
    const view = getNotification(store, actor, id)
    const now = new Date().toISOString()
    if (acknowledge) {
      if (!view.canAcknowledge) throw new HttpError(409, '此消息无需确认或已有新的工作安排，请刷新消息')
      if (confirmationToken !== undefined && confirmationToken !== view.confirmationToken) throw new HttpError(409, '安排内容已更新，请重新查看后确认')
      for (const obligation of currentObligations(store, actor, view)) if (!obligation.acknowledgedAt) store.update<Obligation>('notificationObligations', obligation.id, obligation.version, { acknowledgedAt: now })
    }
    if (!view.openedAt || acknowledge) store.update<Notification>('notifications', id, view.version, { openedAt: view.openedAt ?? now, ...(acknowledge ? { acknowledgedAt: now } : {}) })
    return getNotification(store, actor, id)
  })
}
export function updateNotificationSettings(store: Store, input: Record<string, unknown>, configured: boolean): NotificationSettings {
  return store.transaction(() => {
    const before = getNotificationSettings(store)
    if (input.version !== before.version) throw new HttpError(409, '设置已更新，请刷新')
    if (typeof input.externalEnabled !== 'boolean' || !Array.isArray(input.pilotUserIds) || input.pilotUserIds.length > 100 || input.pilotUserIds.some(id => typeof id !== 'string')) throw new HttpError(400, '请填写有效的启用状态和试点成员')
    const start = input.sendStartHour, end = input.sendEndHour
    if (!Number.isInteger(start) || !Number.isInteger(end) || Number(start) < 0 || Number(end) > 24 || Number(start) >= Number(end)) throw new HttpError(400, '发送时段须在 0–24 时之间且开始早于结束')
    const ids = [...new Set(input.pilotUserIds as string[])]
    for (const id of ids) { const user = store.get<User>('users', id); if (!user || !canUseAccount(user)) throw new HttpError(400, '试点成员必须是可登录账号') }
    if (input.externalEnabled && (!configured || !notificationEnvironmentEnabled() || !ids.length)) throw new HttpError(400, '启用外发需要服务器钉钉配置、HTTPS 地址、外发开关、部署标识和至少一位试点成员')
    const newlyEnabled = input.externalEnabled && (!before.externalEnabled || before.deploymentId !== process.env.DINGTALK_DEPLOYMENT_ID)
    const settings = store.update<NotificationSettings>('notificationSettings', before.id, before.version, {
      externalEnabled: input.externalEnabled, pilotUserIds: ids, sendStartHour: Number(start), sendEndHour: Number(end),
      deploymentId: process.env.DINGTALK_DEPLOYMENT_ID ?? '', enabledAt: newlyEnabled ? new Date().toISOString() : before.enabledAt,
      activationId: newlyEnabled ? randomUUID() : before.activationId,
    })
    for (const delivery of store.list<NotificationDelivery>('notificationDeliveries')) {
      if (['pending', 'failed'].includes(delivery.status) && (!settings.externalEnabled || delivery.activationId !== settings.activationId || !ids.includes(delivery.recipientId))) {
        store.update<NotificationDelivery>('notificationDeliveries', delivery.id, delivery.version, { status: 'skipped', lastError: '外发设置已变更，旧消息不补发' })
      }
    }
    return settings
  })
}
