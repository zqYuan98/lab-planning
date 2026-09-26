import { Router } from 'express'
import type { Entity, User } from '../shared/types.ts'
import type { Notification, NotificationDelivery, NotificationPreview, NotificationSettings, NotificationSettingsView } from '../shared/notifications.ts'
import { requireManager } from './authorization.ts'
import type { DingTalkClient } from './dingtalk.ts'
import { currentIdentity, enqueueNotification, getNotification, getNotificationSettings, notificationEnvironmentEnabled, notificationId, notificationView, openNotification, updateNotificationSettings } from './notifications.ts'
import { HttpError, Store } from './store.ts'
import { pendingNotificationTargets } from './notifications.ts'
import { currentNotificationMessage } from './notification-worker.ts'
import { notificationPresentation } from './notification-presentation.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { readCollaborationSettings } from './collaboration-policy.ts'
import { notificationPage } from './notification-pagination.ts'

function reminderInput(store: Store, source: Notification, recipient: User, actor: User, now: Date) {
  const targets = pendingNotificationTargets(store, recipient, source)
  const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
  return { eventKey: `manual:${day}:${source.id}`, recipientId: recipient.id, kind: 'manual_reminder', title: '请确认工作安排',
    body: '请查看具体安排并确认知悉。', targets, actionable: false, sourceNotificationId: source.id, actorId: actor.id }
}

