import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import type { User, Task, WeeklyRecord, MonthlyPlan } from '../shared/types.ts'

function fixture() {
  const store = new Store(':memory:')
  let now = new Date('2026-09-06T01:00:00Z')
  const service = new WeeklySubmissionService(store, () => now)
  function user(id: string, role: User['role'] = 'member') {
    return store.restoreEntity<User>('users', { id, version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', name: id, email: `${id}@example.test`, position: '', active: true, role })
  }
  const manager = user('manager', 'manager'), member = user('member'), other = user('other')
  service.getRule()
  const set = (value: string) => { now = new Date(value) }
  set('2026-09-11T07:59:59Z')
  function record(weekStart = '2026-09-07', owner = member, submitted = true) {
    const task = store.insert<Task>('tasks', { title: '验证任务', ownerId: owner.id, monthlyPlanId: null, description: '', dueDate: '2026-09-30', status: 'doing', isTemporary: true, temporaryReason: '临时支持' })
    return store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, ownerId: owner.id, monthlyPlanId: null, weekStart, commitment: '交付验证结果', actualOutcome: '已完成第一轮验证', status: 'doing', blocker: '', nextAction: '', evidenceUrl: '', submitted })
  }
  function submit(kind: 'results' | 'plan', note = '', requestId = crypto.randomUUID()) {
    const duty = service.view(member, '2026-09-07').duties.find(d => d.kind === kind)!
    return service.submit(member, { dutyId: duty.id, version: duty.version, manifest: duty.manifest, draftAction: 'retain', note, requestId })
  }
  return { store, service, manager, member, other, set, record, submit }
}

test('Friday cutoff uses Shanghai time, two independent duties, late fill keeps missing fact', () => {
  const f = fixture()
  try {
    f.record()
    f.submit('results')
    f.set('2026-09-11T08:00:00Z')
    f.submit('plan', '下周暂无安排，待项目发布')
    const rows = f.service.view(f.member, '2026-09-07').duties
    assert.equal(rows.find(r => r.kind === 'results')?.status, 'on_time')
    assert.equal(rows.find(r => r.kind === 'plan')?.status, 'late')
    assert.equal(rows.find(r => r.kind === 'plan')?.missingAtDeadline, true)
    f.service.reconcile(); f.service.reconcile()
    assert.equal(f.store.list('weeklyMissing').length, 3)
    assert.equal(f.service.view(f.manager, '2026-09-07').cycle?.rosterIds.length, 2)
  } finally { f.store.close() }
})

test('whole-sheet preview detects edits, additions and withdrawal atomically', () => {
  const f = fixture()
  try {
    const row = f.record()
    let duty = f.service.view(f.member, '2026-09-07').duties[0]
    const payload = { dutyId: duty.id, version: duty.version, manifest: duty.manifest, draftAction: 'retain', requestId: 'edit' }
    f.store.update<WeeklyRecord>('weeklyRecords', row.id, row.version, { actualOutcome: '更新结果' })
    assert.throws(() => f.service.submit(f.member, payload), { status: 409 })
    duty = f.service.view(f.member, '2026-09-07').duties[0]
    const added = f.record()
    assert.throws(() => f.service.submit(f.member, { ...payload, manifest: duty.manifest }), { status: 409 })
    duty = f.service.view(f.member, '2026-09-07').duties[0]
    f.store.update<WeeklyRecord>('weeklyRecords', added.id, added.version, { submitted: false })
    assert.throws(() => f.service.submit(f.member, { ...payload, manifest: duty.manifest }), { status: 409 })
    assert.equal(f.store.list('weeklySubmissions').length, 0)
  } finally { f.store.close() }
})

