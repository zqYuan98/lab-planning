import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import express, { type ErrorRequestHandler } from 'express'
import type { User } from '../shared/types.ts'
import type { UsageSettingsView, UsageSummary } from '../shared/usage-analytics.ts'
import { Store } from '../server/store.ts'
import { createSession, createOriginGuard, requireAuth, type StoredUser } from '../server/auth.ts'
import { getOperationEpoch, rotateOperationEpoch } from '../server/operation-context.ts'
import { UsageAnalyticsStore, usageDay } from '../server/usage-analytics.ts'
import { usageAnalyticsRouter, usageAnalyticsSuccessMiddleware, usageOperationForResponse } from '../server/usage-analytics-routes.ts'

const stamp = '2026-09-24T08:00:00.000Z'
const member = (id: string, role: User['role'] = 'member'): User => ({ id, role, name: id, email: `${id}@example.test`, position: '', active: true, version: 1, createdAt: stamp, updatedAt: stamp })
const users = [member('alice'), member('bob'), member('test'), member('manager', 'manager'), member('observer', 'observer'), { ...member('inactive'), active: false }, { ...member('pending'), registrationStatus: 'pending' as const }]
const event = { page: 'work-register', version: 'r2', userId: 'alice' }
const count = (summary: UsageSummary, name: string) => [...summary.pages, ...summary.actions].find(row => row.name === name)!.count
const settings = (a: UsageAnalyticsStore, enabled = true, excludedUserIds: string[] = [], retentionDays: 30 | 90 = 90, epoch = 'epoch') => a.update({ version: a.view(epoch).settings.version, enabled, retentionDays, excludedUserIds }, users, epoch)

test('default off, strict vocabulary, only eligible members, and explicit active-member denominator', () => {
  const analytics = new UsageAnalyticsStore(':memory:', { version: 'r2', clock: () => new Date(stamp) })
  try {
    assert.equal(analytics.view('epoch').settings.enabled, false)
    analytics.page(users[0], 'epoch', event)
    assert.equal(analytics.summary(users, 'epoch', {}).activeMembers, 0)
    settings(analytics, true, ['test'])
    for (const user of users) analytics.page(user, 'epoch', { ...event, userId: user.id })
    analytics.page(users[0], 'epoch', event)
    const summary = analytics.summary(users, 'epoch', {})
    assert.equal(summary.eligibleMembers, 2)
    assert.equal(summary.activeMembers, 2)
    assert.equal(count(summary, 'work-register'), 2)
    assert.equal(summary.pages.find(row => row.name === 'work-register')!.memberRate, 1)
    assert.equal(summary.denominator, 'active_members_in_period')
    assert.equal(summary.insufficientData, true)
    for (const patch of [{ page: '/tasks?body=secret' }, { body: '正文内容' }, { date: '2026-09-25' }, { userId: 'bob' }, { version: 'spoofed' }, { action: 'unknown' }]) assert.throws(() => analytics.page(users[0], 'epoch', { ...event, ...patch }))
    assert.throws(() => analytics.update({ version: 1, enabled: true, retentionDays: 90, excludedUserIds: [], arbitrary: 'secret' }, users, 'epoch'))
    settings(analytics, true, ['alice', 'test'])
    assert.equal(analytics.summary(users, 'epoch', {}).activeMembers, 1, 'excluding a test account removes its existing contributions')
  } finally { analytics.close() }
})

