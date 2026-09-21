import test from 'node:test'
import assert from 'node:assert/strict'
import express, { type ErrorRequestHandler } from 'express'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Notification, NotificationDelivery } from '../shared/notifications.ts'
import { Store, HttpError } from '../server/store.ts'
import { notificationDiagnostics, notificationDiagnosticsRouter } from '../server/notification-diagnostics.ts'
import { createSession, requireAuth, type StoredUser } from '../server/auth.ts'
import { beginRuntimeRun } from '../server/runtime-health.ts'
import type { DingTalkClient } from '../server/dingtalk.ts'
const client: DingTalkClient = { configured: false, corpId: '', clientId: '', async getIdentity() { throw new Error('no network') }, async send() { throw new Error('no network') }, async result() { throw new Error('no network') } }
function fixture() {
  const store = new Store(':memory:')
  for (let i = 0; i < 251; i++) {
    const id = `delivery-${String(i).padStart(4, '0')}`, status = i < 210 ? 'failed' : 'delivered'
    store.restoreEntity<Notification>('notifications', { id: `n-${i}`, version: 1, createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z', eventKey: id, recipientId: 'member', kind: 'work_assigned', title: 'private business title', body: 'private business body', targets: [], actionable: false, openedAt: null, acknowledgedAt: null, supersededAt: null })
    store.restoreEntity<NotificationDelivery>('notificationDeliveries', { id, version: 1, createdAt: '2026-09-19T00:00:00.000Z', updatedAt: '2026-09-19T00:00:00.000Z', notificationId: `n-${i}`, recipientId: 'member', status, attempts: 1, nextAttemptAt: '2026-09-19T00:00:00.000Z', acceptedAt: null, leaseUntil: null, providerTaskId: null, lastError: 'SECRET_TOKEN provider response', deploymentId: 'secret-deployment', activationId: 'secret-activation', identityId: 'secret-identity' })
  }
  return store
}
test('indexed diagnostics counts all 251 rows and stable time+id cursors reach old failures without duplication', () => {
  const store = fixture()
  try {
    let cursor: { createdAt: string; id: string } | undefined, ids: string[] = []
    do {
      const page = notificationDiagnostics(store, client, { status: 'failed', kind: 'work_assigned', limit: 37, cursor })
      assert.equal(page.total, 210); assert.deepEqual(page.counts, { failed: 210 })
      assert.equal(JSON.stringify(page).includes('SECRET_TOKEN'), false)
      assert.equal(JSON.stringify(page).includes('private business'), false)
      assert.equal(JSON.stringify(page).includes('secret-identity'), false)
      ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor ?? undefined
    } while (cursor)
    assert.equal(ids.length, 210); assert.equal(new Set(ids).size, 210); assert.ok(ids.includes('delivery-0000'))
    assert.deepEqual(store.deliveryCounts({ recipientId: "' OR 1=1--" }), {})
    assert.throws(() => store.queryDeliveries({ limit: 1000000 }), { status: 400 })
    assert.throws(() => store.queryDeliveries({ status: "pending' OR 1=1" as never }), { status: 400 })
    assert.equal(store.queryDeliveries({ status: 'failed', dueAt: '2026-09-20T00:00:00.000Z', limit: 20 }).length, 20)
    const finish = beginRuntimeRun(store, 'worker', new Date('2026-09-20T00:00:00.000Z')); finish(false, new Date('2026-09-20T00:00:01.000Z'))
    assert.ok(notificationDiagnostics(store, client, {}, new Date('2026-09-20T00:03:00.000Z')).health.alerts.includes('通知工作进程最近一轮异常'))
  } finally { store.close() }
})
test('diagnostic endpoint denies members and validates filters before querying', async () => {
  const store = new Store(':memory:'), app = express()
  const member = store.insert<StoredUser>('users', { name: 'member', email: 'member@test.local', role: 'member', position: '', active: true, credentialVersion: 1, passwordHash: 'unused' })
  const manager = store.insert<StoredUser>('users', { ...member, id: 'manager', name: 'manager', email: 'manager@test.local', role: 'manager' })
  app.use(requireAuth(store), notificationDiagnosticsRouter(store, client))
  const errors: ErrorRequestHandler = (error, _req, res, _next) => res.status(error instanceof HttpError ? error.status : 500).json({ error: error.message }); app.use(errors)
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/notification-diagnostics`
    assert.equal((await fetch(url, { headers: { cookie: `lab_session=${createSession(store, member)}` } })).status, 403)
    const cookie = `lab_session=${createSession(store, manager)}`
    for (const query of ['?cursorId=alone', '?from=invalid', '?limit=9999', '?state[]=pending', '?status=unknown&status=failed']) assert.equal((await fetch(`${url}${query}`, { headers: { cookie } })).status, 400)
    assert.equal((await fetch(url, { headers: { cookie } })).status, 200)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close() }
})
