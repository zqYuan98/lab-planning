import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { dirname } from 'node:path'
import { mkdirSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Entity } from '../shared/types.ts'

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
