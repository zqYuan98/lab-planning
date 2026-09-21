import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import type { Task, User, WeeklyRecord } from '../shared/types.ts'
import type { ProgressEvent } from '../shared/collaboration.ts'
import type { WeeklyDutyView, WeeklySubmission } from '../shared/weekly-submissions.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:')
  t.after(() => store.close())
  let now = new Date('2026-09-06T01:00:00Z')
  const service = new WeeklySubmissionService(store, () => now)
  const collaboration = new CollaborationService(store, () => now)
  const user = (id: string, role: User['role']) => store.restoreEntity<User>('users', { id, version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', name: id, email: `${id}@example.test`, position: '', active: true, role })
  const manager = user('manager', 'manager'), member = user('member', 'member')
  service.getRule()
  now = new Date('2026-09-11T07:59:59Z')
  collaboration.updateSettings(manager, { requestId: 'enable-weekly-progress', version: 0, enabled: true, pilotUserIds: [member.id] })
  function record(weekStart = '2026-09-07') {
    const task = store.insert<Task>('tasks', { title: '验证任务', ownerId: member.id, monthlyPlanId: null, description: '', dueDate: '2026-09-30', status: 'doing', isTemporary: true, temporaryReason: '临时支持' })
    return store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, ownerId: member.id, monthlyPlanId: null, weekStart, commitment: '交付验证结果', actualOutcome: '已完成第一轮验证', status: 'doing', blocker: '', nextAction: '', evidenceUrl: '', submitted: true })
  }
  const duty = (kind = 'results') => service.view(member, '2026-09-07').duties.find(row => row.kind === kind)!
  const input = (view: WeeklyDutyView) => ({ dutyId: view.id, version: view.version, manifest: view.manifest, progressEventIds: view.progressEventIds ?? [], draftAction: 'retain', requestId: crypto.randomUUID() })
  const submit = (view = duty()) => service.submit(member, input(view))
  const progress = (row: WeeklyRecord, fields: Record<string, unknown> = {}, actor = member) => collaboration.recordProgress(actor, row.taskId, { requestId: crypto.randomUUID(), version: store.get<Task>('tasks', row.taskId)!.version, note: '形成新的验证结果', ...fields })
  return { store, service, collaboration, member, manager, record, duty, input, submit, progress, set: (value: string) => { now = new Date(value) } }
}

test('task progress dirties only related submissions, including same-timestamp notes, without rewriting on-time facts', t => {
  const f = fixture(t), row = f.record(), unrelated = f.record('2026-08-31')
  const receipt = f.submit()
  f.progress(unrelated)
  assert.equal(f.duty().changedSinceSubmission, false)
  const saved = f.progress(row)
  assert.equal(saved.progressEvent!.occurredAt, receipt.submittedAt)
  let view = f.duty()
  assert.equal(view.changedSinceSubmission, true)
  assert.deepEqual(view.progressEventIds, [saved.progressEvent!.id])
  assert.equal(view.progressEvents![0].note, '形成新的验证结果')
  assert.equal(view.status, 'on_time')
  assert.equal(view.firstSubmittedAt, receipt.submittedAt)
  assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', row.id)!.version, receipt.records[0].version)
  f.set('2026-09-11T09:00:00Z')
  f.submit(view)
  view = f.duty()
  assert.equal(view.changedSinceSubmission, false)
  assert.equal(view.status, 'on_time')
  assert.equal(view.firstSubmittedAt, receipt.submittedAt)
  assert.equal(view.missingAtDeadline, false)
})

test('a progress save between GET and POST rejects the reviewed snapshot even when weekly row versions are unchanged', t => {
  const f = fixture(t), row = f.record(), preview = f.duty()
  const request = f.input(preview)
  f.progress(row)
  assert.deepEqual(f.duty().manifest, preview.manifest)
  assert.throws(() => f.service.submit(f.member, request), { status: 409, message: '关联任务进展已变化，请刷新核对后重新提交' })
  assert.equal(f.store.list('weeklySubmissions').length, 0)
  const fresh = f.duty(), receipt = f.submit(fresh)
  assert.deepEqual(receipt.progressEventIds, fresh.progressEventIds)
  assert.equal(f.duty().changedSinceSubmission, false)
})

test('no-change responses do not dirty submissions; manager recorded meaningful progress does and preserves late facts', t => {
  const f = fixture(t), row = f.record()
  f.set('2026-09-11T08:01:00Z')
  const receipt = f.submit()
  f.progress(row, { note: '', noteType: 'no_change', noChangeReason: '等待试验资源', nextAction: '明天联系设备负责人' })
  assert.equal(f.duty().changedSinceSubmission, false)
  const progress = f.progress(row, { note: '成员现场已完成复测，代为记录', proxyReason: '根据成员提供的现场记录录入' }, f.manager)
  assert.equal(progress.progressEvent!.meaningfulOwnerProgress, false)
  assert.equal(f.duty().changedSinceSubmission, true)
  f.submit()
  assert.equal(f.duty().status, 'late')
  assert.equal(f.duty().firstSubmittedAt, receipt.submittedAt)
  assert.equal(f.duty().missingAtDeadline, true)
})

test('later task notes leave historical cycles unchanged; corrections explicitly linked to a weekly record require review', t => {
  const f = fixture(t), row = f.record()
  f.submit()
  f.set('2026-09-21T09:00:00Z')
  f.progress(row)
  assert.equal(f.duty().changedSinceSubmission, false)
  f.progress(row, { note: '补充当周验收证据', weeklyRecordId: row.id, weeklyRecordVersion: f.store.get<WeeklyRecord>('weeklyRecords', row.id)!.version })
  assert.equal(f.duty().changedSinceSubmission, true)
  assert.equal(f.duty().progressEvents!.length, 1)
})

test('business migration preserves the reviewed progress IDs and their related immutable events', t => {
  const f = fixture(t), row = f.record()
  const progress = f.progress(row)
  const receipt = f.submit()
  const packet = exportBusinessData(f.store, f.manager)
  assert.equal(packet.formatVersion, 3)
  assert.deepEqual(packet.collections.weeklySubmissions[0].progressEventIds, [progress.progressEvent!.id])
  assert.equal(packet.collections.progressEvents.length, 1)
  const target = new Store(':memory:')
  t.after(() => target.close())
  target.restoreEntity<User>('users', f.manager)
  target.restoreEntity<User>('users', f.member)
  const preview = previewRestore(target, f.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target, f.manager, packet, {}, preview.fingerprint)
  assert.deepEqual(target.get<WeeklySubmission>('weeklySubmissions', receipt.id)!.progressEventIds, receipt.progressEventIds)
  assert.equal(target.get<ProgressEvent>('progressEvents', progress.progressEvent!.id)!.note, '形成新的验证结果')
  assert.equal(target.list('businessNotificationEvents').length, 0)
})
