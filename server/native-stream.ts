import { DWClient, EventAck, TOPIC_CARD, TOPIC_ROBOT, type DWClientDownStream } from 'dingtalk-stream'
import type { Entity } from '../shared/types.ts'
import { Store } from './store.ts'
import { createDingTalkNativeClient, type DingTalkNativeClient } from './dingtalk-native.ts'
import { getNativeSettings, nativeCapabilityState } from './native-settings.ts'
import { receiveNativeStream } from './native-callbacks.ts'
import { reconcileNativeDepartures } from './native-reconcile.ts'

export interface NativeStreamClient {
  connected: boolean; registered: boolean
  config: { autoReconnect?: boolean; subscriptions: { type: string; topic: string }[] }
  registerAllEventListener(callback: (message: DWClientDownStream) => { status: EventAck }): unknown
  registerCallbackListener(topic: string, callback: (message: DWClientDownStream) => void): unknown
  socketCallBackResponse(messageId: string, result: unknown): void
  connect(): Promise<void>; disconnect(): void
}
export type NativeStreamFactory = (options: { clientId: string; clientSecret: string; keepAlive: boolean; debug: boolean }) => NativeStreamClient
// Keep the official handshake, TLS and ACK implementation; malformed frames must not crash the process.
export class GuardedStreamClient extends DWClient {
  private closed = false
  override disconnect() { this.closed = true; super.disconnect() }
  override _connect() { return this.closed ? Promise.resolve() : super._connect() }
  override onDownStream(data: string) { try { if (Buffer.byteLength(data) <= 256 * 1024) super.onDownStream(data) } catch { /* Ignore malformed transport frames without logging payloads. */ } }
}
interface StreamRuntime extends Entity { connected: boolean; reason: string }
/** Default-off; the returned stop function can be awaited by server shutdown. */
export function startNativeStream(store: Store, client: DingTalkNativeClient = createDingTalkNativeClient(), options: { factory?: NativeStreamFactory; clock?: () => Date; intervalMs?: number } = {}) {
  const factory = options.factory ?? (input => new GuardedStreamClient(input)), clock = options.clock ?? (() => new Date())
  let stopped = false, sdk: NativeStreamClient | undefined, signature = '', connecting = false, wasConnected = false
  const pending = new Set<Promise<unknown>>()
  const track = (promise: Promise<unknown>) => { pending.add(promise); void promise.finally(() => pending.delete(promise)); return promise }
  function runtime(connected: boolean, reason: string) {
    if (stopped) return
    const previous = store.get<StreamRuntime>('nativeRuntime', 'stream')
    if (previous?.connected === connected && previous.reason === reason && clock().getTime() - Date.parse(previous.updatedAt) < 60000) return
    if (previous) store.update<StreamRuntime>('nativeRuntime', previous.id, previous.version, { connected, reason })
    else store.insert<StreamRuntime>('nativeRuntime', { id: 'stream', connected, reason })
  }
  function refresh() {
    if (stopped) return
    const settings = getNativeSettings(store), caps = nativeCapabilityState(store, client)
    const flags = { events: caps.orgEvents.enabled || caps.todo.enabled && process.env.DINGTALK_NATIVE_STREAM_ENABLED === 'true', card: caps.card.enabled, robot: caps.robot.enabled }
    const enabled = flags.events || flags.card || flags.robot
    const nextSignature = enabled ? JSON.stringify([settings.activationId, flags, client.appId, client.corpId]) : ''
    if (signature !== nextSignature) { sdk?.disconnect(); sdk = undefined; signature = nextSignature; connecting = false; wasConnected = false }
    if (!enabled || !process.env.DINGTALK_CLIENT_ID || !process.env.DINGTALK_CLIENT_SECRET) { runtime(false, '原生接收未启用或尚未完成配置和验收'); return }
    if (!sdk) {
      sdk = factory({ clientId: process.env.DINGTALK_CLIENT_ID, clientSecret: process.env.DINGTALK_CLIENT_SECRET, keepAlive: true, debug: false })
      const connection = sdk
      // The SDK default subscriptions array is shared; replace it before registration.
      connection.config.subscriptions = flags.events ? [{ type: 'EVENT', topic: '*' }] : []
      connection.config.autoReconnect = false // This supervisor owns retries and shutdown.
      if (flags.events) connection.registerAllEventListener(message => {
        if (stopped || connection !== sdk) return { status: EventAck.LATER }
        try { receiveNativeStream(store, client, 'event', message, clock()); return { status: EventAck.SUCCESS } } catch { return { status: EventAck.LATER } }
      })
      for (const [key, topic] of [['card', TOPIC_CARD], ['robot', TOPIC_ROBOT]] as const) if (flags[key]) connection.registerCallbackListener(topic, message => {
        if (stopped || connection !== sdk) return
        try {
          const receipt = receiveNativeStream(store, client, key, message, clock())
          connection.socketCallBackResponse(message.headers.messageId, key === 'card' ? { cardData: { cardParamMap: { status: receipt.accepted ? '已收到操作，正在核验' : '操作不可用，请进入平台查看' } } } : {})
        } catch { /* Do not ACK failed persistence: the provider may safely retry the same event. */ }
      })
    }
    const connected = !!sdk.connected && !!sdk.registered
    runtime(connected, connected ? '官方Stream连接已注册；事件持久化后确认' : '正在建立官方Stream连接')
    if (connected && !wasConnected) void track(reconcileNativeDepartures(store, client, clock(), () => stopped, true).catch(() => {}))
    wasConnected = connected
    if (!sdk.connected && !connecting) {
      connecting = true; const connection = sdk
      void track(connection.connect().catch(() => {}).finally(() => { if (stopped || sdk !== connection) connection.disconnect(); else { connecting = false; runtime(connection.connected && connection.registered, connection.connected ? '连接已建立，等待注册确认' : '连接暂不可用，将自动重试') } }))
    }
  }
  const timer = setInterval(() => { try { refresh() } catch { /* Store shutdown is handled by stop. */ } }, options.intervalMs ?? 5000); timer.unref(); refresh()
  return async () => {
    if (stopped) return
    stopped = true; clearInterval(timer); sdk?.disconnect(); sdk = undefined
    // GuardedStreamClient prevents a delayed endpoint response from opening a socket after stop.
    // The SDK handshake has no timeout option; cap waiting, while its closed guard remains in force.
    let timeout: ReturnType<typeof setTimeout> | undefined
    const settled = await Promise.race([Promise.allSettled([...pending]).then(() => true), new Promise<boolean>(resolve => { timeout = setTimeout(() => resolve(false), 12000); timeout.unref() })])
    if (timeout) clearTimeout(timeout)
    const previous = store.get<StreamRuntime>('nativeRuntime', 'stream')
    if (previous) store.update<StreamRuntime>('nativeRuntime', previous.id, previous.version, { connected: false, reason: '接收连接已停止' })
    // Let the application's bounded shutdown fail closed instead of claiming a clean drain
    // while the official SDK still owns an outstanding HTTPS handshake.
    if (!settled) throw new Error('Stream连接尚未结束，保留数据库等待退出期限')
  }
}