test('page dedup uses Shanghai day and version; action receipts dedup across days and releases', () => {
  const directory = mkdtempSync(join(tmpdir(), 'usage-analytics-')), path = join(directory, 'usage.sqlite')
  let now = new Date('2026-09-23T15:59:59.000Z'), analytics = new UsageAnalyticsStore(path, { version: 'r2', clock: () => now })
  try {
    settings(analytics)
    analytics.page(users[0], 'epoch', event)
    analytics.page(users[0], 'epoch', event)
    analytics.action(users[0], 'epoch', 'task_saved', 'a'.repeat(64))
    now = new Date('2026-09-23T16:00:00.000Z')
    analytics.page(users[0], 'epoch', event)
    analytics.action(users[0], 'epoch', 'task_saved', 'a'.repeat(64))
    assert.equal(count(analytics.summary(users, 'epoch', {}), 'work-register'), 2)
    assert.equal(count(analytics.summary(users, 'epoch', {}), 'task_saved'), 1)
    analytics.close(); analytics = new UsageAnalyticsStore(path, { version: 'r3', clock: () => now })
    analytics.page(users[0], 'epoch', { ...event, version: 'r3' })
    analytics.action(users[0], 'epoch', 'task_saved', 'a'.repeat(64))
    analytics.action(users[0], 'epoch', 'task_saved', 'b'.repeat(64))
    assert.equal(count(analytics.summary(users, 'epoch', {}), 'work-register'), 1)
    assert.equal(count(analytics.summary(users, 'epoch', {}), 'task_saved'), 1)
    assert.equal(count(analytics.summary(users, 'epoch', { version: 'r2' }), 'work-register'), 2)
    const raw = new DatabaseSync(path)
    try {
      const rows = raw.prepare('SELECT * FROM usage_events').all()
      assert.ok(rows.every(row => /^[a-f0-9]{64}$/.test(String(row.member_key))))
      assert.equal(JSON.stringify(rows).includes('alice'), false)
      assert.deepEqual(Object.keys(rows[0]).sort(), ['day', 'kind', 'member_key', 'name', 'operation_key', 'version'])
    } finally { raw.close() }
  } finally { analytics.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('90/30-day retention, disabled cleanup, and restored operation epoch require fresh activation', () => {
  let now = new Date('2026-06-26T08:00:00.000Z')
  const analytics = new UsageAnalyticsStore(':memory:', { version: 'r2', clock: () => now })
  try {
    settings(analytics)
    analytics.page(users[0], 'epoch', event)
    now = new Date('2026-06-27T08:00:00.000Z'); analytics.page(users[0], 'epoch', event)
    now = new Date(stamp); analytics.cleanup()
    assert.equal(count(analytics.summary(users, 'epoch', { from: '2026-06-27' }), 'work-register'), 1)
    analytics.action(users[0], 'epoch', 'task_saved', 'c'.repeat(64), '2026-06-26')
    assert.equal(count(analytics.summary(users, 'epoch', {}), 'task_saved'), 0, 'replaying an expired operation cannot create a fresh action')
    settings(analytics, false, [], 30)
    assert.equal(analytics.summary(users, 'epoch', {}).activeMembers, 0)
    settings(analytics)
    analytics.page(users[0], 'epoch', event)
    assert.equal(analytics.policy(users[0], 'restored').enabled, false)
    assert.equal(analytics.view('restored').activationRequired, true)
    assert.equal(analytics.summary(users, 'restored', {}).activeMembers, 0)
    analytics.page(users[0], 'restored', event)
    settings(analytics, true, [], 90, 'restored')
    assert.equal(analytics.summary(users, 'restored', {}).activeMembers, 0)
    analytics.page(users[0], 'restored', event)
    assert.equal(analytics.summary(users, 'restored', {}).activeMembers, 1)
    settings(analytics, false, [], 90, 'restored')
    now = new Date('2027-01-01T08:00:00.000Z'); analytics.cleanup()
    assert.equal(analytics.summary(users, 'restored', {}).activeMembers, 0)
  } finally { analytics.close() }
})

test('successful-operation projection accepts fixed routes and retains no body, URL or response content', () => {
  const input = { requestId: 'operation-12345678', title: '秘密正文', evidenceUrl: 'https://secret.test/?token=SECRET' }
  const output = { id: 'task-1', version: 2, updatedAt: stamp, description: '秘密正文' }
  const legacy = usageOperationForResponse('PATCH', '/tasks/task-1', input, output)!
  assert.equal(legacy.action, 'task_saved'); assert.equal(legacy.day, '2026-09-24'); assert.match(legacy.id, /^[a-f0-9]{64}$/)
  const capture = usageOperationForResponse('POST', '/work-register/capture', input, { tasks: [{ ...output, createdAt: stamp }] })!
  assert.deepEqual(capture, usageOperationForResponse('POST', '/work-register/capture', input, { tasks: [{ ...output, version: 50, createdAt: stamp }] }))
  for (const path of ['/usage-analytics/page', '/feedback/meta', '/tasks/task-1?secret=yes', '/weekly-submissions/deadline-repair/preview']) assert.equal(usageOperationForResponse('POST', path, input, output), null)
  assert.equal(usageOperationForResponse('GET', '/tasks/task-1', input, output), null)
  assert.equal(JSON.stringify([capture, legacy]).includes('秘密正文'), false)
  assert.equal(JSON.stringify([capture, legacy]).includes('SECRET'), false)
  assert.ok(usageOperationForResponse('PATCH', '/tasks/ignored', input, { ...output, id: '任务.1' }))
  const progress = { progressEvent: { id: 'progress-1', taskId: 'a', createdAt: stamp } }
  const first = usageOperationForResponse('POST', '/tasks/a/progress', input, progress)!
  assert.equal(first.id, usageOperationForResponse('POST', '/tasks/%61/progress', input, progress)!.id, 'route encoding cannot duplicate one successful receipt')
  assert.notEqual(first.id, usageOperationForResponse('POST', '/tasks/b/progress', input, { progressEvent: { id: 'progress-2', taskId: 'b', createdAt: stamp } })!.id, 'separate command scopes count independently')
  for (const requestId of ['x', 'version.2:feedback-1', 'x'.repeat(160)]) assert.ok(usageOperationForResponse('POST', '/feedback', { requestId }, { feedback: { id: '反馈.1', createdAt: stamp } }), 'all valid business request IDs retain their successful operation')
})

test('four calendar weeks with twenty working days is sufficient; gaps start a fresh observation window', () => {
  let now = new Date('2026-08-28T08:00:00.000Z')
  const analytics = new UsageAnalyticsStore(':memory:', { version: 'r2', clock: () => now }), team = Array.from({ length: 5 }, (_, i) => member(`member-${i}`))
  try {
    analytics.update({ version: 0, enabled: true, retentionDays: 90, excludedUserIds: [] }, team, 'epoch')
    for (let day = 0; day < 28; day++) {
      now = new Date(Date.parse('2026-08-28T08:00:00.000Z') + day * 86_400_000)
      if (![0, 6].includes(now.getUTCDay())) for (const person of team) analytics.page(person, 'epoch', { ...event, userId: person.id })
    }
    const summary = analytics.summary(team, 'epoch', {})
    assert.equal(summary.observedDays, 20); assert.equal(summary.observationDays, 28); assert.equal(summary.insufficientData, false)
    analytics.update({ version: 1, enabled: false, retentionDays: 90, excludedUserIds: [] }, team, 'epoch')
    now = new Date('2026-09-25T08:00:00.000Z')
    analytics.update({ version: 2, enabled: true, retentionDays: 90, excludedUserIds: [] }, team, 'epoch')
    assert.equal(analytics.summary(team, 'epoch', {}).observationDays, 1)
    assert.equal(analytics.summary(team, 'epoch', {}).insufficientData, true)
  } finally { analytics.close() }
})

test('old successful receipts cannot backfill an activation, same-day restart or new-release window', () => {
  const directory = mkdtempSync(join(tmpdir(), 'usage-window-')), path = join(directory, 'usage.sqlite')
  let now = new Date(stamp), analytics = new UsageAnalyticsStore(path, { version: 'r2', clock: () => now })
  try {
    settings(analytics)
    for (const [id, occurredAt] of [['a', '2026-09-10T08:00:00.000Z'], ['b', '2026-09-24T07:59:59.999Z']]) analytics.action(users[0], 'epoch', 'task_saved', id.repeat(64), occurredAt)
    assert.equal(count(analytics.summary(users, 'epoch', {}), 'task_saved'), 0)
    analytics.action(users[0], 'epoch', 'task_saved', 'c'.repeat(64), stamp)
    now = new Date('2026-09-24T09:00:00.000Z'); settings(analytics, false)
    now = new Date('2026-09-24T10:00:00.000Z'); settings(analytics)
    analytics.action(users[0], 'epoch', 'task_saved', 'd'.repeat(64), '2026-09-24T09:59:59.999Z')
    assert.equal(count(analytics.summary(users, 'epoch', {}), 'task_saved'), 1)
    analytics.close(); now = new Date('2026-09-24T11:00:00.000Z'); analytics = new UsageAnalyticsStore(path, { version: 'r3', clock: () => now })
    analytics.action(users[0], 'epoch', 'task_saved', 'e'.repeat(64), '2026-09-24T10:59:59.999Z')
    assert.equal(count(analytics.summary(users, 'epoch', {}), 'task_saved'), 0)
    analytics.action(users[0], 'epoch', 'task_saved', 'f'.repeat(64), '2026-09-24T11:00:00.000Z')
    assert.equal(count(analytics.summary(users, 'epoch', {}), 'task_saved'), 1)
  } finally { analytics.close(); rmSync(directory, { recursive: true, force: true }) }
})

test('unavailable sidecar is visibly disabled and cannot be accidentally enabled in memory', () => {
  const analytics = new UsageAnalyticsStore(':memory:', { version: 'r2', unavailable: true, clock: () => new Date(stamp) })
  try {
    assert.equal(analytics.view('epoch').storageUnavailable, true)
    assert.equal(analytics.configuredEnabled, false)
    assert.equal(analytics.policy(users[0], 'epoch').enabled, false)
    assert.throws(() => settings(analytics), error => !!error && typeof error === 'object' && 'status' in error && error.status === 503)
    analytics.page(users[0], 'epoch', event)
    assert.equal(analytics.summary(users, 'epoch', {}).activeMembers, 0)
  } finally { analytics.close() }
})

test('HTTP auth, manager-only configuration/aggregates, successful response counting, identity and epoch checks', async () => {
  const store = new Store(':memory:'), analytics = new UsageAnalyticsStore(':memory:', { version: 'r2', clock: () => new Date(stamp) })
  const cookie: Record<string, string> = {}
  for (const user of users) {
    const stored = store.insert<StoredUser>('users', { ...user, passwordHash: 'unused', credentialVersion: 1 })
    cookie[user.id] = `lab_session=${createSession(store, stored)}`
  }
  const app = express()
  app.use(createOriginGuard(), express.json())
  app.use('/api', requireAuth(store), usageAnalyticsRouter(store, analytics), usageAnalyticsSuccessMiddleware(store, analytics))
  app.patch('/api/tasks/:id', (req, res) => req.body.fail ? res.status(409).json({ error: 'failed' }) : res.json({ id: req.params.id, version: req.body.version, updatedAt: stamp, body: req.body.body }))
  app.get('/api/health', (_req, res) => res.json({ ok: true }))
  app.use(((error, _req, res, _next) => res.status(error.status || 500).json({ error: error.message })) as ErrorRequestHandler)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const request = async (user: string, path: string, method = 'GET', body?: unknown, expected = 200) => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { origin, cookie: cookie[user] || '', 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    assert.equal(response.status, expected, `${user} ${method} ${path}`)
    const text = await response.text(); return text ? JSON.parse(text) : null
  }
  try {
    for (const path of ['/usage-analytics/status', '/usage-analytics/settings', '/usage-analytics/summary']) await request('stranger', path, 'GET', undefined, 401)
    for (const user of ['alice', 'observer']) {
      await request(user, '/usage-analytics/settings', 'GET', undefined, 403)
      await request(user, '/usage-analytics/summary', 'GET', undefined, 403)
      await request(user, '/usage-analytics/settings', 'PUT', { enabled: true }, 403)
    }
    await request('alice', '/usage-analytics/page', 'POST', event, 204)
    assert.equal((await request('manager', '/usage-analytics/summary')).activeMembers, 0)
    const enabled = await request('manager', '/usage-analytics/settings', 'PUT', { version: 0, enabled: true, retentionDays: 90, excludedUserIds: ['test'] }) as UsageSettingsView
    assert.equal(enabled.effectiveEnabled, true)
    await request('bob', '/usage-analytics/page', 'POST', event, 400)
    await request('alice', '/usage-analytics/page', 'POST', { ...event, text: '不可采集的正文' }, 400)
    for (const user of ['alice', 'alice', 'manager', 'observer', 'test']) await request(user, '/usage-analytics/page', 'POST', { ...event, userId: user }, 204)
    for (const user of ['alice', 'alice', 'manager', 'observer', 'test']) await request(user, '/tasks/task-1', 'PATCH', { version: 2, body: '不可采集的正文' })
    await request('alice', '/tasks/task-1', 'PATCH', { version: 3, fail: true }, 409)
    const summary = await request('manager', '/usage-analytics/summary') as UsageSummary
    assert.equal(summary.activeMembers, 1); assert.equal(count(summary, 'work-register'), 1); assert.equal(count(summary, 'task_saved'), 1)
    assert.equal(JSON.stringify(summary).includes('不可采集'), false)
    assert.equal(store.list('usageEvents').length, 0, 'analytics is never a business entity collection')
    const epoch = getOperationEpoch(store); rotateOperationEpoch(store)
    assert.notEqual(getOperationEpoch(store), epoch)
    assert.equal((await request('alice', '/usage-analytics/status')).enabled, false)
    assert.equal((await request('manager', '/usage-analytics/settings')).activationRequired, true)
    assert.equal(usageDay(new Date(stamp)), '2026-09-24')
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close(); analytics.close() }
})
