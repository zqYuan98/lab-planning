import { Router } from 'express'
import { statfsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { DeliveryCursor, DeliveryFilter, NotificationDiagnosticRow, NotificationDiagnostics } from '../shared/notification-diagnostics.ts'
import type { Notification, NotificationDelivery, NotificationSettings } from '../shared/notifications.ts'
import type { User } from '../shared/types.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { requireManager } from './auth.ts'
import type { DingTalkClient } from './dingtalk.ts'
import { currentIdentity, notificationEnvironmentEnabled } from './notifications.ts'
import { currentNotificationMessage } from './notification-worker.ts'
import { runtimeHeartbeat } from './runtime-health.ts'
import { HttpError, type Store } from './store.ts'
import { backupHealth } from './verified-backup.ts'

function nextWindow(now: Date, start: number) {
  const local = new Date(now.getTime() + 8 * 3600000)
  if (local.getUTCHours() >= start) local.setUTCDate(local.getUTCDate() + 1)
  local.setUTCHours(start, 0, 0, 0)
  return new Date(local.getTime() - 8 * 3600000).toISOString()
}
function deliveryReason(store: Store, client: DingTalkClient, row: NotificationDelivery, now: Date): { reason: string; nextAttemptAt: string | null } {
  const iso = now.toISOString(), terminal = { failed: '投递已明确失败，可核查后人工重试', unknown: '发送结果未知，只核查、不自动重发', delivered: '钉钉回执确认已送达', skipped: '安排、权限、绑定或发送范围变化，已取消' }
  if (row.status in terminal) return { reason: terminal[row.status as keyof typeof terminal], nextAttemptAt: null }
  if (row.status === 'sending') return { reason: '已领取，正在等待平台响应', nextAttemptAt: row.leaseUntil }
  if (row.status === 'accepted') return { reason: '平台已受理，等待回执；暂停外发仍继续查询', nextAttemptAt: row.nextAttemptAt }
  const settings = store.get<NotificationSettings>('notificationSettings', 'notifications'), user = store.get<User>('users', row.recipientId), identity = currentIdentity(store, row.recipientId)
  if (!user || !canUseAccount(user)) return { reason: '成员账号不可用，下一轮将取消', nextAttemptAt: null }
  if (!identity || identity.id !== row.identityId || identity.corpId !== client.corpId) return { reason: '成员未绑定或绑定已改变，下一轮将取消', nextAttemptAt: null }
  if (!settings || settings.activationId !== row.activationId || settings.deploymentId !== row.deploymentId || row.deploymentId !== process.env.DINGTALK_DEPLOYMENT_ID || !settings.pilotUserIds.includes(user.id)) return { reason: '发送范围或部署代际已改变，下一轮将取消', nextAttemptAt: null }
  const notification = store.get<Notification>('notifications', row.notificationId)
  if (!notification || !currentNotificationMessage(store, user, notification, now, true)) return { reason: '事项已处理、失效或超出提醒时点，下一轮将取消', nextAttemptAt: null }
  if (!client.configured || !notificationEnvironmentEnabled() || !settings.externalEnabled) return { reason: '外发已暂停，等待显式启用', nextAttemptAt: null }
  const hour = new Date(now.getTime() + 8 * 3600000).getUTCHours()
  if (hour < settings.sendStartHour || hour >= settings.sendEndHour) return { reason: '静默时段，等待下一个发送窗口', nextAttemptAt: nextWindow(now, settings.sendStartHour) }
  if (row.nextAttemptAt > iso) return { reason: row.attempts ? '明确拒收后的退避等待' : '等待计划发送时间', nextAttemptAt: row.nextAttemptAt }
  return { reason: '等待工作进程领取', nextAttemptAt: row.nextAttemptAt }
}
function oldestProcessable(store: Store, client: DingTalkClient, now: Date): string | null {
  let cursor: DeliveryCursor | undefined
  // Read only the pending queue through the index, oldest first, and stop at the
  // first effective item. Old failed/unknown history never enters this scan.
  while (true) {
    const page = store.queryDeliveries({ status: 'pending', dueAt: now.toISOString(), order: 'oldest', cursor, limit: 200 })
    const candidate = page.find(row => deliveryReason(store, client, row, now).reason === '等待工作进程领取')
    if (candidate) return candidate.createdAt
    if (page.length < 200) return null
    const last = page.at(-1)!
    cursor = { createdAt: last.createdAt, id: last.id }
  }
}
export function notificationDiagnostics(store: Store, client: DingTalkClient, filter: DeliveryFilter = {}, now = new Date()): NotificationDiagnostics {
  const limit = filter.limit ?? 50
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, '每页记录数须为 1—100')
  const rows = store.queryDeliveries({ ...filter, limit: limit + 1 }), counts = store.deliveryCounts(filter)
  const items: NotificationDiagnosticRow[] = rows.slice(0, limit).map(row => ({ id: row.id, notificationId: row.notificationId, recipientId: row.recipientId,
    recipientName: store.get<User>('users', row.recipientId)?.name ?? '成员已删除', kind: store.get<Notification>('notifications', row.notificationId)?.kind ?? 'unavailable',
    status: row.status, createdAt: row.createdAt, acceptedAt: row.acceptedAt, attempts: row.attempts, ...deliveryReason(store, client, row, now) }))
  const worker = runtimeHeartbeat(store, 'worker'), scheduler = runtimeHeartbeat(store, 'scheduler')
  const members = store.list<User>('users').filter(canUseAccount), backup = backupHealth()
  let diskUsedPercent: number | null = null
  try { const disk = statfsSync(dirname(resolve(process.env.DATABASE_PATH || 'data/lab-planning.sqlite'))); if (disk.blocks > 0) diskUsedPercent = Math.round((1 - disk.bavail / disk.blocks) * 100) } catch { /* Missing/unavailable storage is reported without a path. */ }
  const oldestAcceptedAt = store.deliveryOldest('accepted')
  const oldestPendingAt = oldestProcessable(store, client, now)
  const callbackBacklog = store.operationalCounts('nativeCallbackInbox').pending ?? 0
  const alerts: string[] = []
  for (const [name, pulse] of [['通知工作进程', worker], ['周期调度', scheduler]] as const) {
    if (!pulse.startedAt) alerts.push(`${name}尚无运行记录`)
    else if (now.getTime() - Date.parse(pulse.completedAt ?? pulse.startedAt) > 120000) alerts.push(`${name}超过 2 分钟未完成`)
    if (pulse.failedAt && (!pulse.completedAt || pulse.failedAt > pulse.completedAt)) alerts.push(`${name}最近一轮异常`)
  }
  if (oldestPendingAt && now.getTime() - Date.parse(oldestPendingAt) > 600000) alerts.push('有效待发记录已等待超过 10 分钟')
  if (oldestAcceptedAt && now.getTime() - Date.parse(oldestAcceptedAt) > 900000) alerts.push('平台受理记录超过 15 分钟尚无最终回执')
  if (!backup.verifiedAt || now.getTime() - Date.parse(backup.verifiedAt) > 26 * 3600000) alerts.push('最近 26 小时没有可验证备份记录')
  if (!backup.offsiteVerifiedAt) alerts.push('异机加密副本尚待配置或验证')
  if (diskUsedPercent !== null && diskUsedPercent > 80) alerts.push('数据盘使用率超过 80%')
  if (callbackBacklog > 0) alerts.push(`原生回调有 ${callbackBacklog} 条待处理`)
  const last = items.at(-1)
  return { items, nextCursor: rows.length > limit && last ? { createdAt: last.createdAt, id: last.id } : null,
    counts, total: Object.values(counts).reduce((sum, value) => sum + (value ?? 0), 0),
    health: { worker, scheduler, oldestPendingAt, oldestAcceptedAt, bindings: { usableMembers: members.length, boundMembers: members.filter(user => !!currentIdentity(store, user.id)).length }, diskUsedPercent, backup, callbackBacklog, nativeOperations: store.operationalCounts('nativeOperations'), ruleOccurrences: store.operationalCounts('reminderOccurrences'), alerts } }
}
/** Mount after requireAuth. Every diagnostic response is manager-only and contains no payloads/provider errors. */
export function notificationDiagnosticsRouter(store: Store, client: DingTalkClient) {
  const router = Router()
  router.get('/notification-diagnostics', requireManager, (req, res) => {
    const allowed = new Set(['status', 'recipientId', 'kind', 'from', 'to', 'cursorCreatedAt', 'cursorId', 'limit'])
    for (const [key, value] of Object.entries(req.query)) if (!allowed.has(key) || typeof value !== 'string') throw new HttpError(400, '诊断查询条件无效')
    const query = req.query as Record<string, string | undefined>
    if (!!query.cursorCreatedAt !== !!query.cursorId) throw new HttpError(400, '分页游标不完整')
    res.json(notificationDiagnostics(store, client, { status: query.status as DeliveryFilter['status'], recipientId: query.recipientId, kind: query.kind, from: query.from, to: query.to,
      limit: query.limit === undefined ? undefined : Number(query.limit), cursor: query.cursorId ? { id: query.cursorId, createdAt: query.cursorCreatedAt! } : undefined }))
  })
  return router
}
