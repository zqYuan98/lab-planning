import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import { WorkService } from '../server/domain-work.ts'
import type { BlockerEpisode, FollowupRequest } from '../shared/collaboration.ts'
import { ensureWeeklyPlanReviewRule, weeklyPlanApprovalMetadata } from '../server/weekly-plan-review.ts'
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord, weeklyPlanFingerprint } from '../shared/weekly-record-state.ts'
import type { Task, User, WeeklyRecord } from '../shared/types.ts'
import type { WeeklyDutyView, WeeklyRule } from '../shared/weekly-submissions.ts'

function fixture() {
  const store = new Store(':memory:')
  let now = new Date('2026-09-06T01:00:00Z')
  const user = (id: string, role: User['role'] = 'member') => store.restoreEntity<User>('users', { id, role, name: id, email: `${id}@example.test`, position: '', active: true, version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' })
  const manager = user('manager', 'manager'), member = user('member')
  const service = new WeeklySubmissionService(store, () => now)
  service.getRule()
  now = new Date('2026-09-11T07:00:00Z')
  const task = store.insert<Task>('tasks', { ownerId: member.id, title: '验证', description: '核对结果', dueDate: '2026-09-18', monthlyPlanId: null, isTemporary: true, temporaryReason: '支持工作', status: 'doing' })
  const add = (weekStart = '2026-09-14', patch: Partial<WeeklyRecord> = {}) => store.insert<WeeklyRecord>('weeklyRecords', { ownerId: member.id, taskId: task.id, monthlyPlanId: null, weekStart, commitment: '完成验证', actualOutcome: '已开始验证', status: 'doing', evidenceUrl: '', blocker: '', nextAction: '', submitted: false, ...patch })
  const duty = (kind: 'plan' | 'results' = 'plan', week = '2026-09-07') => service.view(member, week).duties.find(row => row.kind === kind)!
  const submit = () => { const view = duty(); return service.submit(member, { dutyId: view.id, version: view.version, manifest: view.manifest, draftAction: 'include', requestId: crypto.randomUUID() }) }
  const reviewInput = (view: WeeklyDutyView = duty(), decision = 'approved', reason = '') => ({ dutyId: view.id, version: view.version, submissionId: view.latestSubmission!.id, decision, reason, requestId: crypto.randomUUID() })
  return { store, service, manager, member, task, add, duty, submit, reviewInput, set: (value: string) => { now = new Date(value) } }
}

test('member plan submission is pending until manager approves its immutable version', t => {
  const f = fixture(); t.after(() => f.store.close())
  const row = f.add(), receipt = f.submit()
  assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', row.id)?.submitted, true)
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), false)
  assert.equal(f.duty().planReviewStatus, 'pending')
  assert.equal(receipt.planTaskSnapshots?.[0].title, '验证')
  const input = f.reviewInput()
  assert.throws(() => f.service.review(f.member, input), { status: 403 })
  f.set('2026-09-14T04:00:00Z')
  const approved = f.service.review(f.manager, input)
  assert.equal(f.service.review(f.manager, input).id, approved.id)
  assert.throws(() => f.service.review(f.manager, { ...input, decision: 'returned', reason: '改一下' }), { status: 409 })
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), true)
  assert.equal(f.duty().status, 'on_time')
  assert.equal(f.duty().changedSinceSubmission, false)
  assert.equal(f.duty().planReviewStatus, 'approved')
  assert.equal(f.duty().firstSubmittedAt, receipt.submittedAt)
})

test('execution progress neither changes reviewed planning content nor invalidates approval', t => {
  const f = fixture(); t.after(() => f.store.close())
  const row = f.add(); f.submit()
  let current = f.store.get<WeeklyRecord>('weeklyRecords', row.id)!
  f.store.update<WeeklyRecord>('weeklyRecords', row.id, current.version, { actualOutcome: '执行过程中补充进展', status: 'done', evidenceUrl: 'https://example.test/evidence' })
  assert.equal(f.duty().planReviewStatus, 'pending')
  f.service.review(f.manager, f.reviewInput())
  current = f.store.get<WeeklyRecord>('weeklyRecords', row.id)!
  f.store.update<WeeklyRecord>('weeklyRecords', row.id, current.version, { actualOutcome: '验收补充材料' })
  assert.equal(f.duty().planReviewStatus, 'approved')
  assert.equal(f.duty().changedSinceSubmission, false)
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), true)
})

