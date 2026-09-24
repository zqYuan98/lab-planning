import test from 'node:test'
import assert from 'node:assert/strict'
import type { AuditEvent, Entity, Task, User } from '../shared/types.ts'
import type { CommitmentValue, HistoricalEvidence, PeriodReviewSnapshot, TaskCommitmentEvent } from '../shared/period-reviews.ts'
import type { DeliveryDecision, TaskDelivery } from '../shared/deliveries.ts'
import type { WeeklyCycle, WeeklyDuty, WeeklyMissing, WeeklySubmission } from '../shared/weekly-submissions.ts'
import { Store } from '../server/store.ts'
import { WorkService } from '../server/domain-work.ts'
import { PeriodReviewService, periodReviewContentHash } from '../server/period-reviews.ts'
import { buildPeriodReview } from '../server/period-review-facts.ts'
import { getOperationEpoch, rotateOperationEpoch } from '../server/operation-context.ts'

const at = (day: number, hour = 1) => `2026-09-${String(day).padStart(2, '0')}T${String(hour).padStart(2, '0')}:00:00.000Z`
function fixture() {
  const store = new Store(':memory:'), now = at(30, 15), service = new PeriodReviewService(store, () => new Date(now))
  function seed<T extends Entity>(collection: string, row: Omit<T, keyof Entity> & { id: string }, time = at(1), version = 1): T {
    return store.transaction(() => store.restoreEntity<T>(collection, { ...row, version, createdAt: time, updatedAt: time } as T))
  }
  const user = (id: string, role: User['role']) => seed<User>('users', { id, role, name: id, email: `${id}@test.invalid`, position: '', active: true })
  const manager = user('manager', 'manager'), member = user('member', 'member'), other = user('other', 'member'), observer = user('observer', 'observer')
  const task = seed<Task>('tasks', { id: 'task-one', title: '交付报告', ownerId: member.id, monthlyPlanId: null, description: '三个样本', dueDate: '2026-09-10', status: 'todo', isTemporary: true, temporaryReason: '专项' })
  const value = (overrides: Partial<CommitmentValue> = {}): CommitmentValue => ({ title: task.title, ownerId: member.id, monthlyPlanId: null, projectId: null, dueDate: task.dueDate, scope: task.description, cancelled: false, ...overrides })
  function commitment(id: string, time: string, kind: TaskCommitmentEvent['kind'], oldValue: CommitmentValue | null, newValue: CommitmentValue, recordedAt = time) {
    const audit = seed<AuditEvent>('events', { id: `audit-${id}`, entityType: 'task', entityId: task.id, actorId: manager.id, action: kind === 'initial' ? 'create' : 'update', reason: '批准并说明依据', before: oldValue ? { ...task, ...oldValue } : null, after: { ...task, ...newValue } }, recordedAt)
    return seed<TaskCommitmentEvent>('taskCommitmentEvents', { id, taskId: task.id, kind, oldValue, newValue, actorId: manager.id, reason: '批准并说明依据', effectiveAt: time, recordedAt, sourceType: 'audit', sourceId: audit.id, sourceVersion: 1 }, recordedAt)
  }
  const initial = commitment('initial', at(1), 'initial', null, value())
  function delivery(time = at(14)) { return seed<TaskDelivery>('taskDeliveries', { id: 'delivery-one', seriesId: 'series-one', taskId: task.id, revision: 1, supersedesId: null, taskVersion: 1, ownerId: member.id, submittedBy: member.id, proxyReason: '', submittedAt: time, actualOutcome: '报告完成', evidenceRefs: ['正式证据'], acceptanceCriteriaSnapshot: '三个样本齐全', reviewerIdSnapshot: manager.id, dueDateSnapshot: '2026-09-15', deadlineBasisRefs: [] }, time) }
  function accept(time = at(18), recordedAt = time) { return seed<DeliveryDecision>('deliveryDecisions', { id: 'decision-one', seriesId: 'series-one', deliveryId: 'delivery-one', conclusion: 'accepted', action: 'review', note: '通过', decidedBy: manager.id, decidedAt: time, supersedesDecisionId: null }, recordedAt) }
  const preview = (cutoffAt = at(16)) => service.preview(manager, { period: '2026-09', cutoffAt })
  const create = (cutoffAt = at(16), requestId = 'freeze-review-001') => { const p = preview(cutoffAt); return service.create(manager, { period: p.period, cutoffAt: p.cutoffAt, fingerprint: p.fingerprint, sourceManifest: p.sourceManifest, operationEpoch: p.operationEpoch, requestId }) }
  return { store, seed, service, manager, member, other, observer, task, value, commitment, initial, delivery, accept, preview, create }
}

