import 'dotenv/config'
import { createApp } from './app.ts'
import { Store } from './store.ts'
import { startScheduler } from './scheduler.ts'
import { resolve } from 'node:path'

const store = new Store(resolve(process.env.DATABASE_PATH || 'data/lab-planning.sqlite'))
const app = createApp({ store })
const port = Number(process.env.PORT || 4310)
const host = process.env.HOST || '127.0.0.1'
const server = app.listen(port, host, () => console.log(`部门计划系统已启动：http://${host}:${port}`))
const stopScheduler = startScheduler(store)
let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  stopScheduler()
  server.close(() => { store.close(); process.exitCode = 0 })
  setTimeout(() => process.exit(1), 10000).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
server.on('error', error => { stopScheduler(); store.close(); console.error('服务启动失败：', error.message); process.exitCode = 1 })
