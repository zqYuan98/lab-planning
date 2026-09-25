import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { TestDomain as Domain } from './fixtures/legacy-domain.ts'
import { Store } from '../server/store.ts'
import { getOperationEpoch, rotateOperationEpoch } from '../server/operation-context.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import type { AuditEvent, Entity, MonthlyPlan, User } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store)
  const user = (id: string, role: User['role'] = 'member') => store.insert<StoredUser>('users', { id, name: id, email: `${id}@monthly.test`, role, active: true, position: '', credentialVersion: 1, passwordHash: 'unused-test-credentials' })
  const manager = user('manager', 'manager'), member = user('member'), peer = user('peer')
  const input = { month: '2026-09', title: '专项验证', category: '算法研究', ownerId: member.id, collaboratorIds: [peer.id], expectedOutcome: '形成验证报告', acceptanceCriteria: '完成联合评审', dueDate: '2026-09-30' }
  const publish = (plan: MonthlyPlan) => {
    plan = domain.submitPlan(manager, plan.id, { version: plan.version })
    plan = domain.reviewPlan(manager, plan.id, { version: plan.version, decision: 'approve' })
    domain.publishMonth(manager, plan.month, { planIds: [plan.id] })
    return store.get<MonthlyPlan>('plans', plan.id)!
  }
  const request = (source: MonthlyPlan, extra: Record<string, unknown> = {}) => ({ requestId: randomUUID(), sourceVersion: source.version, month: '2026-10', dueDate: '2026-10-23', reason: '剩余验证工作承接至下月', operationEpoch: getOperationEpoch(store), ...extra })
  const state = () => ['plans', 'events', 'notifications', 'notificationDeliveries', 'monthlyCarryRequests', 'publications'].map(name => store.list(name))
  t.after(() => store.close())
  return { store, domain, manager, member, peer, input, publish, request, state, user }
}

test('not_completed requires a trimmed reason and rejects blank reasons without changing versions, audit or notifications', t => {
  const f = fixture(t), plan = f.publish(f.domain.createPlan(f.manager, f.input)), before = f.state()
  for (const acceptanceNote of [undefined, null, '', ' \n\t ']) {
    assert.throws(() => f.domain.planResult(f.manager, plan.id, { version: plan.version, acceptanceStatus: 'not_completed', actualOutcome: '', acceptanceNote }), error => {
      assert.equal((error as { status: number }).status, 400)
      assert.ok((error as { fieldErrors: Record<string, string> }).fieldErrors.acceptanceNote)
      return true
    })
    assert.deepEqual(f.state(), before)
  }
  assert.throws(() => f.domain.planResult(f.member, plan.id, { version: plan.version, acceptanceStatus: 'not_completed', acceptanceNote: '需要更多样本' }), { status: 403 })
  const result = f.domain.planResult(f.manager, plan.id, { version: plan.version, acceptanceStatus: 'not_completed', acceptanceNote: '  需要更多样本  ' })
  assert.equal(result.acceptanceNote, '需要更多样本')
  assert.equal(result.actualOutcome, '')
  const event = f.store.list<AuditEvent>('events').at(-1)!
  assert.equal(event.action, 'result')
  assert.deepEqual(event.after, result)
})

test('historical empty reasons remain readable, but reconfirming not_completed requires a reason', t => {
  const f = fixture(t), initial = f.publish(f.domain.createPlan(f.manager, f.input))
  const historical = f.store.update<MonthlyPlan>('plans', initial.id, initial.version, { acceptanceStatus: 'not_completed', acceptanceNote: '' })
  assert.equal(f.domain.bootstrap(f.manager).plans[0].acceptanceNote, '')
  const before = f.state()
  assert.throws(() => f.domain.planResult(f.manager, historical.id, { version: historical.version, acceptanceStatus: 'not_completed', acceptanceNote: '' }), { status: 400 })
  assert.deepEqual(f.state(), before)
})

test('ordinary monthly creation validates and persists assignment metadata and rejects forged carry links', t => {
  const f = fixture(t)
  const plan = f.domain.createPlan(f.manager, { ...f.input, workSource: 'leader', assignedBy: '  课题负责人  ', assignedOn: '2026-09-02' })
  assert.equal(plan.workSource, 'leader')
  assert.equal(plan.assignedBy, '课题负责人')
  assert.equal(plan.assignedOn, '2026-09-02')
  for (const extra of [{ workSource: 'unknown' }, { assignedBy: 8 }, { assignedBy: 'x'.repeat(101) }, { assignedOn: '2026-02-30' }]) assert.throws(() => f.domain.createPlan(f.manager, { ...f.input, ...extra }), { status: 400 })
  const before = f.state()
  assert.throws(() => f.domain.createPlan(f.manager, { ...f.input, month: '2026-10', dueDate: '2026-10-23', sourcePlanId: plan.id }), { status: 400 })
  assert.throws(() => f.domain.updatePlan(f.manager, plan.id, { version: plan.version, sourcePlanId: plan.id }), { status: 400 })
  assert.deepEqual(f.state(), before)
})

