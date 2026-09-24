import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { Entity, User } from '../shared/types.ts'
import type { PeriodReviewSnapshot, TaskCommitmentEvent } from '../shared/period-reviews.ts'
import { Store } from '../server/store.ts'
import { WorkService } from '../server/domain-work.ts'
import { PeriodReviewService, periodReviewContentHash } from '../server/period-reviews.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { parsePacket } from '../server/data-transfer-schema.ts'
import { getOperationEpoch } from '../server/operation-context.ts'
import { userDeletionPreview } from '../server/user-deletion.ts'
import { coverage, reviewHash } from '../server/period-review-facts.ts'

function accounts(t: TestContext, prefix: string) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id: prefix + id, name: id, email: `${id}@review-transfer.test`, role, active: true, position: '' })
  return { store, manager: user('manager', 'manager'), member: user('member', 'member') }
}
function fixture(t: TestContext) {
  const f = accounts(t, 'source-'), work = new WorkService(f.store), service = new PeriodReviewService(f.store)
  const today = new Date().toISOString().slice(0, 10), period = today.slice(0, 7)
  const task = work.createTask(f.member, { title: '保留历史责任的工作', dueDate: today, isTemporary: true, temporaryReason: '恢复验证' })
  service.addEvidence(f.manager, { operationEpoch: getOperationEpoch(f.store), requestId: 'evidence-0001', taskId: task.id, ownerId: f.member.id, claimedAt: new Date().toISOString(), statement: '历史材料另有归档', evidence: ['资料归档编号 TEST-01'], reason: '补充复核依据' })
  const cutoffAt = new Date().toISOString(), preview = service.preview(f.manager, { period, cutoffAt })
  let review = service.create(f.manager, { ...preview, requestId: 'snapshot-0001' })
  review = service.finalize(f.manager, review.id, { operationEpoch: getOperationEpoch(f.store), requestId: 'finalize-0001', version: review.version, contentHash: review.contentHash })
  const next = service.preview(f.manager, { period, cutoffAt, previousSnapshotId: review.id })
  const revision = service.create(f.manager, { ...next, requestId: 'snapshot-0002' })
  f.store.insert<Entity & { actorId: string; privateRuntime: string }>('carryWorkflows', { actorId: f.manager.id, privateRuntime: 'excluded-workflow' })
  return { ...f, task, review, revision }
}

test('v6 roundtrip preserves historical facts and revision chains, maps identities and excludes runtime workflows', t => {
  const source = fixture(t), target = accounts(t, 'target-'), packet = exportBusinessData(source.store, source.manager)
  assert.equal(packet.formatVersion, 6)
  assert.equal(packet.collections.taskCommitmentEvents.length, 1)
  assert.equal(packet.collections.historicalEvidence.length, 1)
  assert.equal(packet.collections.periodReviewSnapshots.length, 2)
  assert.doesNotMatch(JSON.stringify(packet), /excluded-workflow|carryWorkflows|periodReviewReceipts/)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  const epoch = getOperationEpoch(target.store)
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  assert.notEqual(getOperationEpoch(target.store), epoch)
  const restored = target.store.get<PeriodReviewSnapshot>('periodReviewSnapshots', source.review.id)!
  assert.equal(restored.authorId, target.manager.id)
  assert.equal(restored.finalizedBy, target.manager.id)
  assert.equal(restored.entries[0].ownerId, target.member.id)
  assert.equal(restored.entries[0].commitments[0].newValue.ownerId, target.member.id)
  assert.equal(restored.contentHash, periodReviewContentHash(restored))
  assert.equal(restored.cutoffAt, source.review.cutoffAt)
  assert.deepEqual(restored.sourceManifest.map(({ hash: _hash, ...ref }) => ref), source.review.sourceManifest.map(({ hash: _hash, ...ref }) => ref))
  const third = accounts(t, 'third-'), reexported = exportBusinessData(target.store, target.manager)
  const nextRestore = previewRestore(third.store, third.manager, reexported)
  assert.equal(nextRestore.canRestore, true, nextRestore.issues.join('\n'))
  assert.equal(target.store.get<TaskCommitmentEvent>('taskCommitmentEvents', packet.collections.taskCommitmentEvents[0].id)!.actorId, target.member.id)
  const repeat = previewRestore(target.store, target.manager, packet)
  assert.equal(repeat.canRestore, true, repeat.issues.join('\n'))
  assert.equal(restoreBusinessData(target.store, target.manager, packet, {}, repeat.fingerprint).restored, 0)
  assert.equal(target.store.list('notifications').length, 0)
})

