import { mkdirSync, writeFileSync } from 'node:fs'
import { Store } from '../server/store.ts'
import { STORAGE_VERSION } from '../server/storage-migrations.ts'
import { workspaceProgressSql } from '../server/workspace-progress.ts'
import type { DatabaseSync } from 'node:sqlite'
import type { Task } from '../shared/types.ts'
const store = new Store(':memory:')
const filters = [
  { resource: 'tasks', actorId: 'member', manager: false, scope: 'open' },
  { resource: 'weekly-records', actorId: 'member', manager: false, taskId: 'task', weekStart: '2026-09-21' },
  { resource: 'history', actorId: 'manager', manager: true, taskId: 'task' },
  { resource: 'progress', actorId: 'member', manager: false, taskId: 'task' },
  { resource: 'reports', actorId: 'manager', manager: true, type: 'weekly', period: '2026-09-21' },
] as const
const results = filters.map(filter => ({ filter, plan: store.workspaceExplain(filter) }))
const registerPlan = store.registerExplain({ actorId: 'member', weekStart: '2026-09-21', view: 'active' })
const progressQuery = workspaceProgressSql([{ id: 'task', ownerId: 'member' } as Task], 'member', false, '2026-09-22')
// Diagnostic access only: this script never runs against a configured or production database.
const progressPlan = (store as unknown as { db: DatabaseSync }).db.prepare(`EXPLAIN QUERY PLAN ${progressQuery.sql}`).all(...progressQuery.values)
mkdirSync('output/phase3-performance', { recursive: true })
writeFileSync(`output/phase3-performance/query-plan-v${STORAGE_VERSION}.json`, JSON.stringify({ queries: results, registerPlan, progressPlan }, null, 2))
console.log(JSON.stringify(results, null, 2)); store.close()
