import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Entity } from '../shared/types.ts'
import type { WeeklyRule } from '../shared/weekly-submissions.ts'
import { applyMigrations } from './storage-migrations.ts'
import type { DeliveryFilter } from '../shared/notification-diagnostics.ts'
import type { DeliveryStatus, NotificationDelivery } from '../shared/notifications.ts'

const deliveryStatuses = new Set(['pending', 'sending', 'accepted', 'delivered', 'failed', 'unknown', 'skipped'])
interface DeliveryQuery extends DeliveryFilter { dueAt?: string; leaseExpiredAt?: string; order?: 'due' | 'created' | 'oldest'; }
function deliveryWhere(filter: DeliveryQuery, cursor = true) {
  const clauses = ["d.collection='notificationDeliveries'"], values: string[] = []
  const add = (sql: string, value?: string) => { if (value !== undefined) { clauses.push(sql); values.push(value) } }
  if (filter.status !== undefined && !deliveryStatuses.has(filter.status)) throw new HttpError(400, '投递状态无效')
  for (const value of [filter.from, filter.to, filter.dueAt, filter.leaseExpiredAt, filter.cursor?.createdAt]) if (value !== undefined && (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)) throw new HttpError(400, '投递查询时间无效')
  if (filter.from && filter.to && filter.from > filter.to) throw new HttpError(400, '查询结束时间不能早于开始时间')
  for (const value of [filter.recipientId, filter.kind, filter.cursor?.id]) if (value !== undefined && (typeof value !== 'string' || !value || value.length > 200)) throw new HttpError(400, '投递查询条件无效')
  add("json_extract(d.data,'$.status')=?", filter.status)
  add("json_extract(d.data,'$.recipientId')=?", filter.recipientId)
  add("json_extract(d.data,'$.createdAt')>=?", filter.from)
  add("json_extract(d.data,'$.createdAt')<=?", filter.to)
  add("json_extract(d.data,'$.nextAttemptAt')<=?", filter.dueAt)
  if (filter.leaseExpiredAt) { clauses.push("(json_extract(d.data,'$.leaseUntil') IS NULL OR json_extract(d.data,'$.leaseUntil')<=?)"); values.push(filter.leaseExpiredAt) }
  if (filter.kind) { clauses.push("EXISTS (SELECT 1 FROM entities n WHERE n.collection='notifications' AND n.id=json_extract(d.data,'$.notificationId') AND json_extract(n.data,'$.kind')=?)"); values.push(filter.kind) }
  if (cursor && filter.cursor) { const comparison = filter.order === 'oldest' ? '>' : '<'; clauses.push(`(json_extract(d.data,'$.createdAt')${comparison}? OR (json_extract(d.data,'$.createdAt')=? AND d.id${comparison}?))`); values.push(filter.cursor.createdAt, filter.cursor.createdAt, filter.cursor.id) }
  return { sql: clauses.join(' AND '), values }
}

export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message) }
}

function storageError(error: unknown): unknown {
  const code = (error as { errcode?: unknown })?.errcode
  // SQLite extended error codes retain the primary code in the lowest byte.
  return typeof code === 'number' && [5, 6].includes(code & 255) ? new HttpError(503, '数据库正忙，请稍后重试') : error
}