test('carry inherits the explicit business fields, resets approval and results, and preserves all source history', t => {
  const f = fixture(t)
  let source = f.publish(f.domain.createPlan(f.manager, { ...f.input, isTemporary: true, temporaryReason: '临时专项', priority: 'high', workSource: 'leader', assignedBy: '主任', assignedOn: '2026-09-02' }))
  source = f.domain.planResult(f.manager, source.id, { version: source.version, acceptanceStatus: 'not_completed', actualOutcome: '已完成部分实验', acceptanceNote: '样本不足' })
  source = f.store.update<MonthlyPlan>('plans', source.id, source.version, { importSource: { batchId: 'batch', sourceId: 'source', rowId: 'row', sourceStatus: '部分完成' }, reviewComment: '旧审批', mergedFromIds: ['historical-source'] })
  const publications = f.store.list('publications'), sourceEvents = f.domain.planHistory(f.manager, source.id)
  const next = f.domain.carryPlan(f.manager, source.id, f.request(source))
  assert.equal(next.workSource, 'leader')
  assert.equal(next.assignedBy, '主任')
  assert.equal(next.assignedOn, '2026-09-02')
  for (const field of ['title', 'projectId', 'category', 'ownerId', 'collaboratorIds', 'expectedOutcome', 'acceptanceCriteria', 'priority', 'isTemporary', 'temporaryReason', 'workSource', 'assignedBy', 'assignedOn'] as const) assert.deepEqual(next[field], source[field], field)
  assert.equal(next.sourcePlanId, source.id)
  assert.equal(next.version, 1)
  assert.equal(next.month, '2026-10')
  assert.equal(next.dueDate, '2026-10-23')
  assert.equal(next.status, 'draft')
  assert.equal(next.publishedVersion, null)
  assert.equal(next.reviewComment, '')
  assert.equal(next.actualOutcome, '')
  assert.equal(next.acceptanceStatus, 'pending')
  assert.equal(next.acceptanceNote, '')
  assert.equal(next.importSource, undefined)
  assert.equal(next.mergedFromIds, undefined)
  assert.equal(next.mergedIntoId, undefined)
  assert.deepEqual(f.store.get('plans', source.id), source)
  assert.deepEqual(f.store.list('publications'), publications)
  assert.deepEqual(f.domain.planHistory(f.manager, source.id), sourceEvents)
})

test('carry replay uses normalized content and only one receipt and pair of audit events', t => {
  const f = fixture(t), source = f.domain.createPlan(f.manager, f.input), input = f.request(source)
  const first = f.domain.carryPlan(f.manager, source.id, input), before = f.state()
  assert.deepEqual(f.domain.carryPlan(f.manager, source.id, { ...input, reason: `  ${input.reason}  ` }), first)
  assert.deepEqual(f.state(), before)
  assert.equal(f.store.list('monthlyCarryRequests').length, 1)
  assert.deepEqual(f.store.list<AuditEvent>('events').filter(event => event.entityId === first.id).map(event => event.action), ['create', 'carry'])
  for (const extra of [{ reason: '不同的承接内容' }, { dueDate: '2026-10-25' }, { sourceVersion: source.version + 1 }]) assert.throws(() => f.domain.carryPlan(f.manager, source.id, { ...input, ...extra }), { status: 409, code: 'IDEMPOTENCY_MISMATCH' })
  const otherSource = f.domain.createPlan(f.manager, { ...f.input, title: '另一来源' })
  assert.throws(() => f.domain.carryPlan(f.manager, otherSource.id, input), { status: 409, code: 'IDEMPOTENCY_MISMATCH' })
})

