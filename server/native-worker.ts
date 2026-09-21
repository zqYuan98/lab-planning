import type { User } from '../shared/types.ts'
import type { ActionIntent, ChannelOperation, ExternalObjectLink, NativeDeliveryAttempt } from '../shared/native-actions.ts'
import type { NotificationDelivery } from '../shared/notifications.ts'
import { Store, HttpError } from './store.ts'
import { DingTalkError } from './dingtalk.ts'
import { createDingTalkNativeClient, type DingTalkNativeClient, type NativeCardInput, type TodoCreate, type TodoUpdate, type NativeReply } from './dingtalk-native.ts'
import { enqueueNativeOperation, fallbackNativeNotification, linkEligible, nativeClip, nativeHash, refreshNativeLinks } from './native-service.ts'
import { getNativeSettings, nativeCapabilityState, verifiedNativeIdentity } from './native-settings.ts'
import { createNativeIntent, nativeIntentForCard } from './native-commands.ts'
import { processNativeInbox } from './native-callbacks.ts'
import { reconcileNativeDepartures, reconcileNativeTodos } from './native-reconcile.ts'
import { getNotificationSettings, notificationEnvironmentEnabled } from './notifications.ts'

const running = new WeakSet<Store>()
type PreparedOperation = { kind: ChannelOperation['kind']; input: TodoCreate | TodoUpdate | NativeCardInput | NativeReply | { unionId: string; taskId: string } | { outTrackId: string; userid: string } | { outTrackId: string; params: Record<string, string> } }
function cardParameters(store: Store, client: DingTalkNativeClient, link: ExternalObjectLink, operation: ChannelOperation, now: Date) {
  const params: Record<string, string> = { title: link.desired.title, summary: nativeClip(link.desired.summary, 1000), status: link.desired.done ? '平台已处理' : '待在平台处理', detailUrl: link.desired.url, actionLabel: '', intentId: '', actionToken: '', actionKind: link.desired.done ? '' : link.action.kind === 'followup' ? 'respond' : link.action.kind === 'progress' ? 'progress' : link.action.kind === 'acknowledge' ? 'acknowledge' : '' }
  if (operation.cardResult) { params.status = nativeClip(operation.cardResult, 1000); return params }
  if (operation.cardIntentId) {
    const { intent, token } = nativeIntentForCard(store, link, operation.cardIntentId, now)
    return { ...params, summary: intent.summary, status: '请核对以下操作，确认后提交；30分钟内有效', actionLabel: '确认提交', intentId: intent.id, actionToken: token, actionKind: 'confirm' }
  }
  if (link.action.kind === 'acknowledge' && !link.desired.done) {
    const actor = store.get<User>('users', link.recipientId)
    if (!actor) throw new HttpError(409, '账号不可用')
    const intent = createNativeIntent(store, actor, { kind: 'acknowledge', targetId: link.action.notificationId, requestId: `card:${operation.id}:${operation.attempts}` }, client, now, link.sourceId)
    params.actionLabel = '确认知悉'; params.intentId = intent.id; params.actionToken = intent.token
    params.summary = nativeClip(`${link.desired.summary}\n仅确认已知悉该安排。任务执行和正式提报状态不会改变。`, 1000)
  }
  return params
}
export function prepareNativeOperation(store: Store, client: DingTalkNativeClient, operation: ChannelOperation, link: ExternalObjectLink | undefined, now: Date): PreparedOperation {
  if (operation.kind === 'robot_reply') { if (!operation.reply) throw new HttpError(409, '回复内容不存在'); return { kind: operation.kind, input: operation.reply } }
  if (!link) throw new HttpError(409, '原生对象不存在')
  const fields = [{ fieldKey: '事项要求', fieldValue: link.desired.summary }]
  if (operation.kind === 'todo_create') return { kind: operation.kind, input: { unionId: link.unionId, sourceId: link.sourceId, subject: link.desired.title, detailUrl: { appUrl: link.desired.url, pcUrl: link.desired.url }, fields, ...(link.desired.dueTime !== undefined ? { dueTime: link.desired.dueTime } : {}) } }
  if (operation.kind === 'todo_update') { if (!link.providerId) throw new HttpError(409, '待办编号尚未确认'); return { kind: operation.kind, input: { unionId: link.unionId, taskId: link.providerId, subject: link.desired.title, done: link.desired.done, fields, ...(link.desired.dueTime !== undefined ? { dueTime: link.desired.dueTime } : {}) } } }
  if (operation.kind === 'todo_delete') { if (!link.providerId) throw new HttpError(409, '待办编号尚未确认'); return { kind: operation.kind, input: { unionId: link.unionId, taskId: link.providerId } } }
  if (operation.kind === 'card_create') { if (!link.templateId) throw new HttpError(409, '互动卡片模板尚未配置'); return { kind: operation.kind, input: { outTrackId: link.sourceId, templateId: link.templateId, userid: link.userid, params: cardParameters(store, client, link, operation, now) } } }
  if (operation.kind === 'card_deliver') return { kind: operation.kind, input: { outTrackId: link.sourceId, userid: link.userid } }
  return { kind: operation.kind, input: { outTrackId: link.sourceId, params: cardParameters(store, client, link, operation, now) } }
}
function operationEligible(store: Store, client: DingTalkNativeClient, operation: ChannelOperation, link?: ExternalObjectLink) {
  const settings = getNativeSettings(store)
  if (operation.deploymentId !== process.env.DINGTALK_DEPLOYMENT_ID || settings.deploymentId !== operation.deploymentId || settings.activationId !== operation.activationId) return false
  if (operation.kind !== 'robot_reply') return !!link && !['isolated', 'external_missing', 'failed', 'unknown'].includes(link.state) && linkEligible(store, link, client)
  if (!nativeCapabilityState(store, client).robot.enabled) return false
  if (!operation.recipientId) return !!operation.reply?.webhook // Only a generic entry reply is generated for unbound users.
  const identity = verifiedNativeIdentity(store, operation.recipientId, client)
  return !!identity && settings.pilotUserIds.includes(operation.recipientId) && (!operation.reply?.userid || identity.userid === operation.reply.userid)
}
async function invoke(client: DingTalkNativeClient, prepared: PreparedOperation): Promise<{ providerId?: string; carrierId?: string | null }> {
  const input = prepared.input
  if (prepared.kind === 'todo_create') return { providerId: (await client.createTodo(input as TodoCreate)).taskId }
  if (prepared.kind === 'todo_update') await client.updateTodo(input as TodoUpdate)
  else if (prepared.kind === 'todo_delete') { const data = input as { unionId: string; taskId: string }; await client.deleteTodo(data.unionId, data.taskId) }
  else if (prepared.kind === 'card_create') { const data = input as NativeCardInput; await client.createCard(data); return { providerId: data.outTrackId } }
  else if (prepared.kind === 'card_deliver') { const data = input as { outTrackId: string; userid: string }; return await client.deliverCard(data.outTrackId, data.userid) }
  else if (prepared.kind === 'card_update') { const data = input as { outTrackId: string; params: Record<string, string> }; await client.updateCard(data.outTrackId, data.params) }
  else await client.sendRobot(input as NativeReply)
  return {}
}
export async function runNativeWorker(store: Store, client: DingTalkNativeClient = createDingTalkNativeClient(), nowOrClock: Date | (() => Date) = () => new Date(), shouldStop = () => false) {
  if (running.has(store)) return
  running.add(store); const clock = typeof nowOrClock === 'function' ? nowOrClock : () => nowOrClock
  try {
    const now = clock()
    // Any persisted in-flight call after a crash is uncertain, even if no local success was recorded.
    for (const operation of store.list<ChannelOperation>('nativeOperations')) if (operation.status === 'sending' && (!operation.leaseUntil || operation.leaseUntil <= now.toISOString())) {
      store.transaction(() => {
        store.update<ChannelOperation>('nativeOperations', operation.id, operation.version, { status: 'unknown', leaseUntil: null, lastError: '上次请求在确认结果前中断，禁止自动重发' })
        const link = operation.linkId && store.get<ExternalObjectLink>('nativeLinks', operation.linkId)
        if (link && link.state !== 'isolated') store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { state: 'unknown', reconcileAt: now.toISOString(), lastError: '请求结果待对账' })
        const attempt = store.get<NativeDeliveryAttempt>('nativeDeliveryAttempts', `${operation.id}:${operation.attempts}`)
        if (attempt?.outcome === 'sending') store.update<NativeDeliveryAttempt>('nativeDeliveryAttempts', attempt.id, attempt.version, { outcome: 'unknown', completedAt: now.toISOString() })
      })
    }
    processNativeInbox(store, client, now); refreshNativeLinks(store, client, now)
    if (shouldStop()) return
    // Only previously sent objects need polling. Fresh creates run below without a pointless read.
    if (store.list<ExternalObjectLink>('nativeLinks').some(row => row.channel === 'todo' && (row.providerId || row.state === 'unknown'))) await reconcileNativeTodos(store, client, now, shouldStop)
    try { await reconcileNativeDepartures(store, client, now, shouldStop) } catch { /* Cursor remains durable; the next run resumes this read. */ }
    for (let batch = 0; batch < 3 && !shouldStop(); batch++) {
      const candidates = store.list<ChannelOperation>('nativeOperations').filter(row => row.status === 'pending' && row.nextAttemptAt <= clock().toISOString()).slice(0, 50)
      if (!candidates.length) break
      for (const candidate of candidates) {
        if (shouldStop()) return
        let operation = store.get<ChannelOperation>('nativeOperations', candidate.id)
        if (!operation || operation.status !== 'pending') continue
        const link = operation.linkId ? store.get<ExternalObjectLink>('nativeLinks', operation.linkId) : undefined
        if (!operationEligible(store, client, operation, link) || link && operation.desiredRevision !== link.desired.revision && operation.kind !== 'card_deliver') {
          store.update<ChannelOperation>('nativeOperations', operation.id, operation.version, { status: 'cancelled', lastError: '权限、配置或事项版本已变化' }); continue
        }
        if (['todo_create', 'card_create', 'card_deliver'].includes(operation.kind)) {
          const settings = getNotificationSettings(store), localHour = new Date(clock().getTime() + 8 * 3600000).getUTCHours()
          const delivery = link && store.get<NotificationDelivery>('notificationDeliveries', link.action.notificationId)
          if (!notificationEnvironmentEnabled() || !settings.externalEnabled || !settings.pilotUserIds.includes(operation.recipientId) || settings.deploymentId !== operation.deploymentId || delivery?.activationId !== settings.activationId) {
            store.update<ChannelOperation>('nativeOperations', operation.id, operation.version, { status: 'cancelled', lastError: '总外发开关或试点范围已改变，旧操作不再补发' })
            if (link) store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { state: 'isolated', lastError: '外发授权代际已变化' })
            continue
          }
          // Direct robot commands are user-initiated replies; proactive native notifications share quiet hours.
          if (localHour < settings.sendStartHour || localHour >= settings.sendEndHour) continue
        }
        if (operation.kind === 'card_deliver' && link) {
          if (link.desired.done) { store.update<ChannelOperation>('nativeOperations', operation.id, operation.version, { status: 'cancelled', lastError: '义务已处理，不再投放卡片' }); continue }
          if (link.action.kind === 'acknowledge' && !store.list<ActionIntent>('nativeActionIntents').some(intent => intent.outTrackId === link.sourceId && intent.status === 'pending' && intent.expiresAt > clock().toISOString())) {
            enqueueNativeOperation(store, link, 'card_update', clock(), `refresh-before-delivery:${operation.id}:${operation.attempts}`)
            continue
          }
        }
        if (link && store.list<ChannelOperation>('nativeOperations').some(row => row.id !== operation!.id && row.linkId === link.id && ['sending', 'unknown'].includes(row.status))) continue
        const started = clock(); let prepared: PreparedOperation
        try { prepared = prepareNativeOperation(store, client, operation, link, started) }
        catch {
          store.update<ChannelOperation>('nativeOperations', operation.id, operation.version, { status: 'failed', lastError: '发送前校验失败，请核对事项和渠道配置' })
          if (link) { const failed = store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { state: operation.kind.endsWith('_create') ? 'failed' : link.state, lastError: '发送前校验失败' }); if (operation.kind.endsWith('_create')) fallbackNativeNotification(store, failed) }
          continue
        }
        // Commit the exact adapter input before any external write. A second DB connection can observe it.
        operation = store.transaction(() => {
          const current = store.get<ChannelOperation>('nativeOperations', operation!.id)!
          const next = store.update<ChannelOperation>('nativeOperations', current.id, current.version, { status: 'sending', attempts: current.attempts + 1, leaseUntil: new Date(started.getTime() + 60000).toISOString() })
          store.insert<NativeDeliveryAttempt>('nativeDeliveryAttempts', { id: `${next.id}:${next.attempts}`, operationId: next.id, attempt: next.attempts, renderedAt: started.toISOString(), payloadHash: nativeHash(prepared), payload: prepared, outcome: 'sending', completedAt: null }); return next
        })
        let outcome: 'succeeded' | 'failed' | 'unknown' = 'succeeded', result: Awaited<ReturnType<typeof invoke>> = {}, retryable = false
        try { result = await invoke(client, prepared) } catch (error) { outcome = error instanceof DingTalkError && error.outcome === 'definitive' ? 'failed' : 'unknown'; retryable = error instanceof DingTalkError && error.retryable && outcome === 'failed' }
        const finished = clock()
        store.transaction(() => {
          const current = store.get<ChannelOperation>('nativeOperations', operation!.id)!
          if (current.status !== 'sending' || current.leaseUntil !== operation!.leaseUntil) return
          const retry = retryable && current.attempts < 5
          store.update<ChannelOperation>('nativeOperations', current.id, current.version, { status: retry ? 'pending' : outcome, leaseUntil: null, nextAttemptAt: retry ? new Date(finished.getTime() + [1, 5, 15, 60][Math.min(current.attempts - 1, 3)] * 60000).toISOString() : current.nextAttemptAt, lastError: outcome === 'succeeded' ? '' : outcome === 'unknown' ? '钉钉未返回确定结果，等待核查，禁止自动重发' : '钉钉明确未受理本次操作' })
          const attempt = store.get<NativeDeliveryAttempt>('nativeDeliveryAttempts', `${current.id}:${current.attempts}`)!
          store.update<NativeDeliveryAttempt>('nativeDeliveryAttempts', attempt.id, attempt.version, { outcome, completedAt: finished.toISOString() })
          const latest = current.linkId ? store.get<ExternalObjectLink>('nativeLinks', current.linkId) : undefined
          if (!latest) return
          const stillEligible = linkEligible(store, latest, client) && latest.state !== 'isolated'
          if (outcome === 'succeeded') {
            const next = store.update<ExternalObjectLink>('nativeLinks', latest.id, latest.version, { ...result, state: !stillEligible ? 'isolated' : current.kind === 'todo_delete' ? 'external_missing' : current.kind === 'card_create' ? 'pending' : latest.desired.done ? 'closed' : 'created', lastSyncedAt: finished.toISOString(), reconcileAt: new Date(finished.getTime() + 15 * 60000).toISOString(), lastError: '' })
            if (current.kind === 'card_create' && stillEligible) enqueueNativeOperation(store, next, 'card_deliver', finished)
          } else if (!retry) {
            const failed = store.update<ExternalObjectLink>('nativeLinks', latest.id, latest.version, { state: !stillEligible ? 'isolated' : outcome === 'unknown' ? 'unknown' : 'failed', reconcileAt: outcome === 'unknown' ? new Date(finished.getTime() + 5 * 60000).toISOString() : latest.reconcileAt, lastError: outcome === 'unknown' ? '结果待核查' : '原生操作明确失败' })
            if (outcome === 'failed') fallbackNativeNotification(store, failed)
          }
        })
      }
    }
  } finally { running.delete(store) }
}
export function startNativeWorker(store: Store, client: DingTalkNativeClient = createDingTalkNativeClient()) {
  let stopped = false, active: Promise<void> | undefined
  const tick = () => { if (!stopped && !active) active = runNativeWorker(store, client, () => new Date(), () => stopped).catch(() => {}).finally(() => { active = undefined }) }
  const timer = setInterval(tick, 15_000); timer.unref(); tick()
  return async () => { stopped = true; clearInterval(timer); await active }
}