export function notificationRouter(store: Store, client: DingTalkClient) {
  const router = Router()
  router.get('/notifications', (req, res) => {
    res.json(notificationPage(store, req.user, req.query))
  })
  router.post('/notifications/open-all', (req, res) => {
    store.transaction(() => { for (const row of store.list<Notification>('notifications').filter(row => row.recipientId === req.user.id && !row.openedAt)) openNotification(store, req.user, row.id) })
    res.json({ ok: true })
  })
  router.get('/notifications/:id', (req, res) => res.json(getNotification(store, req.user, String(req.params.id))))
  router.post('/notifications/:id/open', (req, res) => res.json(openNotification(store, req.user, String(req.params.id))))
  router.post('/notifications/:id/acknowledge', (req, res) => {
    if (typeof req.body.confirmationToken !== 'string' || !req.body.confirmationToken) throw new HttpError(409, '请重新查看当前安排后确认')
    res.json(openNotification(store, req.user, String(req.params.id), true, req.body.confirmationToken))
  })
  router.get('/notifications/:id/preview', requireManager, (req, res) => {
    const source = store.get<Notification>('notifications', String(req.params.id)), now = new Date()
    const recipient = source ? store.get<User>('users', source.recipientId) : undefined
    if (!source || !recipient) throw new HttpError(404, '消息不存在')
    if (req.query.mode !== undefined && req.query.mode !== 'reminder') throw new HttpError(400, '预览类型无效')
    const input = req.query.mode === 'reminder' ? reminderInput(store, source, recipient, req.user, now) : undefined
    const row: Notification = input ? { ...input, id: notificationId(input.eventKey, recipient.id), version: 1, contentSchemaVersion: 1,
      createdAt: now.toISOString(), updatedAt: now.toISOString(), eventTime: now.toISOString(), openedAt: null, acknowledgedAt: null, supersededAt: null } : source
    const current = canUseAccount(recipient) ? currentNotificationMessage(store, recipient, row, now, true) : undefined
    const view = current ?? notificationView(store, recipient, row, now)
    const { prepared } = notificationPresentation(view)
    const settings = store.get<NotificationSettings>('notificationSettings', 'notifications')
    const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
    const quotaUsed = !!input && input.targets.some(target => store.get('notificationReminderQuotas', notificationId(day, recipient.id, target.type, target.id)))
    const eligible = !!current && !quotaUsed
    const reason = !current ? '当前安排已处理、已变更、超出提醒时点或成员不可用，不会按此内容外发。'
      : quotaUsed ? '同一事项今天已提醒，不再重复发送。'
        : !settings?.externalEnabled || !notificationEnvironmentEnabled() || !client.configured ? '当前外发暂停；业务提醒仍可记录为站内消息。'
          : !settings.pilotUserIds.includes(recipient.id) || !currentIdentity(store, recipient.id) ? '成员不在外发范围或尚未绑定，当前仅记录站内消息。'
            : '发送前会再次核对当前安排、接收权限与发送时段。'
    const preview: NotificationPreview = { recipientId: recipient.id, recipientName: recipient.name, title: prepared.title, body: prepared.body,
      buttonText: prepared.buttonText, url: prepared.url, truncated: prepared.truncated, eligible, reason,
      sendWindow: `${String(settings?.sendStartHour ?? 8).padStart(2, '0')}:00—${String(settings?.sendEndHour ?? 20).padStart(2, '0')}:00（北京时间）；时段外等待下一发送窗口`, renderedAt: now.toISOString() }
    res.json(preview)
  })
  router.post('/notifications/:id/remind', requireManager, (req, res) => {
    store.transaction(() => {
      const row = store.get<Notification>('notifications', String(req.params.id)), now = new Date()
      const recipient = row ? store.get<User>('users', row.recipientId) : undefined
      if (!row || !recipient) throw new HttpError(404, '消息不存在')
      const input = reminderInput(store, row, recipient, req.user, now)
      if (!input.targets.length || !row.actionable || !canUseAccount(recipient)) throw new HttpError(409, '该安排无需再次确认，请刷新状态')
      const day = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
      for (const target of input.targets) {
        const key = notificationId(day, recipient.id, target.type, target.id)
        if (store.get('notificationReminderQuotas', key)) throw new HttpError(429, '同一事项每天只能手动提醒一次')
        store.insert<Entity & { actorId: string; recipientId: string; notificationId: string }>('notificationReminderQuotas', { id: key, actorId: req.user.id, recipientId: recipient.id, notificationId: row.id })
      }
      enqueueNotification(store, input, now)
    })
    res.json({ ok: true })
  })
  router.get('/notification-status', requireManager, (req, res) => {
    const type = String(req.query.type ?? ''), id = String(req.query.id ?? '')
    if (!['plan', 'task', 'weeklyRecord'].includes(type) || !id) throw new HttpError(400, '请指定有效工作事项')
    const items = store.list<Notification>('notifications').filter(row => row.targets.some(target => target.type === type && target.id === id)).reverse().slice(0, 100)
      .flatMap(row => { const user = store.get<User>('users', row.recipientId); return user ? [notificationView(store, user, row)] : [] })
    res.json({ items })
  })
  const settingsView = (): NotificationSettingsView => ({
    settings: getNotificationSettings(store), configured: client.configured, environmentEnabled: notificationEnvironmentEnabled(),
    activationRequired: getNotificationSettings(store).externalEnabled && getNotificationSettings(store).deploymentId !== process.env.DINGTALK_DEPLOYMENT_ID,
    bindings: store.list<User>('users').map(user => ({ userId: user.id, bound: !!currentIdentity(store, user.id) })),
    deliveries: store.list<NotificationDelivery>('notificationDeliveries').slice(-200).reverse().map(row => {
      const notification = store.get<Notification>('notifications', row.notificationId), user = store.get<User>('users', row.recipientId)
      const view = notification && user ? notificationView(store, user, notification) : undefined
      return { ...row, title: view?.title ?? '工作消息', openedAt: view?.openedAt ?? null, acknowledgedAt: view?.acknowledgedAt ?? null, canAcknowledge: view?.canAcknowledge ?? false, targets: view?.targets ?? [] }
    }),
  })
  router.get('/notification-settings', requireManager, (_req, res) => res.json(settingsView()))
  router.put('/notification-settings', requireManager, (req, res) => {
    store.transaction(() => {
      const before = getNotificationSettings(store), after = updateNotificationSettings(store, req.body, client.configured)
      const collaboration = readCollaborationSettings(store)
      const allows = (hour: number) => after.sendStartHour <= hour && hour < after.sendEndHour
      if (collaboration.enabled && collaboration.autoRulesEnabled && !allows(9) && !allows(17)) throw new HttpError(400, '自动提醒需要允许 09:00 或 17:00，请先调整协作规则')
      if (collaboration.enabled && (collaboration.dailyManagerEnabled || collaboration.weeklyManagerEnabled || collaboration.memberActionsEnabled) && !allows(17.5)) throw new HttpError(400, '摘要需要允许 17:30，请先调整协作规则')
      store.insert<Entity & { actorId: string; action: string; before: unknown; after: unknown }>('notificationAdminEvents', { actorId: req.user.id, action: 'settings', before, after })
    })
    res.json(settingsView())
  })
  router.post('/notification-deliveries/:id/retry', requireManager, (req, res) => {
    store.transaction(() => {
      const row = store.get<NotificationDelivery>('notificationDeliveries', String(req.params.id))
      if (!row) throw new HttpError(404, '投递记录不存在')
      if (row.status !== 'failed') throw new HttpError(409, '只有钉钉明确失败的消息可重试，结果未知的消息请先核查')
      const settings = getNotificationSettings(store)
      if (!client.configured || !notificationEnvironmentEnabled() || !settings.externalEnabled || settings.activationId !== row.activationId || settings.deploymentId !== row.deploymentId || settings.deploymentId !== process.env.DINGTALK_DEPLOYMENT_ID || !settings.pilotUserIds.includes(row.recipientId) || currentIdentity(store, row.recipientId)?.id !== row.identityId) throw new HttpError(409, '外发配置或绑定已变化，请通过新的业务操作产生消息')
      store.update<NotificationDelivery>('notificationDeliveries', row.id, row.version, { status: 'pending', attempts: 0, providerTaskId: null, acceptedAt: null, leaseUntil: null, nextAttemptAt: new Date().toISOString(), lastError: '' })
      store.insert<Entity & { actorId: string; action: string; deliveryId: string }>('notificationAdminEvents', { actorId: req.user.id, action: 'retry', deliveryId: row.id })
    })
    res.json({ ok: true })
  })
  return router
}
