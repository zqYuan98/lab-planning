import { createHash } from 'node:crypto'
import type { Entity, MonthlyPlan, Task, User } from '../shared/types.ts'
import type { FollowupRequest, BlockerEpisode, ProgressEvent } from '../shared/collaboration.ts'
import type { Notification, NotificationDelivery } from '../shared/notifications.ts'
import type { ExternalObjectLink, NativeActionRef, NativeDesiredState, NativeChannel, ChannelOperation, NativeOperationKind } from '../shared/native-actions.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { appOrigin } from './auth.ts'
import { Store, HttpError } from './store.ts'
import { getNotification, pendingNotificationTargets, sourceNotification } from './notifications.ts'
import { notificationText } from './notification-content.ts'
import { createDingTalkNativeClient, type DingTalkNativeClient } from './dingtalk-native.ts'
import { getNativeSettings, nativeCapabilityState, nativeManager, verifiedNativeIdentity } from './native-settings.ts'
import { projectWeeklyDuty } from './weekly-duty-view.ts'
import type { WeeklyDuty } from '../shared/weekly-submissions.ts'
import type { NotificationDigest } from '../shared/collaboration-notifications.ts'
import { visibleDigestItems } from './collaboration-content.ts'
import { isManager, isObserver } from './authorization.ts'

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]))
  return value
}
export const nativeHash = (value: unknown) => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')
export function nativeClip(value: string, bytes: number) { let result = ''; for (const char of notificationText(value)) { if (Buffer.byteLength(result + char) > bytes - 3) return `${result}…`; result += char } return result }
export function nativeUrl(notificationId: string) { const origin = appOrigin(); if (!origin || origin.protocol !== 'https:') throw new HttpError(409, '原生渠道需要HTTPS入口'); const url = new URL('/entry', origin); url.searchParams.set('notificationId', notificationId); return url.href }
export function nativeDesired(store: Store, recipientId: string, action: NativeActionRef): NativeDesiredState | undefined {
  const actor = store.get<User>('users', recipientId)
  if (!actor || !canUseAccount(actor) || isObserver(actor)) return
  let title = '', summary = '', done = false, dueTime: number | undefined, state: unknown
  const note = store.get<Notification>('notifications', action.notificationId)
  if (!note || note.recipientId !== actor.id) return
  const view = getNotification(store, actor, note.id)
  if (view.unavailable) return
  if (action.kind === 'acknowledge') {
    title = `确认收到：${view.content?.items[0]?.title ?? view.title}`
    summary = view.body; done = !view.canAcknowledge; state = view.confirmationToken ?? view.acknowledgedAt ?? view.supersededAt
  } else if (action.kind === 'followup') {
    const request = store.get<FollowupRequest>('followupRequests', action.id), task = request && store.get<Task>('tasks', request.taskId)
    if (!request || request.ownerId !== actor.id || !task || task.cancellation || task.ownerId !== actor.id) return
    title = `回应催办：${task.title}`; summary = request.requirement; done = request.status !== 'open'; dueTime = Date.parse(request.dueAt); state = [request.version, task.version]
  } else if (action.kind === 'progress') {
    const task = action.taskId && store.get<Task>('tasks', action.taskId)
    if (!task || task.cancellation || task.ownerId !== actor.id) return
    const progress = store.list<ProgressEvent>('progressEvents').filter(row => row.taskId === task.id && row.ownerId === actor.id && row.meaningfulOwnerProgress && row.occurredAt >= note.createdAt).at(-1)
    title = `更新进展：${task.title}`; summary = view.body; done = !!progress; state = [task.version, progress?.id]
  } else if (action.kind === 'review' || action.kind === 'acceptance') {
    const plan = store.get<MonthlyPlan>('plans', action.id)
    if (!plan || !isManager(actor)) return
    title = `${action.kind === 'review' ? '审核目标' : '验收成果'}：${plan.title}`; summary = plan.expectedOutcome
    done = action.kind === 'review' ? plan.status !== 'submitted' : plan.acceptanceStatus !== 'submitted'; state = plan.version
  } else if (action.kind === 'weekly') {
    const duty = store.get<WeeklyDuty>('weeklyDuties', action.id)
    if (!duty || duty.ownerId !== actor.id) return
    const projected = projectWeeklyDuty(duty, { submissions: store.list('weeklySubmissions'), adjustments: store.list('weeklyAdjustments'), records: store.list('weeklyRecords'), missing: store.list('weeklyMissing'), progressEvents: store.list('progressEvents') }, new Date())
    title = `正式提交：${duty.kind === 'results' ? '本周完成情况' : '下周计划'} ${duty.contentWeek}`
    summary = '进入平台核对完整条目后正式提报。'; done = projected.status === 'exempt' || !!projected.latestSubmission && !projected.changedSinceSubmission; dueTime = Date.parse(duty.deadlineAt); state = [duty.version, projected.latestSubmission?.id, projected.changedSinceSubmission]
  } else if (action.kind === 'blocker') {
    const blocker = store.get<BlockerEpisode>('blockerEpisodes', action.id), task = blocker && store.get<Task>('tasks', blocker.parentTaskId)
    if (!blocker || !task || task.cancellation || !isManager(actor)) return
    title = `核对支持请求：${task.title}`; summary = [blocker.reason, blocker.supportNeeded].filter(Boolean).join('；'); done = !!blocker.resolvedAt || !!blocker.managementClosedAt; state = blocker.version
  } else {
    title = view.content?.items[0]?.title ?? view.title; summary = view.body; done = !!view.acknowledgedAt || !!view.supersededAt; state = [view.version, view.confirmationToken]
  }
  const result = { title: nativeClip(title, 180), summary: nativeClip(summary, 900), url: nativeUrl(action.notificationId), done, ...(dueTime !== undefined && Number.isFinite(dueTime) ? { dueTime } : {}) }
  return { ...result, revision: nativeHash([action.kind, action.id, state, result]) }
}
function inferredAction(store: Store, note: Notification): NativeActionRef | undefined {
  const actor = store.get<User>('users', note.recipientId); if (!actor) return
  if (note.kind === 'manual_reminder') {
    const source = sourceNotification(store, actor, note)
    return source?.actionable ? { kind: 'acknowledge', id: source.id, notificationId: note.id } : undefined
  }
  let targets = note.targets
  if (targets.length === 1 && targets[0].type === 'digest') {
    const digest = store.get<NotificationDigest>('notificationDigests', targets[0].id)
    if (!digest || digest.recipientId !== actor.id || digest.itemIds.length !== 1) return
    const items = visibleDigestItems(store, actor, digest)
    if (items.length !== 1) return
    targets = [items[0].target]
  }
  // Multiple obligations remain an H5 digest; one action must never complete a whole digest.
  if (targets.length !== 1) return
  const target = targets[0]
  if (note.actionable && pendingNotificationTargets(store, actor, note).length) return { kind: 'acknowledge', id: note.id, notificationId: note.id }
  if (target.type === 'followup') return { kind: 'followup', id: target.id, notificationId: note.id }
  if (target.type === 'weeklySubmission') return { kind: 'weekly', id: target.id, notificationId: note.id }
  if (target.type === 'task' && note.kind === 'collaboration_risk_member') return { kind: 'progress', id: note.id, taskId: target.id, notificationId: note.id }
  if (target.type === 'plan' && isManager(actor)) {
    const plan = store.get<MonthlyPlan>('plans', target.id)
    if (plan?.status === 'submitted') return { kind: 'review', id: target.id, notificationId: note.id }
    if (plan?.acceptanceStatus === 'submitted') return { kind: 'acceptance', id: target.id, notificationId: note.id }
  }
}
export function enqueueNativeOperation(store: Store, link: ExternalObjectLink, kind: NativeOperationKind, now = new Date(), reconcileKey = '') {
  const uniqueKey = nativeHash([link.id, kind, link.desired.revision, link.generation, link.bindingId, link.bindingVersion, link.deploymentId, reconcileKey])
  const previous = store.get<ChannelOperation>('nativeOperations', uniqueKey)
  if (previous) return previous
  return store.insert<ChannelOperation>('nativeOperations', { id: uniqueKey, uniqueKey, linkId: link.id, kind, desiredRevision: link.desired.revision, deploymentId: link.deploymentId, activationId: link.activationId, recipientId: link.recipientId, status: 'pending', attempts: 0, nextAttemptAt: now.toISOString(), leaseUntil: null, lastError: '' })
}
/** Called before the old worker claims a new delivery. True means only this channel owns it. */
export function routeNativeNotification(store: Store, notificationId: string, now = new Date(), explicitAction?: NativeActionRef, client: DingTalkNativeClient = createDingTalkNativeClient()): boolean {
  try { return store.transaction(() => {
    const settings = getNativeSettings(store), channel = settings.primaryChannel
    const note = store.get<Notification>('notifications', notificationId), delivery = store.get<NotificationDelivery>('notificationDeliveries', notificationId)
    if (!note || !delivery || delivery.status !== 'pending') return false
    const action = explicitAction ?? inferredAction(store, note)
    if (!action || action.notificationId !== note.id) return false
    const sameObligation = store.list<ExternalObjectLink>('nativeLinks').filter(row => row.recipientId === note.recipientId && row.action.kind === action.kind && row.action.id === action.id)
    const unresolved = sameObligation.some(link => link.state === 'unknown' || store.list<ChannelOperation>('nativeOperations').some(operation => operation.linkId === link.id && ['sending', 'unknown'].includes(operation.status)))
    if (unresolved) {
      store.update<NotificationDelivery>('notificationDeliveries', delivery.id, delivery.version, { status: 'skipped', lastError: '同一义务已有未确认的原生请求，禁止切换渠道重复发送' }); return true
    }
    if (note.kind === 'manual_reminder') {
      // A reminder references the original acknowledgement; it must not create a new native obligation.
      const owns = sameObligation.some(link => !['failed', 'isolated', 'external_missing'].includes(link.state) && linkEligible(store, link, client))
      if (owns) store.update<NotificationDelivery>('notificationDeliveries', delivery.id, delivery.version, { status: 'skipped', lastError: '原安排已交由原生渠道处理，提醒不创建重复义务' })
      return owns
    }
    if (delivery.attempts !== 0) return false
    if (channel === 'work_notification' || !settings.enabledAt || note.createdAt < settings.enabledAt || settings.deploymentId !== process.env.DINGTALK_DEPLOYMENT_ID || !settings.pilotUserIds.includes(note.recipientId) || !nativeCapabilityState(store, client)[channel].enabled) return false
    const identity = verifiedNativeIdentity(store, note.recipientId, client)
    if (!identity) return false
    const desired = nativeDesired(store, note.recipientId, action); if (!desired || desired.done) return false
    const previous = store.list<ExternalObjectLink>('nativeLinks').filter(row => row.channel === channel && row.recipientId === note.recipientId && row.action.kind === action.kind && row.action.id === action.id && row.bindingId === identity.identityId).sort((a, b) => b.generation - a.generation)[0]
    if (previous) {
      if (previous.state !== 'unknown' && !linkEligible(store, previous, client)) return false
      const owns = previous.state !== 'failed' && previous.state !== 'isolated'
      if (owns) store.update<NotificationDelivery>('notificationDeliveries', delivery.id, delivery.version, { status: 'skipped', lastError: '已交由所选原生渠道投递，避免重复提醒' })
      return owns
    }
    createNativeLink(store, action, channel, identity, desired, now)
    store.update<NotificationDelivery>('notificationDeliveries', delivery.id, delivery.version, { status: 'skipped', lastError: '已交由所选原生渠道投递，避免重复提醒' })
    return true
  }) } catch {
    // Native projection failure must not abort the ordinary worker or claim an uncertain fallback.
    // No external call occurs in this function; the transaction above rolls back completely.
    const delivery = store.get<NotificationDelivery>('notificationDeliveries', notificationId)
    if (delivery?.status === 'pending') store.update<NotificationDelivery>('notificationDeliveries', delivery.id, delivery.version, { status: 'failed', lastError: '原生投递预检失败，请核查事项或渠道配置；站内业务不受影响' })
    return true
  }
}
function createNativeLink(store: Store, action: NativeActionRef, channel: NativeChannel, identity: NonNullable<ReturnType<typeof verifiedNativeIdentity>>, desired: NativeDesiredState, now: Date, generation = 1) {
  const settings = getNativeSettings(store)
  const id = nativeHash([identity.corpId, identity.appId, identity.identityId, action.kind, action.id, channel, generation, settings.activationId])
  const link = store.insert<ExternalObjectLink>('nativeLinks', { id, action, channel, recipientId: identity.userId, bindingId: identity.identityId, bindingVersion: identity.bindingVersion, corpId: identity.corpId, appId: identity.appId, unionId: identity.unionId, userid: identity.userid, generation, deploymentId: settings.deploymentId, activationId: settings.activationId, sourceId: id, providerId: null, carrierId: null, userIdType: 1, templateId: channel === 'card' ? process.env.DINGTALK_CARD_TEMPLATE_ID ?? null : null, desired, observedDone: null, state: 'pending', lastSyncedAt: null, reconcileAt: now.toISOString(), lastError: '' })
  enqueueNativeOperation(store, link, channel === 'todo' ? 'todo_create' : 'card_create', now)
  return link
}
export function linkEligible(store: Store, link: ExternalObjectLink, client: DingTalkNativeClient) {
  const settings = getNativeSettings(store), identity = verifiedNativeIdentity(store, link.recipientId, client)
  return nativeCapabilityState(store, client)[link.channel].enabled && settings.pilotUserIds.includes(link.recipientId) && settings.activationId === link.activationId && settings.deploymentId === link.deploymentId && link.deploymentId === process.env.DINGTALK_DEPLOYMENT_ID && !!identity && identity.identityId === link.bindingId && identity.bindingVersion === link.bindingVersion && identity.unionId === link.unionId && link.corpId === client.corpId && link.appId === client.appId
}
export function refreshNativeLinks(store: Store, client: DingTalkNativeClient, now = new Date()) {
  for (const link of store.list<ExternalObjectLink>('nativeLinks')) {
    if (['isolated', 'external_missing', 'failed'].includes(link.state)) continue
    if (!linkEligible(store, link, client)) {
      store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { state: 'isolated', lastError: '权限、配置或绑定代际已变化，等待核查' }); continue
    }
    const desired = nativeDesired(store, link.recipientId, link.action)
    if (!desired) { store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { state: 'isolated', lastError: '事项已不可访问，停止外部操作' }); continue }
    if (desired.done && !link.providerId && link.state !== 'unknown') {
      if (link.state !== 'closed') store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { desired, state: 'closed', lastError: '义务已在平台处理，未创建外部对象' })
      for (const operation of store.list<ChannelOperation>('nativeOperations')) if (operation.linkId === link.id && operation.status === 'pending') store.update<ChannelOperation>('nativeOperations', operation.id, operation.version, { status: 'cancelled', lastError: '义务已在平台处理' })
      continue
    }
    if (desired.revision !== link.desired.revision) {
      const next = store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { desired, state: link.state === 'unknown' ? 'unknown' : 'pending_update' })
      // An uncertain creation/delivery must be reconciled, never replaced by a new send.
      if (link.state !== 'unknown') enqueueNativeOperation(store, next, link.providerId ? link.channel === 'todo' ? 'todo_update' : 'card_update' : link.channel === 'todo' ? 'todo_create' : 'card_create', now)
    }
  }
}
export function recreateNativeLink(store: Store, actor: User, id: string, client: DingTalkNativeClient, now = new Date()) {
  nativeManager(store, actor)
  return store.transaction(() => {
    const previous = store.get<ExternalObjectLink>('nativeLinks', id)
    if (!previous || previous.state !== 'external_missing') throw new HttpError(409, '只有已核查的外部缺失对象可显式重新创建')
    if (store.list<ExternalObjectLink>('nativeLinks').some(row => row.action.kind === previous.action.kind && row.action.id === previous.action.id && row.recipientId === previous.recipientId && row.generation > previous.generation)) throw new HttpError(409, '该义务已有新的原生对象')
    const identity = verifiedNativeIdentity(store, previous.recipientId, client), desired = nativeDesired(store, previous.recipientId, previous.action)
    if (!identity || !desired || desired.done || !nativeCapabilityState(store, client)[previous.channel].enabled) throw new HttpError(409, '当前身份或义务不支持重新创建')
    const next = createNativeLink(store, previous.action, previous.channel, identity, desired, now, previous.generation + 1)
    store.insert<Entity & { actorId: string; action: string; linkId: string }>('nativeAdminEvents', { actorId: actor.id, action: 'recreate', linkId: next.id }); return next
  })
}
export function fallbackNativeNotification(store: Store, link: ExternalObjectLink) {
  const settings = getNativeSettings(store)
  const operations = store.list<ChannelOperation>('nativeOperations').filter(row => row.linkId === link.id)
  const accepted = link.channel === 'todo' ? !!link.providerId || operations.some(row => ['unknown', 'succeeded'].includes(row.status))
    : !!link.carrierId || operations.some(row => row.kind !== 'card_create' && ['unknown', 'succeeded'].includes(row.status)) || operations.some(row => row.kind === 'card_create' && row.status === 'unknown')
  if (!settings.fallbackEnabled || accepted) return
  const delivery = store.get<NotificationDelivery>('notificationDeliveries', link.action.notificationId)
  if (delivery?.status === 'skipped' && delivery.lastError === '已交由所选原生渠道投递，避免重复提醒') store.update<NotificationDelivery>('notificationDeliveries', delivery.id, delivery.version, { status: 'pending', lastError: '原生渠道明确未受理，已降级为工作通知' })
}
