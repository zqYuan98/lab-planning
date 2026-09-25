import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { Store } from '../server/store.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { WeeklyReviewDelegationService, readWeeklyReviewDelegation, resolveWholePlanReviewer } from '../server/weekly-review-delegation.ts'
import { addWeekDays, fridayDeadline, shanghaiWeek } from '../server/weekly-submission-clock.ts'
import { isEffectiveWeeklyRecord, weeklyPlanFingerprint } from '../shared/weekly-record-state.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import type { MonthlyPlan, Publication, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { WeeklyCycle, WeeklyDuty, WeeklyPlanReview, WeeklyRule, WeeklySubmissionView } from '../shared/weekly-submissions.ts'
import type { WeeklyReviewQueue } from '../shared/weekly-review-delegation.ts'

function fixture(t: TestContext, week = '2026-09-07', suffix = '') {
  const store = new Store(':memory:'); t.after(() => store.close())
  const now = new Date(`${week}T07:00:00.000Z`)
  const user = (id: string, role: User['role'] = 'member') => store.restoreEntity<StoredUser>('users', {
    id: `${id}${suffix}`, role, name: id, email: `${id}@delegation.test`, position: '', active: true, registrationStatus: 'approved', passwordHash: '', credentialVersion: 1,
    version: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
  })
  const manager = user('manager', 'manager'), member = user('member'), reviewer = user('reviewer'), other = user('other'), observer = user('observer', 'observer')
  const service = new WeeklySubmissionService(store, () => now), delegation = new WeeklyReviewDelegationService(store)
  const contentWeek = addWeekDays(week, 7)
  store.insert<WeeklyRule>('weeklyRules', { id: 'weekly-submission-rule', enabled: true, effectiveWeek: week, timezone: 'Asia/Shanghai', windows: [{ fromWeek: week, toWeek: null }], planReviewEffectiveWeek: week })
  store.insert<WeeklyCycle>('weeklyCycles', { id: week, week, deadlineAt: fridayDeadline(week), rosterIds: [member.id, reviewer.id, other.id], needsReview: false, confirmedBy: manager.id, confirmationReason: '已确认', frozenAt: now.toISOString() })
  const goal = store.insert<MonthlyPlan>('plans', { title: '共享目标', month: contentWeek.slice(0, 7), projectId: null, category: '日常工作', ownerId: reviewer.id, collaboratorIds: [member.id], expectedOutcome: '交付', acceptanceCriteria: '通过', dueDate: `${contentWeek.slice(0, 7)}-28`, priority: 'medium', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '' })
  store.insert<Publication>('publications', { month: goal.month, revision: 1, actorId: manager.id, reason: '发布', plans: [goal] })
  const task = store.insert<Task>('tasks', { ownerId: member.id, title: '计划任务', description: '私人任务说明不可出现在队列', dueDate: contentWeek, monthlyPlanId: goal.id, isTemporary: false, temporaryReason: '', status: 'doing' })
  const add = (patch: Partial<WeeklyRecord> = {}) => store.insert<WeeklyRecord>('weeklyRecords', { ownerId: member.id, taskId: task.id, monthlyPlanId: goal.id, weekStart: contentWeek, commitment: '本周交付承诺', actualOutcome: '私人执行进展', evidenceUrl: 'https://private.example/evidence', blocker: '私人阻塞', nextAction: '私人下一步', status: 'doing', submitted: false, ...patch })
  const duty = () => service.view(member, week).duties.find(row => row.kind === 'plan')!
  const submit = (actor: User = member, draftAction = 'include') => { const view = duty(); return service.submit(actor, { dutyId: view.id, version: view.version, manifest: view.manifest, draftAction, note: '私人提报说明', reason: actor.id !== member.id ? '管理者代录' : '', requestId: crypto.randomUUID() }) }
  const reviewInput = () => { const view = duty(); return { dutyId: view.id, version: view.version, submissionId: view.latestSubmission!.id, decision: 'approved', reason: '', requestId: crypto.randomUUID() } }
  const enable = (ids = [member.id]) => delegation.updateSettings(manager, { version: readWeeklyReviewDelegation(store).version, enabledOwnerIds: ids })
  const resolve = () => { const view = duty(); return resolveWholePlanReviewer(store, view, view.latestSubmission!) }
  return { store, manager, member, reviewer, other, observer, service, delegation, week, goal, task, add, duty, submit, reviewInput, enable, resolve }
}

