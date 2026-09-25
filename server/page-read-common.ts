import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import type { User } from '../shared/types.ts'
import type { WorkspacePage } from '../shared/workspace-query.ts'
import { liveObjectActor, readScopeVersion } from './object-access.ts'
import { getOperationEpoch } from './operation-context.ts'
import { HttpError, type Store } from './store.ts'

export interface PageReadContext { actor: User; accessScopeVersion: string; operationEpoch: string; revision: string }
export function pageContext(store: Store, actor: User): PageReadContext {
  actor = liveObjectActor(store, actor)
  if (actor.role === 'observer') throw new HttpError(403, '观察者仅能读取明确授权的内容', 'READ_ONLY_OBSERVER')
  return { actor, accessScopeVersion: readScopeVersion(store, actor), operationEpoch: getOperationEpoch(store), revision: store.workspaceRevision() }
}
export function queryKeys(input: Record<string, unknown>, allowed: readonly string[]) {
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new HttpError(400, '存在不支持的查询条件')
}
export function queryText(value: unknown, maximum = 200): string {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f]/.test(value)) throw new HttpError(400, '查询条件无效')
  return value.trim()
}
const secret = randomBytes(32)
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
/** Binds paging to the exact current read and permissions; never reuse a cursor across mutations. */
export function pageWindow(input: Record<string, unknown>, context: PageReadContext, scope: unknown) {
  if (input.limit !== undefined && !['string', 'number'].includes(typeof input.limit)) throw new HttpError(400, '分页大小无效')
  const limit = input.limit === undefined ? 50 : Number(input.limit)
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, '分页大小须为 1 至 100')
  const query = Object.fromEntries(Object.keys(input).filter(key => key !== 'cursor').sort().map(key => [key, input[key]]))
  const binding = hash([scope, query, limit, context.actor.id, context.actor.role, context.accessScopeVersion, context.operationEpoch, context.revision])
  let offset = 0
  if (input.cursor !== undefined) {
    try {
      if (typeof input.cursor !== 'string' || input.cursor.length > 4096) throw new Error()
      const [body, signature, extra] = input.cursor.split('.')
      const actual = Buffer.from(signature || '', 'base64url'), expected = createHmac('sha256', secret).update(body).digest()
      if (extra || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error()
      const parsed = JSON.parse(Buffer.from(body, 'base64url').toString())
      if (parsed.binding !== binding || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0) throw new Error()
      offset = parsed.offset
    } catch { throw new HttpError(409, '数据或读取权限已更新，请刷新查看', 'WORKSPACE_CURSOR_STALE') }
  }
  return { limit, offset, cursor(nextOffset: number) {
    const body = Buffer.from(JSON.stringify({ binding, offset: nextOffset })).toString('base64url')
    return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
  } }
}
/** Rows must already be authorized, filtered, and in deterministic order inside one transaction. */
export function readPage<T>(input: Record<string, unknown>, rows: T[], context: PageReadContext, scope: unknown): WorkspacePage<T> {
  const window = pageWindow(input, context, scope), items = rows.slice(window.offset, window.offset + window.limit)
  return { items, total: rows.length, nextCursor: window.offset + items.length < rows.length ? window.cursor(window.offset + items.length) : null, revision: context.revision, accessScopeVersion: context.accessScopeVersion }
}
