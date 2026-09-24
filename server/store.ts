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
import { field, workspaceWhere, reportMetadataProjection, type WorkspaceSqlFilter } from './workspace-query-sql.ts'
import { registerSql, registerViews, type RegisterFilter } from './workspace-register-sql.ts'
import { registerWorkspaceProgressFunctions, workspaceProgressSql, workspaceProgressResult, type WorkspaceProgressRow } from './workspace-progress.ts'
import { historicalPlanDataSql } from './workspace-plan-snapshot.ts'

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
  constructor(public status: number, message: string, public code?: string, public fieldErrors?: Record<string, string>) { super(message) }
}

function storageError(error: unknown): unknown {
  const code = (error as { errcode?: unknown })?.errcode
  // SQLite extended error codes retain the primary code in the lowest byte.
  return typeof code === 'number' && [5, 6].includes(code & 255) ? new HttpError(503, '数据库正忙，请稍后重试') : error
}

/** Single-host persistent store. Transactions are synchronous and support nesting. */
export class Store {
  private db: DatabaseSync
  private readMetrics = { sql: 0, returnedRows: 0, parsedRows: 0, parsedBytes: 0 }
  resetReadMetrics() { this.readMetrics = { sql: 0, returnedRows: 0, parsedRows: 0, parsedBytes: 0 } }
  getReadMetrics() { return { ...this.readMetrics } }
  /** Instrument actual SQLite result rows; query text is never recorded. */
  private readRows(sql: string, values: (string | number | null)[] = []) {
    this.assertTransactionActive()
    const rows = this.db.prepare(sql).all(...values)
    this.readMetrics.sql++; this.readMetrics.returnedRows += rows.length
    return rows
  }
  private parseRow<T>(data: string): T {
    this.readMetrics.parsedRows++; this.readMetrics.parsedBytes += Buffer.byteLength(data)
    return JSON.parse(data) as T
  }
  private depth = 0
  private connectionRevision = randomUUID()
  private transactionContext = new AsyncLocalStorage<{ active: boolean }>()
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
    this.db = new DatabaseSync(path)
    registerWorkspaceProgressFunctions(this.db)
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
    const row = this.readRows('SELECT data FROM entities WHERE collection=? AND id=?', [collection, id])[0]
    return row ? this.parseRow<T>(row.data as string) : undefined
  }
  list<T>(collection: string): T[] {
    this.assertTransactionActive()
    return this.readRows('SELECT data FROM entities WHERE collection=? ORDER BY rowid', [collection])
      .map(row => this.parseRow<T>(row.data as string))
  }
  /** O(1), process-local invalidation token. SQLite remains a single writer instance. */
  workspaceRevision(): string { return `${this.connectionRevision}:${this.readRows('SELECT total_changes() AS n')[0].n}` }
  workspaceCount(filter: WorkspaceSqlFilter): number {
    const where = workspaceWhere(filter)
    return Number(this.readRows(`SELECT COUNT(*) AS n FROM entities e WHERE ${where.sql}`, where.values)[0].n)
  }
  workspacePage<T>(filter: WorkspaceSqlFilter, limit = 50, cursor?: { createdAt: string; id: string }): T[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 101) throw new HttpError(400, '每页最多100条')
    const where = workspaceWhere(filter)
    if (cursor) { where.sql += ` AND (${field('createdAt')}<? OR (${field('createdAt')}=? AND e.id<?))`; where.values.push(cursor.createdAt, cursor.createdAt, cursor.id) }
    const projection = filter.resource === 'reports' ? reportMetadataProjection() : 'e.data'
    return this.readRows(`SELECT ${projection} AS data FROM entities e WHERE ${where.sql} ORDER BY ${field('createdAt')} DESC,e.id DESC LIMIT ?`, [...where.values, limit]).map(row => this.parseRow<T>(row.data as string))
  }
  workspaceExplain(filter: WorkspaceSqlFilter) {
    const where = workspaceWhere(filter)
    return this.readRows(`EXPLAIN QUERY PLAN SELECT e.data FROM entities e WHERE ${where.sql} ORDER BY ${field('createdAt')} DESC,e.id DESC LIMIT 51`, where.values)
  }
  /** Paged row context only; no full weekly collection is materialized. */
  workspaceTaskProgress(tasks: import('../shared/types.ts').Task[], actorId: string, manager: boolean, today: string) {
    if (tasks.length > 100) throw new HttpError(400, '每页最多100条任务')
    if (tasks.some(task => !manager && task.ownerId !== actorId)) throw new HttpError(404, '任务不存在或无权访问')
    if (!tasks.length) return {}
    const query = workspaceProgressSql(tasks, actorId, manager, today)
    return workspaceProgressResult(tasks, this.readRows(query.sql, query.values) as unknown as WorkspaceProgressRow[])
  }
  /** One authorized historical snapshot, with the same ordering used by register filters. */
  registerHistoricalPlan(planId: string, actorId: string) {
    const row = this.readRows(`SELECT ${historicalPlanDataSql('context.id', 'context.actorId')} AS data FROM (SELECT ? AS id,? AS actorId) context`, [planId, actorId])[0]
    return row?.data ? this.parseRow<import('../shared/types.ts').MonthlyPlan>(row.data as string) : undefined
  }
  registerTaskRecords(taskId: string, ownerId: string, weekStart: string) {
    const base = `e.collection='weeklyRecords' AND ${field('taskId')}=? AND ${field('ownerId')}=? AND ${field('deletion')} IS NULL`
    const queries = [
      { sql: `${field('weekStart')}=?`, values: [weekStart] },
      { sql: `${field('weekStart')}>=?`, values: [weekStart] },
      { sql: `${field('weekStart')}<=? AND trim(COALESCE(${field('actualOutcome')},''))<>''`, values: [weekStart] },
    ]
    return queries.flatMap(q => this.readRows(`SELECT e.data FROM entities e WHERE ${base} AND ${q.sql} ORDER BY ${field('weekStart')} DESC,${field('updatedAt')} DESC,e.version DESC,e.id LIMIT 1`, [taskId, ownerId, ...q.values]).map(row => this.parseRow<import('../shared/types.ts').WeeklyRecord>(row.data as string)))
  }
  registerPage(filter: RegisterFilter, limit: number, cursor?: { createdAt: string; id: string }) {
    const query = registerSql(filter), clauses = [query.predicate], values = [...query.values]
    if (cursor) { clauses.push('(createdAt<? OR (createdAt=? AND rowKind||\':\'||id<?))'); values.push(cursor.createdAt, cursor.createdAt, cursor.id) }
    const rows = this.readRows(`${query.cte} SELECT data,rowKind,historicalReference FROM rows WHERE ${clauses.join(' AND ')} ORDER BY createdAt DESC,rowKind||':'||id DESC LIMIT ?`, [...values, limit])
      .map(row => ({ kind: String(row.rowKind) as 'task' | 'plan', historicalReference: !!row.historicalReference, entity: this.parseRow<import('../shared/types.ts').Task | import('../shared/types.ts').MonthlyPlan>(row.data as string) }))
    const total = Number(this.readRows(`${query.cte} SELECT COUNT(*) AS n FROM rows WHERE ${query.predicate}`, query.values)[0].n)
    const summary = this.readRows(`${query.cte} SELECT ${Object.entries(registerViews).map(([key, predicate]) => `COALESCE(SUM(CASE WHEN ${predicate} THEN 1 ELSE 0 END),0) AS "${key}"`).join(',')},COALESCE(SUM(coordination),0) AS coordination,COALESCE(SUM(CASE WHEN active=1 AND priority='high' THEN 1 ELSE 0 END),0) AS highCount FROM rows`, query.baseValues)[0]
    return { rows, total, summary }
  }
  registerExplain(filter: RegisterFilter) {
    const query = registerSql(filter)
    return this.readRows(`EXPLAIN QUERY PLAN ${query.cte} SELECT COUNT(*) AS n FROM rows WHERE ${query.predicate}`, query.values)
  }
  initialTaskEvents(taskId: string) {
    return this.readRows(`SELECT e.data FROM entities e WHERE e.collection='events' AND ${field('entityType')}='task' AND ${field('entityId')}=? AND ${field('before')} IS NULL AND ${field('action')} IN ('create','submit') ORDER BY ${field('createdAt')},e.id LIMIT 2`, [taskId]).map(row=>this.parseRow<import('../shared/types.ts').AuditEvent>(row.data as string))
  }
  taskHistoryPage(taskId: string, actorId: string, manager: boolean, limit: number, cursor?: { createdAt: string; id: string }, observerGrant?: import('../shared/object-access.ts').ObjectGrant) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 101) throw new HttpError(400, '历史分页大小无效')
    const related = `WITH related(type,id) AS (
      SELECT 'task',? UNION ALL SELECT 'weeklyRecord',id FROM entities w WHERE w.collection='weeklyRecords' AND ${field('taskId','w')}=? AND (?=1 OR ${field('ownerId','w')}=?)
      ${[['deliverySeries','deliverySeries','taskId'],['taskDelivery','taskDeliveries','taskId'],['blockerEpisode','blockerEpisodes','parentTaskId'],['blockerAction','blockerActions','taskId'],['decisionRequest','decisionRequests','taskId']].map(([type,collection,parent])=>`UNION ALL SELECT '${type}',id FROM entities r WHERE r.collection='${collection}' AND ${field(parent,'r')}=?`).join(' ')}
      UNION ALL SELECT 'deliveryDecision',d.id FROM entities d JOIN entities r ON r.collection='taskDeliveries' AND r.id=${field('deliveryId','d')} WHERE d.collection='deliveryDecisions' AND ${field('taskId','r')}=?
    )`
    const values: (string|number|null)[] = observerGrant ? [taskId] : [taskId, taskId, manager ? 1 : 0, actorId, taskId, taskId, taskId, taskId, taskId, taskId]
    const predicates = ["e.collection='events'", observerGrant ? `${field('entityType')}='task' AND ${field('entityId')}=?` : `EXISTS(SELECT 1 FROM related r WHERE r.type=${field('entityType')} AND r.id=${field('entityId')})`]
    if (!manager && !observerGrant) { predicates.push(`(${field('entityType')} NOT IN ('task','weeklyRecord') OR COALESCE(${field('after.ownerId')},${field('before.ownerId')})=?)`); values.push(actorId) }
    if (observerGrant?.historyPolicy !== undefined && observerGrant.historyPolicy !== 'all_history') {
      if (!Array.isArray(observerGrant.excludedFactIds)) predicates.push('0=1')
      else { predicates.push(`${field('createdAt')}>=? AND NOT EXISTS(SELECT 1 FROM json_each(?) x WHERE x.value='history:'||e.id)`); values.push(observerGrant.grantedAt, JSON.stringify(observerGrant.excludedFactIds)) }
    }
    if (cursor) { predicates.push(`(${field('createdAt')}<? OR (${field('createdAt')}=? AND e.id<?))`); values.push(cursor.createdAt, cursor.createdAt, cursor.id) }
    const names = ['id','createdAt','entityType','actorId','action','reason']
    return this.readRows(`${observerGrant ? '' : related} SELECT json_object(${names.map(name=>`'${name}',${field(name)}`).join(',')}) AS data FROM entities e WHERE ${predicates.join(' AND ')} ORDER BY ${field('createdAt')} DESC,e.id DESC LIMIT ?`, [...values, limit]).map(row=>this.parseRow<Pick<import('../shared/types.ts').AuditEvent,'id'|'createdAt'|'entityType'|'actorId'|'action'|'reason'>>(row.data as string))
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
    if (!Number.isInteger(expectedVersion) || expectedVersion !== before.version) throw new HttpError(409, '数据已更新，请刷新后重试', 'VERSION_CONFLICT')
    const entity = { ...before, ...patch, id, createdAt: before.createdAt, updatedAt: new Date().toISOString(), version: before.version + 1 }
    try {
      const result = this.db.prepare('UPDATE entities SET version=?,data=? WHERE collection=? AND id=? AND version=?')
        .run(entity.version, JSON.stringify(entity), collection, id, expectedVersion)
      if (result.changes !== 1) throw new HttpError(409, '数据已更新，请刷新后重试', 'VERSION_CONFLICT')
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
    if (!Number.isInteger(expectedVersion) || expectedVersion !== before.version) throw new HttpError(409, '数据已更新，请刷新后重试', 'VERSION_CONFLICT')
    try {
      const result = this.db.prepare('DELETE FROM entities WHERE collection=? AND id=? AND version=?').run(collection, id, expectedVersion)
      if (result.changes !== 1) throw new HttpError(409, '数据已更新，请刷新后重试', 'VERSION_CONFLICT')
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
