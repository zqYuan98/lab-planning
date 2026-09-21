import { DingTalkError } from './dingtalk.ts'
import { appOrigin } from './auth.ts'

export interface TodoCreate { unionId: string; sourceId: string; subject: string; detailUrl: { appUrl: string; pcUrl: string }; fields: { fieldKey: string; fieldValue: string }[]; dueTime?: number }
export interface TodoUpdate { unionId: string; taskId: string; subject: string; done: boolean; dueTime?: number; fields: { fieldKey: string; fieldValue: string }[] }
export interface TodoRemote { taskId: string; sourceId: string; subject: string; isDone: boolean; dueTime?: number; modifiedTime?: number }
export interface NativeCardInput { outTrackId: string; templateId: string; userid: string; params: Record<string, string> }
export interface NativeReply { userid?: string; webhook?: string; expiresAt?: number; text: string }
export interface DingTalkNativeClient {
  configured: boolean; corpId: string; appId: string
  verifyMember(userid: string): Promise<{ userid: string; unionId: string }>
  createTodo(input: TodoCreate): Promise<{ taskId: string }>
  updateTodo(input: TodoUpdate): Promise<void>
  deleteTodo(unionId: string, taskId: string): Promise<void>
  listTodos(unionId: string, nextToken?: string): Promise<{ items: TodoRemote[]; nextToken: string | null }>
  createCard(input: NativeCardInput): Promise<void>
  deliverCard(outTrackId: string, userid: string): Promise<{ carrierId: string | null }>
  updateCard(outTrackId: string, params: Record<string, string>): Promise<void>
  sendRobot(input: NativeReply): Promise<void>
  listLeaveRecords(startTime: string, endTime: string, nextToken?: string): Promise<{ records: { userid: string; leaveTime: string }[]; nextToken: string | null }>
}
const obj = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\s\x00-\x1f\x7f]/.test(value)
function invalid(): never { throw new DingTalkError('钉钉原生接口参数无效', 'definitive') }
function part(value: string) { if (!id(value)) invalid(); return encodeURIComponent(value) }
function requireTrue(value: unknown) { if (value !== true) throw new DingTalkError('钉钉原生操作返回结果不确定', 'unknown') }
export function nativeEntryUrl(value: string, env: NodeJS.ProcessEnv = process.env) {
  try {
    const origin = appOrigin(env.APP_ORIGIN), url = new URL(value)
    if (!origin || origin.protocol !== 'https:' || url.origin !== origin.origin || url.username || url.password || url.hash || url.pathname !== '/entry' || [...url.searchParams.keys()].some(key => key !== 'notificationId') || url.searchParams.getAll('notificationId').length !== 1 || !url.searchParams.get('notificationId') || Buffer.byteLength(url.href) > 1024) invalid()
    return url.href
  } catch { return invalid() }
}
function cardParams(params: Record<string, string>) {
  if (!obj(params) || Object.keys(params).length > 30 || Object.entries(params).some(([key, value]) => Buffer.byteLength(key) > 100 || typeof value !== 'string' || Buffer.byteLength(value) > 1024)) invalid()
  return params
}
/** Official API references checked 2026-09-20; this client never initiates requests at construction. */
export function createDingTalkNativeClient(options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; now?: () => number } = {}): DingTalkNativeClient {
  const env = options.env ?? process.env, fetcher = options.fetch ?? globalThis.fetch, now = options.now ?? Date.now
  const corpId = env.DINGTALK_CORP_ID?.trim() ?? '', appId = env.DINGTALK_CLIENT_ID?.trim() ?? '', secret = env.DINGTALK_CLIENT_SECRET?.trim() ?? ''
  const configured = !!(corpId && appId && secret)
  const tokens = new Map<'modern' | 'legacy', { value: string; expires: number }>()
  const refreshes = new Map<'modern' | 'legacy', Promise<string>>()
  async function request(url: URL, method: string, body?: unknown, token?: string, writing = false) {
    let response: Response, data: Record<string, unknown> | undefined
    try { response = await fetcher(url, { method, redirect: 'error', signal: AbortSignal.timeout(10_000), headers: { accept: 'application/json', ...(token ? { 'x-acs-dingtalk-access-token': token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }) }
    catch { throw new DingTalkError('钉钉原生请求未取得确定结果', writing ? 'unknown' : 'definitive', !writing) }
    try { const raw = await response.text(); if (raw.length > 1024 * 1024) throw new Error(); data = obj(JSON.parse(raw)) } catch { throw new DingTalkError('钉钉原生响应无法确认', writing ? 'unknown' : 'definitive', !writing) }
    if (!response.ok || !data || typeof data.errcode === 'number' && data.errcode !== 0) {
      const definite = response.status >= 400 && response.status < 500 || typeof data?.errcode === 'number' && data.errcode > 0
      throw new DingTalkError('钉钉原生接口拒绝或未确认请求', writing && !definite ? 'unknown' : 'definitive', response.status === 429 || !writing && response.status >= 500)
    }
    return data
  }
  async function token(kind: 'modern' | 'legacy') {
    if (!configured) throw new DingTalkError('钉钉原生能力尚未配置', 'definitive')
    const cached = tokens.get(kind)
    if (cached && cached.expires > now()) return cached.value
    const pending = refreshes.get(kind); if (pending) return pending
    const refresh = (async () => {
      let data: Record<string, unknown>
      if (kind === 'modern') data = await request(new URL('https://api.dingtalk.com/v1.0/oauth2/accessToken'), 'POST', { appKey: appId, appSecret: secret })
      else { const url = new URL('https://oapi.dingtalk.com/gettoken'); url.search = new URLSearchParams({ appkey: appId, appsecret: secret }).toString(); data = await request(url, 'GET') }
      const value = data[kind === 'modern' ? 'accessToken' : 'access_token'], ttl = data[kind === 'modern' ? 'expireIn' : 'expires_in']
      if (typeof value !== 'string' || !value || typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) throw new DingTalkError('钉钉原生凭证响应无效', 'definitive', true)
      tokens.set(kind, { value, expires: now() + ttl * 1000 - Math.min(60_000, ttl * 100) }); return value
    })()
    refreshes.set(kind, refresh)
    try { return await refresh } finally { refreshes.delete(kind) }
  }
  async function api(path: string, method: string, body?: unknown, writing = false) { return request(new URL(path, 'https://api.dingtalk.com'), method, body, await token('modern'), writing) }
  const todoFields = (fields: TodoCreate['fields']) => { if (!Array.isArray(fields) || fields.length > 10 || fields.some(field => !field.fieldKey || Buffer.byteLength(field.fieldKey) > 1024 || typeof field.fieldValue !== 'string' || Buffer.byteLength(field.fieldValue) > 1024)) invalid(); return fields }
  return {
    configured, corpId, appId,
    async verifyMember(userid) {
      part(userid)
      const url = new URL('https://oapi.dingtalk.com/topapi/v2/user/get'); url.searchParams.set('access_token', await token('legacy'))
      const data = await request(url, 'POST', { userid }), result = obj(data.result)
      if (result?.userid !== userid || !id(result.unionid)) throw new DingTalkError('钉钉成员身份无法核验', 'definitive')
      return { userid, unionId: result.unionid }
    },
    async createTodo(input) {
      if (!id(input.sourceId) || !input.subject.trim() || input.subject.length > 1024 || input.dueTime !== undefined && (!Number.isSafeInteger(input.dueTime) || input.dueTime < 0)) invalid()
      const data = await api(`/v1.0/todo/users/${part(input.unionId)}/tasks`, 'POST', { sourceId: input.sourceId, subject: input.subject, creatorId: input.unionId, executorIds: [input.unionId], isOnlyShowExecutor: true, detailUrl: { appUrl: nativeEntryUrl(input.detailUrl.appUrl, env), pcUrl: nativeEntryUrl(input.detailUrl.pcUrl, env) }, contentFieldList: todoFields(input.fields), ...(input.dueTime !== undefined ? { dueTime: input.dueTime } : {}), notifyConfigs: { dingNotify: '0', sendTodoApn: 'false', sendAssistantChat: 'false' } }, true)
      if (!id(data.id)) throw new DingTalkError('钉钉待办创建结果不确定', 'unknown')
      return { taskId: data.id }
    },
    async updateTodo(input) {
      if (!input.subject.trim() || input.subject.length > 1024 || typeof input.done !== 'boolean') invalid()
      const data = await api(`/v1.0/todo/users/${part(input.unionId)}/tasks/${part(input.taskId)}`, 'PUT', { subject: input.subject, done: input.done, contentFieldList: todoFields(input.fields), ...(input.dueTime !== undefined ? { dueTime: input.dueTime } : {}) }, true)
      requireTrue(data.result)
    },
    async deleteTodo(unionId, taskId) { const data = await api(`/v1.0/todo/users/${part(unionId)}/tasks/${part(taskId)}`, 'DELETE', undefined, true); requireTrue(data.result) },
    async listTodos(unionId, nextToken) {
      const data = await api(`/v1.0/todo/users/${part(unionId)}/org/tasks/query`, 'POST', { roleTypes: [['executor']], ...(nextToken ? { nextToken } : {}) })
      if (!Array.isArray(data.todoCards) || data.nextToken !== undefined && data.nextToken !== null && typeof data.nextToken !== 'string') throw new DingTalkError('钉钉待办列表响应无效', 'definitive')
      const items = data.todoCards.flatMap(value => { const row = obj(value); if (!row || !id(row.taskId) || typeof row.isDone !== 'boolean' || typeof row.subject !== 'string') throw new DingTalkError('钉钉待办列表响应无效', 'definitive'); if (!id(row.sourceId)) return []; return [{ taskId: row.taskId, sourceId: row.sourceId, isDone: row.isDone, subject: row.subject, ...(typeof row.dueTime === 'number' ? { dueTime: row.dueTime } : {}), ...(typeof row.modifiedTime === 'number' ? { modifiedTime: row.modifiedTime } : {}) }] })
      return { items, nextToken: typeof data.nextToken === 'string' && data.nextToken ? data.nextToken : null }
    },
    async createCard(input) {
      if (!id(input.outTrackId) || input.outTrackId.length > 100 || !id(input.templateId)) invalid(); part(input.userid)
      const data = await api('/v1.0/card/instances', 'POST', { outTrackId: input.outTrackId, cardTemplateId: input.templateId, userId: input.userid, userIdType: 1, callbackType: 'STREAM', cardData: { cardParamMap: cardParams(input.params) }, imRobotOpenSpaceModel: { supportForward: false, notification: { notificationOff: false } } }, true)
      requireTrue(data.success); if (data.result !== input.outTrackId) throw new DingTalkError('钉钉卡片创建结果不确定', 'unknown')
    },
    async deliverCard(outTrackId, userid) {
      part(outTrackId); part(userid); if (!env.DINGTALK_ROBOT_CODE) invalid()
      const data = await api('/v1.0/card/instances/deliver', 'POST', { outTrackId, userIdType: 1, openSpaceId: `dtv1.card//IM_ROBOT.${userid}`, imRobotOpenDeliverModel: { spaceType: 'IM_ROBOT', robotCode: env.DINGTALK_ROBOT_CODE } }, true)
      requireTrue(data.success)
      const rows = Array.isArray(data.result) ? data.result.map(obj) : [], delivered = rows.find(row => row?.spaceType === 'IM_ROBOT' && row.spaceId === userid)
      if (!delivered || delivered.success !== true) throw new DingTalkError('钉钉卡片投放未取得确定结果', delivered?.success === false ? 'definitive' : 'unknown')
      return { carrierId: typeof delivered.carrierId === 'string' ? delivered.carrierId : null }
    },
    async updateCard(outTrackId, params) { part(outTrackId); const data = await api('/v1.0/card/instances', 'PUT', { outTrackId, userIdType: 1, cardData: { cardParamMap: cardParams(params) }, cardUpdateOptions: { updateCardDataByKey: true } }, true); requireTrue(data.success); requireTrue(data.result) },
    async sendRobot(input) {
      if (typeof input.text !== 'string' || !input.text || Buffer.byteLength(input.text) > 4096) invalid()
      if (input.webhook) {
        const url = new URL(input.webhook)
        if (url.protocol !== 'https:' || url.hostname !== 'oapi.dingtalk.com' || url.port || url.username || url.password || !['/robot/sendBySession', '/robot/send'].includes(url.pathname) || url.hash || !input.expiresAt || input.expiresAt <= now()) invalid()
        const data = await request(url, 'POST', { msgtype: 'text', text: { content: input.text } }, undefined, true)
        if (data.errcode !== 0) throw new DingTalkError('钉钉机器人回复结果不确定', 'unknown')
      } else {
        if (!input.userid || !env.DINGTALK_ROBOT_CODE) invalid()
        part(input.userid)
        const data = await api('/v1.0/robot/oToMessages/batchSend', 'POST', { robotCode: env.DINGTALK_ROBOT_CODE, userIds: [input.userid], msgKey: 'sampleText', msgParam: JSON.stringify({ content: input.text }) }, true)
        if (Array.isArray(data.invalidStaffIdList) && data.invalidStaffIdList.includes(input.userid) || Array.isArray(data.flowControlledStaffIdList) && data.flowControlledStaffIdList.includes(input.userid)) throw new DingTalkError('钉钉机器人明确未接收成员消息', 'definitive')
        if (!id(data.processQueryKey)) throw new DingTalkError('钉钉机器人未返回受理凭据', 'unknown')
      }
    },
    async listLeaveRecords(startTime, endTime, nextToken = '0') {
      const start = Date.parse(startTime), end = Date.parse(endTime)
      if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end - start > 365 * 86400000) invalid()
      const query = new URLSearchParams({ startTime, endTime, nextToken, maxResults: '50' })
      const data = await api(`/v1.0/contact/empLeaveRecords?${query}`, 'GET')
      if (!Array.isArray(data.records)) throw new DingTalkError('钉钉离职记录响应无效', 'definitive')
      const records = data.records.map(value => { const row = obj(value); if (!row || !id(row.userId) || typeof row.leaveTime !== 'string' || !Number.isFinite(Date.parse(row.leaveTime))) throw new DingTalkError('钉钉离职记录响应无效', 'definitive'); return { userid: row.userId, leaveTime: new Date(row.leaveTime).toISOString() } })
      return { records, nextToken: typeof data.nextToken === 'string' && data.nextToken ? data.nextToken : null }
    },
  }
}
