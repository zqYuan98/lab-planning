import test from 'node:test'
import assert from 'node:assert/strict'
import { carryAttemptKey, createCarryAttempt, parseCarryAttempt, persistCarryAttempt } from '../src/monthly-carry.ts'

const now = Date.now()
const payload = { sourceVersion: 3, month: '2026-10', dueDate: '2026-10-30', reason: '继续联调' }

test('carry attempts preserve the exact command across recovery and isolate actor/source', () => {
  const command = createCarryAttempt('manager', 'source', 'epoch', payload, () => 'stable-request-123456', now)
  assert.deepEqual(parseCarryAttempt(JSON.stringify(command), 'manager', 'source', now), command)
  assert.equal(parseCarryAttempt(JSON.stringify(command), 'other', 'source', now), null)
  assert.equal(parseCarryAttempt(JSON.stringify(command), 'manager', 'different', now), null)
  assert.notEqual(carryAttemptKey('a:b', 'c'), carryAttemptKey('a', 'b:c'))
  payload.reason = '后续修改不应改变已经发送的内容'
  assert.equal(command.payload.reason, '继续联调')
})

test('carry attempt rejects malformed data and does not expire an unresolved command', () => {
  const command = createCarryAttempt('manager', 'source', 'epoch', { ...payload, reason: '继续' }, () => 'stable-request-123456', now)
  // Even after the ordinary form draft expires, replay must keep the original key.
  assert.deepEqual(parseCarryAttempt(JSON.stringify(command), 'manager', 'source', now + 30 * 86400000), command)
  for (const change of [{ requestId: '' }, { operationEpoch: '' }, { payload: { ...payload, sourceVersion: 0 } }, { schema: 99 }]) {
    assert.equal(parseCarryAttempt(JSON.stringify({ ...command, ...change }), 'manager', 'source', now), null)
  }
})

test('persisting an attempt is required before an uncertain network operation can start', () => {
  const command = createCarryAttempt('manager', 'source', 'epoch', payload, () => 'stable-request-123456', now)
  const values = new Map<string, string>()
  persistCarryAttempt({ setItem: (key, value) => { values.set(key, value) } }, command)
  assert.deepEqual(parseCarryAttempt(values.get(carryAttemptKey('manager', 'source'))!, 'manager', 'source', now), command)
  assert.throws(() => persistCarryAttempt({ setItem: () => { throw new Error('quota') } }, command), /无法保存本次承接/)
})