test('draft decisions, validation and idempotent immutable revisions', () => {
  const f = fixture()
  try {
    const draft = f.record('2026-09-14', f.member, false)
    const duty = f.service.view(f.member, '2026-09-07').duties.find(d => d.kind === 'plan')!
    const input = { dutyId: duty.id, version: duty.version, manifest: duty.manifest, requestId: 'unique', draftAction: 'include' }
    assert.throws(() => f.service.submit(f.member, { ...input, draftAction: undefined }), { status: 400 })
    const receipt = f.service.submit(f.member, input)
    assert.equal(f.service.submit(f.member, input).id, receipt.id)
    assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', draft.id)?.submitted, true)
    assert.equal(f.store.list('weeklySubmissions').length, 1)
    const current = f.store.get<WeeklyRecord>('weeklyRecords', draft.id)!
    f.store.update<WeeklyRecord>('weeklyRecords', current.id, current.version, { commitment: '后续变更' })
    f.set('2026-09-11T09:00:00Z')
    assert.equal(f.service.view(f.member, '2026-09-07').duties.find(d => d.kind === 'plan')?.changedSinceSubmission, true)
    f.submit('plan')
    const view = f.service.view(f.member, '2026-09-07').duties.find(d => d.kind === 'plan')!
    assert.equal(view.status, 'on_time')
    assert.equal(view.submissions[0].records[0].commitment, '交付验证结果')
    assert.equal(view.submissions.length, 2)
  } finally { f.store.close() }
})

test('privacy, proxy reason, exemption and immutable correction audit', () => {
  const f = fixture()
  try {
    f.record('2026-09-07', f.other)
    const otherDuty = f.service.view(f.other, '2026-09-07').duties[0]
    assert.ok(f.service.view(f.member, '2026-09-07').duties.every(d => d.ownerId === f.member.id))
    const input = { dutyId: otherDuty.id, version: otherDuty.version, manifest: otherDuty.manifest, requestId: 'proxy', draftAction: 'retain' }
    assert.throws(() => f.service.submit(f.member, input), { status: 403 })
    assert.throws(() => f.service.submit(f.manager, input), { status: 400 })
    const receipt = f.service.submit(f.manager, { ...input, reason: '成员出差代录' })
    f.set('2026-09-11T09:00:00Z')
    const current = f.service.view(f.other, '2026-09-07').duties[0]
    f.service.adjust(f.manager, { dutyId: current.id, version: current.version, action: 'invalidate', submissionId: receipt.id, reason: '提交内容误录' })
    const missing = f.service.view(f.other, '2026-09-07').duties[0]
    assert.equal(missing.status, 'missing')
    f.service.adjust(f.manager, { dutyId: missing.id, version: missing.version, action: 'exempt', reason: '出差免报' })
    const exempt = f.service.view(f.other, '2026-09-07').duties[0]
    assert.equal(exempt.status, 'exempt'); assert.equal(exempt.missingAtDeadline, true)
    assert.throws(() => f.service.adjust(f.other, { dutyId: exempt.id, version: exempt.version, action: 'exempt', reason: '自己操作' }), { status: 403 })
  } finally { f.store.close() }
})

test('effective full week, no future empty claims, stopped-server catchup and new member roster', () => {
  const f = fixture()
  try {
    assert.equal(f.service.view(f.member, '2026-08-31').cycle, null)
    assert.equal(f.service.view(f.member, '2026-09-14').cycle, null)
    const joined = f.store.restoreEntity<User>('users', { ...f.member, id: 'joined', createdAt: '2026-09-08T00:00:00Z', updatedAt: '2026-09-08T00:00:00Z' })
    assert.ok(!f.service.view(f.manager, '2026-09-07').cycle?.rosterIds.includes(joined.id))
    f.set('2026-09-25T10:00:00Z')
    f.service.reconcile()
    assert.equal(f.store.list('weeklyCycles').length, 3)
    assert.equal(f.service.view(f.manager, '2026-09-14').cycle?.rosterIds.includes(joined.id), true)
    assert.equal(f.store.list('weeklyMissing').length, 16)
  } finally { f.store.close() }
})