test('planning edits, additions and deletion reject a stale whole-sheet approval', t => {
  for (const mutation of ['edit', 'add', 'delete'] as const) {
    const f = fixture(); t.after(() => f.store.close())
    const row = f.add(); f.submit(); const input = f.reviewInput()
    const current = f.store.get<WeeklyRecord>('weeklyRecords', row.id)!
    if (mutation === 'edit') f.store.update<WeeklyRecord>('weeklyRecords', row.id, current.version, { commitment: '变更计划' })
    if (mutation === 'add') f.add('2026-09-14', { taskId: 'another-task' })
    if (mutation === 'delete') f.store.update<WeeklyRecord>('weeklyRecords', row.id, current.version, { deletion: { deletedAt: '2026-09-11T07:05:00Z', deletedBy: f.manager.id, reason: '错误周安排' } })
    assert.equal(f.duty().planReviewStatus, 'changed')
    assert.throws(() => f.service.review(f.manager, input), { status: 409 })
    assert.equal(f.store.list('weeklyPlanReviews').length, 0)
  }
})

test('returned versions retain timeliness and require a new submission before review', t => {
  const f = fixture(); t.after(() => f.store.close())
  f.add(); const first = f.submit(), input = f.reviewInput()
  assert.throws(() => f.service.review(f.manager, { ...input, decision: 'returned' }), { status: 400 })
  f.service.review(f.manager, { ...input, decision: 'returned', reason: '请补充交付范围' })
  assert.equal(f.duty().planReviewStatus, 'returned')
  assert.throws(() => f.service.review(f.manager, f.reviewInput()), { status: 409 })
  f.set('2026-09-14T04:00:00Z')
  const second = f.submit()
  assert.notEqual(first.id, second.id)
  assert.equal(f.duty().status, 'on_time')
  assert.equal(f.duty().planReviewStatus, 'pending')
  f.service.review(f.manager, f.reviewInput())
  assert.equal(f.duty().planReviewStatus, 'approved')
})

test('amending one approved line preserves other approved lines and historical receipt', t => {
  const f = fixture(); t.after(() => f.store.close())
  const a = f.add(), b = f.add('2026-09-14', { taskId: f.task.id + '-other' })
  f.store.restoreEntity<Task>('tasks', { ...f.task, id: b.taskId })
  const receipt = f.submit(); f.service.review(f.manager, f.reviewInput())
  const current = f.store.get<WeeklyRecord>('weeklyRecords', a.id)!
  f.store.update<WeeklyRecord>('weeklyRecords', a.id, current.version, { commitment: '重新调整安排' })
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', a.id)!), false)
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', b.id)!), true)
  assert.equal(f.duty().planReviewStatus, 'changed')
  assert.equal(receipt.records.find(row => row.id === a.id)?.commitment, '完成验证')
})

test('prospective initialization stamps future member rows only and persists through restart', t => {
  const f = fixture(); t.after(() => f.store.close())
  const oldRule = f.store.get<WeeklyRule>('weeklyRules', 'weekly-submission-rule')!
  f.store.delete('weeklyRules', oldRule.id, oldRule.version)
  const historical = f.add('2026-09-14', { submitted: true })
  const future = f.add('2026-09-28', { submitted: true })
  const assigned = f.add('2026-09-28', { workOrigin: { kind: 'assigned', actorId: f.manager.id, reason: '' }, submitted: true })
  const managerRow = f.add('2026-09-28', { ownerId: f.manager.id, submitted: true })
  assert.equal(weeklyPlanApprovalMetadata(f.store, f.member.id, '2026-09-28'), undefined)
  assert.equal(f.store.get('weeklyRules', oldRule.id), undefined)
  const rule = ensureWeeklyPlanReviewRule(f.store, new Date('2026-09-20T04:00:00Z'))
  assert.equal(rule.planReviewEffectiveWeek, '2026-09-21')
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', historical.id)!), true)
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', future.id)!), false)
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', assigned.id)!), true)
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', managerRow.id)!), true)
  assert.equal(ensureWeeklyPlanReviewRule(f.store, new Date('2026-10-12T04:00:00Z')).planReviewEffectiveWeek, '2026-09-21')
})

