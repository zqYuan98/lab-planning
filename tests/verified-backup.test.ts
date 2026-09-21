import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { Store } from '../server/store.ts'
import type { Entity } from '../shared/types.ts'
import { createVerifiedBackup, drillVerifiedBackup, drillOffsiteBackup, uploadVerifiedBackup, backupManifests, previewBackupRetention, applyBackupRetention } from '../server/verified-backup.ts'

test('encrypted backup verifies SQLite, isolated restore and offsite readback without exposing plaintext or key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'verified-backup-test-'))
  mkdirSync(join(root, 'data')); mkdirSync(join(root, 'keys'))
  const database = join(root, 'data', 'test.sqlite'), keyFile = join(root, 'keys', 'key'), directory = join(root, 'backups'), options = { keyFile, directory }
  writeFileSync(keyFile, randomBytes(32)); const store = new Store(database)
  store.insert<Entity & { secret: string }>('sample', { secret: 'PRIVATE BUSINESS CONTENT' })
  try {
    const manifest = await createVerifiedBackup(database, options)
    assert.equal(readFileSync(join(directory, `${manifest.id}.enc`)).includes(Buffer.from('PRIVATE BUSINESS CONTENT')), false)
    assert.equal((await drillVerifiedBackup(options, manifest.id)).entityCount, 1)
    const remote = new Map<string, Uint8Array>()
    const fetchMock = (async (url: URL, init: RequestInit = {}) => {
      assert.equal(init.redirect, 'error'); assert.equal((init.headers as Record<string, string>).Authorization, 'Bearer synthetic-token')
      if (init.method === 'PUT') {
        const chunks: Buffer[] = []
        if (typeof init.body === 'string') chunks.push(Buffer.from(init.body))
        else for await (const chunk of init.body as unknown as AsyncIterable<Buffer>) chunks.push(chunk)
        remote.set(url.pathname, Buffer.concat(chunks)); return new Response('', { status: 201 })
      }
      return new Response(remote.get(url.pathname) as BodyInit)
    }) as unknown as typeof fetch
    const uploaded = await uploadVerifiedBackup(options, manifest.id, { BACKUP_OFFSITE_URL: 'https://backup.example.test/managed/', BACKUP_OFFSITE_TOKEN: 'synthetic-token' }, fetchMock)
    assert.ok(uploaded.offsiteVerifiedAt); assert.equal(remote.size, 2)
    assert.equal((await drillOffsiteBackup(options, manifest.id, { BACKUP_OFFSITE_URL: 'https://backup.example.test/managed/', BACKUP_OFFSITE_TOKEN: 'synthetic-token' }, fetchMock)).source, 'offsite')
    const recovery = { ...options, directory: join(root, 'fresh-disaster-recovery') }
    assert.equal((await drillOffsiteBackup(recovery, manifest.id, { BACKUP_OFFSITE_URL: 'https://backup.example.test/managed/', BACKUP_OFFSITE_TOKEN: 'synthetic-token' }, fetchMock)).entityCount, 1)
    assert.equal(backupManifests(recovery.directory).length, 1, 'offsite recovery does not depend on the original local backup')
    assert.equal(JSON.stringify(uploaded).includes('synthetic-token'), false)
    assert.equal(backupManifests(directory).length, 1)
    assert.deepEqual(previewBackupRetention(directory).remove, [])
    assert.throws(() => applyBackupRetention(directory, 'unreviewed-token'))
    const bytes = readFileSync(join(directory, `${manifest.id}.enc`)); bytes[0] ^= 1; writeFileSync(join(directory, `${manifest.id}.enc`), bytes)
    await assert.rejects(drillVerifiedBackup(options, manifest.id), /校验失败/)
    await assert.rejects(createVerifiedBackup(database, { ...options, keyFile: database }), /32 字节/)
  } finally {
    store.close()
    assert.ok(relative(resolve(tmpdir()), resolve(root)).startsWith('verified-backup-test-'))
    rmSync(root, { recursive: true, force: true })
  }
})

test('retention preview preserves sole copies and 7 daily/4 weekly/6 monthly representatives', () => {
  const root = mkdtempSync(join(tmpdir(), 'verified-retention-test-'))
  try {
    for (let day = 1; day <= 31; day++) {
      const date = `2026-08-${String(day).padStart(2, '0')}T00:00:00.000Z`, id = `backup-${date.replace(/[-:.]/g, '')}-12345678`
      const manifest = { format: 1, id, createdAt: date, verifiedAt: date, encryptedSha256: 'a'.repeat(64), databaseSha256: 'b'.repeat(64), iv: 'c'.repeat(24), tag: 'd'.repeat(32), bytes: 1,
        ...(day !== 1 ? { offsiteVerifiedAt: date, offsiteTargetHash: 'e'.repeat(64) } : {}) }
      writeFileSync(join(root, `${id}.json`), JSON.stringify(manifest)); writeFileSync(join(root, `${id}.enc`), 'x')
    }
    writeFileSync(join(root, 'unmanaged.sqlite'), 'never delete')
    const plan = previewBackupRetention(root)
    assert.ok(plan.remove.length > 0); assert.ok(plan.keep.some(id => id.includes('20260801')))
    assert.equal(applyBackupRetention(root, plan.token).removed, plan.remove.length)
    assert.equal(readFileSync(join(root, 'unmanaged.sqlite'), 'utf8'), 'never delete')
    assert.ok(backupManifests(root).length >= 7)
  } finally { assert.ok(relative(resolve(tmpdir()), resolve(root)).startsWith('verified-retention-test-')); rmSync(root, { recursive: true, force: true }) }
})
