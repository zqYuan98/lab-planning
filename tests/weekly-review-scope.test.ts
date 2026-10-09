import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { WorkService } from '../server/domain-work.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { WeeklyReviewDelegationService } from '../server/weekly-review-delegation.ts'
import { MyActionsService } from '../server/my-actions.ts'
import { isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import type { Task, User, WeeklyRecord } from '../shared/types.ts'
import type { WeeklyDutyView, WeeklyRule } from '../shared/weekly-submissions.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const now = new Date('2026-10-09T02:00:00.000Z'), week = '2026-10-05'
  const metadata = { version: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }
  const user = (id: string, role: User['role']) => store.restoreEntity<User>('users', { ...metadata, id, role, name: id, email: `${id}@scope.test`, position: '', active: true })
  const manager = user('manager', 'manager'), member = user('member', 'member')
  store.restoreEntity<WeeklyRule>('weeklyRules', { ...metadata, id: 'weekly-submission-rule', enabled: true, effectiveWeek: '2026-09-21', timezone: 'Asia/Shanghai',
    windows: [{ fromWeek: '2026-09-21', toWeek: null }], planReviewEffectiveWeek: '2026-09-21', managerSubmissionEffectiveWeek: '2026-09-21' })
  const service = new WeeklySubmissionService(store, () => now), work = new WorkService(store)
  const queue = new WeeklyReviewDelegationService(store), actions = new MyActionsService(store, () => now)
  service.view(manager, week)
  const add = (owner: User, contentWeek = '2026-10-12') => {
    const task = store.insert<Task>('tasks', { ownerId: owner.id, title: '核对周计划审批', description: '', dueDate: '2026-10-20', monthlyPlanId: null, isTemporary: true, temporaryReason: '验证支持', status: 'doing' })
    return work.createWeeklyRecord(owner, { taskId: task.id, weekStart: contentWeek, commitment: '完成阶段验证', actualOutcome: '已经开展验证', status: 'doing', submitted: true })
  }
  const duty = (owner: User, kind: 'plan' | 'results' = 'plan', cycleWeek = week) => service.view(manager, cycleWeek).duties.find(row => row.ownerId === owner.id && row.kind === kind)!
  const submit = (owner: User, value = duty(owner)) => service.submit(owner, { dutyId: value.id, version: value.version, manifest: value.manifest, progressEventIds: value.progressEventIds, draftAction: 'include', note: value.records.length ? '' : '本周期暂无工作安排', requestId: crypto.randomUUID() })
  const reviewInput = (value: WeeklyDutyView) => ({ dutyId: value.id, version: value.version, submissionId: value.latestSubmission!.id, decision: 'approved', requestId: crypto.randomUUID() })
  return { store, manager, member, week, service, work, queue, actions, add, duty, submit, reviewInput }
}

test('manager self-plans and empty plan receipts never create review gates, queues or actions', t => {
  for (const empty of [false, true]) {
    const f = fixture(t), row = empty ? undefined : f.add(f.manager)
    assert.equal(f.duty(f.manager).planReviewRequired, false)
    assert.equal(f.duty(f.manager).planReviewStatus, 'not_required')
    const receipt = f.submit(f.manager), value = f.duty(f.manager)
    assert.equal(value.status, 'on_time', 'the administrator still owes a formal submission')
    assert.equal(value.planReviewRequired, false)
    assert.equal(value.planReviewStatus, 'not_required')
    assert.equal(f.queue.queue(f.manager, f.week).items.length, 0)
    assert.equal(f.actions.list(f.manager).counts.weekly_review, 0)
    assert.throws(() => f.service.review(f.manager, f.reviewInput(value)), { status: 400 })
    assert.equal(f.store.list('weeklyPlanReviews').length, 0)
    assert.deepEqual(f.store.get('weeklySubmissions', receipt.id), receipt)
    if (row) {
      const current = f.store.get<WeeklyRecord>('weeklyRecords', row.id)!
      assert.equal(isEffectiveWeeklyRecord(current), true)
      f.work.updateWeeklyRecord(f.manager, row.id, { version: current.version, commitment: '补充阶段交付范围' })
      assert.equal(f.duty(f.manager).changedSinceSubmission, true, 'receipt revisions remain independently required')
      assert.equal(f.duty(f.manager).planReviewStatus, 'not_required')
      assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), true)
    }
  }
})