test('explicit per-submitter opt-in selects the current other goal owner and never the proxy actor', t => {
  const f = fixture(t); f.add(); f.submit(f.manager)
  assert.deepEqual(f.resolve(), { kind: 'manager' })
  assert.equal(f.delegation.queue(f.reviewer, f.week).items.length, 0)
  assert.throws(() => f.delegation.updateSettings(f.reviewer, { version: 0, enabledOwnerIds: [f.member.id] }), { status: 403 })
  f.enable([f.reviewer.id]); assert.deepEqual(f.resolve(), { kind: 'manager' })
  f.enable(); assert.deepEqual(f.resolve(), { kind: 'goal_owner', reviewerId: f.reviewer.id, goalId: f.goal.id })
  assert.equal(f.delegation.queue(f.manager, f.week).items.length, 1)
  assert.equal(f.delegation.queue(f.reviewer, f.week).items.length, 1)
  assert.equal(f.delegation.queue(f.other, f.week).items.length, 0)
  assert.throws(() => f.delegation.queue(f.observer, f.week), { status: 403 })
})

test('queue is an explicit minimal DTO and does not widen personal submissions or exports', t => {
  const f = fixture(t); f.add({ submitted: true }); f.add({ commitment: '保留草稿私密内容' }); f.submit(f.member, 'retain'); f.enable()
  const queue = f.delegation.queue(f.reviewer, f.week)
  assert.equal(queue.items[0].retainedDraftCount, 1)
  assert.deepEqual(Object.keys(queue.items[0].items[0]).sort(), ['change', 'commitment', 'goalTitle', 'recordId', 'taskTitle'])
  assert.match(JSON.stringify(queue), /本周交付承诺|共享目标/)
  assert.doesNotMatch(JSON.stringify(queue), /私人|private\.example|保留草稿私密内容|actualOutcome|evidenceUrl|records|planManifest/)
  assert.ok(f.service.view(f.reviewer, f.week).duties.every(row => row.ownerId === f.reviewer.id))
  assert.equal(exportBusinessData(f.store, f.reviewer).collections.weeklySubmissions.length, 0)
  const audits = f.store.list<{ objectIds: string[]; action: string }>('objectReadAudits')
  assert.ok(audits.some(row => row.action === 'weekly_review_queue' && row.objectIds.includes(queue.items[0].dutyId)))
  assert.doesNotMatch(JSON.stringify(audits), /本周交付承诺|私人/)
})

