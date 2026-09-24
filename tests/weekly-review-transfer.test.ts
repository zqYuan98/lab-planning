import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { addWeekDays } from '../server/weekly-submission-clock.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { parsePacket } from '../server/data-transfer-schema.ts'
import { isEffectiveWeeklyRecord, weeklyPlanFingerprint } from '../shared/weekly-record-state.ts'
import type { Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { WeeklyPlanReview, WeeklyRule, WeeklySubmission } from '../shared/weekly-submissions.ts'

function fixture(t: TestContext, suffix: string) {
  const store = new Store(':memory:')
  t.after(() => store.close())
  const account = (name: string, role: User['role'] = 'member') => store.restoreEntity<User>('users', {
    id: `${name}-${suffix}`, version: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z',
    name, email: `${name}@review-transfer.test`, position: '', role, active: true,
  })
  const manager = account('manager', 'manager'), member = account('member'), other = account('other')
  const domain = new Domain(store)
  let now = new Date('2026-09-06T01:00:00.000Z')
  const service = new WeeklySubmissionService(store, () => now)
  const populate = () => {
    service.getRule(); now = new Date('2026-09-11T07:00:00.000Z')
    const task = store.insert<Task>('tasks', { title: '冻结的任务名称', ownerId: member.id, monthlyPlanId: null, description: '提交时的审核上下文', dueDate: '2026-09-30', status: 'doing', isTemporary: true, temporaryReason: '临时支持' })
    const create = (commitment: string) => domain.createWeeklyRecord(member, { taskId: task.id, weekStart: '2026-09-14', commitment })
    const approve = () => {
      let duty = service.view(member, '2026-09-07').duties.find(row => row.kind === 'plan')!
      const receipt = service.submit(member, { dutyId: duty.id, version: duty.version, manifest: duty.manifest, draftAction: 'include', requestId: crypto.randomUUID() })
      duty = service.view(member, '2026-09-07').duties.find(row => row.kind === 'plan')!
      service.review(manager, { dutyId: duty.id, version: duty.version, submissionId: receipt.id, decision: 'approved', reason: '可执行', requestId: crypto.randomUUID() })
      return receipt
    }
    const original = create('原始承诺'), first = approve()
    const approved = store.get<WeeklyRecord>('weeklyRecords', original.id)!
    const report = store.insert<Report>('reports', {
      type: 'weekly', period: '2026-09-07', title: '删除前冻结的报告', status: 'finalized', revision: 1, narrative: '原始内容', authorId: manager.id, finalizedAt: new Date().toISOString(),
      snapshot: { plans: [], contextPlans: [], weeklyRecords: [], tasks: [task], projects: [], users: [member], annualGoals: [], nextPlans: [], nextWeeklyRecords: [approved], publications: [], changes: [] },
    })
    domain.deleteWeeklyRecord(manager, original.id, { version: approved.version, reason: '本周安排需重新明确' })
    const replacement = create('重新安排的承诺'), second = approve()
    domain.updateTask(member, task.id, { version: task.version, title: '后来修改的任务名称', reason: '名称核对更正' })
    return { task, original, replacement, first, second, report }
  }
  return { store, domain, service, manager, member, other, populate }
}

test('approved plans, tombstones, same-week replacements and frozen snapshots survive JSON and account remapping', t => {
  const source = fixture(t, 'source'), target = fixture(t, 'target'), data = source.populate()
  assert.equal(source.domain.bootstrap(source.manager).weeklyRecords.length, 1)
  const packet = JSON.parse(JSON.stringify(exportBusinessData(source.store, source.manager)))
  assert.equal(packet.collections.weeklyRecords.length, 2)
  assert.equal(packet.collections.weeklyPlanReviews.length, 2)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  const original = target.store.get<WeeklyRecord>('weeklyRecords', data.original.id)!
  const replacement = target.store.get<WeeklyRecord>('weeklyRecords', data.replacement.id)!
  assert.equal(original.deletion!.deletedBy, target.manager.id)
  assert.equal(original.deletion!.reason, '本周安排需重新明确')
  assert.equal(isEffectiveWeeklyRecord(original), false)
  assert.equal(isEffectiveWeeklyRecord(replacement), true)
  assert.equal(replacement.planApproval!.approvedFingerprint, weeklyPlanFingerprint(replacement))
  assert.equal(replacement.planApproval!.approvedSubmissionId, data.second.id)
  const first = target.store.get<WeeklySubmission>('weeklySubmissions', data.first.id)!
  assert.equal(first.records[0].deletion, undefined)
  assert.equal(first.records[0].commitment, '原始承诺')
  assert.equal(first.planTaskSnapshots![0].title, '冻结的任务名称')
  assert.equal(first.planManifest![0].fingerprint, weeklyPlanFingerprint(first.records[0]))
  assert.equal(target.store.get<Task>('tasks', data.task.id)!.title, '后来修改的任务名称')
  const frozen = target.store.get<Report>('reports', data.report.id)!.snapshot.nextWeeklyRecords[0]
  assert.equal(frozen.ownerId, target.member.id)
  assert.equal(frozen.deletion, undefined)
  assert.equal(isEffectiveWeeklyRecord(frozen), true)
  assert.ok(target.store.list<WeeklyPlanReview>('weeklyPlanReviews').every(row => row.ownerId === target.member.id && row.reviewedBy === target.manager.id))
  assert.equal(target.store.list('notifications').length, 0)
  assert.equal(target.store.list('notificationDeliveries').length, 0)
  const repeat = previewRestore(target.store, target.manager, packet)
  assert.equal(repeat.canRestore, true, repeat.issues.join('\n'))
  assert.equal(repeat.counts.weeklyPlanReviews.skip, 2)
})

test('filtered exports carry approval dependencies and member exports preserve only their own review and deletion facts', t => {
  const source = fixture(t, 'source'), target = fixture(t, 'target'); source.populate()
  const privateTask = source.store.insert<Task>('tasks', { title: '其他成员的私有安排', ownerId: source.other.id, monthlyPlanId: null, description: '', dueDate: '2026-09-30', status: 'todo', isTemporary: true, temporaryReason: '其他支持' })
  source.domain.createWeeklyRecord(source.other, { taskId: privateTask.id, weekStart: '2026-09-14', commitment: '私有承诺' })
  const filtered = exportBusinessData(source.store, source.manager, { type: 'weeklyRecords', ownerId: source.member.id })
  assert.equal(filtered.collections.weeklyPlanReviews.length, 2)
  assert.equal(previewRestore(target.store, target.manager, filtered).canRestore, true)
  const member = exportBusinessData(source.store, source.member)
  assert.equal(member.collections.weeklyRecords.length, 2)
  assert.equal(member.collections.weeklyPlanReviews.length, 2)
  assert.ok(member.collections.weeklyPlanReviews.every(row => row.ownerId === source.member.id))
  assert.deepEqual(member.collections.weeklyCycles, [])
  assert.deepEqual(member.collections.weeklyRules, [])
  assert.deepEqual(member.collections.events, [])
  assert.doesNotMatch(JSON.stringify(member), /其他成员的私有安排|私有承诺/)
  assert.throws(() => previewRestore(source.store, source.member, member), { status: 403 })
})

test('legacy packets omit all review data without inventing approval or policy facts', t => {
  const source = fixture(t, 'source'), target = fixture(t, 'target')
  const packet = exportBusinessData(source.store, source.manager)
  const legacy = structuredClone(packet) as unknown as { formatVersion: number; collections: Record<string, unknown> }
  delete legacy.collections.weeklyPlanReviews
  const parsed = parsePacket(legacy)
  assert.deepEqual(parsed.collections.weeklyPlanReviews, [])
  assert.equal(previewRestore(target.store, target.manager, legacy).canRestore, true)
  for (const key of ['weeklyRules', 'weeklyCycles', 'weeklyDuties', 'weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments']) delete legacy.collections[key]
  legacy.formatVersion = 1
  assert.deepEqual(parsePacket(legacy).collections.weeklyPlanReviews, [])
})

test('tampered review identity, fingerprints, missing approval references and active duplicates block restore', t => {
  const source = fixture(t, 'source'), target = fixture(t, 'target'); source.populate()
  const packet = exportBusinessData(source.store, source.manager)
  const cases: Array<(copy: typeof packet) => void> = [
    copy => { copy.collections.weeklyPlanReviews = [] },
    copy => { copy.collections.weeklyPlanReviews[0].ownerId = source.other.id },
    copy => { copy.collections.weeklyPlanReviews[0].reviewedAt = '2026-09-10T00:00:00.000Z' },
    copy => { copy.collections.weeklyRecords[0].planApproval!.approvedSubmissionId = 'missing-receipt' },
    copy => { copy.collections.weeklyRecords[0].planApproval!.approvedFingerprint = JSON.stringify(['wrong-task', source.member.id, '2026-09-14', null, '篡改']) },
    copy => { copy.collections.weeklySubmissions[0].planManifest![0].fingerprint = JSON.stringify([copy.collections.tasks[0].id, source.member.id, '2026-09-14', null, '篡改']) },
    copy => { copy.collections.weeklySubmissions[0].planTaskSnapshots = [] },
    copy => { delete copy.collections.weeklyRecords.find(row => row.deletion)!.deletion },
    copy => { copy.collections.weeklyPlanReviews.push({ ...copy.collections.weeklyPlanReviews[0], id: 'duplicate-review', requestId: 'duplicate-request' }) },
    copy => { copy.collections.reports[0].snapshot.nextWeeklyRecords[0].planApproval!.approvedSubmissionId = copy.collections.weeklySubmissions.at(-1)!.id },
  ]
  for (const mutate of cases) {
    const copy = structuredClone(packet); mutate(copy)
    const preview = previewRestore(target.store, target.manager, copy)
    assert.equal(preview.canRestore, false, mutate.toString())
    assert.throws(() => restoreBusinessData(target.store, target.manager, copy, {}, preview.fingerprint), { status: 409 })
  }
  for (const mutate of [
    (copy: typeof packet) => { Object.assign(copy.collections.weeklyRecords[0].deletion ?? copy.collections.weeklyRecords[1].deletion!, { secret: 'forbidden' }) },
    (copy: typeof packet) => { Object.assign(copy.collections.weeklySubmissions[0].planTaskSnapshots![0], { secret: 'forbidden' }) },
    (copy: typeof packet) => { copy.collections.weeklyPlanReviews[0].decision = 'returned'; copy.collections.weeklyPlanReviews[0].reason = ' ' },
  ]) {
    const copy = structuredClone(packet); mutate(copy)
    assert.throws(() => previewRestore(target.store, target.manager, copy), { status: 400 })
  }
  assert.equal(target.store.list('weeklyRecords').length, 0)
  assert.equal(target.store.list('weeklyPlanReviews').length, 0)
})

test('invalidated approval remains legal in frozen history but cannot authorize a current row after restoration', t => {
  const source = fixture(t, 'source'), target = fixture(t, 'target'), data = source.populate()
  const approved = source.store.get<WeeklyRecord>('weeklyRecords', data.replacement.id)!
  source.store.update<Report>('reports', data.report.id, data.report.version, { snapshot: { ...data.report.snapshot, nextWeeklyRecords: [approved] } })
  let duty = source.service.view(source.member, '2026-09-07').duties.find(row => row.kind === 'plan')!
  source.service.adjust(source.manager, { dutyId: duty.id, version: duty.version, action: 'invalidate', submissionId: data.second.id, reason: '错误版本作废' })
  const packet = exportBusinessData(source.store, source.manager)
  assert.equal(packet.collections.weeklyRecords.find(row => row.id === approved.id)!.planApproval!.approvedSubmissionId, null)
  assert.equal(packet.collections.reports[0].snapshot.nextWeeklyRecords[0].planApproval!.approvedSubmissionId, data.second.id)
  const legitimate = previewRestore(target.store, target.manager, packet)
  assert.equal(legitimate.canRestore, true, legitimate.issues.join('\n'))
  const forged = structuredClone(packet)
  forged.collections.weeklyRecords.find(row => row.id === approved.id)!.planApproval = approved.planApproval
  const rejected = previewRestore(target.store, target.manager, forged)
  assert.equal(rejected.canRestore, false)
  assert.match(rejected.issues.join('\n'), /当前批准依据指向已作废的提交/)
  assert.throws(() => restoreBusinessData(target.store, target.manager, forged, {}, rejected.fingerprint), { status: 409 })
  duty = source.service.view(source.member, '2026-09-07').duties.find(row => row.kind === 'plan')!
  source.service.adjust(source.manager, { dutyId: duty.id, version: duty.version, action: 'restore', submissionId: data.second.id, reason: '已核对恢复' })
  const restoredPacket = exportBusinessData(source.store, source.manager)
  assert.equal(previewRestore(target.store, target.manager, restoredPacket).canRestore, true)
  restoreBusinessData(target.store, target.manager, packet, {}, legitimate.fingerprint)
  assert.equal(isEffectiveWeeklyRecord(target.store.get<WeeklyRecord>('weeklyRecords', data.replacement.id)!), false)
  assert.equal(isEffectiveWeeklyRecord(target.store.get<Report>('reports', data.report.id)!.snapshot.nextWeeklyRecords[0]), true)
})

test('legacy current rows inherit the target review policy while frozen history and issued assignments remain unchanged', t => {
  for (const includeLegacyRule of [false, true]) {
    const source = fixture(t, `source-${includeLegacyRule}`), target = fixture(t, `target-${includeLegacyRule}`)
    const targetRule = new WeeklySubmissionService(target.store).getRule()
    const reviewWeek = targetRule.planReviewEffectiveWeek!, contentWeek = addWeekDays(reviewWeek, 7)
    const oldRule = { ...targetRule }
    delete oldRule.planReviewEffectiveWeek
    if (includeLegacyRule) source.store.restoreEntity<WeeklyRule>('weeklyRules', oldRule)
    const add = (kind: 'self' | 'proxy' | 'assigned', submitted = true, weekStart = contentWeek, owner = source.member) => {
      const task = source.store.insert<Task>('tasks', { title: `${kind}旧任务`, ownerId: owner.id, monthlyPlanId: null, description: '', dueDate: '', status: 'todo', isTemporary: true, temporaryReason: '历史临时支持' })
      return source.store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, ownerId: owner.id, monthlyPlanId: null, weekStart, commitment: '迁移前承诺', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'planned', submitted,
        workOrigin: { kind, actorId: kind === 'self' ? owner.id : source.manager.id, reason: kind === 'proxy' ? '代录说明' : '' } })
    }
    const own = add('self'), proxy = add('proxy'), draftAssignment = add('assigned', false), issued = add('assigned')
    const historical = add('self', true, reviewWeek), managerRow = add('self', true, contentWeek, source.manager), removed = add('self')
    source.store.update<WeeklyRecord>('weeklyRecords', removed.id, removed.version, { deletion: { deletedAt: new Date().toISOString(), deletedBy: source.manager.id, reason: '历史删除' } })
    const report = source.store.insert<Report>('reports', { type: 'weekly', period: reviewWeek, title: '审批策略前报告', status: 'finalized', revision: 1, narrative: '保留原样', authorId: source.manager.id, finalizedAt: new Date().toISOString(),
      snapshot: { plans: [], weeklyRecords: [], tasks: [], projects: [], users: [source.member], annualGoals: [], nextPlans: [], nextWeeklyRecords: [own], publications: [], changes: [] } })
    const packet = exportBusinessData(source.store, source.manager)
    const preview = previewRestore(target.store, target.manager, packet)
    assert.equal(preview.canRestore, true, preview.issues.join('\n'))
    assert.match(preview.notices.join('\n'), /3 条.*待审核/)
    assert.equal(target.store.list('weeklyRecords').length, 0, 'preview does not write normalization')
    restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
    for (const row of [own, proxy, draftAssignment]) {
      const restored = target.store.get<WeeklyRecord>('weeklyRecords', row.id)!
      assert.deepEqual(restored.planApproval, { required: true, approvedSubmissionId: null, approvedFingerprint: null })
      assert.equal(isEffectiveWeeklyRecord(restored), false)
      assert.equal(restored.version, row.version)
      assert.equal(restored.ownerId, target.member.id)
    }
    for (const row of [issued, historical, managerRow, removed]) assert.equal(target.store.get<WeeklyRecord>('weeklyRecords', row.id)!.planApproval, undefined)
    assert.equal(target.store.get<Report>('reports', report.id)!.snapshot.nextWeeklyRecords[0].planApproval, undefined)
    assert.equal(target.store.get<WeeklyRule>('weeklyRules', targetRule.id)!.planReviewEffectiveWeek, reviewWeek)
    assert.equal(previewRestore(target.store, target.manager, packet).canRestore, true, 'normalized imports are idempotent')
    assert.equal(target.store.list('notifications').length, 0)
    assert.equal(target.store.list('notificationDeliveries').length, 0)
  }
})