test('late deadline approval preserves prior overdue interval; later acceptance leaves cutoff pending', t => {
  const f = fixture(); t.after(() => f.store.close())
  f.commitment('extension', at(12), 'deadline', f.value(), f.value({ dueDate: '2026-09-15' })); f.delivery(); f.accept()
  const row = f.preview().entries[0]
  assert.equal(row.originalDueDate, '2026-09-10'); assert.equal(row.effectiveDueDate, '2026-09-15')
  assert.deepEqual(row.overdueIntervals, [{ from: '2026-09-10T16:00:00.000Z', through: at(12), dueDate: '2026-09-10', endedBy: 'deadline_change' }])
  assert.equal(row.statusAtCutoff, 'pending_review'); assert.equal(row.submissions[0].timely, true); assert.equal(row.acceptedAt, null)
  const after = f.preview(at(20)).entries[0]
  assert.equal(after.acceptedSubmittedAt, at(14)); assert.equal(after.acceptedAt, at(18)); assert.equal(after.submissions[0].acceptanceWaitMs, 4 * 86400000)
})

test('freeze, finalize and later revision retain original bytes and show explicit post-period knowledge', t => {
  const f = fixture(); t.after(() => f.store.close()); f.delivery()
  const draft = f.create(), epoch = getOperationEpoch(f.store)
  const input = { operationEpoch: epoch, requestId: 'finalize-review-001', version: draft.version, contentHash: draft.contentHash }
  const final = f.service.finalize(f.manager, draft.id, input), frozen = JSON.stringify(final)
  assert.deepEqual(f.service.finalize(f.manager, draft.id, input), final)
  f.accept()
  f.store.update<Task>('tasks', f.task.id, 1, { title: '今天改名', dueDate: '2026-10-30', ownerId: f.other.id })
  const p = f.service.preview(f.manager, { period: final.period, cutoffAt: final.cutoffAt, previousSnapshotId: final.id, laterEvidenceThrough: at(20) })
  const revision = f.service.create(f.manager, { period: p.period, cutoffAt: p.cutoffAt, previousSnapshotId: final.id, laterEvidenceThrough: at(20), fingerprint: p.fingerprint, sourceManifest: p.sourceManifest, operationEpoch: epoch, requestId: 'revision-review-001' })
  assert.equal(revision.revision, 2); assert.equal(revision.entries[0].statusAtCutoff, 'pending_review'); assert.equal(revision.entries[0].laterStatus, 'accepted'); assert.equal(revision.entries[0].laterSubmissions[0].submittedAt, at(14)); assert.ok(revision.differences.length)
  assert.equal(JSON.stringify(f.store.get('periodReviewSnapshots', final.id)), frozen)
  assert.equal(periodReviewContentHash(final), final.contentHash)
  assert.match(f.service.export(f.manager, final.id), /历史周期复盘/)
})

test('missing original audit and broken commitment links remain unknown; current dueDate cannot fill gaps', t => {
  const f = fixture(); t.after(() => f.store.close())
  f.store.delete('events', f.initial.sourceId, 1)
  const row = f.preview().entries[0]
  assert.equal(row.ownerId, null); assert.equal(row.originalDueDate, null); assert.equal(row.statusAtCutoff, 'unknown'); assert.ok(row.unknowns.some(item => item.includes('断链')))
  assert.equal(f.preview().evidenceCoverage.rate, null)
})