test('self, mixed goals, missing goal, stale live association and unusable reviewer all fall back to managers', t => {
  for (const scenario of ['self', 'task-self', 'task-reassigned', 'retained-mixed', 'missing-goal', 'merged', 'live-relinked', 'cancelled-task', 'inactive', 'pending', 'observer', 'empty'] as const) {
    const f = fixture(t)
    if (scenario !== 'empty') f.add({ submitted: true })
    if (scenario === 'retained-mixed') {
      const otherGoal = f.store.insert<MonthlyPlan>('plans', { ...f.goal, id: 'other-goal' })
      const otherTask = f.store.insert<Task>('tasks', { ...f.task, id: 'other-task', monthlyPlanId: otherGoal.id })
      f.add({ taskId: otherTask.id, monthlyPlanId: otherGoal.id })
    }
    f.submit(f.member, 'retain'); f.enable()
    if (scenario === 'self') f.store.update<MonthlyPlan>('plans', f.goal.id, f.goal.version, { ownerId: f.member.id })
    if (scenario === 'task-self') f.store.update<Task>('tasks', f.task.id, f.task.version, { ownerId: f.reviewer.id })
    if (scenario === 'task-reassigned') f.store.update<Task>('tasks', f.task.id, f.task.version, { ownerId: f.other.id })
    if (scenario === 'missing-goal') f.store.delete('plans', f.goal.id, f.goal.version)
    if (scenario === 'merged') f.store.update<MonthlyPlan>('plans', f.goal.id, f.goal.version, { status: 'merged' })
    if (scenario === 'live-relinked') f.store.update<Task>('tasks', f.task.id, f.task.version, { monthlyPlanId: null })
    if (scenario === 'cancelled-task') f.store.update<Task>('tasks', f.task.id, f.task.version, { cancellation: { cancelledAt: new Date().toISOString(), cancelledBy: f.manager.id, reason: '已取消' } })
    if (scenario === 'inactive') f.store.update<User>('users', f.reviewer.id, f.reviewer.version, { active: false })
    if (scenario === 'pending') f.store.update<User>('users', f.reviewer.id, f.reviewer.version, { registrationStatus: 'pending' })
    if (scenario === 'observer') f.store.update<User>('users', f.reviewer.id, f.reviewer.version, { role: 'observer' })
    assert.deepEqual(f.resolve(), { kind: 'manager' }, scenario)
    assert.throws(() => f.service.review(f.reviewer, f.reviewInput()), { status: 403 }, scenario)
    assert.equal(f.service.review(f.manager, f.reviewInput()).reviewedBy, f.manager.id, scenario)
  }
})

test('retained draft mutation is part of whole-plan authorization and requires a new receipt', t => {
  const f = fixture(t); f.add({ submitted: true }); const draft = f.add({ commitment: '草稿' }); f.submit(f.member, 'retain'); f.enable()
  const input = f.reviewInput()
  assert.equal(f.resolve().kind, 'goal_owner')
  f.store.update<WeeklyRecord>('weeklyRecords', draft.id, draft.version, { commitment: '草稿内容已变化' })
  assert.equal(f.resolve().kind, 'manager')
  assert.equal(f.delegation.queue(f.reviewer, f.week).items.length, 0)
  assert.throws(() => f.service.review(f.reviewer, input), { status: 403 })
  assert.throws(() => f.service.review(f.manager, input), { status: 409 })
})

test('revocation is rechecked before both new review writes and successful idempotent retry', t => {
  for (const scenario of ['disabled-setting', 'changed-goal-owner', 'inactive-reviewer', 'task-self', 'changed-plan'] as const) {
    const f = fixture(t); const row = f.add(); f.submit(); f.enable(); const input = f.reviewInput()
    const review = f.service.review(f.reviewer, input)
    assert.equal(f.service.review(f.reviewer, input).id, review.id)
    if (scenario === 'disabled-setting') f.enable([])
    if (scenario === 'changed-goal-owner') f.store.update<MonthlyPlan>('plans', f.goal.id, f.goal.version, { ownerId: f.other.id })
    if (scenario === 'inactive-reviewer') f.store.update<User>('users', f.reviewer.id, f.reviewer.version, { active: false })
    if (scenario === 'task-self') f.store.update<Task>('tasks', f.task.id, f.task.version, { ownerId: f.reviewer.id })
    if (scenario === 'changed-plan') { const current = f.store.get<WeeklyRecord>('weeklyRecords', row.id)!; f.store.update<WeeklyRecord>('weeklyRecords', row.id, current.version, { commitment: '新的承诺' }) }
    assert.throws(() => f.service.review(f.reviewer, input), { status: 403 }, scenario)
    assert.throws(() => f.service.review(f.reviewer, { ...input, requestId: 'another-review-request' }), { status: 403 }, scenario)
    assert.equal(f.store.list('weeklyPlanReviews').length, 1)
  }
})

