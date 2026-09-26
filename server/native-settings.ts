import { randomUUID } from 'node:crypto'
import type { User, Entity } from '../shared/types.ts'
import type { NativeSettings, NativeSettingsView, NativeCapability, NativeVerifiedIdentity, ChannelOperation, ExternalObjectLink } from '../shared/native-actions.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import type { DingTalkIdentity } from './dingtalk.ts'
import type { DingTalkNativeClient } from './dingtalk-native.ts'
import { appOrigin } from './auth.ts'
import { HttpError, Store } from './store.ts'
import { isManager } from './authorization.ts'

export const nativeCapabilities: NativeCapability[] = ['identity', 'todo', 'card', 'robot', 'orgEvents', 'leaveSync']
export function nativeManager(store: Store, actor: User) { const current = store.get<User>('users', actor.id); if (!current || !canUseAccount(current) || !isManager(current)) throw new HttpError(403, '仅管理者可配置原生能力'); return current }
export function getNativeSettings(store: Store): NativeSettings {
  return store.get<NativeSettings>('nativeSettings', 'native') ?? { id: 'native', version: 0, createdAt: '', updatedAt: '', todoEnabled: false, cardEnabled: false, robotEnabled: false, orgEventsEnabled: false, leaveSyncEnabled: false, primaryChannel: 'work_notification', pilotUserIds: [], verifiedCapabilities: [], verificationNote: '', enabledAt: null, activationId: '', deploymentId: '', fallbackEnabled: true }
}
export function nativeCapabilityState(store: Store, client: DingTalkNativeClient, env = process.env): NativeSettingsView['capabilities'] {
  const settings = getNativeSettings(store)
  let origin = false; try { origin = appOrigin(env.APP_ORIGIN)?.protocol === 'https:' } catch { /* Show a configuration reason, never credentials. */ }
  const base = client.configured && env.DINGTALK_NATIVE_ENABLED === 'true' && !!env.DINGTALK_DEPLOYMENT_ID && origin
  const configured: Record<NativeCapability, boolean> = { identity: base, todo: base, card: base && !!env.DINGTALK_CARD_TEMPLATE_ID && !!env.DINGTALK_ROBOT_CODE && env.DINGTALK_NATIVE_STREAM_ENABLED === 'true', robot: base && !!env.DINGTALK_ROBOT_CODE && env.DINGTALK_NATIVE_STREAM_ENABLED === 'true', orgEvents: base && env.DINGTALK_NATIVE_STREAM_ENABLED === 'true', leaveSync: base }
  const flags: Record<NativeCapability, boolean> = { identity: true, todo: settings.todoEnabled, card: settings.cardEnabled, robot: settings.robotEnabled, orgEvents: settings.orgEventsEnabled, leaveSync: settings.leaveSyncEnabled }
  return Object.fromEntries(nativeCapabilities.map(key => { const verified = settings.verifiedCapabilities.includes(key); const enabled = configured[key] && verified && flags[key] && settings.deploymentId === env.DINGTALK_DEPLOYMENT_ID; return [key, { configured: configured[key], verified, enabled, reason: !configured[key] ? '服务器配置、HTTPS入口或该渠道所需参数尚未完成' : !verified ? '尚未完成本企业权限和客户端验收' : !enabled ? '能力已关闭或部署代际已变化' : '已启用；接口送达状态单独记录' }] })) as NativeSettingsView['capabilities']
}
export function nativeBinding(store: Store, userId: string, corpId = process.env.DINGTALK_CORP_ID): DingTalkIdentity | undefined {
  const matches = store.list<DingTalkIdentity>('externalIdentities').filter(row => row.provider === 'dingtalk' && row.corpId === corpId && row.userId === userId)
  return matches.length === 1 ? matches[0] : undefined
}
export function verifiedNativeIdentity(store: Store, userId: string, client: Pick<DingTalkNativeClient, 'corpId' | 'appId'>): NativeVerifiedIdentity | undefined {
  const user = store.get<User>('users', userId), binding = nativeBinding(store, userId, client.corpId)
  if (!user || !canUseAccount(user) || !binding) return
  return store.list<NativeVerifiedIdentity>('nativeIdentities').find(row => row.userId === userId && row.identityId === binding.id && row.bindingVersion === binding.version && row.corpId === client.corpId && row.appId === client.appId && row.userid === binding.userid && row.developerScope === (process.env.DINGTALK_DEVELOPER_SCOPE?.trim() || client.corpId) && !row.suspendedAt)
}
export function updateNativeSettings(store: Store, actor: User, input: Record<string, unknown>, client: DingTalkNativeClient, now = new Date()) {
  nativeManager(store, actor)
  return store.transaction(() => {
    const current = getNativeSettings(store)
    if (input.version !== current.version) throw new HttpError(409, '原生渠道配置已更新，请刷新')
    const flags = ['todoEnabled', 'cardEnabled', 'robotEnabled', 'orgEventsEnabled', 'leaveSyncEnabled', 'fallbackEnabled'] as const
    if (flags.some(key => typeof input[key] !== 'boolean') || !['work_notification', 'todo', 'card'].includes(String(input.primaryChannel)) || !Array.isArray(input.pilotUserIds) || input.pilotUserIds.length > 100 || input.pilotUserIds.some(id => typeof id !== 'string') || !Array.isArray(input.verifiedCapabilities) || input.verifiedCapabilities.some(key => !nativeCapabilities.includes(key as NativeCapability)) || typeof input.verificationNote !== 'string' || input.verificationNote.length > 1000) throw new HttpError(400, '请提供完整且有效的渠道配置')
    if (input.verifiedCapabilities.length && !input.verificationNote.trim()) throw new HttpError(400, '请记录真实租户验收日期和结果')
    const pilots = [...new Set(input.pilotUserIds as string[])]; for (const id of pilots) { const user = store.get<User>('users', id); if (!user || !canUseAccount(user)) throw new HttpError(400, '试点成员必须为有效账号') }
    const capabilities = nativeCapabilityState(store, client)
    const enabled = (['todo', 'card', 'robot', 'orgEvents', 'leaveSync'] as const).filter(key => input[`${key}Enabled`])
    if (enabled.some(key => !capabilities[key].configured || !(input.verifiedCapabilities as string[]).includes(key)) || enabled.length && (!pilots.length || !input.verifiedCapabilities.includes('identity'))) throw new HttpError(400, '启用前请完成服务器配置、身份及对应渠道的真实验收，并选择试点成员')
    if (input.primaryChannel !== 'work_notification' && !input[`${input.primaryChannel}Enabled`]) throw new HttpError(400, '主渠道必须处于启用状态')
    const shape = { todoEnabled: input.todoEnabled as boolean, cardEnabled: input.cardEnabled as boolean, robotEnabled: input.robotEnabled as boolean, orgEventsEnabled: input.orgEventsEnabled as boolean, leaveSyncEnabled: input.leaveSyncEnabled as boolean, fallbackEnabled: input.fallbackEnabled as boolean, primaryChannel: input.primaryChannel as NativeSettings['primaryChannel'], pilotUserIds: pilots, verifiedCapabilities: [...new Set(input.verifiedCapabilities)] as NativeCapability[], verificationNote: input.verificationNote.trim() }
    const changed = Object.entries(shape).some(([key, value]) => JSON.stringify(current[key as keyof NativeSettings]) !== JSON.stringify(value)) || current.deploymentId !== process.env.DINGTALK_DEPLOYMENT_ID
    const fields = { ...shape, enabledAt: changed && enabled.length ? now.toISOString() : current.enabledAt, activationId: changed ? randomUUID() : current.activationId, deploymentId: process.env.DINGTALK_DEPLOYMENT_ID ?? '' }
    const next = current.version ? store.update<NativeSettings>('nativeSettings', current.id, current.version, fields) : store.insert<NativeSettings>('nativeSettings', { id: 'native', ...fields })
    if (changed) for (const operation of store.list<ChannelOperation>('nativeOperations')) if (operation.status === 'pending') store.update<ChannelOperation>('nativeOperations', operation.id, operation.version, { status: 'cancelled', lastError: '配置代际已变更，旧操作不会补发' })
    store.insert<Entity & { actorId: string; action: string; activationId: string }>('nativeAdminEvents', { actorId: actor.id, action: 'settings_updated', activationId: next.activationId })
    return next
  })
}
export async function verifyNativeIdentity(store: Store, actor: User, userId: string, client: DingTalkNativeClient, now = new Date()) {
  if (actor.id !== userId) nativeManager(store, actor)
  if (!nativeCapabilityState(store, client).identity.configured) throw new HttpError(409, '原生身份能力尚未配置')
  const user = store.get<User>('users', userId), binding = nativeBinding(store, userId, client.corpId)
  if (!user || !canUseAccount(user) || !binding) throw new HttpError(409, '请先完成当前有效账号的钉钉绑定')
  const verified = await client.verifyMember(binding.userid)
  if (verified.userid !== binding.userid || !verified.unionId) throw new HttpError(409, '成员身份核验不一致')
  return store.transaction(() => {
    const current = nativeBinding(store, userId, client.corpId), account = store.get<User>('users', userId)
    if (!current || current.id !== binding.id || current.version !== binding.version || !account || !canUseAccount(account)) throw new HttpError(409, '核验期间账号或绑定已变化')
    const fields = { userId, identityId: binding.id, bindingVersion: binding.version, corpId: client.corpId, appId: client.appId, developerScope: process.env.DINGTALK_DEVELOPER_SCOPE?.trim() || client.corpId, userid: binding.userid, unionId: verified.unionId, verifiedAt: now.toISOString(), suspendedAt: null, suspensionReason: '' }
    const existing = store.get<NativeVerifiedIdentity>('nativeIdentities', binding.id)
    return existing ? store.update<NativeVerifiedIdentity>('nativeIdentities', existing.id, existing.version, fields) : store.insert<NativeVerifiedIdentity>('nativeIdentities', { id: binding.id, ...fields })
  })
}
export function nativeSettingsView(store: Store, actor: User, client: DingTalkNativeClient): NativeSettingsView {
  nativeManager(store, actor)
  const operations = store.list<ChannelOperation>('nativeOperations'), links = store.list<ExternalObjectLink>('nativeLinks')
  const runtime = store.get<Entity & { connected: boolean; reason: string }>('nativeRuntime', 'stream')
  return { settings: getNativeSettings(store), capabilities: nativeCapabilityState(store, client), identities: store.list<User>('users').map(user => { const verified = verifiedNativeIdentity(store, user.id, client), any = store.list<NativeVerifiedIdentity>('nativeIdentities').find(row => row.userId === user.id); return { userId: user.id, verified: !!verified, suspended: !!any?.suspendedAt, verifiedAt: verified?.verifiedAt ?? null } }), counts: { pending: operations.filter(row => row.status === 'pending' || row.status === 'sending').length, failed: operations.filter(row => row.status === 'failed').length, unknown: operations.filter(row => row.status === 'unknown').length, mismatches: links.filter(row => ['mismatch', 'external_missing', 'isolated'].includes(row.state)).length, inboxPending: store.list<{ status: string }>('nativeCallbackInbox').filter(row => row.status === 'pending').length }, stream: { connected: runtime?.connected ?? false, updatedAt: runtime?.updatedAt ?? null, reason: runtime?.reason ?? '尚未启动接收连接' } }
}
