import { createHash } from 'node:crypto'
import type { Entity } from '../shared/types.ts'
import { appOrigin } from './auth.ts'
import { dingTalkEntryLink } from '../shared/dingtalk-entry.ts'

export interface DingTalkIdentity extends Entity {
  provider: 'dingtalk'
  corpId: string
  userid: string
  userId: string
}

export interface DingTalkMessage {
  title: string
  body: string
  url: string
  buttonText?: string
  card?: {
    heading: string
    intro?: string
    items: { title: string; lines: string[] }[]
    footer?: string
    totalCount?: number
  }
}

export interface DingTalkClient {
  configured: boolean
  corpId: string
  clientId: string
  getIdentity(code: string): Promise<{ corpId: string; userid: string }>
  send(userid: string, message: DingTalkMessage): Promise<{ taskId: string }>
  result(taskId: string, userid: string): Promise<'delivered' | 'failed' | 'pending'>
}

/** Unknown means a send may have been accepted. It must never be resent automatically. */
export class DingTalkError extends Error {
  constructor(message: string, public outcome: 'definitive' | 'unknown', public retryable = false) {
    super(message)
    this.name = 'DingTalkError'
  }
}

export interface DingTalkClientOptions {
  env?: NodeJS.ProcessEnv
  fetch?: typeof globalThis.fetch
  now?: () => number
}

const API = 'https://oapi.dingtalk.com'
const MESSAGE_BYTES = 2048
const BUTTON_TEXTS = new Set(['查看工作安排', '查看并确认安排', '查看并确认原安排', '查看变更并确认', '查看变更', '查看本月安排', '查看目标变更', '查看并审核', '查看审核结果', '核对并正式提交', '查看摘要', '查看事项', '查看原安排', '更新进度并回应', '查看工作摘要', '处理延期申请', '查看延期结果', '核对支持请求', '查看定稿报告', '查看进展'])
const RETRYABLE_CODES = new Set([88, 90018, 90019, 90020, 130101, 40014, 42001])
const EXPIRED_TOKEN_CODES = new Set([40014, 42001])
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const validUserid = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s,\x00-\x1f\x7f]/.test(value)
const taskIdValue = (value: unknown): string | undefined => typeof value === 'string' && /^[1-9]\d{0,24}$/.test(value) ? value : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? String(value) : undefined
function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let result = '', bytes = 3 // Reserve the UTF-8 ellipsis; never split a Unicode character.
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8')
    if (bytes + size > maxBytes) break
    result += char
    bytes += size
  }
  return `${result}…`
}
function plainMarkdown(value: string): string {
  // Escape ASCII punctuation, including URL separators, so supplied text cannot
  // introduce links, images or HTML. Escape after truncation to keep pairs intact.
  return value.replace(/[\x21-\x2f\x3a-\x40\x5b-\x60\x7b-\x7e]/g, character => `\\${character}`)
}
function contentError(): never { throw new DingTalkError('钉钉通知内容格式无效', 'definitive') }
function budgetError(): never { throw new DingTalkError('钉钉通知的必要内容和完整入口超过消息预算', 'definitive') }
function payloadFor(title: string, markdown: string, url: string, buttonText: string) {
  return { msgtype: 'action_card' as const, action_card: { title, markdown, single_title: buttonText, single_url: url } }
}
function fits(payload: ReturnType<typeof payloadFor>) {
  return Buffer.byteLength(JSON.stringify(payload), 'utf8') <= MESSAGE_BYTES
}