test('period ownership controls member projection, including after reassignment and online revocation', t => {
  const f = fixture(); t.after(() => f.store.close())
  f.commitment('reassignment', at(20), 'owner', f.value(), f.value({ ownerId: f.other.id }))
  const draft = f.create(), final = f.service.finalize(f.manager, draft.id, { operationEpoch: getOperationEpoch(f.store), requestId: 'finalize-owner-review', version: draft.version, contentHash: draft.contentHash })
  f.store.update<Task>('tasks', f.task.id, 1, { ownerId: f.other.id })
  assert.equal(f.service.read(f.member, final.id).entries[0].ownerId, f.member.id)
  assert.equal(f.service.list(f.other).length, 0); assert.throws(() => f.service.read(f.other, final.id), { status: 404 })
  assert.throws(() => f.service.read(f.observer, final.id), { status: 403 })
  const own = f.service.read(f.member, final.id)
  assert.equal(own.differences.length, 0); assert.equal(own.sourceManifest.some(row => row.id === 'reassignment'), false)
  f.store.update<User>('users', f.member.id, 1, { active: false }); assert.throws(() => f.service.read(f.member, final.id), { status: 403 })
})

test('preview is bound to complete source content and rejects changes, additions, epoch changes and stale finalization', t => {
  const f = fixture(); t.after(() => f.store.close()); const p = f.preview()
  const input = { period: p.period, cutoffAt: p.cutoffAt, fingerprint: p.fingerprint, sourceManifest: p.sourceManifest, operationEpoch: p.operationEpoch, requestId: 'freeze-conflict-review' }
  f.delivery(); assert.throws(() => f.service.create(f.manager, input), { status: 409, code: 'SOURCE_CONFLICT' })
  const draft = f.create(); assert.throws(() => f.service.finalize(f.manager, draft.id, { operationEpoch: p.operationEpoch, requestId: 'finalize-bad-hash', version: draft.version, contentHash: 'tampered' }), { status: 409, code: 'CONTENT_CONFLICT' })
  rotateOperationEpoch(f.store); assert.throws(() => f.service.create(f.manager, input), { status: 409, code: 'OPERATION_CONTEXT_CHANGED' })
})

test('manual evidence keeps claimed and recorded times and never becomes a formal submission', t => {
  const f = fixture(); t.after(() => f.store.close())
  const evidence = f.service.addEvidence(f.manager, { operationEpoch: getOperationEpoch(f.store), requestId: 'manual-evidence-001', taskId: f.task.id, claimedAt: at(9), statement: '人工声称已邮件发出', evidence: ['归档邮件编号'], reason: '历史系统漏记' })
  assert.equal(evidence.claimedAt, at(9)); assert.equal(evidence.recordedAt, at(30, 15))
  assert.equal(f.preview().entries[0].evidence.length, 0)
  const content = buildPeriodReview(f.store, { period: '2026-09', cutoffAt: at(16), generatedAt: at(30, 15), laterEvidenceThrough: at(30, 15) })
  assert.equal(content.entries[0].evidence.length, 1); assert.equal(content.entries[0].statusAtCutoff, 'unsubmitted'); assert.equal(content.entries[0].firstSubmittedAt, null)
  assert.equal(f.store.list<HistoricalEvidence>('historicalEvidence').length, 1)
})

