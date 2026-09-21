import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { constants, copyFileSync, createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { Readable, Transform } from 'node:stream'
import { DatabaseSync, backup } from 'node:sqlite'

export interface BackupManifest {
  format: 1; id: string; createdAt: string; verifiedAt: string; encryptedSha256: string; databaseSha256: string
  iv: string; tag: string; bytes: number; offsiteVerifiedAt?: string; offsiteTargetHash?: string; restoredAt?: string; restoreSeconds?: number
}
interface BackupOptions { directory: string; keyFile: string; now?: Date }
const inside = (parent: string, child: string) => { const path = relative(parent, child); return path === '' || !path.startsWith('..') && !isAbsolute(path) }
const idPattern = /^backup-\d{8}T\d{9}Z-[a-f0-9]{8}$/
function rootDirectory(directory: string) { mkdirSync(resolve(directory), { recursive: true, mode: 0o700 }); return realpathSync(resolve(directory)) }
function keyFor(options: BackupOptions): Buffer {
  const root = rootDirectory(options.directory), keyFile = realpathSync(resolve(options.keyFile))
  if (inside(root, keyFile)) throw new Error('备份密钥必须单独保管，不能位于备份目录内')
  const key = readFileSync(keyFile)
  if (key.length !== 32) throw new Error('备份密钥格式无效，需要独立的 32 字节密钥文件')
  return key
}
async function hashFile(path: string) { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex') }
function manifestPath(directory: string, id: string) { if (!idPattern.test(id)) throw new Error('备份标识无效'); return join(rootDirectory(directory), `${id}.json`) }
function encryptedPath(directory: string, id: string) { manifestPath(directory, id); const path = join(rootDirectory(directory), `${id}.enc`); if (existsSync(path) && !inside(rootDirectory(directory), realpathSync(path))) throw new Error('备份文件超出受管目录'); return path }
function saveManifest(directory: string, value: BackupManifest) {
  const path = manifestPath(directory, value.id), temporary = `${path}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temporary, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 }); renameSync(temporary, path)
}
function readManifest(directory: string, id: string): BackupManifest {
  const path = manifestPath(directory, id)
  if (!inside(rootDirectory(directory), realpathSync(path))) throw new Error('备份清单超出受管目录')
  const value = JSON.parse(readFileSync(path, 'utf8')) as BackupManifest
  if (value.format !== 1 || value.id !== id || !/^[a-f0-9]{64}$/.test(value.encryptedSha256) || !/^[a-f0-9]{64}$/.test(value.databaseSha256) || !/^[a-f0-9]{24}$/.test(value.iv) || !/^[a-f0-9]{32}$/.test(value.tag) || !Number.isFinite(Date.parse(value.createdAt)) || !Number.isFinite(Date.parse(value.verifiedAt))) throw new Error('备份清单无效')
  return value
}
export function backupManifests(directory: string): BackupManifest[] {
  if (!existsSync(directory)) return []
  return readdirSync(directory).filter(name => name.endsWith('.json') && idPattern.test(name.slice(0, -5))).flatMap(name => {
    try { const value = readManifest(directory, name.slice(0, -5)); return statSync(encryptedPath(directory, value.id)).size === value.bytes ? [value] : [] } catch { return [] } // Unrecognized/missing files are never retention candidates.
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
}
async function verifyEncrypted(options: BackupOptions, manifest: BackupManifest, destination: string) {
  const path = encryptedPath(options.directory, manifest.id)
  if (await hashFile(path) !== manifest.encryptedSha256) throw new Error('加密备份校验失败')
  const decipher = createDecipheriv('aes-256-gcm', keyFor(options), Buffer.from(manifest.iv, 'hex'))
  decipher.setAuthTag(Buffer.from(manifest.tag, 'hex'))
  await pipeline(createReadStream(path), decipher, createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
  if (await hashFile(destination) !== manifest.databaseSha256) throw new Error('恢复数据校验失败')
  const database = new DatabaseSync(destination, { readOnly: true })
  try {
    if (database.prepare('PRAGMA integrity_check').get()?.integrity_check !== 'ok') throw new Error('SQLite 完整性校验失败')
    return Number(database.prepare('SELECT COUNT(*) AS count FROM entities').get()?.count ?? 0)
  } finally { database.close() }
}
/** Online SQLite backup, authenticated encryption and a full isolated decrypt/integrity check. */
export async function createVerifiedBackup(databasePath: string, options: BackupOptions): Promise<BackupManifest> {
  const root = rootDirectory(options.directory), source = realpathSync(databasePath), key = keyFor(options)
  if (inside(dirname(source), realpathSync(options.keyFile))) throw new Error('备份密钥不能与生产数据库保存在同一目录树')
  if (inside(root, source)) throw new Error('生产数据库不能位于受管备份目录内')
  const now = options.now ?? new Date(), id = `backup-${now.toISOString().replace(/[-:.]/g, '')}-${randomBytes(4).toString('hex')}`
  const workspace = await mkdtemp(join(tmpdir(), 'lab-backup-verify-')), plain = join(workspace, 'snapshot.sqlite'), restored = join(workspace, 'verified.sqlite')
  const encrypted = encryptedPath(root, id), partial = `${encrypted}.partial`
  try {
    const sourceDb = new DatabaseSync(source, { readOnly: true })
    try { await backup(sourceDb, plain) } finally { sourceDb.close() }
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv)
    await pipeline(createReadStream(plain), cipher, createWriteStream(partial, { flags: 'wx', mode: 0o600 }))
    renameSync(partial, encrypted)
    const manifest: BackupManifest = { format: 1, id, createdAt: now.toISOString(), verifiedAt: now.toISOString(),
      encryptedSha256: await hashFile(encrypted), databaseSha256: await hashFile(plain), iv: iv.toString('hex'), tag: cipher.getAuthTag().toString('hex'), bytes: statSync(encrypted).size }
    await verifyEncrypted(options, manifest, restored)
    saveManifest(root, manifest)
    return manifest
  } finally { rmSync(workspace, { recursive: true, force: true }); rmSync(partial, { force: true }) }
}
function offsiteBase(env: NodeJS.ProcessEnv) {
  const base = new URL(env.BACKUP_OFFSITE_URL ?? '')
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || !base.pathname.endsWith('/')) throw new Error('异机副本需要 HTTPS 固定目录地址；地址不能包含凭据或查询参数')
  return base
}
/** Explicit CLI operation only. Remote endpoint must support PUT and authenticated GET of the same immutable object. */
export async function uploadVerifiedBackup(options: BackupOptions, id: string, env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch): Promise<BackupManifest> {
  const manifest = readManifest(options.directory, id), base = offsiteBase(env), token = env.BACKUP_OFFSITE_TOKEN
  if (!token || /[\r\n]/.test(token)) throw new Error('异机备份凭据尚未配置')
  const path = encryptedPath(options.directory, id)
  if (await hashFile(path) !== manifest.encryptedSha256) throw new Error('本地加密副本校验失败，未上传')
  const url = new URL(`${id}.enc`, base), headers = { Authorization: `Bearer ${token}` }
  const result = await request(url, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/octet-stream', 'If-None-Match': '*' }, body: createReadStream(path) as unknown as BodyInit, duplex: 'half', redirect: 'error', signal: AbortSignal.timeout(120000) } as RequestInit)
  if (!result.ok && result.status !== 412) throw new Error('异机备份写入失败，保留本地副本')
  await result.body?.cancel()
  const response = await request(url, { headers, redirect: 'error', signal: AbortSignal.timeout(120000) })
  if (!response.ok || !response.body) throw new Error('异机副本回读失败，尚未标记上传完成')
  const hash = createHash('sha256'); let bytes = 0
  const sink = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; if (bytes > manifest.bytes) return callback(new Error('异机副本长度不匹配')); hash.update(chunk); callback() } })
  await pipeline(Readable.fromWeb(response.body as never), sink)
  if (bytes !== manifest.bytes || hash.digest('hex') !== manifest.encryptedSha256) throw new Error('异机副本校验失败，尚未标记上传完成')
  // The decryption manifest is required to restore offsite; it contains no secret key.
  const manifestResult = await request(new URL(`${id}.json`, base), { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(manifest), redirect: 'error', signal: AbortSignal.timeout(30000) })
  if (!manifestResult.ok) throw new Error('异机恢复清单写入失败，尚未标记上传完成')
  await manifestResult.body?.cancel()
  const manifestRead = await request(new URL(`${id}.json`, base), { headers, redirect: 'error', signal: AbortSignal.timeout(30000) })
  if (!manifestRead.ok || JSON.stringify(await manifestRead.json()) !== JSON.stringify(manifest)) throw new Error('异机恢复清单回读失败，尚未标记上传完成')
  const updated = { ...manifest, offsiteVerifiedAt: new Date().toISOString(), offsiteTargetHash: createHash('sha256').update(base.href).digest('hex') }
  saveManifest(options.directory, updated); return updated
}
/** Always uses a fresh isolated directory and never takes a production restore destination. */
export async function drillVerifiedBackup(options: BackupOptions, id: string) {
  const manifest = readManifest(options.directory, id), start = performance.now(), workspace = await mkdtemp(join(tmpdir(), 'lab-restore-drill-'))
  try {
    const entityCount = await verifyEncrypted(options, manifest, join(workspace, 'restored.sqlite')), seconds = Math.ceil((performance.now() - start) / 1000)
    saveManifest(options.directory, { ...manifest, restoredAt: new Date().toISOString(), restoreSeconds: seconds })
    return { id, integrity: 'ok', entityCount, seconds, isolated: true }
  } finally { rmSync(workspace, { recursive: true, force: true }) }
}
/** Read the encrypted object AND recovery manifest from the configured remote endpoint before drilling. */
export async function drillOffsiteBackup(options: BackupOptions, id: string, env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch) {
  if (!idPattern.test(id)) throw new Error('备份标识无效')
  const base = offsiteBase(env), token = env.BACKUP_OFFSITE_TOKEN
  if (!token || /[\r\n]/.test(token)) throw new Error('异机备份凭据尚未配置')
  const workspace = await mkdtemp(join(tmpdir(), 'lab-offsite-drill-')), headers = { Authorization: `Bearer ${token}` }
  try {
    const response = await request(new URL(`${id}.json`, base), { headers, redirect: 'error', signal: AbortSignal.timeout(30000) })
    if (!response.ok || !response.body) throw new Error('异机恢复清单读取失败')
    const chunks: Buffer[] = []; let total = 0
    for await (const chunk of Readable.fromWeb(response.body as never)) { total += chunk.length; if (total > 16384) throw new Error('异机恢复清单超出预算'); chunks.push(Buffer.from(chunk)) }
    writeFileSync(join(workspace, `${id}.json`), Buffer.concat(chunks), { flag: 'wx', mode: 0o600 })
    const manifest = readManifest(workspace, id)
    if (!Number.isSafeInteger(manifest.bytes) || manifest.bytes < 1 || manifest.bytes > 100 * 1024 * 1024 * 1024) throw new Error('异机备份长度无效')
    const encrypted = await request(new URL(`${id}.enc`, base), { headers, redirect: 'error', signal: AbortSignal.timeout(120000) })
    if (!encrypted.ok || !encrypted.body) throw new Error('异机备份读取失败')
    let bytes = 0
    const bounded = new Transform({ transform(chunk, _encoding, callback) { bytes += chunk.length; callback(bytes > manifest.bytes ? new Error('异机备份超出清单长度') : null, chunk) } })
    await pipeline(Readable.fromWeb(encrypted.body as never), bounded, createWriteStream(join(workspace, `${id}.enc`), { flags: 'wx', mode: 0o600 }))
    const result = await drillVerifiedBackup({ ...options, directory: workspace }, id)
    // Update local health only when this is the same verified artifact and target.
    // A disaster-recovery drill also works when the original local backups are
    // gone. Import only the verified ciphertext/manifest into the managed root.
    const local = existsSync(manifestPath(options.directory, id)) ? readManifest(options.directory, id) : manifest
    if (local.encryptedSha256 !== manifest.encryptedSha256) throw new Error('异机备份与本地清单不匹配')
    const localEncrypted = encryptedPath(options.directory, id)
    if (existsSync(localEncrypted)) { if (await hashFile(localEncrypted) !== manifest.encryptedSha256) throw new Error('本地备份已变化，未覆盖') }
    else copyFileSync(join(workspace, `${id}.enc`), localEncrypted, constants.COPYFILE_EXCL)
    saveManifest(options.directory, { ...local, offsiteVerifiedAt: new Date().toISOString(), offsiteTargetHash: createHash('sha256').update(base.href).digest('hex'), restoredAt: new Date().toISOString(), restoreSeconds: result.seconds })
    return { ...result, source: 'offsite' }
  } finally { rmSync(workspace, { recursive: true, force: true }) }
}
/** Retain 7 daily, 4 weekly and 6 monthly representatives. Only remotely verified surplus copies are eligible. */
export function previewBackupRetention(directory: string) {
  const all = backupManifests(directory), keep = new Set<string>()
  for (const [limit, key] of [[7, (date: Date) => date.toISOString().slice(0, 10)], [4, (date: Date) => { date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7)); return date.toISOString().slice(0, 10) }], [6, (date: Date) => date.toISOString().slice(0, 7)]] as const) {
    const groups = new Set<string>()
    for (const item of all) { const group = key(new Date(item.createdAt)); if (!groups.has(group) && groups.size < limit) { groups.add(group); keep.add(item.id) } }
  }
  const remove = all.filter(item => !keep.has(item.id) && item.offsiteVerifiedAt && item.offsiteTargetHash).map(item => item.id)
  const token = createHash('sha256').update(JSON.stringify(all)).update(JSON.stringify(remove)).digest('hex')
  return { keep: all.filter(item => !remove.includes(item.id)).map(item => item.id), remove, token, automaticDeletion: false }
}
/** Recompute the reviewed plan immediately; never delete an unverified or sole managed copy. */
export function applyBackupRetention(directory: string, token: string) {
  const plan = previewBackupRetention(directory)
  if (token !== plan.token || !plan.keep.length) throw new Error('保留预览已改变，请重新核对')
  for (const id of plan.remove) {
    // Resolve and validate both files before either is removed, with no recursive deletion.
    const root = rootDirectory(directory), paths = [encryptedPath(root, id), manifestPath(root, id)].map(path => realpathSync(path))
    if (paths.some(path => !inside(root, path))) throw new Error('保留对象超出受管目录')
    for (const path of paths) rmSync(path)
  }
  return { removed: plan.remove.length }
}
export function backupHealth(env: NodeJS.ProcessEnv = process.env) {
  const configured = !!env.VERIFIED_BACKUP_DIR && !!env.BACKUP_KEY_FILE
  const all = env.VERIFIED_BACKUP_DIR ? backupManifests(env.VERIFIED_BACKUP_DIR) : []
  const latest = (field: 'verifiedAt' | 'offsiteVerifiedAt' | 'restoredAt') => all.map(item => item[field]).filter((value): value is string => !!value).sort().at(-1) ?? null
  return { configured, verifiedAt: latest('verifiedAt'), offsiteVerifiedAt: latest('offsiteVerifiedAt'), restoredAt: latest('restoredAt') }
}