test('manager and delegate compete for one receipt: only the first review succeeds', t => {
  for (const winner of ['manager', 'reviewer'] as const) {
    const f = fixture(t); f.add(); f.submit(); f.enable(); const input = f.reviewInput()
    const approved = f.service.review(f[winner], input)
    assert.throws(() => f.service.review(winner === 'manager' ? f.reviewer : f.manager, { ...input, requestId: 'competing-request' }), { status: 409 })
    assert.equal(f.service.review(f[winner], input).id, approved.id)
    assert.equal(f.store.list('weeklyPlanReviews').length, 1)
  }
})

test('delegated returns require a new receipt; stale versions and the superseded receipt cannot approve', t => {
  const f = fixture(t); const row = f.add(); f.submit(); f.enable(); const first = f.reviewInput()
  assert.throws(() => f.service.review(f.reviewer, { ...first, version: first.version - 1 }), { status: 409 })
  f.service.review(f.reviewer, { ...first, decision: 'returned', reason: '补充交付边界' })
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), false)
  assert.equal(f.delegation.queue(f.reviewer, f.week).items.length, 0)
  f.submit()
  assert.throws(() => f.service.review(f.reviewer, { ...first, requestId: 'stale-receipt' }), { status: 409 })
  assert.throws(() => f.service.review(f.reviewer, { ...first, decision: 'returned', reason: '补充交付边界' }), { status: 409 })
  f.service.review(f.reviewer, f.reviewInput())
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), true)
})

test('queue pages bound disclosed IDs and audit failure fails closed', t => {
  const f = fixture(t); f.add(); const receipt = f.submit(); f.enable()
  const duty = f.duty()
  // Distinct historical duties exercise the queue cursor without adding private DTO fields.
  for (let index = 0; index < 51; index++) {
    const id = `queue-${String(index).padStart(3, '0')}`
    f.store.restoreEntity<WeeklyDuty>('weeklyDuties', { ...duty, id })
    f.store.restoreEntity('weeklySubmissions', { ...receipt, id: `receipt-${id}`, dutyId: id })
  }
  const first = f.delegation.queue(f.manager, f.week)
  assert.equal(first.items.length, 50); assert.ok(first.nextCursor)
  const next = f.delegation.queue(f.manager, f.week, first.nextCursor)
  assert.equal(next.items.length, 2); assert.equal(next.nextCursor, null)
  assert.equal(new Set([...first.items, ...next.items].map(item => item.dutyId)).size, 52)
  const audit = f.store.list<{ objectIds: string[] }>('objectReadAudits').at(-1)!
  assert.equal(audit.objectIds.length, 2)
  const original = f.store.recordObjectRead.bind(f.store)
  f.store.recordObjectRead = () => { throw new Error('模拟审计存储不可用') }
  assert.throws(() => f.delegation.queue(f.reviewer, f.week), /模拟审计存储不可用/)
  f.store.recordObjectRead = original
})

test('progress preserves approval and new whole submissions identify changed, new and already approved lines', t => {
  const f = fixture(t); const a = f.add(), b = f.add({ commitment: '另一个批准承诺' }); f.submit(); f.enable()
  assert.deepEqual(f.delegation.queue(f.reviewer, f.week).items[0].items.map(row => row.change), ['new', 'new'])
  f.service.review(f.reviewer, f.reviewInput())
  const currentA = f.store.get<WeeklyRecord>('weeklyRecords', a.id)!, currentB = f.store.get<WeeklyRecord>('weeklyRecords', b.id)!
  f.store.update<WeeklyRecord>('weeklyRecords', a.id, currentA.version, { commitment: '变化后的承诺' })
  f.store.update<WeeklyRecord>('weeklyRecords', b.id, currentB.version, { actualOutcome: '继续补充执行进展' })
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', b.id)!), true)
  f.add({ commitment: '本次新增安排' }); f.submit()
  const rows = f.delegation.queue(f.reviewer, f.week).items[0].items
  assert.equal(rows.find(row => row.recordId === a.id)?.change, 'changed')
  assert.equal(rows.find(row => row.recordId === b.id)?.change, 'already-approved')
  assert.ok(rows.some(row => row.change === 'new'))
  f.service.review(f.reviewer, f.reviewInput())
  assert.ok(f.store.list<WeeklyRecord>('weeklyRecords').every(isEffectiveWeeklyRecord))
})

