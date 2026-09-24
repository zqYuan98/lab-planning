import 'dotenv/config'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { Store } from '../server/store.ts'
import { rotateOperationEpoch } from '../server/operation-context.ts'

const argument = process.argv[2]
if (!argument || process.argv.length !== 3) throw new Error('用法：npm run reset-operation-context -- <恢复后的数据库路径>。请先停止对应应用。')
const path = resolve(argument)
if (!statSync(path).isFile()) throw new Error('恢复数据库路径必须是已存在的文件')
const store = new Store(path)
try {
  rotateOperationEpoch(store)
  console.log(`已更新操作环境；重新启动后请刷新并核对未确认的承接操作：${path}`)
} finally { store.close() }