test('paused review metadata roundtrips and cannot exempt a current row during an active review cycle', t => {
  const source = fixture(t, 'source'), target = fixture(t, 'target')
  const rule = source.service.getRule()
  const task = source.store.insert<Task>('tasks', { title: '暂停周期任务', ownerId: source.member.id, monthlyPlanId: null, description: '', dueDate: '', status: 'todo', isTemporary: true, temporaryReason: '临时支持' })
  const row = source.domain.createWeeklyRecord(source.member, { taskId: task.id, weekStart: addWeekDays(rule.planReviewEffectiveWeek!, 7), commitment: '暂停周期安排', submitted: true })
  source.service.updateRule(source.manager, { version: rule.version, enabled: false })
  const suspended = source.store.get<WeeklyRecord>('weeklyRecords', row.id)!
  assert.equal(suspended.planApproval!.suspended, true)
  source.store.insert<Report>('reports', { type: 'weekly', period: rule.planReviewEffectiveWeek!, title: '暂停期间冻结报告', status: 'finalized', revision: 1, narrative: '', authorId: source.manager.id, finalizedAt: new Date().toISOString(),
    snapshot: { plans: [], weeklyRecords: [], tasks: [], projects: [], users: [source.member], annualGoals: [], nextPlans: [], nextWeeklyRecords: [suspended], publications: [], changes: [] } })
  const packet = exportBusinessData(source.store, source.manager, { type: 'weeklyRecords' })
  assert.equal(packet.collections.weeklyRules.length, 1, 'pending or suspended metadata carries its policy dependency')
  assert.equal(packet.collections.weeklyRecords[0].planApproval!.suspended, true)
  const valid = previewRestore(target.store, target.manager, packet)
  assert.equal(valid.canRestore, true, valid.issues.join('\n'))
  const active = exportBusinessData(source.store, source.manager)
  active.collections.weeklyRules[0].enabled = true
  active.collections.weeklyRules[0].windows[0].toWeek = null
  const invalid = previewRestore(target.store, target.manager, active)
  assert.equal(invalid.canRestore, false)
  assert.match(invalid.issues.join('\n'), /当前暂停审核标记与规则生效窗口不一致/)
  delete active.collections.weeklyRecords[0].planApproval!.suspended
  assert.equal(previewRestore(target.store, target.manager, active).canRestore, true, 'historical paused snapshots remain valid under a later active rule')
  restoreBusinessData(target.store, target.manager, packet, {}, valid.fingerprint)
  const restored = target.store.get<WeeklyRecord>('weeklyRecords', row.id)!
  assert.equal(restored.planApproval!.suspended, true)
  assert.equal(isEffectiveWeeklyRecord(restored), true)
})
