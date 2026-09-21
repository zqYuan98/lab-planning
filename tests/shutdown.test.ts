import test from 'node:test'
import assert from 'node:assert/strict'
import { drainServices, SHUTDOWN_TIMEOUT_MS } from '../server/shutdown.ts'

test('shutdown stops claiming immediately and keeps database open until a delayed provider result is persisted', async () => {
  let claiming = true, stored = false, closed = false
  let finishSend!: () => void, closeHttp!: () => void
  const send = new Promise<void>(resolve => { finishSend = resolve })
  const http = new Promise<void>(resolve => { closeHttp = resolve })
  const draining = drainServices({ stopScheduling: () => { claiming = false }, stopWorkers: async () => { await send; assert.equal(closed, false); stored = true }, closeHttp: () => http, closeStore: () => { assert.equal(stored, true); closed = true } })
  assert.equal(claiming, false)
  closeHttp(); await new Promise(resolve => setImmediate(resolve)); assert.equal(closed, false)
  finishSend(); await draining; assert.equal(closed, true)
  assert.ok(SHUTDOWN_TIMEOUT_MS >= 35000)
})