test('weekly compliance uses frozen roster, duty, missing and whole receipts; late receipt does not rewrite cutoff', t => {
  const f = fixture(); t.after(() => f.store.close())
  f.seed<WeeklyCycle>('weeklyCycles', { id: 'cycle', week: '2026-09-07', deadlineAt: at(11), rosterIds: [f.member.id], needsReview: false, confirmedBy: f.manager.id, confirmationReason: '确认', frozenAt: at(7) }, at(7))
  f.seed<WeeklyDuty>('weeklyDuties', { id: 'duty', ownerId: f.member.id, cycleWeek: '2026-09-07', kind: 'results', contentWeek: '2026-09-07', deadlineAt: at(11) }, at(7))
  f.seed<WeeklyMissing>('weeklyMissing', { id: 'missing', dutyId: 'duty', ownerId: f.member.id, cycleWeek: '2026-09-07', kind: 'results', deadlineAt: at(11), detectedAt: at(11, 2) }, at(11, 2))
  f.seed<WeeklySubmission>('weeklySubmissions', { id: 'whole-receipt', dutyId: 'duty', ownerId: f.member.id, cycleWeek: '2026-09-07', kind: 'results', submittedAt: at(18), actorId: f.member.id, reason: '', note: '', requestId: 'receipt', records: [], retainedDraftIds: [], retainedDraftManifest: [] }, at(18))
  f.store.update<Task>('tasks', f.task.id, 1, { status: 'done' })
  assert.equal(f.preview().weeklyCompliance[0].statusAtCutoff, 'missing')
  const content = buildPeriodReview(f.store, { period: '2026-09', cutoffAt: at(16), generatedAt: at(30), laterEvidenceThrough: at(20) })
  assert.equal(content.weeklyCompliance[0].statusAtCutoff, 'missing'); assert.equal(content.weeklyCompliance[0].laterSubmittedAt, at(18))
  assert.equal(content.weeklyCompliance[0].firstSubmittedAt, null); assert.equal(content.weeklyCompliance[0].missingAtDeadline, true)
})

test('backdated acceptance recorded after cutoff is excluded from period-known facts', t => {
  const f = fixture(); t.after(() => f.store.close()); f.delivery(); f.accept(at(15), at(18))
  assert.equal(f.preview().entries[0].statusAtCutoff, 'pending_review')
})

test('base work mutations emit immutable commitments even when collaboration is disabled', t => {
  const f = fixture(); t.after(() => f.store.close()); const work = new WorkService(f.store)
  const task = work.createTask(f.member, { title: '基础任务', dueDate: '2026-10-01', description: '交付一份报告', isTemporary: true, temporaryReason: '独立实验' })
  const initial = f.store.list<TaskCommitmentEvent>('taskCommitmentEvents').find(row => row.taskId === task.id)!
  const updated = work.updateTask(f.member, task.id, { version: task.version, dueDate: '2026-10-05', requestedOutcome: '交付两份报告', reason: '新增验证样本' })
  const events = f.store.list<TaskCommitmentEvent>('taskCommitmentEvents').filter(row => row.taskId === task.id)
  assert.deepEqual(events.map(row => row.kind), ['initial', 'deadline', 'scope'])
  assert.deepEqual(f.store.get('taskCommitmentEvents', initial.id), initial)
  assert.equal(events[1].newValue.dueDate, updated.dueDate)
})

test('accepted replacement keeps current version pending and excludes prior acceptance from attainment denominator', t => {
  const f = fixture(); t.after(() => f.store.close()); const first = f.delivery(at(8)); f.accept(at(9))
  f.seed<TaskDelivery>('taskDeliveries', { ...first, id: 'delivery-two', revision: 2, supersedesId: first.id, submittedAt: at(14) }, at(14))
  const row = f.preview().entries[0]
  assert.equal(row.statusAtCutoff, 'pending_review'); assert.equal(row.onTimeAccepted, null); assert.equal(row.acceptedSubmittedAt, null)
  assert.equal(f.preview().evidenceCoverage.acceptedKnown, 0)
})

test('an older version returned after the replacement submission cannot restart the new version overdue interval', t => {
  const f = fixture(); t.after(() => f.store.close()); const first = f.delivery(at(8))
  f.seed<TaskDelivery>('taskDeliveries', { ...first, id: 'delivery-two', revision: 2, supersedesId: first.id, submittedAt: at(9) }, at(9))
  f.seed<DeliveryDecision>('deliveryDecisions', { id: 'older-returned', seriesId: first.seriesId, deliveryId: first.id, conclusion: 'returned', action: 'correct', note: '旧版不符合', decidedBy: f.manager.id, decidedAt: at(12), supersedesDecisionId: null }, at(12))
  assert.equal(f.preview().entries[0].overdueIntervals.length, 0)
})

