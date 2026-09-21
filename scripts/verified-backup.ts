import 'dotenv/config'
import { randomBytes } from 'node:crypto'
import { closeSync, mkdirSync, openSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { createVerifiedBackup, uploadVerifiedBackup, drillVerifiedBackup, drillOffsiteBackup, previewBackupRetention, applyBackupRetention } from '../server/verified-backup.ts'

const [command, argument] = process.argv.slice(2)
const directory = process.env.VERIFIED_BACKUP_DIR, keyFile = process.env.BACKUP_KEY_FILE
let lock: number | undefined, lockPath: string | undefined
try {
  if (!directory || !keyFile) throw new Error('请先配置 VERIFIED_BACKUP_DIR 与独立的 BACKUP_KEY_FILE')
  mkdirSync(resolve(directory), { recursive: true, mode: 0o700 })
  const candidate = join(realpathSync(resolve(directory)), '.verified-backup.lock')
  lock = openSync(candidate, 'wx', 0o600); lockPath = candidate
  writeFileSync(lock, String(process.pid))
  const options = { directory, keyFile }
  if (command === 'keygen') { writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 }); console.log('独立备份密钥已创建；请离线保管，勿放入数据库或备份目录。') }
  else if (command === 'create') { const result = await createVerifiedBackup(process.env.DATABASE_PATH || 'data/lab-planning.sqlite', options); console.log(JSON.stringify({ id: result.id, verifiedAt: result.verifiedAt, bytes: result.bytes })) }
  else if (command === 'upload' && argument) { const result = await uploadVerifiedBackup(options, argument); console.log(JSON.stringify({ id: result.id, offsiteVerifiedAt: result.offsiteVerifiedAt })) }
  else if (command === 'drill' && argument) console.log(JSON.stringify(await drillVerifiedBackup(options, argument)))
  else if (command === 'drill-offsite' && argument) console.log(JSON.stringify(await drillOffsiteBackup(options, argument)))
  else if (command === 'retention-preview') console.log(JSON.stringify(previewBackupRetention(directory), null, 2))
  else if (command === 'retention-apply' && argument) console.log(JSON.stringify(applyBackupRetention(directory, argument)))
  else throw new Error('命令：keygen | create | upload <备份ID> | drill <备份ID> | drill-offsite <备份ID> | retention-preview | retention-apply <预览令牌>')
} catch { console.error('备份操作未完成，请核对命令、独立密钥、受管目录、进程锁或异机端点配置；未输出凭据或服务端响应。'); process.exitCode = 1 }
finally { if (lock !== undefined) closeSync(lock); if (lockPath) unlinkSync(lockPath) }
