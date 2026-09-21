import type { Entity, Task, User } from '../shared/types.ts'
import type { ActionIntent, CallbackInbox, ChannelOperation, ExternalObjectLink, NativeVerifiedIdentity } from '../shared/native-actions.ts'
import type { FollowupRequest } from '../shared/collaboration.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { Store, HttpError } from './store.ts'
import { appOrigin } from './auth.ts'
import type { DingTalkNativeClient } from './dingtalk-native.ts'
import { getNativeSettings, nativeCapabilityState, verifiedNativeIdentity } from './native-settings.ts'
import { nativeHash, nativeClip, linkEligible, enqueueNativeOperation } from './native-service.ts'
import { confirmNativeIntent, createNativeIntent, nativeIntentForCard } from './native-commands.ts'

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max ? value : ''
const date = (value: unknown) => { const valueMs = typeof value === 'number' || typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Date.parse(String(value)); return Number.isFinite(valueMs) ? new Date(valueMs).toISOString() : '' }
export interface NativeStreamEnvelope { headers: Record<string, unknown>; data: string }
/** Only the authenticated official Stream connection may call this function. No HTTP route exposes it. */
export function receiveNativeStream(store: Store, client: DingTalkNativeClient, topic: 'event' | 'card' | 'robot', envelope: NativeStreamEnvelope, now = new Date()): { accepted: boolean; duplicate?: boolean; inboxId?: string } {
  if (typeof envelope.data !== 'string' || Buffer.byteLength(envelope.data) > 64 * 1024) return { accepted: false }
  let input: Record<string, unknown>; try { input = record(JSON.parse(envelope.data)) } catch { return { accepted: false } }
  const settings = getNativeSettings(store), caps = nativeCapabilityState(store, client)
  if (!settings.enabledAt || settings.deploymentId !== process.env.DINGTALK_DEPLOYMENT_ID) return { accepted: false }
  let eventType = topic as string, eventId = '', corpId = '', occurredAt = now.toISOString(), data: Record<string, unknown> = {}
  if (topic === 'event') {
    eventType = text(envelope.headers.eventType); eventId = text(envelope.headers.eventId); corpId = text(envelope.headers.eventCorpId)
    occurredAt = date(envelope.headers.eventBornTime) || date(input.timeStamp)
    if (!['todo_task_create', 'todo_task_update', 'todo_task_delete', 'user_leave_org'].includes(eventType)) return { accepted: false }
    if (eventType === 'user_leave_org') {
      if (!caps.orgEvents.enabled || !Array.isArray(input.userId) || input.userId.length > 1000 || input.userId.some(id => !text(id))) return { accepted: false }
      data = { userids: input.userId }
    } else {
      if (!caps.todo.enabled || !text(input.taskId)) return { accepted: false }
      data = { taskId: input.taskId }
    }
  } else if (topic === 'card') {
    if (!caps.card.enabled || input.type !== 'actionCallback') return { accepted: false }
    corpId = text(input.corpId); eventId = text(envelope.headers.messageId)
    const link = store.list<ExternalObjectLink>('nativeLinks').find(row => row.sourceId === input.outTrackId)
    if (!link || link.channel !== 'card' || link.userIdType !== 1 || link.userid !== input.userId || !linkEligible(store, link, client)) return { accepted: false }
    let content: Record<string, unknown>; try { content = record(typeof input.content === 'string' ? JSON.parse(input.content) : input.content) } catch { return { accepted: false } }
    const privateData = record(content.cardPrivateData), params = record(privateData.params)
    if (!Array.isArray(privateData.actionIds) || privateData.actionIds.length !== 1) return { accepted: false }
    const action = privateData.actionIds[0]
    if (action === 'confirm') {
      if (!text(params.intentId) || !text(params.actionToken, 128)) return { accepted: false }
      data = { action, intentId: params.intentId, tokenHash: nativeHash(params.actionToken) }
    } else if (action === 'preview_response' && link.action.kind === 'followup' || action === 'preview_progress' && link.action.kind === 'progress') {
      // A template may collect simple progress fields, but never an actor, target id or arbitrary command.
      const allowed = ['note', 'taskStatus', 'completionNote', 'nextAction', 'noChangeReason', 'noteType']
      if (Object.keys(params).some(key => !allowed.includes(key)) || Object.values(params).some(value => typeof value !== 'string') || Buffer.byteLength(JSON.stringify(params)) > 2000) return { accepted: false }
      data = { action, progress: params, targetId: link.action.kind === 'followup' ? link.action.id : link.action.taskId }
    } else return { accepted: false }
    data = { ...data, outTrackId: link.sourceId, recipientId: link.recipientId, bindingId: link.bindingId, bindingVersion: link.bindingVersion }
  } else {
    if (!caps.robot.enabled || !['1', '2'].includes(String(input.conversationType))) return { accepted: false }
    corpId = text(input.senderCorpId); eventId = text(input.msgId); const userid = text(input.senderStaffId)
    if (!userid || !text(record(input.text).content, 4000)) return { accepted: false }
    const candidates = store.list<NativeVerifiedIdentity>('nativeIdentities').filter(row => row.userid === userid && row.corpId === client.corpId && row.appId === client.appId && !row.suspendedAt)
      .map(row => { const current = verifiedNativeIdentity(store, row.userId, client); return current?.id === row.id && current.userid === userid ? current : undefined }).filter(row => !!row)
    const valid = candidates.length === 1 ? candidates[0] : undefined
    data = { userid, recipientId: valid?.userId ?? '', bindingId: valid?.identityId ?? '', bindingVersion: valid?.bindingVersion ?? 0, conversationType: String(input.conversationType), content: record(input.text).content,
      webhook: text(input.sessionWebhook, 2048), expiresAt: Number(input.sessionWebhookExpiredTime) || 0 }
  }
  if (!eventId || corpId !== client.corpId || !occurredAt || occurredAt < settings.enabledAt || Date.parse(occurredAt) > now.getTime() + 5 * 60000) return { accepted: false }
  const id = nativeHash([client.appId, corpId, eventType, eventId, settings.deploymentId]), payloadHash = nativeHash(data)
  return store.transaction(() => {
    const before = store.get<CallbackInbox>('nativeCallbackInbox', id)
    if (before) return { accepted: before.payloadHash === payloadHash, duplicate: true, inboxId: id }
    store.insert<CallbackInbox>('nativeCallbackInbox', { id, appId: client.appId, corpId, eventType, eventId, occurredAt, receivedAt: now.toISOString(), deploymentId: settings.deploymentId, payloadHash, status: 'pending', result: '', data })
    return { accepted: true, inboxId: id }
  })
}
export function applyNativeDeparture(store: Store, client: DingTalkNativeClient, userid: string, occurredAt: string, source: string, now = new Date()) {
  return store.transaction(() => {
    const identities = store.list<NativeVerifiedIdentity>('nativeIdentities').filter(row => row.corpId === client.corpId && row.appId === client.appId && row.userid === userid && !row.suspendedAt)
    let count = 0
    for (const identity of identities) {
      const current = verifiedNativeIdentity(store, identity.userId, client)
      // A late event from an old binding must never disable a freshly verified identity.
      if (!current || current.id !== identity.id || occurredAt < identity.verifiedAt) continue
      const user = store.get<User & { credentialVersion?: number }>('users', identity.userId)
      if (!user) continue
      store.update<User & { credentialVersion: number }>('users', user.id, user.version, { active: false, credentialVersion: (user.credentialVersion ?? 0) + 1 })
      for (const session of store.list<Entity & { userId: string; revoked: boolean }>('sessions')) if (session.userId === user.id && !session.revoked) store.update<Entity & { revoked: boolean }>('sessions', session.id, session.version, { revoked: true })
      store.update<NativeVerifiedIdentity>('nativeIdentities', identity.id, identity.version, { suspendedAt: now.toISOString(), suspensionReason: '已核验企业离职事件，需管理员重新核验后恢复' })
      for (const link of store.list<ExternalObjectLink>('nativeLinks')) if (link.recipientId === user.id && link.state !== 'isolated') store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { state: 'isolated', lastError: '企业成员已离职，已停止原生操作' })
      for (const operation of store.list<ChannelOperation>('nativeOperations')) if (operation.recipientId === user.id && operation.status === 'pending') store.update<ChannelOperation>('nativeOperations', operation.id, operation.version, { status: 'cancelled', lastError: '企业成员已离职' })
      for (const intent of store.list<ActionIntent>('nativeActionIntents')) if (intent.recipientId === user.id && intent.status === 'pending') store.update<ActionIntent>('nativeActionIntents', intent.id, intent.version, { status: 'rejected', result: '企业成员已离职' })
      store.insert<Entity & { action: string; userId: string; source: string; occurredAt: string }>('nativeAdminEvents', { action: 'member_departed', userId: user.id, source, occurredAt }); count++
    }
    return count
  })
}
function botText(store: Store, inbox: CallbackInbox, client: DingTalkNativeClient, now: Date) {
  const entry = appOrigin()?.href ?? '', settings = getNativeSettings(store), data = inbox.data
  if (data.conversationType !== '1') return `请在私聊或平台查看个人工作事项：${entry}`
  const actor = store.get<User>('users', String(data.recipientId)), identity = actor && verifiedNativeIdentity(store, actor.id, client)
  if (!actor || !canUseAccount(actor) || !identity || identity.identityId !== data.bindingId || identity.bindingVersion !== data.bindingVersion || !settings.pilotUserIds.includes(actor.id)) return `请先在平台登录并绑定当前企业钉钉账号：${entry}`
  const command = String(data.content).trim()
  if (command === '我的待办') {
    const tasks = store.list<Task>('tasks').filter(row => row.ownerId === actor.id && row.status !== 'done').slice(0, 10)
    return `我的待办（最多10项）\n${tasks.map(row => `${row.title}｜${row.status === 'blocked' ? '受阻' : row.status === 'doing' ? '进行中' : '未开始'}｜事项编号 ${row.id}`).join('\n') || '暂无未完成事项'}\n${entry}`
  }
  if (command === '我的催办') {
    const rows = store.list<FollowupRequest>('followupRequests').filter(row => row.ownerId === actor.id && row.status === 'open').slice(0, 10)
    return `待回应催办（最多10项）\n${rows.map(row => `${store.get<Task>('tasks', row.taskId)?.title ?? '工作事项'}｜${row.requirement}｜${row.dueAt}｜催办编号 ${row.id}`).join('\n') || '暂无待回应催办'}\n${entry}`
  }
  if (command === '本周事项' || command === '正式提报') return `请进入平台核对本周安排和完整条目后正式提报：${entry}`
  const confirm = /^确认操作 ([a-f0-9]{64}) ([a-f0-9]{64})$/.exec(command)
  if (confirm) return confirmNativeIntent(store, actor, confirm[1], confirm[2], client, now).result
  const ack = /^确认安排 ([\w:.-]{1,200})$/.exec(command), progress = /^(更新进度|回应催办) ([\w:.-]{1,200}) ([\s\S]+)$/.exec(command)
  if (ack || progress) {
    const intent = createNativeIntent(store, actor, ack ? { kind: 'acknowledge', targetId: ack[1], requestId: `bot:${inbox.id}` } : { kind: progress![1] === '更新进度' ? 'progress' : 'respond', targetId: progress![2], requestId: `bot:${inbox.id}`, progress: { noteType: 'progress', note: progress![3] } }, client, now)
    return `${intent.summary}\n请核对以上内容；确认后回复：\n确认操作 ${intent.id} ${intent.token}\n该确认在30分钟后失效。`
  }
  return '支持：我的待办、我的催办、本周事项、正式提报。\n提交操作先预览再确认：\n确认安排 通知编号\n更新进度 事项编号 进展内容\n回应催办 催办编号 回应内容'
}
function enqueueReply(store: Store, inbox: CallbackInbox, content: string, now: Date) {
  const id = nativeHash(['robot_reply', inbox.id]), settings = getNativeSettings(store)
  if (store.get('nativeOperations', id)) return
  const data = inbox.data, useWebhook = data.conversationType === '2' || !data.recipientId
  if (useWebhook && (!data.webhook || Number(data.expiresAt) <= now.getTime())) return
  const entry = appOrigin()?.href ?? '', body = nativeClip(entry ? content.replaceAll(entry, '') : content, 4000 - Buffer.byteLength(entry) - 1)
  store.insert<ChannelOperation>('nativeOperations', { id, uniqueKey: id, linkId: null, kind: 'robot_reply', desiredRevision: inbox.payloadHash, deploymentId: settings.deploymentId, activationId: settings.activationId, recipientId: String(data.recipientId || ''), status: 'pending', attempts: 0, nextAttemptAt: now.toISOString(), leaseUntil: null, lastError: '', reply: { text: `${body}\n${entry}`, ...(useWebhook ? { webhook: String(data.webhook), expiresAt: Number(data.expiresAt) } : { userid: String(data.userid) }) } })
}
export function processNativeInbox(store: Store, client: DingTalkNativeClient, now = new Date()) {
  for (const row of store.list<CallbackInbox>('nativeCallbackInbox').filter(row => row.status === 'pending').slice(0, 100)) {
    try {
      store.transaction(() => {
        const settings = getNativeSettings(store), caps = nativeCapabilityState(store, client)
        if (row.deploymentId !== settings.deploymentId || row.deploymentId !== process.env.DINGTALK_DEPLOYMENT_ID || row.corpId !== client.corpId || row.appId !== client.appId || !settings.enabledAt || row.receivedAt < settings.enabledAt) throw new HttpError(409, '部署或启用边界已变化')
        if (row.eventType === 'user_leave_org') {
          if (!caps.orgEvents.enabled) throw new HttpError(409, '组织事件接收已关闭')
          for (const userid of row.data.userids as string[]) applyNativeDeparture(store, client, userid, row.occurredAt, row.id, now)
        } else if (row.eventType.startsWith('todo_task_')) {
          if (!caps.todo.enabled) throw new HttpError(409, '待办渠道已关闭')
          for (const link of store.list<ExternalObjectLink>('nativeLinks')) if (link.channel === 'todo' && link.providerId === row.data.taskId && linkEligible(store, link, client)) {
            if (link.lastSyncedAt && row.occurredAt < link.lastSyncedAt) continue
            store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, row.eventType === 'todo_task_delete' ? { state: 'external_missing', lastError: '已收到外部删除事件；业务义务保留，需管理员明确决定是否重建', reconcileAt: null } : { reconcileAt: now.toISOString() })
          }
        } else if (row.eventType === 'card') {
          if (!caps.card.enabled) throw new HttpError(409, '卡片渠道已关闭')
          const actor = store.get<User>('users', String(row.data.recipientId)); if (!actor) throw new HttpError(403, '账号不可用')
          if (row.data.action === 'confirm') confirmNativeIntent(store, actor, String(row.data.intentId), String(row.data.tokenHash), client, now, { outTrackId: String(row.data.outTrackId), alreadyHashed: true })
          else {
            const link = store.list<ExternalObjectLink>('nativeLinks').find(link => link.sourceId === row.data.outTrackId)
            if (!link || !linkEligible(store, link, client) || link.bindingId !== row.data.bindingId || link.bindingVersion !== row.data.bindingVersion || link.desired.done) throw new HttpError(409, '卡片事项或绑定已改变')
            const intent = createNativeIntent(store, actor, { kind: row.data.action === 'preview_response' ? 'respond' : 'progress', targetId: String(row.data.targetId), progress: row.data.progress as any, requestId: `card-preview:${row.id}` }, client, now, link.sourceId)
            nativeIntentForCard(store, link, intent.id, now)
            const operation = enqueueNativeOperation(store, link, 'card_update', now, row.id)
            store.update<ChannelOperation>('nativeOperations', operation.id, operation.version, { cardIntentId: intent.id })
          }
        } else if (row.eventType === 'robot') {
          if (!caps.robot.enabled) throw new HttpError(409, '机器人已关闭')
          let content: string
          try { content = botText(store, row, client, now) } catch (error) { content = error instanceof HttpError ? error.message : '该操作暂时不可处理，请进入平台核对。' }
          enqueueReply(store, row, content, now)
        } else throw new HttpError(400, '不支持的事件类型')
        store.update<CallbackInbox>('nativeCallbackInbox', row.id, row.version, { status: 'processed', result: '已处理' })
      })
    } catch (error) {
      const current = store.get<CallbackInbox>('nativeCallbackInbox', row.id)
      if (current?.status === 'pending') {
        const result = error instanceof HttpError ? error.message : '事件处理失败，请核查内部队列'
        store.update<CallbackInbox>('nativeCallbackInbox', row.id, current.version, { status: 'rejected', result })
        if (row.eventType === 'card') {
          const link = store.list<ExternalObjectLink>('nativeLinks').find(link => link.sourceId === row.data.outTrackId)
          if (link && linkEligible(store, link, client)) {
            const operation = enqueueNativeOperation(store, link, 'card_update', now, `rejected:${row.id}`)
            store.update<ChannelOperation>('nativeOperations', operation.id, operation.version, { cardResult: `${result}，请进入平台核对最新状态` })
          }
        }
      }
    }
  }
}
