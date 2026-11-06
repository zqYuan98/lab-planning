import { createHash } from 'node:crypto'
import type { DingTalkSheetSnapshot } from '../shared/dingtalk-documents.ts'
import type { DingTalkDocumentCandidate, DingTalkDocumentDiscovery, DingTalkDocumentStatus } from '../shared/dingtalk-monthly-api.ts'
import { monthlySourceRule } from './dingtalk-monthly-mapping.ts'

export interface DingTalkDocumentsClient {
  status(): DingTalkDocumentStatus
  discover(month: string, documentUrl?: string): Promise<Omit<DingTalkDocumentDiscovery, 'id'>>
  read(candidate: DingTalkDocumentCandidate, month: string): Promise<DingTalkSheetSnapshot>
}
export class DingTalkDocumentError extends Error {
  constructor(readonly code: string, message: string, readonly status = 502, readonly retryable = false) {
    super(message); this.name = 'DingTalkDocumentError'
  }
}
interface Options { env?: NodeJS.ProcessEnv; fetch?: typeof globalThis.fetch; now?: () => number }
interface NodeInfo { nodeId: string; name: string; type: 'FILE' | 'FOLDER'; category?: string; extension?: string; modifiedAt?: string; hasChildren?: boolean }
interface SheetInfo { id: string; name: string; lastNonEmptyRow: number; lastNonEmptyColumn: number; rowCount: number; columnCount: number }
const DEFAULT_FOLDER = 'YQBnd5ExVE1BK3vlhadjO74MVyeZqMmz'
const MERGES_WARNING = '钉钉开放接口未提供合并区域信息；空单元格不会自动继承，缺失字段须逐行核对。'
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024
const object = (v: unknown): Record<string, unknown> | undefined => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined
const validId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(v)
const cleanName = (v: string) => v.normalize('NFKC').trim().replace(/\s+/g, '')
// Wiki node metadata includes the native extension in its business name.
const cleanDocumentTitle = (v: string) => cleanName(v).replace(/\.axls$/i, '')
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex')
function fail(code: string, message: string, status = 502): never { throw new DingTalkDocumentError(code, message, status) }
function columnName(number: number): string {
  let value = '', remaining = number
  while (remaining > 0) { remaining--; value = String.fromCharCode(65 + remaining % 26) + value; remaining = Math.floor(remaining / 26) }
  return value
}
function documentIdFromUrl(value: string): string {
  try {
    const url = new URL(value)
    const match = /^\/i\/nodes\/([A-Za-z0-9_-]{1,256})\/?$/.exec(url.pathname)
    if (url.protocol !== 'https:' || url.hostname !== 'alidocs.dingtalk.com' || url.port || url.username || url.password || !match) throw new Error()
    // Sharing attribution is harmless; credentials and arbitrary URL shapes are not accepted.
    if ([...url.searchParams.keys()].some(key => key !== 'utm_scene')) throw new Error()
    return match[1]
  } catch { return fail('DINGTALK_DOCUMENT_URL_INVALID', '请填写钉钉文档的完整 HTTPS 节点链接', 400) }
}
function limit(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const value = Number(env[key])
  return Number.isSafeInteger(value) && value >= 1 ? Math.min(value, fallback) : fallback
}

/**
 * Read-only wire contracts checked against official Markdown on 2026-11-06:
 * get-node-list.md, obtain-all-worksheets.md, obtain-worksheet-properties.md,
 * get-cell-properties.md. Those explicitly identify nodeId(dentryUuid) as workbookId.
 * No application credentials, operator identifiers, or provider response bodies leave this client.
 */
