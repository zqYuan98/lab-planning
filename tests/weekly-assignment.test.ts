import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { remapUsers, rowReferences, schemas } from '../server/data-transfer-schema.ts'
import type { AuditEvent, Task, User, WeeklyRecord } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store)
  const user = (id: string, role: User['role'] = 'member') => store.restoreEntity<User>('users', { id, version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', name: id, email: `${id}@assignment.test`, role, active: true, position: '' })
  const manager = user('manager', 'manager'), member = user('member'), peer = user('peer')
  const task = (actor = manager, ownerId = member.id, extra = {}) => domain.createTask(actor, { title: '责任人交付任务', ownerId, isTemporary: true, temporaryReason: '临时需求', dueDate: '2026-09-30', ...extra })
  const record = (task: Task, actor = manager, extra = {}) => domain.createWeeklyRecord(actor, { taskId: task.id, weekStart: '2026-09-14', commitment: '交付验证报告', ...extra })
  t.after(() => store.close())
  return { store, domain, manager, member, peer, task, record }
}

test('issued work belongs to responsible member, stays distinct from whole-sheet receipt and retains issuer after updates', t => {
  const f = fixture(t), task = f.task(), record = f.record(task)
  assert.deepEqual(record.workOrigin, { kind: 'assigned', actorId: f.manager.id, reason: '' })
  assert.equal(record.ownerId, f.member.id)
  assert.equal(f.domain.bootstrap(f.member).weeklyRecords[0].id, record.id)
  assert.equal(f.domain.bootstrap(f.peer).weeklyRecords.length, 0)
  assert.throws(() => f.domain.updateWeeklyRecord(f.peer, record.id, { version: record.version, actualOutcome: '篡改' }), { status: 403 })
  const updated = f.domain.updateWeeklyRecord(f.member, record.id, { version: record.version, actualOutcome: '完成验证', status: 'done', workOrigin: { kind: 'self', actorId: f.member.id }, creationKind: 'self' })
  assert.deepEqual(updated.workOrigin, record.workOrigin)
  let now = new Date('2026-09-13T01:00:00Z')
  const service = new WeeklySubmissionService(f.store, () => now)
  service.getRule(); now = new Date('2026-09-18T07:00:00Z')
  const duty = service.view(f.member, '2026-09-14').duties.find(d => d.kind === 'results')!
  assert.equal(duty.status, 'due')
  assert.equal(f.store.list('weeklySubmissions').length, 0)
  const receipt = service.submit(f.member, { dutyId: duty.id, version: duty.version, manifest: duty.manifest, draftAction: 'include', requestId: 'member-review' })
  assert.equal(receipt.ownerId, f.member.id); assert.equal(receipt.actorId, f.member.id)
  assert.deepEqual(receipt.records[0].workOrigin, record.workOrigin)
  assert.equal(service.view(f.member, '2026-09-14').duties.find(d => d.kind === 'results')!.status, 'on_time')
  assert.equal(f.domain.carryWeeklyRecord(f.member, record.id, { weekStart: '2026-09-21' }).workOrigin?.kind, 'self')
})

test('server owns source identity and validates proxy creation, responsible accounts and member privileges', t => {
  const f = fixture(t)
  assert.throws(() => f.task(f.manager, f.member.id, { creationKind: 'proxy' }), { status: 400 })
  assert.throws(() => f.task(f.member, f.member.id, { creationKind: 'assigned' }), { status: 400 })
  assert.throws(() => f.task(f.member, f.peer.id), { status: 403 })
  const task = f.task(f.manager, f.member.id, { creationKind: 'proxy', creationReason: '成员出差代录', workOrigin: { actorId: f.peer.id } })
  assert.deepEqual(task.workOrigin, { kind: 'proxy', actorId: f.manager.id, reason: '成员出差代录' })
  assert.throws(() => f.record(task, f.manager, { creationKind: 'proxy' }), { status: 400 })
  const record = f.record(task, f.manager, { creationKind: 'proxy', creationReason: '成员电话告知计划' })
  assert.equal(record.workOrigin?.reason, '成员电话告知计划')
  assert.equal(f.task(f.manager, f.manager.id).workOrigin?.kind, 'self')
  f.store.update<User>('users', f.member.id, f.member.version, { active: false })
  assert.throws(() => f.domain.createWeeklyRecord(f.manager, { taskId: task.id, weekStart: '2026-09-21', commitment: '后续' }), { status: 400 })
})

test('legacy source inference uses only creation audit, excludes imports and never writes entities or exported origins', t => {
  const f = fixture(t), created = f.task(), createdRow = f.record(created)
  const { workOrigin: _a, ...task } = created, { workOrigin: _b, ...record } = createdRow
  // Model a genuinely pre-commitment legacy dataset before changing its old audit snapshots.
  for (const event of f.store.list<{ id: string; version: number }>('taskCommitmentEvents')) f.store.delete('taskCommitmentEvents', event.id, event.version)
  f.store.update<Task>('tasks', task.id, task.version, { workOrigin: undefined }); f.store.update<WeeklyRecord>('weeklyRecords', record.id, record.version, { workOrigin: undefined })
  for (const event of f.store.list<AuditEvent>('events')) {
    if (!['task', 'weeklyRecord'].includes(event.entityType)) continue
    const after = { ...(event.after as Record<string, unknown>) }; delete after.workOrigin
    f.store.update<AuditEvent>('events', event.id, event.version, { after })
  }
  const before = JSON.stringify([f.store.list('tasks'), f.store.list('weeklyRecords'), f.store.list('events')])
  assert.equal(f.domain.bootstrap(f.member).weeklyRecords[0].workOrigin?.kind, 'assigned')
  assert.equal(JSON.stringify([f.store.list('tasks'), f.store.list('weeklyRecords'), f.store.list('events')]), before)
  const packet = exportBusinessData(f.store, f.manager)
  assert.equal(packet.collections.weeklyRecords[0].workOrigin, undefined)
  assert.equal(packet.collections.tasks[0].workOrigin, undefined)
  const target = new Store(':memory:'); t.after(() => target.close())
  for (const user of [f.manager, f.member, f.peer]) target.restoreEntity('users', user)
  const preview = previewRestore(target, f.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target, f.manager, packet, {}, preview.fingerprint)
  assert.equal(target.get<WeeklyRecord>('weeklyRecords', record.id)!.workOrigin, undefined)
  assert.equal(new Domain(target).bootstrap(f.member).weeklyRecords[0].workOrigin?.kind, 'assigned')
  f.store.update<WeeklyRecord>('weeklyRecords', record.id, record.version + 1, { importSource: { batchId: 'b', sourceId: 's', rowId: 'r', sourceStatus: '' } })
  assert.equal(f.domain.bootstrap(f.member).weeklyRecords[0].workOrigin, undefined)
  const ownTask = f.task(f.member), ownRecord = f.record(ownTask, f.member)
  f.domain.updateWeeklyRecord(f.manager, ownRecord.id, { version: ownRecord.version, actualOutcome: '管理者补充' })
  assert.equal(f.domain.bootstrap(f.member).weeklyRecords.find(row => row.id === ownRecord.id)?.workOrigin?.kind, 'self')
})

test('stored origins survive migration and participate in account reference remapping including receipt snapshots', t => {
  const f = fixture(t), task = f.task(f.manager, f.member.id, { creationKind: 'proxy', creationReason: '电话代录' }), row = f.record(task)
  const packet = exportBusinessData(f.store, f.manager)
  assert.deepEqual(packet.collections.tasks[0].workOrigin, task.workOrigin)
  assert.deepEqual(packet.collections.weeklyRecords[0].workOrigin, row.workOrigin)
  assert.ok(rowReferences('weeklyRecords', row).some(ref => ref.collection === 'users' && ref.id === f.manager.id))
  const remapped = remapUsers('weeklyRecords', row, { manager: 'new-manager', member: 'new-member' }) as WeeklyRecord
  assert.equal(remapped.workOrigin!.actorId, 'new-manager'); assert.equal(remapped.ownerId, 'new-member')
  const nested = remapUsers('weeklySubmissions', { actorId: 'member', ownerId: 'member', records: [row] }, { manager: 'new-manager' }) as { records: WeeklyRecord[] }
  assert.equal(nested.records[0].workOrigin!.actorId, 'new-manager')
  assert.equal(schemas.weeklyRecords.safeParse({ ...row, workOrigin: { ...row.workOrigin, secret: 'no' } }).success, false)
  assert.equal(schemas.tasks.safeParse({ ...task, workOrigin: { ...task.workOrigin, reason: '' } }).success, false)
})
