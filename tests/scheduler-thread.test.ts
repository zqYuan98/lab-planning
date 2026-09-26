import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { Entity } from '../shared/types.ts'
import { Store } from '../server/store.ts'
import { startSchedulerThread } from '../server/scheduler-thread.ts'
import { runtimeHeartbeat } from '../server/runtime-health.ts'

/** A file database; `close` runs first at teardown because Windows cannot delete open files. */
function database(t: import('node:test').TestContext, close: () => void) {
  const root = mkdtempSync(join(tmpdir(), 'scheduler-thread-'))
  t.after(() => { close(); rmSync(root, { recursive: true, force: true }) })
  return join(root, 'lab.sqlite')
}

test('the scheduler runs on its own thread, reports heartbeats to the request thread and stops cleanly', async t => {
  let store!: Store
  const path = database(t, () => store.close())
  store = new Store(path)
  const stop = startSchedulerThread(store, path, { intervalMs: 50 })
  const deadline = Date.now() + 15_000
  while (!runtimeHeartbeat(store, 'scheduler').completedAt && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  const heartbeat = runtimeHeartbeat(store, 'scheduler')
  assert.ok(heartbeat.startedAt && heartbeat.completedAt, 'a completed tick is visible to diagnostics on the request thread')
  assert.equal(heartbeat.failedAt, null)
  await stop()
  const settled = runtimeHeartbeat(store, 'scheduler').completedAt
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(runtimeHeartbeat(store, 'scheduler').completedAt, settled, 'no ticks after stop')
})

test('read transactions do not wait for another connection\'s write lock and see committed data only', t => {
  let store!: Store, other!: DatabaseSync
  const path = database(t, () => { other.close(); store.close() })
  store = new Store(path); other = new DatabaseSync(path)
  store.transaction(() => store.insert<Entity & { title: string }>('samples', { id: 'committed', title: '已提交' }))
  const before = store.readTransaction(() => store.workspaceRevision())
  other.exec("PRAGMA busy_timeout=0; BEGIN IMMEDIATE; INSERT INTO entities(collection,id,version,data) VALUES('samples','pending',1,'{}')")
  const started = performance.now()
  const seen = store.readTransaction(() => store.list<Entity>('samples').map(row => row.id))
  assert.ok(performance.now() - started < 1000, 'the read did not wait for the busy timeout')
  assert.deepEqual(seen, ['committed'])
  other.exec('COMMIT')
  assert.notEqual(store.readTransaction(() => store.workspaceRevision()), before, 'another connection\'s commit invalidates page cursors')
})

test('a write inside a read transaction is a programming error and leaves nothing behind', t => {
  const store = new Store(':memory:'); t.after(() => store.close())
  assert.throws(() => store.readTransaction(() => store.insert<Entity>('samples', { id: 'nope' })), /read-only transaction/)
  assert.equal(store.get('samples', 'nope'), undefined)
  // Nested write transactions inside a read transaction are refused as well.
  assert.throws(() => store.readTransaction(() => store.transaction(() => store.insert<Entity>('samples', { id: 'nested' }))), /read-only transaction/)
  // After the read transaction ends, writes work again.
  store.transaction(() => store.insert<Entity>('samples', { id: 'after' }))
  assert.ok(store.get('samples', 'after'))
})

test('every database opens with its operation epoch so first reads need no write', t => {
  let reopened: Store | undefined
  const path = database(t, () => reopened?.close())
  const first = new Store(path)
  const epoch = first.readTransaction(() => first.get<{ epoch: string }>('operationContexts', 'business-commands')?.epoch)
  first.close()
  assert.match(epoch ?? '', /^[0-9a-f-]{36}$/)
  reopened = new Store(path)
  assert.equal(reopened.get<{ epoch: string }>('operationContexts', 'business-commands')?.epoch, epoch, 'reopening keeps the existing epoch')
})