test('delegated approvals retain the existing invalidation/restoration chain and migrate without enabling delegation', t => {
  const f = fixture(t), target = fixture(t, f.week, '-target'); const row = f.add(); const receipt = f.submit(); f.enable()
  const review = f.service.review(f.reviewer, f.reviewInput())
  let duty = f.duty()
  f.service.adjust(f.manager, { dutyId: duty.id, version: duty.version, submissionId: receipt.id, action: 'invalidate', reason: '核查' })
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), false)
  duty = f.duty()
  f.service.adjust(f.manager, { dutyId: duty.id, version: duty.version, submissionId: receipt.id, action: 'restore', reason: '确认后恢复' })
  assert.equal(isEffectiveWeeklyRecord(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!), true)
  // Keep target accounts only, as a clean target business database.
  for (const collection of ['weeklyRules', 'weeklyCycles', 'plans', 'tasks', 'publications']) for (const entity of target.store.list<{ id: string; version: number }>(collection)) target.store.delete(collection, entity.id, entity.version)
  const packet = exportBusinessData(f.store, f.manager), preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  const restored = target.store.get<WeeklyPlanReview>('weeklyPlanReviews', review.id)!
  assert.equal(restored.reviewedBy, target.reviewer.id)
  assert.equal(restored.reason, review.reason)
  assert.deepEqual(readWeeklyReviewDelegation(target.store).enabledOwnerIds, [])
  const restoredRow = target.store.get<WeeklyRecord>('weeklyRecords', row.id)!
  assert.equal(restoredRow.planApproval!.approvedFingerprint, weeklyPlanFingerprint(restoredRow))
  assert.equal(isEffectiveWeeklyRecord(restoredRow), true)
})

test('HTTP delegates see only the dedicated queue, cannot configure, and lose write access after live revocation', async t => {
  const f = fixture(t, shanghaiWeek(new Date())); f.add(); f.submit(); f.enable()
  const server = createApp({ store: f.store }).listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const cookie = `lab_session=${createSession(f.store, f.reviewer)}`
  async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  const queue = await request(`/weekly-review-queue?week=${f.week}`)
  assert.equal(queue.status, 200); const item = (queue.body as WeeklyReviewQueue).items[0]
  assert.ok(item); assert.doesNotMatch(JSON.stringify(queue.body), /私人|private\.example/)
  const own = await request(`/weekly-submissions?week=${f.week}`)
  assert.ok((own.body as WeeklySubmissionView).duties.every(duty => duty.ownerId === f.reviewer.id))
  assert.equal((await request('/weekly-review-delegation')).status, 403)
  assert.equal((await request('/weekly-review-delegation', { version: 1, enabledOwnerIds: [] }, 'PUT')).status, 403)
  const input = { dutyId: item.dutyId, version: item.version, submissionId: item.submissionId, decision: 'approved', requestId: 'http-delegate-review' }
  const approved = await request('/weekly-submissions/review', input)
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  assert.equal((await request('/weekly-submissions/review', input)).status, 200)
  f.enable([])
  assert.equal((await request(`/weekly-review-queue?week=${f.week}`)).body.items.length, 0)
  assert.equal((await request('/weekly-submissions/review', input)).status, 403)
  assert.equal(f.store.list('weeklyPlanReviews').length, 1)
})

test('HTTP simultaneous manager and delegate review requests commit exactly one conclusion', async t => {
  const f = fixture(t, shanghaiWeek(new Date())); f.add(); f.submit(); f.enable(); const input = f.reviewInput()
  const server = createApp({ store: f.store }).listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/weekly-submissions/review`
  const responses = await Promise.all([f.manager, f.reviewer].map(actor => fetch(url, { method: 'POST', headers: { cookie: `lab_session=${createSession(f.store, actor)}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...input, requestId: `concurrent-${actor.id}` }) })))
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409])
  assert.equal(f.store.list('weeklyPlanReviews').length, 1)
})
