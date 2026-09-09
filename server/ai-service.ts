import type { AuditEvent, Entity, User } from '../shared/types.ts'
import { manager, type Input } from './domain-common.ts'
import { HttpError, Store } from './store.ts'

const SETTINGS_ID = 'ai-connection'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

export interface AiSettings {
  baseUrl: string
  model: string
  visionModel: string
  configured: boolean
  hasApiKey: boolean
  source: 'environment' | 'settings' | 'none'
}
interface ConnectionFields { baseUrl: string; model: string; visionModel: string; apiKey: string }
interface StoredAiSettings extends Entity, ConnectionFields {}
export interface ResolvedAiSettings extends AiSettings { apiKey: string }
export interface AiMessage {
  role: 'system' | 'user'
  content: string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>
}

function settingText(value: unknown, label: string, max: number, status: number): string {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new HttpError(status, `${label}配置无效`)
  return value.trim()
}

function connectionFields(input: ConnectionFields, status = 400): ConnectionFields {
  const baseUrl = settingText(input.baseUrl, 'AI 服务地址', 2048, status)
  const model = settingText(input.model, 'AI 文本模型', 200, status)
  const visionModel = settingText(input.visionModel, 'AI 视觉模型', 200, status)
  const apiKey = settingText(input.apiKey, 'AI 密钥', 8192, status)
  let normalizedUrl = ''
  if (baseUrl) {
    let url: URL
    try { url = new URL(baseUrl) } catch { throw new HttpError(status, 'AI 服务地址配置无效') }
    if (!/^https?:\/\//i.test(baseUrl) || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || baseUrl.includes('?') || baseUrl.includes('#')) {
      throw new HttpError(status, 'AI 服务地址须为 HTTP 或 HTTPS，且不能包含账号、密码、查询参数或片段')
    }
    normalizedUrl = url.href.replace(/\/+$/, '')
  }
  return { baseUrl: normalizedUrl, model, visionModel, apiKey }
}

function safeSettings(fields: ConnectionFields, source: AiSettings['source']): AiSettings {
  return {
    baseUrl: fields.baseUrl, model: fields.model, visionModel: fields.visionModel || fields.model,
    configured: !!(fields.baseUrl && fields.model && fields.apiKey), hasApiKey: !!fields.apiKey, source,
  }
}

/** Server-only: never include this result in a response, report snapshot or audit event. */
export function resolveAiSettings(store: Store): ResolvedAiSettings {
  const saved = store.get<StoredAiSettings>('settings', SETTINGS_ID)
  const raw: ConnectionFields = saved ?? {
    baseUrl: process.env.AI_BASE_URL || '', model: process.env.AI_MODEL || '',
    visionModel: process.env.AI_VISION_MODEL || '', apiKey: process.env.AI_API_KEY || '',
  }
  const fields = connectionFields(raw, 503)
  const source = saved ? 'settings' : Object.values(raw).some(Boolean) ? 'environment' : 'none'
  return { ...safeSettings(fields, source), apiKey: fields.apiKey }
}

export function readAiSettings(store: Store): AiSettings {
  const resolved = resolveAiSettings(store)
  return safeSettings(resolved, resolved.source)
}

export function updateAiSettings(store: Store, actor: User, input: Input): AiSettings {
  manager(actor)
  if (input.clearApiKey !== undefined && typeof input.clearApiKey !== 'boolean') throw new HttpError(400, '清除密钥选项必须是布尔值')
  return store.transaction(() => {
    const saved = store.get<StoredAiSettings>('settings', SETTINGS_ID)
    const current = resolveAiSettings(store)
    const requestedKey = input.apiKey === undefined ? '' : settingText(input.apiKey, 'AI 密钥', 8192, 400)
    if (input.clearApiKey === true && requestedKey) throw new HttpError(400, '不能同时填写新密钥并清除密钥')
    const next = connectionFields({
      baseUrl: input.baseUrl === undefined ? current.baseUrl : input.baseUrl as string,
      model: input.model === undefined ? current.model : input.model as string,
      visionModel: input.visionModel === undefined ? saved?.visionModel ?? process.env.AI_VISION_MODEL ?? '' : input.visionModel as string,
      apiKey: input.clearApiKey === true ? '' : requestedKey || current.apiKey,
    })
    if (saved) store.update<StoredAiSettings>('settings', SETTINGS_ID, saved.version, next)
    else store.insert<StoredAiSettings>('settings', { id: SETTINGS_ID, ...next })
    const safe = safeSettings(next, 'settings')
    store.insert<AuditEvent>('events', {
      actorId: actor.id, entityType: 'aiSettings', entityId: SETTINGS_ID, action: 'update', reason: '',
      before: safeSettings(current, current.source), after: safe,
    })
    return safe
  })
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('AI request aborted'))
    work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
    if (signal.aborted) { abort(); return }
    signal.addEventListener('abort', abort, { once: true })
  })
}