test('draft access and creation are manager-only and successful freeze replays without duplicate snapshots', t => {
  const f = fixture(); t.after(() => f.store.close()); const p = f.preview()
  const input = { period: p.period, cutoffAt: p.cutoffAt, fingerprint: p.fingerprint, sourceManifest: p.sourceManifest, operationEpoch: p.operationEpoch, requestId: 'freeze-replay-test' }
  const result = f.service.create(f.manager, input)
  assert.deepEqual(f.service.create(f.manager, input), result)
  assert.equal(f.store.list<PeriodReviewSnapshot>('periodReviewSnapshots').length, 1)
  assert.throws(() => f.service.create(f.member, input), { status: 403 })
  assert.throws(() => f.service.preview(f.member, input), { status: 403 })
  assert.throws(() => f.service.read(f.member, result.id), { status: 404 })
  assert.throws(() => f.service.create(f.manager, { ...input, cutoffAt: at(17) }), { status: 409, code: 'IDEMPOTENCY_MISMATCH' })
})

test('legacy task audits reconstruct only typed commitments and silent import audits never invent original promises', t => {
  const f = fixture(); t.after(() => f.store.close())
  f.store.delete('taskCommitmentEvents', f.initial.id, 1)
  const legacy = f.preview().entries[0]
  assert.equal(legacy.originalDueDate, '2026-09-10'); assert.equal(legacy.ownerId, f.member.id)
  assert.equal('after' in legacy.commitments[0], false); assert.equal('entityType' in legacy.commitments[0], false)
  f.store.update<Task>('tasks', f.task.id, 1, { importSource: { batchId: 'import', sourceId: 'source', rowId: 'legacy', sourceStatus: '', mode: 'draft', notificationMode: 'silent' } })
  const imported = f.preview().entries[0]
  assert.equal(imported.ownerId, null); assert.equal(imported.originalDueDate, null); assert.equal(imported.statusAtCutoff, 'unknown')
})

test('same-millisecond commitment events follow task versions, not random source UUID ordering', t => {
  const f = fixture(); t.after(() => f.store.close())
  const before = f.value(), after = f.value({ dueDate: '2026-09-25' })
  const audit = f.seed<AuditEvent>('events', { id: '000-sorts-before-initial', entityType: 'task', entityId: f.task.id, actorId: f.manager.id, action: 'update', reason: '同毫秒修改', before: { ...f.task, version: 1 }, after: { ...f.task, dueDate: after.dueDate, version: 2 } }, at(1))
  f.seed<TaskCommitmentEvent>('taskCommitmentEvents', { id: 'same-ms', taskId: f.task.id, kind: 'deadline', oldValue: before, newValue: after, effectiveAt: at(1), recordedAt: at(1), actorId: f.manager.id, reason: '同毫秒修改', sourceType: 'audit', sourceId: audit.id, sourceVersion: 1 }, at(1))
  assert.equal(f.preview().entries[0].effectiveDueDate, '2026-09-25')
})

test('whole-week submission at the exact deadline is late and missing a formal cycle stays unknown', t => {
  const f = fixture(); t.after(() => f.store.close())
  f.seed<WeeklyDuty>('weeklyDuties', { id: 'duty-exact', ownerId: f.member.id, cycleWeek: '2026-09-07', kind: 'results', contentWeek: '2026-09-07', deadlineAt: at(11) }, at(7))
  f.seed<WeeklySubmission>('weeklySubmissions', { id: 'exact-receipt', dutyId: 'duty-exact', ownerId: f.member.id, cycleWeek: '2026-09-07', kind: 'results', submittedAt: at(11), actorId: f.member.id, reason: '', note: '', requestId: 'exact', records: [], retainedDraftIds: [], retainedDraftManifest: [] }, at(11))
  assert.equal(f.preview().weeklyCompliance[0].statusAtCutoff, 'unknown')
  f.seed<WeeklyCycle>('weeklyCycles', { id: 'exact-cycle', week: '2026-09-07', deadlineAt: at(11), rosterIds: [f.member.id], needsReview: false, confirmedBy: f.manager.id, confirmationReason: '', frozenAt: at(7) }, at(7))
  assert.equal(f.preview().weeklyCompliance[0].statusAtCutoff, 'late')
})