test('v6 rejects damaged content, broken chain, missing source and forged temporal scope atomically', t => {
  const source = fixture(t), target = accounts(t, 'target-'), packet = exportBusinessData(source.store, source.manager)
  const invalid: Array<(copy: typeof packet) => void> = [
    copy => { copy.collections.periodReviewSnapshots[0].entries[0].title = '篡改冻结事实' },
    copy => { const row = copy.collections.periodReviewSnapshots.find(r => r.revision === 2)!; row.previousSnapshotId = row.id; row.contentHash = periodReviewContentHash(row) },
    copy => { copy.collections.taskCommitmentEvents[0].sourceId = 'missing-source' },
    copy => { const row = copy.collections.periodReviewSnapshots[0]; row.sourceManifest[0].version += 100; row.contentHash = periodReviewContentHash(row) },
    copy => { const row = copy.collections.periodReviewSnapshots[0]; row.evidenceCoverage.total += 1; row.contentHash = periodReviewContentHash(row) },
    copy => { const row = copy.collections.periodReviewSnapshots[0]; row.finalizedBy = null },
    copy => { const row = copy.collections.periodReviewSnapshots[0]; row.sourceManifest[0].hash = '0'.repeat(64); row.contentHash = periodReviewContentHash(row) },
    copy => { const row = copy.collections.periodReviewSnapshots[0]; row.entries[0].ownerId = source.manager.id; row.contentHash = periodReviewContentHash(row) },
    copy => { const row = copy.collections.periodReviewSnapshots[0]; row.period = '2001-01'; row.contentHash = periodReviewContentHash(row) },
    copy => { const row = copy.collections.periodReviewSnapshots[0]; row.entries[0].commitments[0].recordedAt = '2099-01-01T00:00:00.000Z'; row.contentHash = periodReviewContentHash(row) },
  ]
  for (const change of invalid) {
    const copy = structuredClone(packet); change(copy)
    const preview = previewRestore(target.store, target.manager, copy)
    assert.equal(preview.canRestore, false, 'invalid history must be rejected')
    assert.throws(() => restoreBusinessData(target.store, target.manager, copy, {}, preview.fingerprint), { status: 409 })
    assert.equal(target.store.list('tasks').length, 0)
    assert.equal(target.store.list('periodReviewSnapshots').length, 0)
  }
})

test('older formats reject new history facts, manager migration remains distinct from member projection', t => {
  const f = fixture(t), packet = exportBusinessData(f.store, f.manager)
  for (const version of [1, 2, 3, 4, 5] as const) assert.throws(() => parsePacket({ ...packet, formatVersion: version }), { status: 400 })
  const old = structuredClone(packet)
  old.formatVersion = 5; old.collections.taskCommitmentEvents = []; old.collections.historicalEvidence = []; old.collections.periodReviewSnapshots = []
  assert.equal(parsePacket(old).formatVersion, 5)
  const member = exportBusinessData(f.store, f.member)
  assert.equal(member.collections.periodReviewSnapshots.length, 0)
  assert.equal(member.collections.taskCommitmentEvents.length, 0)
  assert.equal(member.collections.historicalEvidence.length, 0)
  const blockers = userDeletionPreview(f.store, f.manager, f.member).blockers
  assert.ok(blockers.some(row => row.key === 'taskCommitmentEvents'))
  assert.ok(blockers.some(row => row.key === 'periodReviewSnapshots'))
})

test('matching forged commitment and embedded ownership cannot override the independent source audit', t => {
  const source = fixture(t), target = accounts(t, 'target-'), packet = exportBusinessData(source.store, source.manager)
  packet.collections.periodReviewSnapshots = packet.collections.periodReviewSnapshots.filter(row => row.revision === 1)
  const formal = packet.collections.taskCommitmentEvents[0], review = packet.collections.periodReviewSnapshots[0]
  formal.newValue.ownerId = source.manager.id
  review.entries[0].ownerId = source.manager.id
  review.entries[0].commitments[0].newValue.ownerId = source.manager.id
  for (const ref of [...review.sourceManifest, ...review.entries.flatMap(row => row.sourceRefs)]) if (ref.collection === 'taskCommitmentEvents' && ref.id === formal.id) ref.hash = reviewHash(formal)
  review.contentHash = periodReviewContentHash(review)
  const result = previewRestore(target.store, target.manager, packet)
  assert.equal(result.canRestore, false); assert.ok(result.issues.some(issue => issue.includes('原始任务审计')))
  assert.equal(target.store.list('periodReviewSnapshots').length, 0)
})

test('rehashing cannot create acceptance without a receipt or duplicate a frozen metric denominator', t => {
  const source = fixture(t), target = accounts(t, 'target-'), original = exportBusinessData(source.store, source.manager)
  for (const duplicate of [false, true]) {
    const packet = structuredClone(original); packet.collections.periodReviewSnapshots = packet.collections.periodReviewSnapshots.filter(row => row.revision === 1)
    const review = packet.collections.periodReviewSnapshots[0]
    if (duplicate) review.entries.push(structuredClone(review.entries[0]))
    else { review.entries[0].statusAtCutoff = 'accepted'; review.entries[0].onTimeAccepted = true; review.entries[0].acceptedAt = review.cutoffAt }
    review.evidenceCoverage = coverage(review.entries); review.contentHash = periodReviewContentHash(review)
    const result = previewRestore(target.store, target.manager, packet)
    assert.equal(result.canRestore, false); assert.ok(result.issues.some(issue => issue.includes(duplicate ? '重复' : '派生事实')))
  }
})