/** Business fragments are plain text; only this module adds Markdown structure. */
function safeFragment(value: string) {
  return value
    .replace(/[\uD800-\uDFFF]/gu, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '（附件已附，进入查看）')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]*>/g, '')
    .replace(/(?:https?|ftp):\/\/[^\s<>"'）)\]】]+|www\.[^\s<>"'）)\]】]+/gi, '（链接已附，进入查看）')
    .replace(/\b(?:mailto|javascript|data):[^\s<>]+/gi, '（链接已省略）')
    .replace(/@/g, '＠')
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .replace(/\s+/g, ' ').trim()
}

function validatedEntry(value: string, env: NodeJS.ProcessEnv) {
  try {
    const canonical = appOrigin(env.APP_ORIGIN)
    if (!canonical) throw new Error()
    return dingTalkEntryLink(value, { origin: canonical.origin, agentId: env.DINGTALK_AGENT_ID, corpId: env.DINGTALK_CORP_ID, enabled: env.DINGTALK_APPLINK_ENABLED === 'true' })
  } catch { throw new DingTalkError('钉钉通知需要配置 HTTPS 同源事项入口', 'definitive') }
}

function renderStructured(message: DingTalkMessage, title: string, url: string, buttonText: string) {
  const source = message.card!
  const validText = (value: unknown, max = 32_000): value is string => typeof value === 'string' && value.length <= max
  if (!record(source) || !validText(source.heading, 16_000) || !source.heading.trim() || !Array.isArray(source.items) || source.items.length > 1000 || (source.intro !== undefined && !validText(source.intro)) || (source.footer !== undefined && !validText(source.footer)) || (source.totalCount !== undefined && (!Number.isSafeInteger(source.totalCount) || source.totalCount < source.items.length))) contentError()
  for (const item of source.items) {
    if (!record(item) || !validText(item.title, 16_000) || !item.title.trim() || !Array.isArray(item.lines) || item.lines.length > 100 || !item.lines.every(line => validText(line))) contentError()
  }
  const heading = safeFragment(source.heading)
  const items = source.items.slice(0, 3).map(item => ({ title: safeFragment(item.title), lines: item.lines.map(safeFragment).filter(Boolean) }))
  if (!heading || items.some(item => !item.title)) contentError()
  const intro = source.intro ? safeFragment(source.intro) : ''
  const footer = source.footer ? safeFragment(source.footer) : ''
  const totalCount = source.totalCount ?? source.items.length
  let count = items.length, lineBytes = 4096, contextBytes = 4096, titleBytes = 256
  // Preserve all actual deadline values, including changes with both old and new dates.
  const isDeadline = (line: string) => /截止|期限|到期/.test(line.split(/[:：]/, 1)[0])
    || /^(?:\d{4}-\d{2}-\d{2}|截至(?:时间|时点)?[：:]|最近(?:有效)?(?:进展|更新)(?:时间)?[：:])/.test(line)
  function render() {
    let truncated = totalCount > count
    const clip = (value: string, bytes: number) => {
      const clipped = truncateUtf8(value, bytes)
      truncated ||= clipped !== value
      return clipped
    }
    const clipLine = (line: string) => {
      if (isDeadline(line) || Buffer.byteLength(line, 'utf8') <= lineBytes) return line
      const arrow = line.indexOf('→'), colon = line.search(/[:：]/)
      // A long old value must not hide the new requirement after the arrow.
      if (arrow >= 0) {
        const label = colon >= 0 && colon < arrow ? clip(line.slice(0, colon + 1), 48) : ''
        const oldValue = line.slice(label ? colon + 1 : 0, arrow).trim()
        const newValue = line.slice(arrow + 1).trim()
        const valueBytes = Math.max(9, Math.floor((lineBytes - Buffer.byteLength(label, 'utf8') - 5) / 2))
        return `${label}${clip(oldValue, valueBytes)} → ${clip(newValue, valueBytes)}`
      }
      return clip(line, lineBytes)
    }
    const renderedTitle = clip(title, titleBytes)
    const renderedHeading = clip(heading, titleBytes)
    const body = [renderedHeading]
    const markdown = [`### ${plainMarkdown(renderedHeading)}`]
    for (const value of [clip(intro, contextBytes)]) if (value) { body.push(value); markdown.push(plainMarkdown(value)) }
    for (const item of items.slice(0, count)) {
      const itemTitle = clip(item.title, titleBytes)
      const lines = item.lines.map(clipLine)
      body.push([itemTitle, ...lines].join('\n'))
      markdown.push([`**${plainMarkdown(itemTitle)}**`, ...lines.map(plainMarkdown)].join('\n\n'))
    }
    if (totalCount > count) {
      const remaining = `另有 ${totalCount - count} 项，查看全部`
      body.push(remaining); markdown.push(remaining)
    }
    const renderedFooter = clip(footer, contextBytes)
    if (renderedFooter) { body.push(renderedFooter); markdown.push(plainMarkdown(renderedFooter)) }
    return { payload: payloadFor(renderedTitle, markdown.join('\n\n'), url, buttonText), body: body.join('\n\n'), title: renderedTitle, truncated }
  }
  let rendered = render()
  if (fits(rendered.payload)) return rendered
  // Context/notes yield first. Shorten requirements before reducing the item count;
  // headings and identifiers are the last text that may be shortened.
  contextBytes = 180
  rendered = render()
  if (fits(rendered.payload)) return rendered
  for (const bytes of [512, 320, 192, 120, 72]) {
    lineBytes = bytes
    rendered = render()
    if (fits(rendered.payload)) return rendered
  }
  while (count > 1) {
    count--
    rendered = render()
    if (fits(rendered.payload)) return rendered
  }
  for (const bytes of [160, 96, 48]) {
    titleBytes = bytes
    rendered = render()
    if (fits(rendered.payload)) return rendered
  }
  return budgetError()
}

/** Pure final rendering, shared by previews, stored delivery snapshots and send. */
export function prepareDingTalkMessage(message: DingTalkMessage, env: NodeJS.ProcessEnv = process.env) {
  const url = validatedEntry(message.url, env)
  if (typeof message.title !== 'string' || typeof message.body !== 'string' || !message.title.trim() || !message.body.trim() || message.title.length > 16_000 || message.body.length > 32_000) contentError()
  const buttonText = message.buttonText ?? '查看工作安排'
  if (!BUTTON_TEXTS.has(buttonText)) contentError()
  const rawTitle = message.card ? safeFragment(message.title) : message.title.replace(/[\x00-\x1f\x7f]/g, ' ')
  if (!rawTitle.trim()) contentError()
  let prepared: { payload: ReturnType<typeof payloadFor>; body: string; title: string; truncated: boolean }
  if (message.card !== undefined) {
    prepared = renderStructured(message, rawTitle, url, buttonText)
  } else {
    const title = truncateUtf8(rawTitle, 256)
    let body = truncateUtf8(message.body, 4096)
    let payload = payloadFor(title, plainMarkdown(body), url, buttonText)
    if (!fits(payload)) {
      const chars = Array.from(body)
      let low = 1, high = chars.length - 1, best = ''
      while (low <= high) {
        const middle = Math.floor((low + high) / 2)
        const candidate = `${chars.slice(0, middle).join('')}…`
        if (fits(payloadFor(title, plainMarkdown(candidate), url, buttonText))) { best = candidate; low = middle + 1 } else high = middle - 1
      }
      if (!best) budgetError()
      body = best
      payload = payloadFor(title, plainMarkdown(body), url, buttonText)
    }
    prepared = { payload, body, title, truncated: title !== rawTitle || body !== message.body }
  }
  return { ...prepared, buttonText, url, payloadHash: createHash('sha256').update(JSON.stringify(prepared.payload)).digest('hex') }
}

/**
 * Internal H5 app API, not personal OAuth or administrator SSO.
 * Official reference: https://github.com/open-dingtalk/h5app-auth-demo
 * https://open.dingtalk.com/document/orgapp/asynchronous-sending-of-enterprise-session-messages
 * https://open.dingtalk.com/document/orgapp/message-types-and-data-format
 * https://open.dingtalk.com/document/orgapp/gets-the-result-of-sending-messages-asynchronously-to-the-enterprise
 * No API call is made at construction; token refreshes are coalesced and no send is retried here.
 */
export function createDingTalkClient(options: DingTalkClientOptions = {}): DingTalkClient {
  const env = options.env ?? process.env
  const fetcher = options.fetch ?? globalThis.fetch
  const now = options.now ?? Date.now
  const corpId = env.DINGTALK_CORP_ID?.trim() ?? ''
  const clientId = env.DINGTALK_CLIENT_ID?.trim() ?? ''
  const secret = env.DINGTALK_CLIENT_SECRET?.trim() ?? ''
  const agentId = env.DINGTALK_AGENT_ID?.trim() ?? ''
  const configured = !!(corpId && clientId && secret && /^[1-9]\d{0,14}$/.test(agentId))
  let cached: { value: string; expiresAt: number } | undefined
  let refreshing: Promise<string> | undefined

  async function request(url: URL, body: unknown, sending = false): Promise<Record<string, unknown>> {
    const outcome = sending ? 'unknown' : 'definitive'
    let response: globalThis.Response
    try {
      response = await fetcher(url, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) })
    } catch { throw new DingTalkError('钉钉服务请求未取得确定结果', outcome, !sending) }
    // HTTP errors, truncation, malformed data and missing task IDs cannot prove non-acceptance.
    if (!response.ok) throw new DingTalkError('钉钉服务暂时无法处理请求', outcome, !sending)
    let data: Record<string, unknown> | undefined
    try {
      const raw = await response.text()
      if (raw.length > 1024 * 1024) throw new Error()
      // The provider's task_id is a long. Preserve digits beyond JavaScript's safe integer range.
      data = record(JSON.parse(raw.replace(/("task_id"\s*:\s*)(\d{16,})(?=\s*[,}])/g, '$1"$2"')))
    } catch { throw new DingTalkError('钉钉服务返回了无法确认的结果', outcome, !sending) }
    if (!data || !Number.isSafeInteger(data.errcode)) throw new DingTalkError('钉钉服务返回了无法确认的结果', outcome, !sending)
    const code = data.errcode as number
    if (code !== 0) {
      if (EXPIRED_TOKEN_CODES.has(code)) cached = undefined
      // Provider system-busy errors do not establish whether an async send was committed.
      if (code < 0 && sending) throw new DingTalkError('钉钉发送结果尚不确定', 'unknown')
      throw new DingTalkError(`钉钉接口拒绝请求（${code}）`, 'definitive', RETRYABLE_CODES.has(code) || code < 0)
    }
    return data
  }

  async function token(): Promise<string> {
    if (!configured) throw new DingTalkError('钉钉企业应用尚未完成配置', 'definitive')
    if (cached && cached.expiresAt > now()) return cached.value
    if (refreshing) return refreshing
    const refresh = (async () => {
      const url = new URL('/gettoken', API)
      url.search = new URLSearchParams({ appkey: clientId, appsecret: secret }).toString()
      const data = await request(url, undefined)
      if (typeof data.access_token !== 'string' || !data.access_token || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new DingTalkError('钉钉凭证响应无效', 'definitive', true)
      const lifetime = data.expires_in * 1000
      cached = { value: data.access_token, expiresAt: now() + lifetime - Math.min(60_000, lifetime / 10) }
      return cached.value
    })()
    refreshing = refresh
    try { return await refresh } finally { if (refreshing === refresh) refreshing = undefined }
  }

  async function post(path: string, body: unknown, sending = false) {
    // Failure before acquiring a token is known not to have sent a notification.
    const accessToken = await token()
    const url = new URL(path, API)
    url.searchParams.set('access_token', accessToken)
    return request(url, body, sending)
  }

  return {
    configured, corpId, clientId,
    async getIdentity(code) {
      if (typeof code !== 'string' || !code || code.length > 2048 || /\s/.test(code)) throw new DingTalkError('钉钉授权码无效，请重新打开应用', 'definitive')
      const data = await post('/topapi/v2/user/getuserinfo', { code })
      const identity = record(data.result)
      if (!validUserid(identity?.userid)) throw new DingTalkError('钉钉未返回有效的企业成员身份', 'definitive')
      // getuserinfo is scoped by the internal app's enterprise access_token.
      // If a future provider response supplies a corp ID, it must agree with that scope.
      if (identity.corp_id !== undefined && identity.corp_id !== corpId || identity.corpId !== undefined && identity.corpId !== corpId) throw new DingTalkError('钉钉企业身份不匹配', 'definitive')
      return { corpId, userid: identity.userid }
    },
    async send(userid, message) {
      if (!validUserid(userid)) throw new DingTalkError('钉钉接收人无效', 'definitive')
      const prepared = prepareDingTalkMessage(message, env)
      const data = await post('/topapi/message/corpconversation/asyncsend_v2', {
        agent_id: Number(agentId), userid_list: userid, to_all_user: false,
        msg: prepared.payload,
      }, true)
      const taskId = taskIdValue(data.task_id)
      if (!taskId) throw new DingTalkError('钉钉已受理但未返回有效任务编号', 'unknown')
      return { taskId }
    },
    async result(taskId, userid) {
      if (!taskIdValue(taskId) || !validUserid(userid)) throw new DingTalkError('钉钉结果查询参数无效', 'definitive')
      const data = await post('/topapi/message/corpconversation/getsendresult', { agent_id: Number(agentId), task_id: taskId })
      const result = record(data.send_result)
      if (!result) return 'pending'
      const contains = (key: string) => Array.isArray(result[key]) && (result[key] as unknown[]).includes(userid)
      if (['failed_user_id_list', 'invalid_user_id_list', 'forbidden_user_id_list'].some(contains)) return 'failed'
      if (Array.isArray(result.forbidden_list) && result.forbidden_list.some(item => record(item)?.userid === userid)) return 'failed'
      // Only explicit membership proves success. An empty failure list proves nothing.
      if (['read_user_id_list', 'unread_user_id_list'].some(contains)) return 'delivered'
      return 'pending'
    },
  }
}
