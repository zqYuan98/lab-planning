import 'dotenv/config'
import { DatabaseSync, backup } from 'node:sqlite'
import { mkdir, stat } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const source = resolve(process.env.DATABASE_PATH || './data/lab-planning.sqlite')
const destination = resolve(process.argv[2] || `./data/backups/lab-planning-${new Date().toISOString().replace(/[:.]/g, '-')}.sqlite`)
if (source === destination) throw new Error('备份路径不能与源数据库相同')
await stat(source)
try {
  await stat(destination)
  throw new Error('目标文件已存在，请使用新的备份文件名')
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
}
await mkdir(dirname(destination), { recursive: true })
const database = new DatabaseSync(source, { readOnly: true })
try {
  await backup(database, destination)
  const verification = new DatabaseSync(destination, { readOnly: true })
  try {
    const result = verification.prepare('PRAGMA integrity_check').get()
    if (result?.integrity_check !== 'ok') throw new Error('备份完整性检查未通过')
  } finally { verification.close() }
  console.log(`备份已完成并通过完整性检查：${destination}`)
} finally { database.close() }