test('successful replay precedes source version and eligibility checks; a first stale command is rejected', t => {
  const f = fixture(t), source = f.domain.createPlan(f.manager, f.input), input = f.request(source)
  const target = f.domain.carryPlan(f.manager, source.id, input)
  f.store.update<MonthlyPlan>('plans', source.id, source.version, { title: '来源已变更', acceptanceStatus: 'accepted' })
  const before = f.state()
  assert.deepEqual(f.domain.carryPlan(f.manager, source.id, input), target)
  assert.throws(() => f.domain.carryPlan(f.manager, source.id, { ...input, requestId: randomUUID() }), { status: 409, code: 'SOURCE_VERSION_CONFLICT' })
  assert.deepEqual(f.state(), before)
})

test('different business requests and actors may explicitly split one source into multiple same-month targets', t => {
  const f = fixture(t), source = f.domain.createPlan(f.manager, f.input), input = f.request(source)
  const first = f.domain.carryPlan(f.manager, source.id, input)
  const second = f.domain.carryPlan(f.manager, source.id, { ...input, requestId: randomUUID() })
  const third = f.domain.carryPlan(f.user('other-manager', 'manager'), source.id, input)
  assert.equal(new Set([first.id, second.id, third.id]).size, 3)
  assert.equal(f.store.list('monthlyCarryRequests').length, 3)
})

test('carry returns the current merged target on replay and rejects a missing target without recreating it', t => {
  const f = fixture(t), source = f.domain.createPlan(f.manager, f.input), input = f.request(source)
  const first = f.domain.carryPlan(f.manager, source.id, input)
  const merged = f.store.update<MonthlyPlan>('plans', first.id, first.version, { status: 'merged', mergedIntoId: 'combined-target' })
  assert.deepEqual(f.domain.carryPlan(f.manager, source.id, input), merged)
  f.store.delete('plans', merged.id, merged.version)
  const before = f.state()
  assert.throws(() => f.domain.carryPlan(f.manager, source.id, input), { status: 409, code: 'CARRY_TARGET_MISSING' })
  assert.deepEqual(f.state(), before)
})

test('carry command validates request shape and current manager permission before checking operation context', t => {
  const f = fixture(t), source = f.domain.createPlan(f.manager, f.input), input = f.request(source)
  for (const extra of [{ requestId: undefined }, { requestId: 'too-short' }, { requestId: 'x'.repeat(101) }, { requestId: 'invalid/request/id' }, { sourceVersion: undefined }, { sourceVersion: 0 }, { sourceVersion: 1.5 }, { sourceVersion: '1' }]) assert.throws(() => f.domain.carryPlan(f.manager, source.id, { ...input, ...extra }), { status: 400 })
  assert.throws(() => f.domain.carryPlan(f.member, source.id, { ...input, operationEpoch: undefined }), { status: 403 })
  f.store.update<User>('users', f.manager.id, f.manager.version, { active: false })
  assert.throws(() => f.domain.carryPlan(f.manager, source.id, input), { status: 403 })
})

test('missing or stale epochs reject both first writes and replays, even if a restore lost the receipt', t => {
  const f = fixture(t), source = f.domain.createPlan(f.manager, f.input), input = f.request(source), before = f.state()
  for (const operationEpoch of [undefined, '', 'client-chosen-epoch']) assert.throws(() => f.domain.carryPlan(f.manager, source.id, { ...input, operationEpoch }), { status: 409, code: 'OPERATION_CONTEXT_CHANGED' })
  assert.deepEqual(f.state(), before)
  f.domain.carryPlan(f.manager, source.id, input)
  rotateOperationEpoch(f.store)
  const after = f.state()
  assert.throws(() => f.domain.carryPlan(f.manager, source.id, input), { status: 409, code: 'OPERATION_CONTEXT_CHANGED' })
  assert.deepEqual(f.state(), after)
  for (const receipt of f.store.list<{ id: string; version: number }>('monthlyCarryRequests')) f.store.delete('monthlyCarryRequests', receipt.id, receipt.version)
  const restored = f.state()
  assert.throws(() => f.domain.carryPlan(f.manager, source.id, { ...input, requestId: randomUUID() }), { status: 409, code: 'OPERATION_CONTEXT_CHANGED' })
  assert.deepEqual(f.state(), restored)
})

test('a former manager cannot replay a successful command with a stale actor object', t => {
  const f = fixture(t), source = f.domain.createPlan(f.manager, f.input), input = f.request(source)
  f.domain.carryPlan(f.manager, source.id, input)
  f.store.update<User>('users', f.manager.id, f.manager.version, { role: 'member' })
  const before = f.state()
  assert.throws(() => f.domain.carryPlan(f.manager, source.id, { ...input, operationEpoch: undefined }), { status: 403 })
  assert.deepEqual(f.state(), before)
})

