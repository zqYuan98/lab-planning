import { Worker } from 'node:worker_threads'
import type { Store } from './store.ts'
import { recordRuntimeHeartbeat } from './runtime-health.ts'
import type { RuntimeHeartbeat } from '../shared/notification-diagnostics.ts'

const RESTART_DELAY_MS = 30_000, STOP_TIMEOUT_MS = 10_000

/**
 * Run the scheduler on a worker thread with its own connection to `databasePath`. Heartbeats are
 * mirrored into `store` for the diagnostics page. An unexpected exit is logged and restarted.
 * Returns a stop function that resolves once the thread has closed its connection.
 */
export function startSchedulerThread(store: Store, databasePath: string, options: { intervalMs?: number; restartDelayMs?: number } = {}): () => Promise<void> {
  let stopping = false, worker: Worker | undefined, restart: NodeJS.Timeout | undefined
  const spawn = () => {
    const current = new Worker(new URL('./scheduler-worker.ts', import.meta.url), { workerData: { databasePath, intervalMs: options.intervalMs } })
    worker = current
    current.on('message', (message: { type?: string; heartbeat?: RuntimeHeartbeat }) => {
      if (message?.type === 'heartbeat' && message.heartbeat) recordRuntimeHeartbeat(store, 'scheduler', message.heartbeat)
    })
    current.on('error', error => console.error('定时任务线程异常：', error instanceof Error ? error.message : '未知错误'))
    current.on('exit', code => {
      if (worker === current) worker = undefined
      if (stopping) return
      console.error(`定时任务线程意外退出（代码 ${code}），${Math.round((options.restartDelayMs ?? RESTART_DELAY_MS) / 1000)} 秒后重启`)
      restart = setTimeout(spawn, options.restartDelayMs ?? RESTART_DELAY_MS)
      restart.unref()
    })
  }
  spawn()
  return () => {
    stopping = true
    if (restart) clearTimeout(restart)
    const current = worker
    if (!current) return Promise.resolve()
    return new Promise<void>(resolve => {
      const force = setTimeout(() => void current.terminate(), STOP_TIMEOUT_MS)
      current.once('exit', () => { clearTimeout(force); resolve() })
      current.postMessage({ type: 'stop' })
    })
  }
}
