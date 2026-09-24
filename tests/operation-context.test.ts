import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DatabaseSync, backup } from 'node:sqlite'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { assertOperationEpoch, getOperationEpoch, rotateOperationEpoch } from '../server/operation-context.ts'

test('operation epoch persists across reads and normal database reopen', () => {
  const prefix = resolve(tmpdir(), 'lab-operation-context-')
  const directory = mkdtempSync(prefix)
  const path = join(directory, 'fixture.sqlite')
  let store = new Store(path)
  try {
    const epoch = getOperationEpoch(store)
    assert.match(epoch, /^[a-f0-9-]{36}$/)
    assert.equal(getOperationEpoch(store), epoch)
    assert.doesNotThrow(() => assertOperationEpoch(store, epoch))
    store.close()
    store = new Store(path)
    assert.equal(getOperationEpoch(store), epoch)
  } finally {
    store.close()
    assert.ok(resolve(directory).startsWith(prefix))
    rmSync(directory, { recursive: true, force: true })
  }
})

test('missing, forged and pre-restore epochs are rejected without changing the current epoch', () => {
  const store = new Store(':memory:')
  try {
    const first = getOperationEpoch(store)
    for (const value of [undefined, '', 'forged', [], { epoch: first }]) {
      assert.throws(() => assertOperationEpoch(store, value), { status: 409, code: 'OPERATION_CONTEXT_CHANGED' })
      assert.equal(getOperationEpoch(store), first)
    }
    const second = rotateOperationEpoch(store)
    assert.notEqual(second, first)
    assert.throws(() => assertOperationEpoch(store, first), { status: 409, code: 'OPERATION_CONTEXT_CHANGED' })
    assert.doesNotThrow(() => assertOperationEpoch(store, second))
  } finally { store.close() }
})

test('operation context rotation participates in the surrounding restore transaction', () => {
  const store = new Store(':memory:')
  try {
    const initial = getOperationEpoch(store)
    assert.throws(() => store.transaction(() => {
      rotateOperationEpoch(store)
      throw new Error('restore failed')
    }), /restore failed/)
    assert.equal(getOperationEpoch(store), initial)
  } finally { store.close() }
})

test('business restore rotates only on actual changes, and a failed final audit rolls the epoch back', t => {
  const source = new Store(':memory:'), target = new Store(':memory:')
  t.after(() => { source.close(); target.close() })
  const sourceDomain = new Domain(source), targetDomain = new Domain(target)
  const account = { name: '测试管理者', email: 'epoch@fixture.test', password: 'Fixture-password-2026!' }
  const owner = sourceDomain.setup(account), targetOwner = targetDomain.setup(account)
  sourceDomain.createPlan(owner, { month: '2026-09', title: '迁移目标', category: '研发', expectedOutcome: '报告', acceptanceCriteria: '核对通过', dueDate: '2026-09-30' })
  const initial = getOperationEpoch(target)
  const packet = exportBusinessData(source, owner)
  assert.equal('operationContexts' in packet.collections, false)
  const preview = previewRestore(target, targetOwner, packet)
  const original = target.insert.bind(target)
  const insert = t.mock.method(target, 'insert', (collection: string, input: any) => {
    if (collection === 'events' && input.entityType === 'dataRestore') throw new Error('restore audit failed')
    return original(collection, input)
  })
  assert.throws(() => restoreBusinessData(target, targetOwner, packet, {}, preview.fingerprint), /restore audit failed/)
  assert.equal(getOperationEpoch(target), initial)
  assert.equal(target.list('plans').length, 0)
  insert.mock.restore()
  restoreBusinessData(target, targetOwner, packet, {}, preview.fingerprint)
  const restored = getOperationEpoch(target)
  assert.notEqual(restored, initial)
  const repeated = previewRestore(target, targetOwner, packet)
  assert.equal(restoreBusinessData(target, targetOwner, packet, {}, repeated.fingerprint).restored, 0)
  assert.equal(getOperationEpoch(target), restored)
})

test('whole-backup recovery reset rejects a browser command created after the backup point', async () => {
  const prefix = resolve(tmpdir(), 'lab-operation-recovery-')
  const directory = mkdtempSync(prefix)
  const sourcePath = join(directory, 'source.sqlite'), restoredPath = join(directory, 'restored.sqlite')
  const source = new Store(sourcePath)
  try {
    const domain = new Domain(source)
    const owner = domain.setup({ name: '恢复测试', email: 'restore@fixture.test', password: 'Fixture-password-2026!' })
    const plan = domain.createPlan(owner, { month: '2026-09', title: '原月目标', category: '研发', expectedOutcome: '报告', acceptanceCriteria: '核对通过', dueDate: '2026-09-30' })
    const command = { sourceVersion: plan.version, operationEpoch: getOperationEpoch(source), requestId: 'backup-point-command-123', month: '2026-10', dueDate: '2026-10-30', reason: '继续' }
    const database = new DatabaseSync(sourcePath, { readOnly: true })
    try { await backup(database, restoredPath) } finally { database.close() }
    domain.carryPlan(owner, plan.id, command)
    const resetScript = fileURLToPath(new URL('../scripts/reset-operation-context.ts', import.meta.url))
    const result = spawnSync(process.execPath, ['--import', 'tsx', resetScript, restoredPath], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    const restored = new Store(restoredPath)
    try {
      assert.throws(() => new Domain(restored).carryPlan(owner, plan.id, command), { code: 'OPERATION_CONTEXT_CHANGED' })
      assert.equal(restored.list('plans').length, 1)
      assert.equal(restored.list('monthlyCarryRequests').length, 0)
    } finally { restored.close() }
  } finally {
    source.close()
    assert.ok(resolve(directory).startsWith(prefix))
    rmSync(directory, { recursive: true, force: true })
  }
})
