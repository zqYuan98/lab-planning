import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openUsageAnalytics } from '../server/usage-analytics-startup.ts'
import type { User } from '../shared/types.ts'

test('unavailable optional analytics preserves damaged file and stays disabled without blocking business startup', t => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-usage-startup-'))
  const path = join(directory, 'stats.sqlite'), original = 'damaged synthetic sqlite fixture'
  writeFileSync(path, original)
  const warnings: string[] = [], analytics = openUsageAnalytics(path, 'test-release', message => warnings.push(message))
  t.after(() => { analytics.close(); rmSync(directory, { recursive: true, force: true }) })
  assert.equal(readFileSync(path, 'utf8'), original)
  assert.equal(warnings.length, 1)
  assert.equal(analytics.configuredEnabled, false)
  assert.equal(analytics.view('epoch').storageUnavailable, true)
  assert.equal(analytics.view('epoch').effectiveEnabled, false)
  const member: User = { id: 'member', role: 'member', name: 'Synthetic member', email: 'member@example.test', position: '', active: true, version: 1, createdAt: '2026-09-24T00:00:00.000Z', updatedAt: '2026-09-24T00:00:00.000Z' }
  assert.deepEqual(analytics.policy(member, 'epoch'), { enabled: false, version: 'test-release' })
  assert.throws(() => analytics.update({ version: 0, enabled: true, retentionDays: 90, excludedUserIds: [] }, [], 'epoch'), { status: 503 })
  analytics.cleanup()
})

test('healthy analytics sidecar opens normally with collection disabled by default', t => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-usage-healthy-'))
  const analytics = openUsageAnalytics(join(directory, 'stats.sqlite'), 'test-release', () => assert.fail('Unexpected storage fallback'))
  t.after(() => { analytics.close(); rmSync(directory, { recursive: true, force: true }) })
  assert.equal(analytics.view('epoch').storageUnavailable, undefined)
  assert.equal(analytics.view('epoch').settings.retentionDays, 90)
  assert.equal(analytics.configuredEnabled, false)
})
