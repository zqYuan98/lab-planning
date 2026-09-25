import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { AddressInfo } from 'node:net'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { getOperationEpoch, rotateOperationEpoch } from '../server/operation-context.ts'
import { UsageAnalyticsStore } from '../server/usage-analytics.ts'
import type { UsageSettingsView, UsageSummary } from '../shared/usage-analytics.ts'

test('real app counts only successful member work without changing workspace revision, and sidecar backup restores independently', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-usage-deployment-')), path = join(directory, 'business.sqlite.usage.sqlite')
  const store = new Store(':memory:'), domain = new Domain(store)
  const manager = domain.setup({ name: 'Synthetic manager', email: 'manager@usage.invalid', password: 'SyntheticUsage2026!' })
  const member = domain.createUser(manager, { name: 'Synthetic member', email: 'member@usage.invalid', password: 'SyntheticUsage2026!', role: 'member' })
  const observer = domain.createUser(manager, { name: 'Synthetic observer', email: 'observer@usage.invalid', password: 'SyntheticUsage2026!', role: 'observer' })
  const analytics = new UsageAnalyticsStore(path, { version: 'test-built-release' })
  const app = createApp({ store, usageAnalytics: analytics, enableScheduler: false, dingtalkClient: { configured: false } as never })
  const cookies = Object.fromEntries([manager, member, observer].map(user => [user.id, `lab_session=${createSession(store, store.get<StoredUser>('users', user.id)!)}`]))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    analytics.close(); store.close(); rmSync(directory, { recursive: true, force: true })
  })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const request = async (actorId: string, path: string, method = 'GET', body?: unknown, status = 200) => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { cookie: cookies[actorId], 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text()
    assert.equal(response.status, status, `${method} ${path}: ${text}`)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    return text ? JSON.parse(text) : undefined
  }
  assert.equal((await request(member.id, '/usage-analytics/status')).enabled, false)
  assert.equal((await request(observer.id, '/usage-analytics/status')).enabled, false)
  await request(observer.id, '/usage-analytics/settings', 'GET', undefined, 403)
  const settings = await request(manager.id, '/usage-analytics/settings') as UsageSettingsView
  await request(manager.id, '/usage-analytics/settings', 'PUT', { version: settings.settings.version, enabled: true, retentionDays: 90, excludedUserIds: [] })
  const epoch = getOperationEpoch(store), revision = store.workspaceRevision()
  const page = { userId: member.id, page: 'work-register', version: 'test-built-release' }
  await request(member.id, '/usage-analytics/page', 'POST', page, 204)
  await request(member.id, '/usage-analytics/page', 'POST', page, 204)
  assert.equal(store.workspaceRevision(), revision, 'a measurement must not invalidate business paging cursors')
  const command = { requestId: 'capture-analytics-replay-0001', titles: ['Synthetic task'], workSource: 'self' }
  await request(member.id, '/work-register/capture', 'POST', command, 201)
  await request(member.id, '/work-register/capture', 'POST', command, 201)
  await request(member.id, '/work-register/capture', 'POST', { ...command, requestId: 'capture-invalid-00000001', titles: [] }, 400)
  const summary = await request(manager.id, '/usage-analytics/summary') as UsageSummary
  assert.equal(summary.pages.find(row => row.name === 'work-register')?.count, 1)
  assert.equal(summary.actions.find(row => row.name === 'work_captured')?.count, 1)
  assert.equal(summary.activeMembers, 1)
  const destination = join(directory, 'usage-backup.sqlite')
  const backup = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/backup.ts'), destination], { cwd: process.cwd(), env: { ...process.env, DATABASE_PATH: path }, encoding: 'utf8', timeout: 20_000 })
  assert.ifError(backup.error)
  assert.equal(backup.status, 0, backup.stderr)
  const restored = new UsageAnalyticsStore(destination, { version: 'test-built-release' })
  try {
    assert.deepEqual(restored.summary([manager, member, observer], epoch, {}), summary)
    assert.equal(restored.view(epoch).effectiveEnabled, true)
    assert.equal(restored.view(rotateOperationEpoch(store)).effectiveEnabled, false)
    assert.equal(restored.view(getOperationEpoch(store)).activationRequired, true)
  } finally { restored.close() }
})
