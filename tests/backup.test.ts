import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../server/store.ts'
import type { Project } from '../shared/types.ts'

test('online backup produces an independently reopenable database and refuses overwriting existing backups', () => {
  const prefix = resolve(tmpdir(), 'lab-planning-backup-')
  const directory = mkdtempSync(prefix)
  const source = join(directory, 'source.sqlite'), destination = join(directory, 'backup.sqlite')
  const store = new Store(source)
  try {
    const project = store.insert<Project>('projects', { name: '备份验证项目', code: 'BACKUP', description: '独立测试记录', ownerId: 'fixture-manager', status: 'active' })
    const script = fileURLToPath(new URL('../scripts/backup.ts', import.meta.url))
    const run = () => spawnSync(process.execPath, ['--import', 'tsx', script, destination], { env: { ...process.env, DATABASE_PATH: source }, encoding: 'utf8' })
    const first = run()
    assert.equal(first.status, 0, first.stderr)
    const restored = new Store(destination)
    try { assert.deepEqual(restored.get<Project>('projects', project.id), project) } finally { restored.close() }
    const repeated = run()
    assert.notEqual(repeated.status, 0)
    assert.match(repeated.stderr, /目标文件已存在/)
  } finally {
    store.close()
    assert.ok(resolve(directory).startsWith(prefix), 'only the verified task-created temporary directory may be removed')
    rmSync(directory, { recursive: true, force: true })
  }
})
