// Worker entry: the scheduler runs here on its own SQLite connection, so its synchronous ticks
// never pause HTTP requests. Page reads use read-only transactions and do not wait for its writes.
import { parentPort, workerData } from 'node:worker_threads'
import { Store } from './store.ts'
import { startScheduler } from './scheduler.ts'

const { databasePath, intervalMs } = workerData as { databasePath: string; intervalMs?: number }
const store = new Store(databasePath)
const stop = startScheduler(store, { intervalMs, onHeartbeat: heartbeat => parentPort!.postMessage({ type: 'heartbeat', heartbeat }) })
parentPort!.on('message', message => {
  if ((message as { type?: string })?.type !== 'stop') return
  // Ticks are synchronous, so none is in progress while this handler runs.
  stop(); store.close(); parentPort!.close()
})