test('whole-sheet cannot bypass unpublished target and rolls back other drafts', () => {
  const f = fixture()
  try {
    const first = f.record('2026-09-14', f.member, false)
    const second = f.record('2026-09-14', f.member, false)
    const plan = f.store.insert<MonthlyPlan>('plans', { month: '2026-09', title: '未发布', projectId: null, category: '研发', ownerId: f.member.id, collaboratorIds: [], expectedOutcome: '交付', acceptanceCriteria: '验收', dueDate: '2026-09-30', priority: 'medium', status: 'draft', reviewComment: '', publishedVersion: null, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '' })
    f.store.update<WeeklyRecord>('weeklyRecords', second.id, second.version, { monthlyPlanId: plan.id })
    const duty = f.service.view(f.member, '2026-09-07').duties.find(d => d.kind === 'plan')!
    assert.throws(() => f.service.submit(f.member, { dutyId: duty.id, version: duty.version, manifest: duty.manifest, requestId: 'invalid', draftAction: 'include' }), { status: 400 })
    assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', first.id)?.submitted, false)
    assert.equal(f.store.list('weeklySubmissions').length, 0)
  } finally { f.store.close() }
})

test('ambiguous historic roster needs manager confirmation and cannot create false misses', () => {
  const f = fixture()
  try {
    f.store.update<User>('users', f.member.id, 1, { active: false })
    f.set('2026-09-11T09:00:00Z')
    const view = f.service.view(f.manager, '2026-09-07')
    assert.equal(view.cycle?.needsReview, true)
    assert.equal(f.store.list('weeklyMissing').length, 0)
    f.service.confirmRoster(f.manager, { week: view.week, version: view.cycle!.version, rosterIds: [f.member.id, f.other.id], reason: '核对本周实际在岗名单' })
    assert.equal(f.store.list('weeklyMissing').length, 4)
    assert.throws(() => f.service.confirmRoster(f.member, { week: view.week, version: 1, rosterIds: [], reason: '越权' }), { status: 403 })
  } finally { f.store.close() }
})

test('rule pause resumes from next full week without liabilities for paused weeks', () => {
  const f = fixture()
  try {
    let rule = f.service.getRule()
    rule = f.service.updateRule(f.manager, { version: rule.version, enabled: false })
    f.set('2026-09-21T01:00:00Z')
    rule = f.service.updateRule(f.manager, { version: rule.version, enabled: true })
    f.set('2026-10-02T09:00:00Z')
    f.service.reconcile()
    assert.equal(f.service.view(f.manager, '2026-09-14').cycle, null)
    assert.equal(f.service.view(f.manager, '2026-09-21').cycle, null)
    assert.ok(f.service.view(f.manager, '2026-09-28').cycle)
    assert.equal(f.store.list('weeklyMissing').length, 8)
  } finally { f.store.close() }
})

test('restarting service uses persisted facts and handles the year boundary', () => {
  const f = fixture()
  try {
    f.record(); f.submit('results')
    const restarted = new WeeklySubmissionService(f.store, () => new Date('2026-09-11T09:00:00Z'))
    assert.equal(restarted.view(f.member, '2026-09-07').duties[0].status, 'on_time')
    assert.equal(f.service.view(f.member, '2026-12-28').nextWeek, '2027-01-04')
    assert.equal(f.service.view(f.member, '2026-12-28').deadlineAt, '2027-01-01T08:00:00.000Z')
  } finally { f.store.close() }
})

test('editing a retained draft changes whole-sheet preview without erasing original receipt', () => {
  const f = fixture()
  try {
    const draft = f.record('2026-09-14', f.member, false)
    f.submit('plan', '尚未正式安排，先留草稿')
    assert.equal(f.service.view(f.member, '2026-09-07').duties.find(d => d.kind === 'plan')?.changedSinceSubmission, false)
    f.store.update<WeeklyRecord>('weeklyRecords', draft.id, draft.version, { commitment: '更改后的承诺' })
    assert.equal(f.service.view(f.member, '2026-09-07').duties.find(d => d.kind === 'plan')?.changedSinceSubmission, true)
  } finally { f.store.close() }
})
