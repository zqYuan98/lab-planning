import { randomBytes, timingSafeEqual } from 'node:crypto'
import type { Entity, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { FollowupRequest, ProgressContent } from '../shared/collaboration.ts'
import type { ActionIntent, NativeActionInput, NativeIntentView, ExternalObjectLink } from '../shared/native-actions.ts'
import { Store, HttpError } from './store.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { getNotification, openNotification } from './notifications.ts'
import { CollaborationService } from './collaboration-service.ts'
import type { DingTalkNativeClient } from './dingtalk-native.ts'
import { getNativeSettings, nativeCapabilityState, verifiedNativeIdentity } from './native-settings.ts'
import { nativeClip, nativeHash } from './native-service.ts'

interface IntentSecret extends Entity { token: string; payloadHash: string }
function liveActor(store: Store, actor: User) { const current = store.get<User>('users', actor.id); if (!current || !canUseAccount(current) || current.role === 'observer') throw new HttpError(403, '当前账号不可操作'); return current }
function normalizedProgress(value: unknown): ProgressContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HttpError(400, '请提供明确的进展内容')
  const input = value as Record<string, unknown>, allowed = ['weeklyRecordId', 'weeklyRecordVersion', 'taskStatus', 'weekly', 'noteType', 'note', 'noChangeReason', 'nextAction', 'completionNote', 'evidenceUrl', 'blockerReason', 'blockerImpact', 'supportNeeded']
  if (Object.keys(input).some(key => !allowed.includes(key)) || JSON.stringify(value).length > 16_000) throw new HttpError(400, '进展字段超出原生操作范围')
  for (const [key, data] of Object.entries(input)) if (key !== 'weekly' && key !== 'weeklyRecordVersion' && typeof data !== 'string') throw new HttpError(400, '进展字段格式无效')
  if (input.weeklyRecordVersion !== undefined && (!Number.isSafeInteger(input.weeklyRecordVersion) || Number(input.weeklyRecordVersion) < 1)) throw new HttpError(400, '周安排版本无效')
  if (input.weekly !== undefined && (!input.weekly || typeof input.weekly !== 'object' || Array.isArray(input.weekly) || Object.entries(input.weekly).some(([key, data]) => !['status', 'actualOutcome', 'evidenceUrl', 'blocker', 'nextAction'].includes(key) || typeof data !== 'string'))) throw new HttpError(400, '本周进展字段无效')
  if (input.taskStatus !== undefined && !['todo', 'doing', 'blocked', 'done'].includes(String(input.taskStatus)) || input.noteType !== undefined && !['progress', 'no_change'].includes(String(input.noteType))) throw new HttpError(400, '进展状态无效')
  return structuredClone(input) as ProgressContent
}
export function createNativeIntent(store: Store, actor: User, input: NativeActionInput, client: DingTalkNativeClient, now = new Date(), outTrackId: string | null = null): NativeIntentView {
  actor = liveActor(store, actor)
  const settings = getNativeSettings(store), capability = nativeCapabilityState(store, client)
  if (!capability.card.enabled && !capability.robot.enabled || !settings.pilotUserIds.includes(actor.id)) throw new HttpError(409, '原生操作当前未启用')
  const identity = verifiedNativeIdentity(store, actor.id, client)
  if (!identity) throw new HttpError(409, '请先核验当前钉钉绑定')
  if (!input || !['acknowledge', 'progress', 'respond'].includes(input.kind) || typeof input.targetId !== 'string' || !input.targetId || input.targetId.length > 200 || typeof input.requestId !== 'string' || !/^[\w:.-]{1,160}$/.test(input.requestId)) throw new HttpError(400, '原生操作参数无效')
  const progress = input.kind === 'acknowledge' ? null : normalizedProgress(input.progress)
  const id = nativeHash([actor.id, input.requestId, settings.activationId]), payloadHash = nativeHash({ kind: input.kind, targetId: input.targetId, progress, outTrackId })
  return store.transaction(() => {
    const before = store.get<ActionIntent>('nativeActionIntents', id), secret = store.get<IntentSecret>('nativeIntentSecrets', id)
    if (before) {
      if (!secret || secret.payloadHash !== payloadHash) throw new HttpError(409, '同一请求标识对应的操作内容不同')
      if (before.expiresAt <= now.toISOString() || before.status !== 'pending') throw new HttpError(409, '该操作已处理或已过期，请重新生成')
      return { id, token: secret.token, summary: before.summary, expiresAt: before.expiresAt, kind: before.kind, targetId: before.targetId }
    }
    let summary = '', targetVersion = 0, taskVersion: number | null = null, confirmationToken: string | null = null
    if (input.kind === 'acknowledge') {
      const view = getNotification(store, actor, input.targetId)
      if (!view.canAcknowledge || !view.confirmationToken) throw new HttpError(409, '该安排无需确认或已有变化')
      summary = `确认知悉：${view.content?.items.map(item => item.title).join('、') ?? view.title}。确认不会完成任务或正式提报。`; targetVersion = view.version; confirmationToken = view.confirmationToken
    } else {
      const request = input.kind === 'respond' ? store.get<FollowupRequest>('followupRequests', input.targetId) : undefined
      if (input.kind === 'respond' && (!request || request.ownerId !== actor.id || request.status !== 'open')) throw new HttpError(409, '该催办当前不可回应')
      const taskId = request?.taskId ?? input.targetId, view = new CollaborationService(store, () => now).taskView(actor, taskId)
      if (view.task.ownerId !== actor.id || !view.enabled) throw new HttpError(403, '仅本人可通过原生入口提交此进展')
      if (progress?.weeklyRecordId) { const weekly = store.get<WeeklyRecord>('weeklyRecords', progress.weeklyRecordId); if (!weekly || weekly.taskId !== taskId || weekly.ownerId !== actor.id || weekly.version !== progress.weeklyRecordVersion) throw new HttpError(409, '周安排已变化，请重新核对') }
      targetVersion = request?.version ?? view.task.version; taskVersion = view.task.version
      const labels: Record<string, string> = { taskStatus: '任务状态', noteType: '记录类型', note: '进展说明', noChangeReason: '暂无变化的原因', nextAction: '下一步行动', completionNote: '完成说明', evidenceUrl: '成果链接', blockerReason: '阻塞原因', blockerImpact: '影响', supportNeeded: '需要的支持', status: '本周状态', actualOutcome: '本周成果', blocker: '本周阻塞' }
      const values: Record<string, string> = { todo: '待开始', doing: '进行中', blocked: '阻塞', done: '成员自报完成', progress: '进展记录', no_change: '暂无变化', planned: '已计划' }
      const describe = (data: Record<string, unknown>): string[] => Object.entries(data).flatMap(([key, value]) => key === 'weekly' ? describe(value as Record<string, unknown>) : ['weeklyRecordId', 'weeklyRecordVersion'].includes(key) ? [] : [`${labels[key] ?? key}：${typeof value === 'string' && ['taskStatus', 'noteType', 'status'].includes(key) ? values[value] ?? value : value}`])
      const weekly = progress?.weeklyRecordId ? store.get<WeeklyRecord>('weeklyRecords', progress.weeklyRecordId) : undefined
      summary = `${input.kind === 'respond' ? '回应催办' : '更新进展'}：${view.task.title}${weekly ? `\n对应周：${weekly.weekStart}` : ''}\n${describe(progress as Record<string, unknown>).join('\n')}`
    }
    if (Buffer.byteLength(summary) > 3000) throw new HttpError(400, '操作预览过长，请精简内容或进入平台提交')
    const token = randomBytes(32).toString('hex'), expiresAt = new Date(now.getTime() + 30 * 60000).toISOString()
    store.insert<ActionIntent>('nativeActionIntents', { id, recipientId: actor.id, bindingId: identity.identityId, bindingVersion: identity.bindingVersion, deploymentId: settings.deploymentId, activationId: settings.activationId, kind: input.kind, targetId: input.targetId, tokenHash: nativeHash(token), expiresAt, requestId: `native_${id}`, targetVersion, taskVersion, confirmationToken, progress, summary: nativeClip(summary, 3000), status: 'pending', result: '', outTrackId })
    store.insert<IntentSecret>('nativeIntentSecrets', { id, token, payloadHash })
    return { id, token, summary: nativeClip(summary, 3000), expiresAt, kind: input.kind, targetId: input.targetId }
  })
}
export function nativeIntentForCard(store: Store, link: ExternalObjectLink, intentId: string, now: Date) {
  const intent = store.get<ActionIntent>('nativeActionIntents', intentId), secret = store.get<IntentSecret>('nativeIntentSecrets', intentId)
  if (!intent || !secret || intent.status !== 'pending' || intent.expiresAt <= now.toISOString() || intent.recipientId !== link.recipientId || intent.bindingId !== link.bindingId || intent.bindingVersion !== link.bindingVersion || intent.deploymentId !== link.deploymentId || intent.activationId !== link.activationId || intent.outTrackId !== link.sourceId || Buffer.byteLength(intent.summary) > 1000) throw new HttpError(409, '卡片预览已失效或内容过长，请进入平台核对')
  return { intent, token: secret.token }
}
export function confirmNativeIntent(store: Store, actor: User, intentId: string, token: string, client: DingTalkNativeClient, now = new Date(), callback?: { outTrackId: string; alreadyHashed?: boolean }) {
  actor = liveActor(store, actor)
  const identity = verifiedNativeIdentity(store, actor.id, client), settings = getNativeSettings(store), caps = nativeCapabilityState(store, client)
  if (!identity || !caps.card.enabled && !caps.robot.enabled || !settings.pilotUserIds.includes(actor.id)) throw new HttpError(403, '当前身份或原生操作权限已失效')
  return store.transaction(() => {
    const intent = store.get<ActionIntent>('nativeActionIntents', intentId)
    if (!intent || intent.recipientId !== actor.id || intent.bindingId !== identity.identityId || intent.bindingVersion !== identity.bindingVersion || intent.deploymentId !== settings.deploymentId || intent.deploymentId !== process.env.DINGTALK_DEPLOYMENT_ID || intent.activationId !== settings.activationId) throw new HttpError(403, '该操作与当前有效身份不匹配')
    const supplied = callback?.alreadyHashed ? token : nativeHash(token)
    if (!/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(intent.tokenHash, 'hex'))) throw new HttpError(403, '动作凭据无效')
    if (callback) {
      const link = store.list<ExternalObjectLink>('nativeLinks').find(row => row.sourceId === callback.outTrackId)
      if (!link || link.recipientId !== actor.id || intent.outTrackId !== callback.outTrackId || link.bindingId !== identity.identityId) throw new HttpError(403, '卡片与当前操作不匹配')
    }
    if (intent.status === 'succeeded') return { id: intent.id, status: intent.status, result: intent.result }
    if (intent.status !== 'pending' || intent.expiresAt <= now.toISOString()) throw new HttpError(409, '动作已过期或已处理，请进入平台查看最新安排')
    if (intent.kind === 'acknowledge') {
      if (!intent.confirmationToken) throw new HttpError(409, '确认义务已变化')
      openNotification(store, actor, intent.targetId, true, intent.confirmationToken)
    } else if (intent.kind === 'progress') {
      new CollaborationService(store, () => now).recordProgress(actor, intent.targetId, { ...intent.progress, version: intent.taskVersion, requestId: intent.requestId })
    } else {
      new CollaborationService(store, () => now).respondFollowup(actor, intent.targetId, { version: intent.targetVersion, taskVersion: intent.taskVersion, progress: intent.progress, requestId: intent.requestId })
    }
    const result = intent.kind === 'acknowledge' ? '已确认知悉，执行和正式提报状态未改变' : intent.kind === 'respond' ? '催办回应已保存' : '进展已保存'
    store.update<ActionIntent>('nativeActionIntents', intent.id, intent.version, { status: 'succeeded', result })
    return { id: intent.id, status: 'succeeded' as const, result }
  })
}
