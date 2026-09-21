import 'dotenv/config'
import { createApp } from './app.ts'
import { Store } from './store.ts'
import { startScheduler } from './scheduler.ts'
import { resolve } from 'node:path'
import { closeImportServices } from './import-routes.ts'
import { startNotificationWorker } from './notification-worker.ts'
import { createDingTalkClient } from './dingtalk.ts'
import { drainServices, SHUTDOWN_TIMEOUT_MS } from './shutdown.ts'
import { createDingTalkNativeClient } from './dingtalk-native.ts'
import { startNativeWorker } from './native-worker.ts'
import { startNativeStream } from './native-stream.ts'

const store = new Store(resolve(process.env.DATABASE_PATH || 'data/lab-planning.sqlite'))
const dingtalkClient = createDingTalkClient()
const nativeClient = createDingTalkNativeClient()
const app = createApp({ store, dingtalkClient, nativeClient })
const port = Number(process.env.PORT || 4310)
const host = process.env.HOST || '127.0.0.1'
const server = app.listen(port, host)
let stopScheduler = () => {}
let stopNotifications = async () => {}
let stopNative = async () => {}
let stopStream = async () => {}
server.once('listening', () => {
  if (stopping) return
  stopScheduler = startScheduler(store)
  stopNotifications = startNotificationWorker(store, dingtalkClient)
  stopNative = startNativeWorker(store, nativeClient)
  stopStream = startNativeStream(store, nativeClient)
  console.log(`部门计划系统已启动：http://${host}:${port}`)
})
let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  const deadline = setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS)
  deadline.unref()
  void drainServices({
    stopScheduling: () => { stopScheduler(); closeImportServices(store) },
    stopWorkers: async () => { await Promise.all([stopNotifications(), stopNative(), stopStream()]) },
    closeHttp: () => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())),
    closeStore: () => store.close(),
  }).then(() => { clearTimeout(deadline); process.exitCode = 0 }).catch(() => { console.error('服务退出未完成，保留发送租约供重启核查'); process.exitCode = 1 })
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
server.on('error', error => { stopScheduler(); store.close(); console.error('服务启动失败：', error.message); process.exitCode = 1 })