test('deletion and planning identity remain independent of execution and metadata versions', () => {
  const row = { id: 'a', taskId: 't', ownerId: 'u', weekStart: '2026-09-14', monthlyPlanId: null, commitment: '交付', submitted: true } as WeeklyRecord
  const approved = { ...row, planApproval: { required: true as const, approvedSubmissionId: 'receipt', approvedFingerprint: weeklyPlanFingerprint(row) } }
  assert.equal(isEffectiveWeeklyRecord({ ...approved, version: 99, actualOutcome: '完成' }), true)
  assert.equal(isEffectiveWeeklyRecord({ ...approved, commitment: '另一个承诺' }), false)
  assert.equal(isActiveWeeklyRecord({ ...approved, deletion: { deletedAt: '', deletedBy: '', reason: '' } }), false)
})

test('invalidating a reviewed receipt suspends its approval; explicit restoration restores matching content', t => {
  const f = fixture(); t.after(() => f.store.close())
  const row = f.add(), receipt = f.submit(); f.service.review(f.manager, f.reviewInput())
  let duty = f.duty()
  f.service.adjust(f.manager, { dutyId: duty.id, version: duty.version, action: 'invalidate', submissionId: receipt.id, reason: '核查本次提报' })
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), false)
  duty = f.duty()
  f.service.adjust(f.manager, { dutyId: duty.id, version: duty.version, action: 'restore', submissionId: receipt.id, reason: '核查通过，恢复原始提报' })
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), true)
  assert.equal(f.duty().planReviewStatus, 'approved')
})

test('approving after results submission does not make results receipt changed', t => {
  const f = fixture(); t.after(() => f.store.close())
  f.add(); f.submit()
  f.set('2026-09-18T07:00:00Z')
  const results = f.duty('results', '2026-09-14')
  f.service.submit(f.member, { dutyId: results.id, version: results.version, manifest: results.manifest, requestId: 'results-once' })
  assert.equal(f.duty('results', '2026-09-14').changedSinceSubmission, false)
  f.service.review(f.manager, f.reviewInput())
  assert.equal(f.duty('results', '2026-09-14').changedSinceSubmission, false)
})

test('effort-only edits mark results receipts changed without changing plan approval or legacy empty values', t => {
  for (const field of ['plannedEffortDays', 'actualEffortDays'] as const) {
    const f = fixture(); t.after(() => f.store.close())
    const work = new WorkService(f.store), row = f.add(), fingerprint = weeklyPlanFingerprint(row)
    f.submit(); f.service.review(f.manager, f.reviewInput())
    const results = () => f.duty('results', '2026-09-14')
    let minute = 0
    const submitResults = () => {
      f.set(`2026-09-18T07:0${minute++}:00Z`)
      const duty = results()
      return f.service.submit(f.member, { dutyId: duty.id, version: duty.version, manifest: duty.manifest, requestId: crypto.randomUUID() })
    }
    const receipt = submitResults(), frozen = JSON.stringify(receipt)
    let current = f.store.get<WeeklyRecord>('weeklyRecords', row.id)!
    current = work.updateWeeklyRecord(f.member, row.id, { version: current.version, [field]: null })
    assert.equal(results().changedSinceSubmission, false, 'legacy missing and explicit empty both mean unknown')
    current = work.updateWeeklyRecord(f.member, row.id, { version: current.version, [field]: 0 })
    assert.equal(results().changedSinceSubmission, true, 'zero is a reported value rather than unknown')
    assert.equal(weeklyPlanFingerprint(current), fingerprint)
    assert.equal(f.duty().planReviewStatus, 'approved')
    assert.equal(f.duty().changedSinceSubmission, false)
    assert.equal(isEffectiveWeeklyRecord(current), true)
    assert.equal(JSON.stringify(results().latestSubmission), frozen)
    assert.equal(receipt.records[0][field], undefined)
    assert.equal(submitResults().records[0][field], 0)
    assert.equal(results().changedSinceSubmission, false)
    current = f.store.get<WeeklyRecord>('weeklyRecords', row.id)!
    current = work.updateWeeklyRecord(f.member, row.id, { version: current.version, [field]: 0.5 })
    assert.equal(results().changedSinceSubmission, true)
    assert.equal(submitResults().records[0][field], 0.5)
    assert.equal(results().changedSinceSubmission, false)
    current = f.store.get<WeeklyRecord>('weeklyRecords', row.id)!
    work.updateWeeklyRecord(f.member, row.id, { version: current.version, [field]: null })
    assert.equal(results().changedSinceSubmission, true, 'clearing a reported value also needs a new receipt')
  }
})

