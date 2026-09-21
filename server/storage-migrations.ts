import type { DatabaseSync } from 'node:sqlite'

export const STORAGE_VERSION = 2
/** Version 1 records the existing JSON entity format without rewriting any business record.
 * Future data transformations must be explicit ordered migrations with backup/restore tests.
 */
export function applyMigrations(db: DatabaseSync) {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')
    const latest = Number(db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get()?.version)
    if (latest > STORAGE_VERSION) throw new Error('数据库版本高于当前程序，请使用对应的新版本，避免降级损坏数据')
    if (latest === 0) db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(1, 'persistent-entities-and-import-provenance', new Date().toISOString())
    if (latest < 2) {
      // Derived indexes only; no business entity or historical notification changes.
      db.exec(`CREATE INDEX IF NOT EXISTS delivery_due ON entities(collection,json_extract(data,'$.status'),json_extract(data,'$.nextAttemptAt'),id);
        CREATE INDEX IF NOT EXISTS delivery_lease ON entities(collection,json_extract(data,'$.status'),json_extract(data,'$.leaseUntil'),id);
        CREATE INDEX IF NOT EXISTS entity_created ON entities(collection,json_extract(data,'$.createdAt') DESC,id DESC);
        CREATE INDEX IF NOT EXISTS delivery_recipient ON entities(collection,json_extract(data,'$.recipientId'),json_extract(data,'$.createdAt') DESC,id DESC);`)
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(2, 'notification-queue-and-diagnostic-indexes', new Date().toISOString())
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