/** Single-host persistent store. Transactions are synchronous and support nesting. */
export class Store {
  private db: DatabaseSync
  private depth = 0
  private transactionContext = new AsyncLocalStorage<{ active: boolean }>()
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;')
    this.db.exec(`CREATE TABLE IF NOT EXISTS entities (
      collection TEXT NOT NULL, id TEXT NOT NULL, version INTEGER NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(collection, id)
    )`)
    applyMigrations(this.db)
  }
  private assertTransactionActive() {
    if (this.transactionContext.getStore()?.active === false) throw new Error('Store transaction has ended; asynchronous work is not allowed')
  }
  get<T>(collection: string, id: string): T | undefined {
    this.assertTransactionActive()
    const row = this.db.prepare('SELECT data FROM entities WHERE collection=? AND id=?').get(collection, id)
    return row ? JSON.parse(row.data as string) as T : undefined
  }
  list<T>(collection: string): T[] {
    this.assertTransactionActive()
    return this.db.prepare('SELECT data FROM entities WHERE collection=? ORDER BY rowid').all(collection)
      .map(row => JSON.parse(row.data as string) as T)
  }
  insert<T extends Entity>(collection: string, input: Omit<T, keyof Entity> & Partial<Entity>): T {
    this.assertTransactionActive()
    const now = new Date().toISOString()
    const entity = { ...input, id: input.id || randomUUID(), version: 1, createdAt: now, updatedAt: now } as T
    try {
      this.db.prepare('INSERT INTO entities(collection,id,version,data) VALUES(?,?,?,?)')
        .run(collection, entity.id, 1, JSON.stringify(entity))
    } catch (error) {
      const mapped = storageError(error)
      if (mapped !== error) throw mapped
      if (this.get(collection, entity.id)) throw new HttpError(409, '记录已存在，请刷新后重试')
      throw error
    }
    return structuredClone(entity)
  }
  update<T extends Entity>(collection: string, id: string, expectedVersion: number, patch: Partial<T>): T {
    const before = this.get<T>(collection, id)
    if (!before) throw new HttpError(404, '记录不存在')
    if (!Number.isInteger(expectedVersion) || expectedVersion !== before.version) throw new HttpError(409, '数据已更新，请刷新后重试')
    const entity = { ...before, ...patch, id, createdAt: before.createdAt, updatedAt: new Date().toISOString(), version: before.version + 1 }
    try {
      const result = this.db.prepare('UPDATE entities SET version=?,data=? WHERE collection=? AND id=? AND version=?')
        .run(entity.version, JSON.stringify(entity), collection, id, expectedVersion)
      if (result.changes !== 1) throw new HttpError(409, '数据已更新，请刷新后重试')
    } catch (error) { throw storageError(error) }
    return structuredClone(entity)
  }
  /** Fixed collection/field allowlist; bounded and fully parameterized. */
  queryDeliveries(filter: DeliveryQuery = {}): NotificationDelivery[] {
    this.assertTransactionActive()
    const limit = filter.limit ?? 50
    if (!Number.isInteger(limit) || limit < 1 || limit > 201 || filter.order !== undefined && !['due', 'created', 'oldest'].includes(filter.order)) throw new HttpError(400, '投递分页参数无效')
    const where = deliveryWhere(filter)
    const order = filter.order === 'due' ? "json_extract(d.data,'$.nextAttemptAt'),d.id" : filter.order === 'oldest' ? "json_extract(d.data,'$.createdAt'),d.id" : "json_extract(d.data,'$.createdAt') DESC,d.id DESC"
    return this.db.prepare(`SELECT d.data FROM entities d WHERE ${where.sql} ORDER BY ${order} LIMIT ?`).all(...where.values, limit).map(row => JSON.parse(row.data as string) as NotificationDelivery)
  }
  deliveryCounts(filter: DeliveryFilter = {}): Partial<Record<DeliveryStatus, number>> {
    this.assertTransactionActive()
    const where = deliveryWhere(filter, false)
    return Object.fromEntries(this.db.prepare(`SELECT json_extract(d.data,'$.status') AS status,COUNT(*) AS count FROM entities d WHERE ${where.sql} GROUP BY json_extract(d.data,'$.status')`).all(...where.values).map(row => [String(row.status), Number(row.count)]))
  }
  deliveryOldest(status: 'pending' | 'accepted', dueAt?: string): string | null {
    this.assertTransactionActive()
    const where = deliveryWhere({ status, dueAt })
    const field = status === 'accepted' ? 'acceptedAt' : 'createdAt'
    const row = this.db.prepare(`SELECT MIN(json_extract(d.data,'$.${field}')) AS oldest FROM entities d WHERE ${where.sql}`).get(...where.values)
    return typeof row?.oldest === 'string' ? row.oldest : null
  }
  operationalCounts(collection: 'nativeCallbackInbox' | 'nativeOperations' | 'reminderOccurrences'): Record<string, number> {
    this.assertTransactionActive()
    if (!['nativeCallbackInbox', 'nativeOperations', 'reminderOccurrences'].includes(collection)) throw new HttpError(400, '诊断集合无效')
    if (collection === 'reminderOccurrences') return Object.fromEntries(this.db.prepare("SELECT CASE WHEN COALESCE(json_extract(data,'$.cancelledReason'),'')<>'' THEN 'cancelled' ELSE 'recorded' END AS state,COUNT(*) AS count FROM entities WHERE collection=? GROUP BY state").all(collection).map(row => [String(row.state), Number(row.count)]))
    return Object.fromEntries(this.db.prepare("SELECT COALESCE(json_extract(data,'$.status'),'other') AS status,COUNT(*) AS count FROM entities WHERE collection=? GROUP BY json_extract(data,'$.status')").all(collection).map(row => [String(row.status), Number(row.count)]))
  }
  delete(collection: string, id: string, expectedVersion: number): void {
    const before = this.get<Entity>(collection, id)
    if (!before) throw new HttpError(404, '记录不存在')
    if (!Number.isInteger(expectedVersion) || expectedVersion !== before.version) throw new HttpError(409, '数据已更新，请刷新后重试')
    try {
      const result = this.db.prepare('DELETE FROM entities WHERE collection=? AND id=? AND version=?').run(collection, id, expectedVersion)
      if (result.changes !== 1) throw new HttpError(409, '数据已更新，请刷新后重试')
    } catch (error) { throw storageError(error) }
  }
  /** Only for validated, administrator-authorized data restoration; never upserts. */
  restoreEntity<T extends Entity>(collection: string, entity: T): T {
    this.assertTransactionActive()
    if (!entity.id || !Number.isInteger(entity.version) || entity.version < 1 || !Number.isFinite(Date.parse(entity.createdAt)) || !Number.isFinite(Date.parse(entity.updatedAt))) throw new HttpError(400, '恢复记录缺少有效标识或版本时间')
    try {
      this.db.prepare('INSERT INTO entities(collection,id,version,data) VALUES(?,?,?,?)').run(collection, entity.id, entity.version, JSON.stringify(entity))
    } catch (error) {
      const mapped = storageError(error)
      if (mapped !== error) throw mapped
      if (this.get(collection, entity.id)) throw new HttpError(409, '恢复记录已存在，未覆盖原数据')
      throw error
    }
    return structuredClone(entity)
  }
  /** A server-created, untouched default is not yet a configured business rule. */
  isUnusedWeeklyRule(rule: WeeklyRule): boolean {
    const current = this.get<WeeklyRule>('weeklyRules', 'weekly-submission-rule')
    if (!current || JSON.stringify(current) !== JSON.stringify(rule) || this.list('weeklyRules').length !== 1) return false
    if (rule.id !== 'weekly-submission-rule' || rule.version !== 1 || rule.createdAt !== rule.updatedAt || !rule.enabled || rule.timezone !== 'Asia/Shanghai') return false
    if (Object.keys(rule).filter(key => key !== 'planReviewEffectiveWeek').sort().join(',') !== 'createdAt,effectiveWeek,enabled,id,timezone,updatedAt,version,windows') return false
    const created = new Date(rule.createdAt)
    if (!Number.isFinite(created.getTime())) return false
    const local = new Date(created.getTime() + 8 * 3600000)
    local.setUTCDate(local.getUTCDate() + 7 - ((local.getUTCDay() + 6) % 7))
    const nextWeek = local.toISOString().slice(0, 10)
    if (rule.planReviewEffectiveWeek !== undefined && rule.planReviewEffectiveWeek !== nextWeek) return false
    if (rule.effectiveWeek !== nextWeek || JSON.stringify(rule.windows) !== JSON.stringify([{ fromWeek: nextWeek, toWeek: null }])) return false
    if (['weeklyCycles', 'weeklyDuties', 'weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments', 'weeklyPlanReviews'].some(name => this.list(name).length > 0)) return false
    if (this.list<{ planApproval?: unknown }>('weeklyRecords').some(row => row.planApproval)) return false
    if (this.list<{ entityType: string }>('events').some(event => ['weeklyRule', 'weeklyCycle', 'weeklyPlanReview'].includes(event.entityType))) return false
    return !this.list<{ snapshot?: { weeklySubmissions?: unknown[] } }>('reports').some(report => report.snapshot?.weeklySubmissions?.length)
  }
  /** Migration-only exception: replace exactly an unused bootstrap rule, atomically. */
  replaceUnusedWeeklyRule(before: WeeklyRule, incoming: WeeklyRule): WeeklyRule {
    this.assertTransactionActive()
    if (this.depth === 0 || incoming.id !== 'weekly-submission-rule' || !this.isUnusedWeeklyRule(before)) throw new HttpError(409, '默认周提报规则已使用或变化，请重新预览')
    try {
      const result = this.db.prepare('UPDATE entities SET version=?,data=? WHERE collection=? AND id=? AND version=?')
        .run(incoming.version, JSON.stringify(incoming), 'weeklyRules', before.id, before.version)
      if (result.changes !== 1) throw new HttpError(409, '默认周提报规则已变化，请重新预览')
    } catch (error) { throw storageError(error) }
    return structuredClone(incoming)
  }
  transaction<T>(fn: () => T): T {
    this.assertTransactionActive()
    const context = { active: true }
    return this.transactionContext.run(context, () => {
      const level = this.depth
      const savepoint = `nested_${level}`
      let started = false
      try {
        this.db.exec(level === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${savepoint}`)
        started = true
        this.depth++
        const result = fn()
        if (result && typeof (result as { then?: unknown }).then === 'function') {
          // The rejected continuation keeps this context, so it cannot write after rollback.
          void Promise.resolve(result).catch(() => {})
          throw new Error('Store transactions must be synchronous')
        }
        this.db.exec(level === 0 ? 'COMMIT' : `RELEASE ${savepoint}`)
        return result
      } catch (error) {
        if (started) {
          try { this.db.exec(level === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`) }
          catch { /* Preserve the operation error if SQLite already ended the transaction. */ }
        }
        throw storageError(error)
      } finally {
        context.active = false
        if (started) this.depth--
      }
    })
  }
  close() { this.db.close() }
}
