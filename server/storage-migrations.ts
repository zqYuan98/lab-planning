import type { DatabaseSync } from 'node:sqlite'

export const STORAGE_VERSION = 5
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
    if (latest < 3) {
      // EXPLAIN evidence: output/phase3-performance/query-plan-v2.json.
      // These bounded query paths formerly scanned each entire collection.
      db.exec(`CREATE INDEX task_active_owner_created ON entities(json_extract(data,'$.ownerId'),json_extract(data,'$.createdAt') DESC,id DESC) WHERE collection='tasks' AND json_extract(data,'$.cancellation') IS NULL;
        CREATE INDEX weekly_active_task_owner_week ON entities(json_extract(data,'$.taskId'),json_extract(data,'$.ownerId'),json_extract(data,'$.weekStart'),json_extract(data,'$.createdAt') DESC,id DESC) WHERE collection='weeklyRecords' AND json_extract(data,'$.deletion') IS NULL;
        CREATE INDEX weekly_progress_task_owner_week ON entities(json_extract(data,'$.taskId'),json_extract(data,'$.ownerId'),json_extract(data,'$.weekStart') DESC,json_extract(data,'$.updatedAt') DESC,version DESC,id) WHERE collection='weeklyRecords' AND json_extract(data,'$.deletion') IS NULL AND trim(COALESCE(json_extract(data,'$.actualOutcome'),''))<>'';
        CREATE INDEX event_object_created ON entities(json_extract(data,'$.entityType'),json_extract(data,'$.entityId'),json_extract(data,'$.createdAt') DESC,id DESC) WHERE collection='events';
        CREATE INDEX progress_task_created ON entities(json_extract(data,'$.taskId'),json_extract(data,'$.createdAt') DESC,id DESC) WHERE collection='progressEvents';
        CREATE INDEX report_period_created ON entities(json_extract(data,'$.type'),json_extract(data,'$.period'),json_extract(data,'$.createdAt') DESC,id DESC) WHERE collection='reports';`)
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(3, 'workspace-bounded-query-indexes', new Date().toISOString())
    }
    if (latest < 4) {
      // Compatibility fence: old binaries assume every cycle has a Friday deadline.
      // No existing business row is rewritten by this migration.
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(4, 'weekly-calendar-deadline-compatibility', new Date().toISOString())
    }
    if (latest < 5) {
      // Goal-owner reads and scope derivation formerly scanned the complete tasks collection.
      // This index contains current links only and never changes business or frozen snapshot rows.
      db.exec(`CREATE INDEX task_active_goal_id ON entities(json_extract(data,'$.monthlyPlanId'),id) WHERE collection='tasks' AND json_extract(data,'$.cancellation') IS NULL`)
      db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)').run(5, 'goal-owner-current-task-index', new Date().toISOString())
    }
    db.exec('COMMIT')
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