test('approving blocked rows for multiple tasks keeps every blocker attached to its own task', t => {
  const f = fixture(); t.after(() => f.store.close())
  new CollaborationService(f.store).updateSettings(f.manager, { version: 0, requestId: 'enable-blocker-review', enabled: true, pilotUserIds: [f.member.id] })
  const secondTask = f.store.restoreEntity<Task>('tasks', { ...f.task, id: 'second-review-task' })
  const rows = [f.add('2026-09-14', { status: 'blocked', blocker: '等待数据', blockerImpact: '影响验证', supportNeeded: '协调数据' }),
    f.add('2026-09-14', { taskId: secondTask.id, status: 'blocked', blocker: '等待环境', blockerImpact: '影响交付', supportNeeded: '开通环境' })]
  f.submit(); f.service.review(f.manager, f.reviewInput())
  const blockers = f.store.list<BlockerEpisode>('blockerEpisodes')
  assert.equal(blockers.length, 2)
  for (const row of rows) assert.equal(blockers.find(item => item.sourceId === row.id)?.parentTaskId, row.taskId)
})

test('manager assignment drafts require review when the owner publishes or the manager formally submits the sheet', t => {
  for (const publisher of ['owner', 'proxy'] as const) {
    const f = fixture(); t.after(() => f.store.close())
    const work = new WorkService(f.store)
    const row = work.createWeeklyRecord(f.manager, { taskId: f.task.id, weekStart: '2026-09-14', commitment: '尚待确认的管理员草稿', submitted: false })
    assert.equal(row.planApproval?.required, true)
    if (publisher === 'owner') work.updateWeeklyRecord(f.member, row.id, { version: row.version, submitted: true })
    else {
      const duty = f.duty()
      f.service.submit(f.manager, { dutyId: duty.id, version: duty.version, manifest: duty.manifest, draftAction: 'include', requestId: 'manager-proxy-assigned-draft', reason: '替成员核对提报' })
    }
    assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), false)
  }
})

test('pausing weekly submissions exempts only new paused cycles and resuming does not rewrite them', t => {
  const f = fixture(); t.after(() => f.store.close())
  const work = new WorkService(f.store)
  const create = (weekStart: string) => work.createWeeklyRecord(f.member, { taskId: f.task.id, weekStart, commitment: `安排 ${weekStart}`, submitted: true })
  const current = create('2026-09-14'), paused = create('2026-09-21'), future = create('2026-09-28')
  const rule = f.service.getRule()
  f.service.updateRule(f.manager, { version: rule.version, enabled: false })
  assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', current.id)?.planApproval?.suspended, undefined)
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', current.id)!), false)
  assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', paused.id)?.planApproval?.suspended, true)
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', paused.id)!), true)
  assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', future.id)?.planApproval?.suspended, true)
  const addedDuringPause = create('2026-10-05')
  assert.equal(addedDuringPause.planApproval?.suspended, true)
  const otherTask = f.store.restoreEntity<Task>('tasks', { ...f.task, id: 'other-pause-task' })
  const followupFields = { ownerId: f.member.id, requestedBy: f.manager.id, managerRecipientIds: [f.manager.id], generation: 1, requirement: '补充反馈', dueAt: '2026-09-30T08:00:00Z', status: 'open' as const, respondedAt: null, closedAt: null, closedBy: null, closeReason: '', lastChangedBy: f.manager.id, changeReason: '' }
  const affectedFollowup = f.store.insert<FollowupRequest>('followupRequests', { ...followupFields, taskId: f.task.id, weeklyRecordId: future.id })
  const unrelatedFollowup = f.store.insert<FollowupRequest>('followupRequests', { ...followupFields, taskId: otherTask.id, weeklyRecordId: null })
  const blocker = f.store.insert<BlockerEpisode>('blockerEpisodes', { parentTaskId: f.task.id, sourceType: 'weeklyRecord', sourceId: future.id, ownerId: f.member.id, generation: 1, openedAt: '2026-09-11T07:00:00Z', openedBy: f.member.id, resolvedAt: null, resolvedBy: null, reason: '数据缺失', impact: '影响验证', supportNeeded: '协调数据', reviewAt: null, closureReason: '' })
  f.set('2026-09-18T07:00:00Z')
  const stopped = f.service.getRule()
  f.service.updateRule(f.manager, { version: stopped.version, enabled: true })
  assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', paused.id)?.planApproval?.suspended, true)
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', paused.id)!), true)
  for (const row of [future, addedDuringPause]) {
    assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', row.id)?.planApproval?.suspended, undefined)
    assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), false)
  }
  assert.equal(f.store.get<{ status: string }>('followupRequests', affectedFollowup.id)?.status, 'cancelled')
  assert.equal(f.store.get<{ status: string }>('followupRequests', unrelatedFollowup.id)?.status, 'open')
  assert.ok(f.store.get<BlockerEpisode>('blockerEpisodes', blocker.id)?.resolvedAt)
})

