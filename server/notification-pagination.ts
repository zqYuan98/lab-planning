import type { Notification, NotificationView } from '../shared/notifications.ts'
import type { User } from '../shared/types.ts'
import { notificationView } from './notifications.ts'
import { HttpError, type Store } from './store.ts'

type Filter = 'all' | 'unread' | 'pending'
interface Cursor { v: 1; recipientId: string; filter: Filter; createdAt: string; id: string }
export interface NotificationPage {
  items: NotificationView[]; unreadCount: number; pendingCount: number; totalCount: number
  filteredCount: number; nextCursor: string | null
}

function readCursor(value: unknown, actor: User, filter: Filter): Cursor | null {
  if (value === undefined) return null
  const invalid = () => new HttpError(400, '消息分页位置无效，请刷新消息列表')
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,1024}$/.test(value)) throw invalid()
  try {
    const decoded = Buffer.from(value, 'base64url')
    if (decoded.toString('base64url') !== value) throw invalid()
    const cursor: unknown = JSON.parse(decoded.toString('utf8'))
    if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor)) throw invalid()
    const row = cursor as Record<string, unknown>
    if (Object.keys(row).sort().join(',') !== 'createdAt,filter,id,recipientId,v' || row.v !== 1
      || row.recipientId !== actor.id || row.filter !== filter
      || typeof row.id !== 'string' || !row.id || row.id.length > 200 || /[\u0000-\u001f]/.test(row.id)
      || typeof row.createdAt !== 'string' || !Number.isFinite(Date.parse(row.createdAt))
      || new Date(row.createdAt).toISOString() !== row.createdAt) throw invalid()
    return row as unknown as Cursor
  } catch { throw invalid() }
}

/** Filter current obligations before paging. Opened state never substitutes for acknowledgement. */
export function notificationPage(store: Store, actor: User, query: Record<string, unknown>): NotificationPage {
  const filter = query.filter ?? 'all'
  if (filter !== 'all' && filter !== 'unread' && filter !== 'pending') throw new HttpError(400, '消息筛选条件无效')
  if (query.limit !== undefined && (typeof query.limit !== 'string' || !/^[1-9]\d{0,2}$/.test(query.limit))) throw new HttpError(400, '每页消息数须为 1 至 200')
  const limit = query.limit === undefined ? 200 : Number(query.limit)
  if (limit > 200) throw new HttpError(400, '每页消息数须为 1 至 200')
  const cursor = readCursor(query.cursor, actor, filter)
  const owned = store.list<Notification>('notifications').filter(row => row.recipientId === actor.id)
  // A cursor is only a boundary within this user's inbox, never a source of permissions.
  if (cursor && !owned.some(row => row.id === cursor.id && row.createdAt === cursor.createdAt)) throw new HttpError(400, '消息分页位置无效，请刷新消息列表')
  const now = new Date()
  const rows = owned.map(row => notificationView(store, actor, row, now))
  const unreadCount = rows.filter(row => !row.openedAt).length
  const pendingCount = rows.filter(row => row.canAcknowledge).length
  const filtered = rows.filter(row => filter === 'all' || (filter === 'unread' ? !row.openedAt : row.canAcknowledge))
    .sort((a, b) => a.createdAt === b.createdAt ? a.id === b.id ? 0 : a.id > b.id ? -1 : 1 : a.createdAt > b.createdAt ? -1 : 1)
  const remaining = cursor ? filtered.filter(row => row.createdAt < cursor.createdAt || row.createdAt === cursor.createdAt && row.id < cursor.id) : filtered
  const items = remaining.slice(0, limit), last = items.at(-1)
  const nextCursor = remaining.length > limit && last ? Buffer.from(JSON.stringify({ v: 1, recipientId: actor.id, filter, createdAt: last.createdAt, id: last.id } satisfies Cursor)).toString('base64url') : null
  return { items, unreadCount, pendingCount, totalCount: rows.length, filteredCount: filtered.length, nextCursor }
}