async function responseText(response: Response, signal: AbortSignal): Promise<string> {
  const declaredSize = Number(response.headers.get('content-length'))
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    void response.body?.cancel().catch(() => {})
    throw new Error('AI response exceeds size limit')
  }
  if (!response.body) throw new Error('AI response has no body')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const part = await abortable(reader.read(), signal)
      if (part.done) break
      size += part.value.byteLength
      if (size > MAX_RESPONSE_BYTES) throw new Error('AI response exceeds size limit')
      chunks.push(part.value)
    }
    return Buffer.concat(chunks, size).toString('utf8')
  } finally {
    // Cancellation also releases a stalled or oversized upstream response.
    void reader.cancel().catch(() => {}).finally(() => reader.releaseLock())
  }
}

/** Only server-authorized callers may provide messages; returned JSON still needs domain validation. */
export async function callAiJson(store: Store, messages: AiMessage[], options: { vision?: boolean; timeoutMs?: number } = {}): Promise<unknown> {
  const settings = resolveAiSettings(store)
  if (!settings.configured) throw new HttpError(503, '尚未完整配置 AI 服务地址、模型和密钥')
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) throw new HttpError(400, 'AI 超时时间须为 1 至 120000 毫秒')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await abortable(fetch(`${settings.baseUrl}/chat/completions`, {
      method: 'POST', redirect: 'error', signal: controller.signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model: options.vision ? settings.visionModel : settings.model, temperature: 0, max_tokens: 8192,
        response_format: { type: 'json_object' }, messages }),
    }), controller.signal)
    if (!response.ok) {
      void response.body?.cancel().catch(() => {})
      throw new Error('AI upstream returned an unsuccessful status')
    }
    const envelope = JSON.parse(await responseText(response, controller.signal)) as { choices?: Array<{ message?: { content?: unknown } }> } | null
    const content = envelope?.choices?.[0]?.message?.content
    if (typeof content !== 'string' || !content.trim()) throw new Error('AI response has no JSON content')
    const trimmed = content.trim()
    const fenced = /^```(?:json)?[\t ]*\r?\n([\s\S]*?)\r?\n```$/i.exec(trimmed)
    return JSON.parse(fenced ? fenced[1] : trimmed)
  } catch {
    // Do not expose upstream bodies, request URLs, credentials or provider error messages.
    throw new HttpError(controller.signal.aborted ? 504 : 502, controller.signal.aborted
      ? 'AI 服务请求超时，请稍后重试' : 'AI 服务连接失败或响应格式无效，请检查配置后重试')
  } finally { clearTimeout(timeout) }
}

export async function testAiConnection(store: Store, actor: User): Promise<{ ok: true; model: string }> {
  manager(actor)
  const response = await callAiJson(store, [
    { role: 'system', content: '这是连接测试。只返回 JSON 对象 {"ok":true}。' },
    { role: 'user', content: '{"ping":true}' },
  ], { timeoutMs: 15_000 })
  if (!response || typeof response !== 'object' || Array.isArray(response) || (response as { ok?: unknown }).ok !== true) throw new HttpError(502, 'AI 服务未通过 JSON 连接测试')
  return { ok: true, model: resolveAiSettings(store).model }
}