test('a member amendment of assigned work remains reviewable after pause and resume', t => {
  const f = fixture(); t.after(() => f.store.close())
  const work = new WorkService(f.store)
  let row = work.createWeeklyRecord(f.manager, { taskId: f.task.id, weekStart: '2026-09-28', commitment: '原下发要求', submitted: true })
  row = work.updateWeeklyRecord(f.member, row.id, { version: row.version, commitment: '成员修改后的要求' })
  assert.equal(row.planApproval?.required, true)
  f.service.updateRule(f.manager, { version: f.service.getRule().version, enabled: false })
  assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', row.id)?.planApproval?.suspended, true)
  f.set('2026-09-18T07:00:00Z')
  f.service.updateRule(f.manager, { version: f.service.getRule().version, enabled: true })
  const resumed = f.store.get<WeeklyRecord>('weeklyRecords', row.id)!
  assert.equal(resumed.planApproval?.required, true)
  assert.equal(resumed.planApproval?.suspended, undefined)
  assert.equal(isEffectiveWeeklyRecord(resumed), false)
})

test('saving manager execution feedback cannot silently approve an unchanged member amendment of assigned work', t => {
  const f = fixture(); t.after(() => f.store.close())
  const work = new WorkService(f.store)
  let row = work.createWeeklyRecord(f.manager, { taskId: f.task.id, weekStart: '2026-09-14', commitment: '管理员原始下发', submitted: true })
  row = work.updateWeeklyRecord(f.member, row.id, { version: row.version, commitment: '成员待审修订' })
  const approval = row.planApproval
  assert.equal(isEffectiveWeeklyRecord(row), false)
  row = work.updateWeeklyRecord(f.manager, row.id, { version: row.version, commitment: row.commitment, submitted: true,
    status: 'doing', actualOutcome: '已核对成员执行进展', proxyReason: '根据成员反馈记录' })
  assert.deepEqual(row.planApproval, approval)
  assert.equal(isEffectiveWeeklyRecord(row), false)
  row = work.updateWeeklyRecord(f.manager, row.id, { version: row.version, commitment: `  ${row.commitment}  `, submitted: true, actualOutcome: '补充执行反馈' })
  assert.deepEqual(row.planApproval, approval)
  assert.equal(isEffectiveWeeklyRecord(row), false)
  row = work.updateWeeklyRecord(f.manager, row.id, { version: row.version, commitment: '管理员重新下发的正式要求', submitted: true })
  assert.equal(row.planApproval, undefined)
  assert.equal(isEffectiveWeeklyRecord(row), true)
})

test('only a direct manager draft publication clears assignment review; formal sheet submission never does', t => {
  const f = fixture(); t.after(() => f.store.close())
  const work = new WorkService(f.store)
  let row = work.createWeeklyRecord(f.manager, { taskId: f.task.id, weekStart: '2026-09-14', commitment: '管理员草稿', submitted: false })
  assert.equal(row.planApproval?.required, true)
  row = work.updateWeeklyRecord(f.manager, row.id, { version: row.version, commitment: row.commitment, submitted: true })
  assert.equal(row.planApproval, undefined)
  assert.equal(isEffectiveWeeklyRecord(row), true)
  row = work.updateWeeklyRecord(f.member, row.id, { version: row.version, commitment: '成员修订要求' })
  row = work.updateWeeklyRecord(f.manager, row.id, { version: row.version, commitment: '整份代交中的计划修改', submitted: true }, { formalSubmission: true })
  assert.equal(row.planApproval?.required, true)
  assert.equal(isEffectiveWeeklyRecord(row), false)
})
