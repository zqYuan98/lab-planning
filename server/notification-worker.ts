import type { Notification, NotificationDelivery, NotificationDeliveryContent, NotificationView } from '../shared/notifications.ts'
import type { MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { createDingTalkClient, DingTalkError, type DingTalkClient } from './dingtalk.ts'
import { currentIdentity, getNotificationSettings, notificationEnvironmentEnabled, notificationView } from './notifications.ts'
import { currentReminderSlot } from './notification-reminders.ts'
import { Store } from './store.ts'
import { WeeklySubmissionService } from './weekly-submissions.ts'
import { projectNotificationContent } from './notification-content.ts'
import { notificationPresentation } from './notification-presentation.ts'
import { beginRuntimeRun } from './runtime-health.ts'
import { collaborationNotificationCurrent, projectCollaborationContent } from './collaboration-content.ts'
import { routeNativeNotification } from './native-service.ts'

const RETRY_MINUTES = [1, 5, 15, 60]
const running = new WeakSet<Store>()
function update(store: Store, id: string, patch: Partial<NotificationDelivery>, expectedLease?: string) {
  return store.transaction(() => {
    const current = store.get<NotificationDelivery>('notificationDeliveries', id)
    if (!current || expectedLease && current.leaseUntil !== expectedLease) return
    return store.update<NotificationDelivery>('notificationDeliveries', id, current.version, patch)
  })
}
export function currentNotificationMessage(store: Store, actor: User, row: Notification, now: Date, readOnly = false): NotificationView | undefined {
  if (row.kind.startsWith('feedback_') || row.targets.some(target => target.type === 'feedback')) return undefined
  const view = notificationView(store, actor, row, now)
  if (!collaborationNotificationCurrent(store, actor, row, now)) return undefined
  if (view.kind !== 'weekly_reminder' && now.getTime() - Date.parse(view.createdAt) > 7 * 86400000) return undefined
  if (view.kind === 'participation_removed') return view
  if (view.unavailable || view.acknowledgedAt || view.supersededAt) return undefined
  if (view.kind === 'manual_reminder') {
    if (!view.sourceCanAcknowledge || !view.sourceNotificationId) return undefined
  }
  if (view.kind === 'weekly_summary') {
    const week = view.targets[0]?.cycleWeek
    if (!week || currentReminderSlot(now, week) !== '16:05') return undefined
  }
  if (view.kind !== 'weekly_reminder') {
    for (const target of view.targets) {
      if (target.type === 'plan') {
        const plan = store.get<MonthlyPlan>('plans', target.id)
        if (!plan) return undefined
        if (['monthly_published', 'plan_changed', 'manual_reminder'].includes(view.kind) && plan.status !== 'published') return undefined
        if (view.kind === 'proposal_review' && plan.status !== 'submitted') return undefined
        if (view.kind === 'proposal_result') {
          const approved = view.title === '临时目标审核通过'
          const returned = view.title === '临时目标已退回'
          if (!approved && !returned || approved && !['approved', 'published'].includes(plan.status) || returned && plan.status !== 'returned') return undefined
        }
      }
      if (target.type === 'task' || target.type === 'weeklyRecord') {
        const work = store.get<Task | WeeklyRecord>(target.type === 'task' ? 'tasks' : 'weeklyRecords', target.id)
        if (!work || target.type === 'weeklyRecord' && !isEffectiveWeeklyRecord(work as WeeklyRecord) || work.monthlyPlanId && store.get<MonthlyPlan>('plans', work.monthlyPlanId)?.status !== 'published') return undefined
      }
    }
    return row.kind.startsWith('collaboration_') ? { ...view, ...projectCollaborationContent(store, actor, row, view.targets, now) } : view
  }
  const cycle = view.targets[0]?.cycleWeek
  if (!cycle) return undefined
  const hour = new Date(now.getTime() + 8 * 3600000).getUTCHours()
  if (view.eventKey.includes(':09:00:') && hour >= 15) return undefined
  const service = new WeeklySubmissionService(store, () => now)
  const formal = readOnly ? service.preview(actor, cycle) : service.view(actor, cycle)
  if (!formal || !formal.rule.enabled || formal.cycle?.needsReview || now.toISOString() >= formal.deadlineAt) return undefined
  const due = formal.duties.filter(duty => view.targets.some(target => target.id === duty.id) && duty.status !== 'exempt' && (!duty.latestSubmission || duty.changedSinceSubmission))
  if (!due.length) return undefined
  const time = new Date(now.getTime() + 8 * 3600000).toISOString().slice(11, 16)
  const targets = view.targets.filter(target => due.some(duty => duty.id === target.id))
  const current = { ...row, body: `截至今日 ${time}，${due.map(duty => `${duty.kind === 'results' ? '本周完成情况' : '下周计划'}${duty.latestSubmission ? '有修改待重新提报' : '尚未正式提报'}`).join('；')}。请在今日 16:00 前核对并提交。` }
  return { ...view, targets, ...projectNotificationContent(store, actor, current, targets, { canAcknowledge: false, now }) }
}

/** A lease is persisted before network I/O. An abandoned send without a receipt is uncertain, never retried automatically. */
export async function runNotificationWorker(store: Store, client: DingTalkClient = createDingTalkClient(), time: Date | (() => Date) = () => new Date(), shouldStop: () => boolean = () => false): Promise<void> {
  if (running.has(store)) return
  running.add(store)
  const clock = typeof time === 'function' ? time : () => time
  const finishHeartbeat = beginRuntimeRun(store, 'worker', clock())
  let success = true
  try {
    const now = clock()
    const iso = now.toISOString()
    for (const abandoned of store.queryDeliveries({ status: 'sending', leaseExpiredAt: iso, limit: 200 })) {
      update(store, abandoned.id, { status: abandoned.providerTaskId ? 'accepted' : 'unknown', leaseUntil: null, lastError: '发送中断，结果待核查；未自动重发' }, abandoned.leaseUntil!)
    }
    if (!client.configured) return
    const settings = getNotificationSettings(store)
    // Poll known provider receipts even during quiet hours or after external send is disabled.
    const receipts = store.queryDeliveries({ status: 'accepted', dueAt: iso, leaseExpiredAt: iso, order: 'due', limit: 20 })
    for (const candidate of receipts) {
      if (shouldStop()) break
      const now = clock(), iso = now.toISOString()
      const identity = currentIdentity(store, candidate.recipientId)
      if (!identity || identity.corpId !== client.corpId || identity.id !== candidate.identityId || !candidate.providerTaskId || candidate.deploymentId !== process.env.DINGTALK_DEPLOYMENT_ID || Date.parse(candidate.acceptedAt ?? '') + 24 * 3600000 <= now.getTime()) {
        update(store, candidate.id, { status: 'unknown', leaseUntil: null, lastError: '回执无法继续核对，结果未知；未自动重发' })
        continue
      }
      const lease = new Date(now.getTime() + 60000).toISOString()
      const claimed = store.transaction(() => {
        const row = store.get<NotificationDelivery>('notificationDeliveries', candidate.id)!
        if (row.status !== 'accepted' || row.leaseUntil && row.leaseUntil > iso) return undefined
        return store.update<NotificationDelivery>('notificationDeliveries', row.id, row.version, { leaseUntil: lease })
      })
      if (!claimed) continue
      try {
        const result = await client.result(claimed.providerTaskId!, identity.userid)
        update(store, claimed.id, { status: result === 'pending' ? 'accepted' : result, leaseUntil: null, nextAttemptAt: new Date(now.getTime() + 60000).toISOString(), lastError: result === 'failed' ? '钉钉回执确认发送失败，可核查配置后重试' : '' }, lease)
      } catch {
        update(store, claimed.id, { leaseUntil: null, nextAttemptAt: new Date(now.getTime() + 5 * 60000).toISOString(), lastError: '暂时未取得钉钉回执，将继续查询' }, lease)
      }
    }
    const localHour = new Date(now.getTime() + 8 * 3600000).getUTCHours()
    if (!notificationEnvironmentEnabled() || !settings.externalEnabled || settings.deploymentId !== process.env.DINGTALK_DEPLOYMENT_ID || localHour < settings.sendStartHour || localHour >= settings.sendEndHour) return
    const candidates = store.queryDeliveries({ status: 'pending', dueAt: iso, order: 'due', limit: 20 })
    for (const candidate of candidates) {
      if (shouldStop()) break
      const now = clock(), iso = now.toISOString(), localHour = new Date(now.getTime() + 8 * 3600000).getUTCHours()
      const claimed = store.transaction(() => {
        const row = store.get<NotificationDelivery>('notificationDeliveries', candidate.id)!
        if (row.status !== 'pending' || row.nextAttemptAt > iso) return undefined
        const fresh = getNotificationSettings(store), actor = store.get<User>('users', row.recipientId), identity = currentIdentity(store, row.recipientId)
        // Settings can change while the preceding send awaits the provider.
        // A changed quiet period defers remaining messages instead of discarding them.
        if (localHour < fresh.sendStartHour || localHour >= fresh.sendEndHour) return undefined
        const eligible = notificationEnvironmentEnabled() && fresh.externalEnabled && fresh.activationId === row.activationId && fresh.deploymentId === row.deploymentId && row.deploymentId === process.env.DINGTALK_DEPLOYMENT_ID && fresh.pilotUserIds.includes(row.recipientId)
          && actor && canUseAccount(actor) && identity?.id === row.identityId && identity.corpId === client.corpId
        const notification = store.get<Notification>('notifications', row.notificationId)
        const view = eligible && actor && notification ? currentNotificationMessage(store, actor, notification, now) : undefined
        if (!view || !identity || !actor) { update(store, row.id, { status: 'skipped', lastError: '成员、绑定或工作安排已变更或超过 7 天，停止外发' }); return undefined }
        if (routeNativeNotification(store, notification!.id, now)) return undefined
        let presentation: ReturnType<typeof notificationPresentation>
        try { presentation = notificationPresentation(view) }
        catch (error) {
          if (!(error instanceof DingTalkError)) throw error
          update(store, row.id, { status: 'failed', lastError: '通知内容或事项入口不符合发送要求，请检查内容预览' })
          return undefined
        }
        const lease = new Date(now.getTime() + 60000).toISOString()
        const delivery = store.update<NotificationDelivery>('notificationDeliveries', row.id, row.version, { status: 'sending', attempts: row.attempts + 1, leaseUntil: lease })
        const { prepared } = presentation
        store.insert<NotificationDeliveryContent>('notificationDeliveryContents', { deliveryId: delivery.id, notificationId: view.id, recipientId: actor.id,
          attempt: delivery.attempts, renderedAt: now.toISOString(), templateVersion: 1, title: prepared.title, body: prepared.body,
          buttonText: prepared.buttonText, url: prepared.url, payloadHash: prepared.payloadHash, payload: prepared.payload, confirmationToken: view.confirmationToken })
        return { delivery, identity, message: presentation.message }
      })
      if (!claimed) continue
      const { delivery, identity, message } = claimed
      try {
        const receipt = await client.send(identity.userid, message)
        const accepted = clock()
        update(store, delivery.id, { status: 'accepted', providerTaskId: receipt.taskId, acceptedAt: accepted.toISOString(), leaseUntil: null, nextAttemptAt: new Date(accepted.getTime() + 30000).toISOString(), lastError: '' }, delivery.leaseUntil!)
      } catch (error) {
        const definitive = error instanceof DingTalkError && error.outcome === 'definitive'
        const retry = definitive && error.retryable && delivery.attempts < 5
        const providerError = error instanceof DingTalkError ? /^钉钉接口拒绝请求（(\d+)）$/.exec(error.message) : null
        // Preserve only an adapter-generated numeric code, never provider text or URLs.
        const errorCode = error instanceof DingTalkError && providerError && providerError[0] === error.message ? providerError[1] : undefined
        const lastError = !definitive ? '发送结果未知，为避免重复通知未自动重发' : retry ? '钉钉明确拒收，将稍后重试' : '钉钉明确拒收，请检查应用配置、成员范围和消息内容'
        update(store, delivery.id, { status: !definitive ? 'unknown' : retry ? 'pending' : 'failed', leaseUntil: null,
          nextAttemptAt: new Date(now.getTime() + (RETRY_MINUTES[delivery.attempts - 1] ?? 60) * 60000).toISOString(),
          lastError: errorCode ? `${lastError}（错误码：${errorCode}）` : lastError,
        }, delivery.leaseUntil!)
      }
    }
  } catch (error) { success = false; throw error }
  finally { running.delete(store); finishHeartbeat(success, clock()) }
}
export function startNotificationWorker(store: Store, client = createDingTalkClient()): () => Promise<void> {
  let stopped = false, active: Promise<void> | undefined
  const tick = () => {
    if (stopped || active) return
    active = runNotificationWorker(store, client, () => new Date(), () => stopped).catch(error => { console.error('消息投递处理失败：', error instanceof Error ? error.name : '未知错误') }).finally(() => { active = undefined })
  }
  const interval = setInterval(tick, 15000)
  interval.unref()
  tick()
  return async () => { stopped = true; clearInterval(interval); await active }
}