test('a post-period replacement and acceptance appear only in the later-evidence revision', t => {
  const f = fixture(); t.after(() => f.store.close()); const first = f.delivery(at(8))
  f.seed<DeliveryDecision>('deliveryDecisions', { id: 'first-return', seriesId: first.seriesId, deliveryId: first.id, conclusion: 'returned', action: 'review', note: '补充材料', decidedBy: f.manager.id, decidedAt: at(9), supersedesDecisionId: null }, at(9))
  const replacement = f.seed<TaskDelivery>('taskDeliveries', { ...first, id: 'second-after-period', revision: 2, supersedesId: first.id, submittedAt: at(18), dueDateSnapshot: '2026-09-19' }, at(18))
  f.seed<DeliveryDecision>('deliveryDecisions', { id: 'second-accepted', seriesId: first.seriesId, deliveryId: replacement.id, conclusion: 'accepted', action: 'review', note: '补充齐全', decidedBy: f.manager.id, decidedAt: at(20), supersedesDecisionId: null }, at(20))
  const draft = f.create(), final = f.service.finalize(f.manager, draft.id, { operationEpoch: getOperationEpoch(f.store), requestId: 'finalize-later-v2', version: draft.version, contentHash: draft.contentHash })
  const revised = f.service.preview(f.manager, { period: final.period, cutoffAt: final.cutoffAt, previousSnapshotId: final.id, laterEvidenceThrough: at(25) }).entries[0]
  assert.equal(revised.statusAtCutoff, 'returned'); assert.deepEqual(revised.submissions.map(row => row.revision), [1])
  assert.equal(revised.laterStatus, 'accepted'); assert.deepEqual(revised.laterSubmissions.map(row => row.revision), [1, 2]); assert.equal(revised.laterSubmissions[1].timely, true)
  assert.equal(f.service.read(f.manager, final.id).entries[0].laterStatus, null)
})

test('cancellation stops future overdue accrual while retaining the already overdue interval', t => {
  const f = fixture(); t.after(() => f.store.close())
  f.commitment('cancelled', at(12), 'cancellation', f.value(), f.value({ cancelled: true }))
  assert.deepEqual(f.preview().entries[0].overdueIntervals, [{ from: '2026-09-10T16:00:00.000Z', through: at(12), dueDate: '2026-09-10', endedBy: 'cancellation' }])
})

test('a roster still needing confirmation cannot produce known weekly compliance', t => {
  const f = fixture(); t.after(() => f.store.close())
  f.seed<WeeklyCycle>('weeklyCycles', { id: 'uncertain-cycle', week: '2026-09-07', deadlineAt: at(11), rosterIds: [f.member.id], needsReview: true, confirmedBy: null, confirmationReason: '', frozenAt: at(7) }, at(7))
  f.seed<WeeklyDuty>('weeklyDuties', { id: 'uncertain-duty', ownerId: f.member.id, cycleWeek: '2026-09-07', kind: 'results', contentWeek: '2026-09-07', deadlineAt: at(11) }, at(7))
  f.seed<WeeklyMissing>('weeklyMissing', { id: 'uncertain-miss', dutyId: 'uncertain-duty', ownerId: f.member.id, cycleWeek: '2026-09-07', kind: 'results', deadlineAt: at(11), detectedAt: at(12) }, at(12))
  assert.equal(f.preview().weeklyCompliance[0].statusAtCutoff, 'unknown')
})

test('scope commitments retain description changes even when a requested outcome already exists', t => {
  const f = fixture(); t.after(() => f.store.close()); const work = new WorkService(f.store)
  const task = work.createTask(f.member, { title: '范围变化', description: '三个样本', requestedOutcome: '实验报告', dueDate: '2026-10-01', isTemporary: true, temporaryReason: '试验' })
  work.updateTask(f.member, task.id, { version: task.version, description: '五个样本', reason: '新增两个验证样本' })
  const change = f.store.list<TaskCommitmentEvent>('taskCommitmentEvents').find(row => row.taskId === task.id && row.kind === 'scope')!
  assert.ok(change); assert.match(change.oldValue!.scope, /三个样本/); assert.match(change.newValue.scope, /五个样本/); assert.match(change.newValue.scope, /实验报告/)
})