test('carry validates source eligibility, month bounds, archived projects and every active participant', t => {
  const f = fixture(t), source = f.domain.createPlan(f.manager, f.input)
  for (const extra of [{ month: '2026-09', dueDate: '2026-09-23' }, { dueDate: '2026-11-01' }, { reason: ' ' }]) assert.throws(() => f.domain.carryPlan(f.manager, source.id, f.request(source, extra)), { status: 400 })
  for (const patch of [{ status: 'merged' as const }, { acceptanceStatus: 'accepted' as const }]) {
    const disallowed = f.domain.createPlan(f.manager, f.input)
    const changed = f.store.update<MonthlyPlan>('plans', disallowed.id, disallowed.version, patch)
    assert.throws(() => f.domain.carryPlan(f.manager, changed.id, f.request(changed)), { status: 400 })
  }
  const project = f.domain.createProject(f.manager, { name: '归档项目', code: 'ARC', ownerId: f.manager.id })
  const archived = f.domain.createPlan(f.manager, { ...f.input, projectId: project.id })
  f.domain.updateProject(f.manager, project.id, { version: project.version, status: 'archived' })
  assert.throws(() => f.domain.carryPlan(f.manager, archived.id, f.request(archived)), { status: 400 })
  for (const user of [f.peer, f.member]) {
    f.store.update<User>('users', user.id, user.version, { active: false })
    assert.throws(() => f.domain.carryPlan(f.manager, source.id, f.request(source)), { status: 400 })
    const disabled = f.store.get<User>('users', user.id)!
    f.store.update<User>('users', user.id, disabled.version, { active: true })
  }
})

test('carry rolls back target, both audit events, notifications and receipt when any final write fails', t => {
  const f = fixture(t), source = f.domain.createPlan(f.manager, f.input), original = f.store.insert.bind(f.store)
  for (const failAt of ['create', 'carry', 'receipt']) {
    const before = f.state(), input = f.request(source)
    f.store.insert = <T extends Entity>(collection: string, value: Omit<T, keyof Entity> & Partial<Entity>): T => {
      if (failAt === 'receipt' && collection === 'monthlyCarryRequests' || collection === 'events' && (value as { action?: string }).action === failAt) throw new Error(`injected ${failAt} failure`)
      return original<T>(collection, value)
    }
    try { assert.throws(() => f.domain.carryPlan(f.manager, source.id, input), new RegExp(`injected ${failAt} failure`)) }
    finally { f.store.insert = original }
    assert.deepEqual(f.state(), before)
    const retried = f.domain.carryPlan(f.manager, source.id, input)
    assert.ok(retried.id)
  }
})

test('HTTP exposes field errors and carry conflicts while requiring the operation epoch header', async t => {
  const f = fixture(t), source = f.publish(f.domain.createPlan(f.manager, f.input))
  const server = createApp({ store: f.store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, cookie = `lab_session=${createSession(f.store, f.manager)}`
  const request = (path: string, body: unknown, epoch?: string) => fetch(`${origin}/api${path}`, { method: 'POST', headers: { origin, cookie, 'content-type': 'application/json', ...(epoch ? { 'X-Operation-Epoch': epoch } : {}) }, body: JSON.stringify(body) })
  try {
    const before = f.state()
    const invalid = await request(`/plans/${source.id}/result`, { version: source.version, acceptanceStatus: 'not_completed', acceptanceNote: '  ' })
    assert.equal(invalid.status, 400)
    assert.ok((await invalid.json()).fieldErrors.acceptanceNote)
    assert.deepEqual(f.state(), before)
    const input = f.request(source)
    const missingHeader = await request(`/plans/${source.id}/carry`, input)
    assert.equal(missingHeader.status, 409)
    assert.equal((await missingHeader.json()).code, 'OPERATION_CONTEXT_CHANGED')
    const first = await request(`/plans/${source.id}/carry`, input, input.operationEpoch)
    assert.equal(first.status, 200)
    const target = await first.json()
    const replay = await request(`/plans/${source.id}/carry`, input, input.operationEpoch)
    assert.equal(replay.status, 200)
    assert.equal((await replay.json()).id, target.id)
    const mismatch = await request(`/plans/${source.id}/carry`, { ...input, reason: '不同承接原因' }, input.operationEpoch)
    assert.equal(mismatch.status, 409)
    assert.equal((await mismatch.json()).code, 'IDEMPOTENCY_MISMATCH')
    assert.equal(f.store.list('monthlyCarryRequests').length, 1)
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
})