export function createDingTalkDocumentsClient(options: Options = {}): DingTalkDocumentsClient {
  const env = options.env ?? process.env, fetcher = options.fetch ?? globalThis.fetch, now = options.now ?? Date.now
  const corpId = env.DINGTALK_CORP_ID?.trim() ?? '', appId = env.DINGTALK_CLIENT_ID?.trim() ?? '', secret = env.DINGTALK_CLIENT_SECRET?.trim() ?? ''
  const operatorId = env.DINGTALK_DOCUMENT_OPERATOR_ID?.trim() ?? '' // Explicit unionId, never a display name or userid.
  const folderId = env.DINGTALK_DOCUMENT_FOLDER_ID?.trim() || DEFAULT_FOLDER
  const folderName = env.DINGTALK_DOCUMENT_FOLDER_NAME?.trim() || '人工智能实验室管理'
  const configured = validId(corpId) && validId(appId) && !!secret && validId(operatorId) && validId(folderId)
  const connectionId = digest([corpId, appId, operatorId, folderId])
  let timeZone = env.DINGTALK_DOCUMENT_TIME_ZONE?.trim() || 'Asia/Taipei'
  try { new Intl.DateTimeFormat('en', { timeZone }).format() } catch { timeZone = 'Asia/Taipei' }
  const maxDepth = limit(env, 'DINGTALK_DOCUMENT_MAX_DEPTH', 3), maxNodes = limit(env, 'DINGTALK_DOCUMENT_MAX_NODES', 500), maxDocuments = limit(env, 'DINGTALK_DOCUMENT_MAX_DOCUMENTS', 100)
  let cachedToken: { value: string; expires: number } | undefined
  let refreshing: Promise<string> | undefined
  function requireConfigured() { if (!configured) fail('DINGTALK_DOCUMENT_NOT_CONFIGURED', '钉钉文档连接尚未配置；请由管理员配置文档操作身份并验证读取权限', 503) }
  async function request(path: string, query: Record<string, string> = {}, body?: Record<string, unknown>, accessToken?: string): Promise<Record<string, unknown>> {
    const url = new URL(path, 'https://api.dingtalk.com')
    url.search = new URLSearchParams(query).toString()
    let response: Response
    try {
      response = await fetcher(url, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(12_000), headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...(accessToken ? { 'x-acs-dingtalk-access-token': accessToken } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) })
    } catch { throw new DingTalkDocumentError('DINGTALK_DOCUMENT_NETWORK', '暂时无法连接钉钉，请稍后重新获取', 502, true) }
    let data: Record<string, unknown> | undefined
    try {
      const reader = response.body?.getReader()
      if (!reader) throw new Error()
      const pieces: Uint8Array[] = []; let size = 0
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        size += part.value.byteLength
        if (size > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new Error() }
        pieces.push(part.value)
      }
      data = object(JSON.parse(Buffer.concat(pieces).toString('utf8')))
    } catch { fail('DINGTALK_DOCUMENT_RESPONSE_INVALID', '钉钉返回的数据不完整或超过读取限额，请缩小来源范围') }
    if (!data) fail('DINGTALK_DOCUMENT_RESPONSE_INVALID', '钉钉返回的数据格式无法确认')
    if (!response.ok || data.code !== undefined || data.errcode !== undefined && Number(data.errcode) !== 0) {
      // The provider's message may contain access tokens, application identifiers, and URLs.
      const code = String(data.code ?? data.subCode ?? data.sub_code ?? data.errcode ?? '')
      // AccessTokenPermissionDenied is a missing scope, not an expired token.
      if (response.status === 403 || /permission|accessDenied|acrossOrg|Forbidden|60011/i.test(code)) throw new DingTalkDocumentError('DINGTALK_DOCUMENT_PERMISSION_DENIED', '当前钉钉应用或操作人缺少文档读取权限，请核对应用权限和源文件授权', 403)
      if (response.status === 401 || /token|auth/i.test(code)) {
        cachedToken = undefined
        throw new DingTalkDocumentError('DINGTALK_DOCUMENT_AUTH_FAILED', '钉钉文档连接授权已失效，请管理员重新核验连接', 503)
      }
      if (response.status === 429) throw new DingTalkDocumentError('DINGTALK_DOCUMENT_RATE_LIMIT', '钉钉读取请求暂时受限，请稍后重新获取', 503, true)
      if (response.status === 404 || /notFound|NotExist/i.test(code)) fail('DINGTALK_DOCUMENT_NOT_FOUND', '来源文档或工作表不存在，请重新查找来源', 404)
      throw new DingTalkDocumentError('DINGTALK_DOCUMENT_PROVIDER_ERROR', '钉钉未能完成读取，请核对来源及连接权限后重试', 502, response.status >= 500)
    }
    return data
  }
  async function token(): Promise<string> {
    requireConfigured()
    if (cachedToken && cachedToken.expires > now()) return cachedToken.value
    if (refreshing) return refreshing
    const pending = (async () => {
      const data = await request('/v1.0/oauth2/accessToken', {}, { appKey: appId, appSecret: secret })
      if (typeof data.accessToken !== 'string' || !data.accessToken || typeof data.expireIn !== 'number' || !Number.isFinite(data.expireIn) || data.expireIn <= 0) fail('DINGTALK_DOCUMENT_AUTH_FAILED', '无法取得有效的钉钉应用凭证，请管理员核对配置', 503)
      cachedToken = { value: data.accessToken, expires: now() + data.expireIn * 1000 - Math.min(60_000, data.expireIn * 100) }
      return cachedToken.value
    })()
    refreshing = pending
    try { return await pending } finally { refreshing = undefined }
  }
  async function api(path: string, query: Record<string, string> = {}) { return request(path, { ...query, operatorId }, undefined, await token()) }
  function parseNode(value: unknown): NodeInfo {
    const row = object(value)
    if (!row || !validId(row.nodeId) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 1000 || row.type !== 'FILE' && row.type !== 'FOLDER') fail('DINGTALK_DOCUMENT_RESPONSE_INVALID', '钉钉目录返回了无法识别的节点')
    const timestamp = row.modifiedTimestamp
    if (timestamp !== undefined && (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8_640_000_000_000_000)) fail('DINGTALK_DOCUMENT_RESPONSE_INVALID', '钉钉目录修改时间无效')
    const modifiedAt = typeof timestamp === 'number' && timestamp > 0 ? new Date(timestamp).toISOString() : undefined
    return { nodeId: row.nodeId, name: row.name, type: row.type, category: typeof row.category === 'string' ? row.category : undefined, extension: typeof row.extension === 'string' ? row.extension.toLowerCase() : undefined, modifiedAt, hasChildren: typeof row.hasChildren === 'boolean' ? row.hasChildren : undefined }
  }
  async function sheets(documentId: string): Promise<{ id: string; name: string }[]> {
    const data = await api(`/v1.0/doc/workbooks/${encodeURIComponent(documentId)}/sheets`)
    if (!Array.isArray(data.value) || data.value.length > 200) fail('DINGTALK_DOCUMENT_RESPONSE_INVALID', '钉钉工作表列表不完整或超过限额')
    const seen = new Set<string>()
    return data.value.map(value => {
      const sheet = object(value)
      if (!sheet || !validId(sheet.id) || typeof sheet.name !== 'string' || !sheet.name.trim() || sheet.name.length > 1000 || seen.has(sheet.id)) fail('DINGTALK_DOCUMENT_RESPONSE_INVALID', '钉钉工作表列表存在缺失或重复标识')
      seen.add(sheet.id); return { id: sheet.id, name: sheet.name }
    })
  }
  async function discover(month: string, documentUrl?: string): Promise<Omit<DingTalkDocumentDiscovery, 'id'>> {
    const rule = monthlySourceRule(month), requestedId = documentUrl ? documentIdFromUrl(documentUrl) : undefined
    requireConfigured()
    const warnings: string[] = [], candidates: DingTalkDocumentCandidate[] = []
    const queue = [{ id: folderId, path: [folderName], depth: 0 }], visited = new Set<string>([folderId]), documents = new Set<string>(), nodes = new Set<string>()
    let complete = true, requestedFound = false, pageCount = 0
    const note = (message: string) => { complete = false; if (!warnings.includes(message)) warnings.push(message) }
    for (let at = 0; at < queue.length; at++) {
      const current = queue[at], cursors = new Set<string>(); let cursor = ''
      do {
        if (++pageCount > 50) { note('来源目录超过分页查找限额，请缩小范围。'); break }
        let data: Record<string, unknown>
        try { data = await api('/v2.0/wiki/nodes', { parentNodeId: current.id, maxResults: '50', ...(cursor ? { nextToken: cursor } : {}) }) }
        catch (error) {
          if (at === 0) throw error
          note('部分子目录无法读取，查找未完成；请核对目录权限。'); break
        }
        if (!Array.isArray(data.nodes) || data.nodes.length > 50 || data.nextToken !== undefined && data.nextToken !== null && typeof data.nextToken !== 'string') fail('DINGTALK_DOCUMENT_RESPONSE_INVALID', '钉钉目录列表或分页信息不完整')
        for (const value of data.nodes) {
          const node = parseNode(value)
          nodes.add(node.nodeId)
          if (nodes.size > maxNodes) { note('来源目录超过节点查找限额，请缩小范围。'); break }
          if (node.type === 'FOLDER') {
            if (visited.has(node.nodeId)) continue
            visited.add(node.nodeId)
            if (current.depth >= maxDepth) { if (node.hasChildren !== false) note('来源目录超过子目录深度限额，请缩小范围。'); continue }
            queue.push({ id: node.nodeId, path: [...current.path, node.name], depth: current.depth + 1 }); continue
          }
          if (node.category !== 'ALIDOC' || node.extension !== 'axls' || documents.has(node.nodeId)) continue
          documents.add(node.nodeId)
          if (documents.size > maxDocuments) { note('来源目录超过工作簿查找限额，请缩小范围。'); break }
          if (requestedId && node.nodeId !== requestedId) continue
          if (requestedId === node.nodeId) requestedFound = true
          let tabs: { id: string; name: string }[]
          try { tabs = await sheets(node.nodeId) } catch { note('部分工作簿无法列出工作表，查找未完成；请核对文档权限。'); continue }
          for (const tab of tabs) {
            if (!rule.sheetNames.some(name => cleanName(name) === cleanName(tab.name))) continue
            const titleMatches = rule.reportTitles.some(title => cleanDocumentTitle(title) === cleanDocumentTitle(node.name))
            const yearKnown = node.name.includes(rule.reportMonth.slice(0, 4)) || tab.name.includes(month.slice(0, 4))
            candidates.push({ id: digest([connectionId, month, node.nodeId, tab.id]), documentId: node.nodeId, documentTitle: node.name, documentUrl: `https://alidocs.dingtalk.com/i/nodes/${node.nodeId}`, sheetId: tab.id, sheetName: tab.name, path: [...current.path, node.name], modifiedAt: node.modifiedAt, recommended: titleMatches && yearKnown })
          }
        }
        if (nodes.size > maxNodes || documents.size > maxDocuments) break
        cursor = typeof data.nextToken === 'string' ? data.nextToken : ''
        if (cursor && cursors.has(cursor)) { note('钉钉目录分页游标重复，查找未完成。'); break }
        if (cursor) cursors.add(cursor)
      } while (cursor)
      if (nodes.size > maxNodes || documents.size > maxDocuments || pageCount > 50) break
    }
    if (requestedId && !requestedFound && complete) fail('DINGTALK_DOCUMENT_OUT_OF_SCOPE', '该文档不在已绑定文件夹范围内，请选择文件夹内的月报材料', 400)
    const recommended = candidates.filter(candidate => candidate.recommended)
    // Uncertain discovery or multiple same-month candidates cannot produce a preselection.
    if (!complete || candidates.length !== 1 || recommended.length !== 1) candidates.forEach(candidate => { candidate.recommended = false })
    if (candidates.some(candidate => !candidate.documentTitle.includes(rule.reportMonth.slice(0, 4)) && !candidate.sheetName.includes(month.slice(0, 4)))) warnings.push('候选来源未标明年份，请结合原表日期确认目标年份。')
    if (!candidates.length && complete) warnings.push('未在绑定文件夹内找到所选月份的目标工作表。')
    candidates.sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.path.join('/').localeCompare(b.path.join('/'), 'zh-CN') || a.id.localeCompare(b.id))
    return { targetMonth: month, complete, warnings, candidates, ...(candidates.length === 1 && candidates[0].recommended ? { recommendedCandidateId: candidates[0].id } : {}) }
  }
  async function sheetInfo(documentId: string, sheetId: string): Promise<SheetInfo> {
    const info = await api(`/v1.0/doc/workbooks/${encodeURIComponent(documentId)}/sheets/${encodeURIComponent(sheetId)}`)
    if (info.id !== sheetId || typeof info.name !== 'string' || !['lastNonEmptyRow', 'lastNonEmptyColumn', 'rowCount', 'columnCount'].every(key => Number.isSafeInteger(info[key]))) fail('DINGTALK_DOCUMENT_RESPONSE_INVALID', '钉钉工作表边界信息不完整')
    const shape = info as unknown as SheetInfo
    if (shape.lastNonEmptyRow < -1 || shape.lastNonEmptyColumn < -1 || shape.rowCount < 0 || shape.columnCount < 0 || shape.lastNonEmptyRow >= shape.rowCount || shape.lastNonEmptyColumn >= shape.columnCount || (shape.lastNonEmptyRow === -1) !== (shape.lastNonEmptyColumn === -1)) fail('DINGTALK_DOCUMENT_RESPONSE_INVALID', '钉钉工作表边界信息无效')
    return shape
  }
  async function values(documentId: string, sheetId: string, height: number, width: number): Promise<DingTalkSheetSnapshot['rows']> {
    const rows: DingTalkSheetSnapshot['rows'] = [], chunkHeight = Math.max(1, Math.min(200, Math.floor(5000 / width)))
    let textLength = 0
    for (let start = 1; start <= height; start += chunkHeight) {
      const end = Math.min(height, start + chunkHeight - 1), range = `A${start}:${columnName(width)}${end}`
      const data = await api(`/v1.0/doc/workbooks/${encodeURIComponent(documentId)}/sheets/${encodeURIComponent(sheetId)}/ranges/${encodeURIComponent(range)}`, { select: 'values,displayValues' })
      if (data.hasMore === true || data.truncated === true || !Array.isArray(data.values) || !Array.isArray(data.displayValues) || data.values.length !== end - start + 1 || data.displayValues.length !== end - start + 1) fail('DINGTALK_DOCUMENT_INCOMPLETE', '钉钉返回的单元格范围不完整，未生成导入预览')
      for (let index = 0; index < data.values.length; index++) {
        const raw = data.values[index], display = data.displayValues[index]
        if (!Array.isArray(raw) || !Array.isArray(display) || raw.length !== width || display.length !== width) fail('DINGTALK_DOCUMENT_INCOMPLETE', '钉钉返回的单元格列数不完整，未生成导入预览')
        const cells = raw.map((value: unknown, cellIndex: number) => {
          if (value !== null && !['string', 'number', 'boolean'].includes(typeof value) || typeof value === 'number' && !Number.isFinite(value) || display[cellIndex] !== null && typeof display[cellIndex] !== 'string') fail('DINGTALK_DOCUMENT_RESPONSE_INVALID', '钉钉单元格包含无法识别的数据类型')
          const text = display[cellIndex] || (value === null ? '' : String(value))
          textLength += text.length
          if (textLength > 1_200_000) fail('DINGTALK_DOCUMENT_TOO_LARGE', '工作表文字超过导入限额，请缩小来源范围', 400)
          return text
        })
        rows.push({ rowNumber: start + index, cells })
      }
    }
    return rows
  }
  return {
    status() {
      const parts = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit' }).formatToParts(now())
      return { configured, folderId, folderName, currentMonth: `${parts.find(p => p.type === 'year')!.value}-${parts.find(p => p.type === 'month')!.value}`, timeZone, message: configured ? '文档连接配置已填写；实际可读范围以查找和获取结果为准。' : '文档连接尚未配置；需设置文档操作人 unionId 并验证目录与表格读取权限。' }
    },
    discover,
    async read(candidate, month) {
      monthlySourceRule(month)
      if (!candidate || !validId(candidate.documentId) || !validId(candidate.sheetId) || typeof candidate.id !== 'string') fail('DINGTALK_DOCUMENT_SELECTION_INVALID', '来源选择无效，请重新查找并选择', 400)
      // Re-prove scope from the trusted root, never trust client-supplied path or title.
      const found = await discover(month, `https://alidocs.dingtalk.com/i/nodes/${candidate.documentId}`)
      if (!found.complete) fail('DINGTALK_DOCUMENT_INCOMPLETE', '尚未完成来源范围核对，请完成查找后再获取')
      const live = found.candidates.find(item => item.id === candidate.id && item.documentId === candidate.documentId && item.sheetId === candidate.sheetId)
      if (!live) fail('DINGTALK_DOCUMENT_SELECTION_CHANGED', '来源文件或目标工作表已变化，请重新查找并选择', 409)
      const before = await sheetInfo(live.documentId, live.sheetId), height = before.lastNonEmptyRow + 1, width = before.lastNonEmptyColumn + 1
      if (before.name !== live.sheetName) fail('DINGTALK_DOCUMENT_SOURCE_CHANGED', '目标工作表名称已变化，请重新获取', 409)
      if (!height || !width) fail('DINGTALK_DOCUMENT_EMPTY', '目标工作表为空，尚无可导入的月度目标', 400)
      if (height > 10000 || width > 256 || height * width > 100000) fail('DINGTALK_DOCUMENT_TOO_LARGE', '目标工作表超过导入限额，请缩小来源范围', 400)
      const rows = await values(live.documentId, live.sheetId, height, width)
      const after = await sheetInfo(live.documentId, live.sheetId)
      if (after.name !== before.name || after.lastNonEmptyRow !== before.lastNonEmptyRow || after.lastNonEmptyColumn !== before.lastNonEmptyColumn) fail('DINGTALK_DOCUMENT_SOURCE_CHANGED', '获取期间源工作表发生变化，请重新获取', 409)
      // The OpenAPI has no revision/snapshot token. Compare a second bounded pass instead
      // of inventing an atomic read guarantee or treating a timestamp as a revision.
      const verification = await values(live.documentId, live.sheetId, height, width)
      const finalInfo = await sheetInfo(live.documentId, live.sheetId)
      if (digest(rows) !== digest(verification) || finalInfo.name !== before.name || finalInfo.lastNonEmptyRow !== before.lastNonEmptyRow || finalInfo.lastNonEmptyColumn !== before.lastNonEmptyColumn) fail('DINGTALK_DOCUMENT_SOURCE_CHANGED', '获取期间源工作表发生变化，请重新获取', 409)
      return { connectionId, folderId, documentId: live.documentId, workbookId: live.documentId, documentTitle: live.documentTitle, documentUrl: live.documentUrl, path: live.path, sheetId: live.sheetId, sheetName: live.sheetName, targetMonth: month, range: `A1:${columnName(width)}${height}`, rows, merges: [], mergesKnown: false, warnings: [MERGES_WARNING, '来源不提供原子快照版本；本次完整读取已复读核对，后续变更需再次获取。'], complete: true, truncated: false, hasMore: false, readAt: new Date(now()).toISOString() }
    },
  }
}