test('member whole-plan approval is still required for both populated and empty submissions', t => {
  for (const empty of [false, true]) {
    const f = fixture(t), row = empty ? undefined : f.add(f.member)
    f.submit(f.member)
    const value = f.duty(f.member)
    assert.equal(value.planReviewRequired, true)
    assert.equal(value.planReviewStatus, 'pending')
    assert.equal(f.queue.queue(f.manager, f.week).items.length, 1)
    assert.equal(f.actions.list(f.manager).counts.weekly_review, 1)
    assert.throws(() => f.service.review(f.member, f.reviewInput(value)), { status: 403 })
    f.service.review(f.manager, f.reviewInput(value))
    assert.equal(f.duty(f.member).planReviewStatus, 'approved')
    if (row) assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), true)
  }
})

test('promoting a member before or after submission preserves required historical plan approval', t => {
  for (const afterSubmission of [false, true]) {
    const f = fixture(t), row = f.add(f.member)
    if (afterSubmission) f.submit(f.member)
    f.store.update<User>('users', f.member.id, f.member.version, { role: 'manager' })
    if (!afterSubmission) f.submit(f.member)
    const value = f.duty(f.member)
    assert.equal(value.planReviewRequired, true)
    assert.equal(value.planReviewStatus, 'pending')
    assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), false)
    assert.equal(f.queue.queue(f.manager, f.week).items.length, 1)
    assert.equal(f.actions.list(f.manager).counts.weekly_review, 1)
    f.service.review(f.manager, f.reviewInput(value))
    assert.equal(f.duty(f.member).planReviewStatus, 'approved')
    assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), true)
  }
})

test('a results receipt never invents a prior plan submission or approval, and later review preserves the results receipt', t => {
  const f = fixture(t), row = f.add(f.member, f.week)
  const results = f.submit(f.member, f.duty(f.member, 'results'))
  assert.equal(f.duty(f.member, 'results').status, 'on_time')
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), false)
  assert.equal(f.duty(f.member, 'plan', '2026-09-28').planReviewStatus, 'unsubmitted')
  assert.equal(f.queue.queue(f.manager, '2026-09-28').items.length, 0)
  assert.equal(f.store.list('weeklySubmissions').length, 1)
  assert.equal(f.store.list('weeklyPlanReviews').length, 0)
  f.submit(f.member, f.duty(f.member, 'plan', '2026-09-28'))
  const plan = f.duty(f.member, 'plan', '2026-09-28')
  assert.equal(plan.status, 'late')
  f.service.review(f.manager, f.reviewInput(plan))
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), true)
  assert.equal(f.duty(f.member, 'results').changedSinceSubmission, false)
  assert.deepEqual(f.store.get('weeklySubmissions', results.id), results)
})

test('exemption hides an unreviewable pending action without granting plan approval, and revocation restores it', t => {
  const f = fixture(t), row = f.add(f.member)
  f.submit(f.member)
  let value = f.duty(f.member)
  f.service.adjust(f.manager, { dutyId: value.id, version: value.version, action: 'exempt', reason: '请假期间免交' })
  value = f.duty(f.member)
  assert.equal(value.status, 'exempt')
  assert.equal(value.planReviewStatus, 'pending', 'exemption does not fabricate a review conclusion')
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), false)
  assert.equal(f.queue.queue(f.manager, f.week).items.length, 0)
  assert.equal(f.actions.list(f.manager).counts.weekly_review, 0)
  assert.throws(() => f.service.review(f.manager, f.reviewInput(value)), { status: 409 })
  assert.equal(f.store.list('weeklyPlanReviews').length, 0)
  f.service.adjust(f.manager, { dutyId: value.id, version: value.version, action: 'revoke_exemption', reason: '已返岗恢复提报' })
  assert.equal(f.duty(f.member).planReviewStatus, 'pending')
  assert.equal(f.queue.queue(f.manager, f.week).items.length, 1)
  assert.equal(f.actions.list(f.manager).counts.weekly_review, 1)
})
