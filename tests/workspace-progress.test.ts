import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { TestDomain as Domain } from './fixtures/legacy-domain.ts'
import { WorkspaceQueryService } from '../server/workspace-query.ts'
import { workProgressProjector } from '../server/work-progress.ts'
import { buildWorkRegister, workRegisterToday } from '../shared/work-register.ts'
import { weeklyPlanFingerprint } from '../shared/weekly-record-state.ts'
import type { AuditEvent, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { ProgressEvent } from '../shared/collaboration.ts'

const today = '2026-09-22', now = new Date(`${today}T08:00:00Z`)
function fixture(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id, role, name: id, email: `${id}@test.invalid`, position: '', active: true })
  const manager = user('manager', 'manager'), member = user('member', 'member'), peer = user('peer', 'member')
  const task = (id: string, patch: Partial<Task> = {}) => store.insert<Task>('tasks', { id, title: `任务${id}`, ownerId: member.id, monthlyPlanId: null, description: '', dueDate: '2026-10-01', status: 'doing', isTemporary: false, temporaryReason: '', ...patch })
  const record = (task: Task, id: string, patch: Partial<WeeklyRecord> = {}) => store.insert<WeeklyRecord>('weeklyRecords', { id, taskId: task.id, ownerId: task.ownerId, monthlyPlanId: null, weekStart: '2026-09-14', commitment: '验证', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'doing', submitted: true, ...patch })
  const progress = (task: Task, id: string, patch: Partial<ProgressEvent> = {}) => store.insert<ProgressEvent>('progressEvents', { id, mutationId: id, taskId: task.id, weeklyRecordId: null, actorId: task.ownerId, ownerId: task.ownerId, source: 'task', noteType: 'progress', note: '', noChangeReason: '', nextAction: '', proxyReason: '', changes: [], meaningfulOwnerProgress: true, occurredAt: '2026-09-20T01:00:00.000Z', auditEventIds: [], ...patch })
  const audit = (task: Task, id: string, patch: Partial<AuditEvent> = {}) => store.transaction(() => store.restoreEntity<AuditEvent>('events', { id, version: 1, entityType: 'task', entityId: task.id, actorId: task.ownerId, action: 'update', reason: '', before: task, after: task, createdAt: '2026-09-19T01:00:00.000Z', updatedAt: '2026-09-19T01:00:00.000Z', ...patch }))
  const compare = (tasks: Task[], actor = member) => {
    const complete = workProgressProjector(store, actor, now), expected = Object.fromEntries(tasks.map(task => [task.id, complete(task)]))
    assert.deepEqual(store.workspaceTaskProgress(tasks, actor.id, actor.role === 'manager', today), expected)
  }
  return { store, manager, member, peer, task, record, progress, audit, compare }
}

test('paged progress preserves recorded, reconstructed and unknown facts, proxy and overall evidence', t => {
  const f = fixture(t), a = f.task('a', { currentProgress: '总体：完成　初稿', completionNote: '已归档' }), b = f.task('b', { currentProgress: '旧导入说明', completionNote: '旧完成说明' })
  const week = f.record(a, 'week-a', { actualOutcome: '完成接口验证' })
  f.progress(a, 'progress-overall', { note: '总体更新', changes: [{ field: 'task.currentProgress', before: '', after: '总体:完成 初稿' }] })
  f.audit(a, 'audit-completion', { before: { ...a, completionNote: '' }, after: a })
  f.audit(a, 'audit-week', { entityType: 'weeklyRecord', entityId: week.id, before: { ...week, actualOutcome: '' }, after: week })
  f.progress(a, 'progress-week', { source: 'weeklyRecord', weeklyRecordId: week.id, actorId: f.manager.id, occurredAt: '2026-09-21T01:00:00.000Z', note: '完成接口验证', changes: [{ field: 'weeklyRecord.actualOutcome', before: '', after: week.actualOutcome }], auditEventIds: ['audit-week'] })
  f.progress(a, 'unknown-note', { note: '发生日期未知的备注', occurredAt: '' })
  f.progress(a, 'no-change', { noteType: 'no_change', note: '不应展示为新进展', occurredAt: '2026-09-22T02:00:00.000Z' })
  f.record(b, 'unknown-week', { actualOutcome: '遗留周成果' })
  f.compare([a, b]); f.compare([a, b], f.manager)
  const result = f.store.workspaceTaskProgress([a], f.member.id, false, today)[a.id]
  assert.equal(result.latestExecution?.text, '完成接口验证'); assert.equal(result.latestExecution?.proxy, true)
  assert.equal(result.overallProgress?.evidenceRef, 'progress-overall')
})

test('progress excludes future, deleted, draft, unapproved and other-owner records and facts', t => {
  const f = fixture(t), task = f.task('scope'), other = f.task('other', { ownerId: f.peer.id })
  const invalid = [f.record(task, 'future', { weekStart: '2026-10-05' }), f.record(task, 'deleted', { deletion: { deletedAt: '2026-09-21T00:00:00Z', deletedBy: f.member.id, reason: '' } }), f.record(task, 'draft', { submitted: false }), f.record(task, 'unapproved', { planApproval: { required: true, approvedSubmissionId: null, approvedFingerprint: null } }), f.record(task, 'peer', { ownerId: f.peer.id })]
  for (const row of invalid) f.progress(task, `p-${row.id}`, { weeklyRecordId: row.id, note: `隐藏${row.id}` })
  const approved = f.record(task, 'approved', { actualOutcome: '有效审批承诺' })
  f.store.update<WeeklyRecord>('weeklyRecords', approved.id, approved.version, { planApproval: { required: true, approvedSubmissionId: 'approved', approvedFingerprint: weeklyPlanFingerprint(approved) } })
  f.progress(task, 'approved-progress', { weeklyRecordId: approved.id, note: '有效审批承诺' })
  f.progress(task, 'other-owner', { ownerId: f.peer.id, note: '其他人事实' })
  f.progress(other, 'other-task', { note: '其他人任务' })
  f.compare([task]); f.compare([task, other], f.manager)
  assert.equal(f.store.workspaceTaskProgress([task], f.member.id, false, today)[task.id].latestExecution?.text, '有效审批承诺')
  assert.throws(() => f.store.workspaceTaskProgress([other], f.member.id, false, today), /无权/)
  assert.throws(() => f.store.workspaceTaskProgress(Array(101).fill(task), f.member.id, false, today), /100/)
})

test('unknown history is exactly the same latest twenty facts and the SQLite result stays bounded as active history grows', t => {
  const f = fixture(t), task = f.task('growing', { currentProgress: '无日期的总体说明' })
  f.store.transaction(() => { for (let i = 0; i < 80; i++) f.record(task, `legacy-${String(i).padStart(3, '0')}`, { actualOutcome: `历史成果${i}`, weekStart: i % 2 ? '2026-09-07' : '2026-09-14' }) })
  f.compare([task]); f.store.resetReadMetrics()
  const before = f.store.workspaceTaskProgress([task], f.member.id, false, today), baseline = f.store.getReadMetrics()
  f.store.transaction(() => { for (let i = 0; i < 1000; i++) f.record(task, `older-${i}`, { actualOutcome: `更旧成果${i}`, weekStart: '2025-01-06' }) })
  f.compare([task]); f.store.resetReadMetrics()
  assert.deepEqual(f.store.workspaceTaskProgress([task], f.member.id, false, today), before)
  assert.deepEqual(f.store.getReadMetrics(), baseline)
  assert.equal(baseline.sql, 1); assert.equal(baseline.returnedRows, 21); assert.equal(baseline.parsedRows, 0)
})

test('register page content keeps the full projection progress contract including missing live tasks', t => {
  const f = fixture(t), task = f.task('register', { currentProgress: '总体安排' }), legacy = f.task('missing', { currentProgress: '历史任务说明' })
  const thisWeek = buildWorkRegister({ user: f.member, tasks: [], weeklyRecords: [] }).weekStart
  const record = f.record(task, 'current', { weekStart: thisWeek, actualOutcome: '实际执行成果' })
  f.progress(task, 'register-progress', { weeklyRecordId: record.id, note: record.actualOutcome })
  f.record(legacy, 'legacy-context', { weekStart: thisWeek })
  f.audit(legacy, 'missing-task-audit', { before: null, after: legacy })
  f.store.delete('tasks', legacy.id, legacy.version)
  const expected = buildWorkRegister(new Domain(f.store).bootstrap(f.member), { today: workRegisterToday() })
  const query = new WorkspaceQueryService(f.store), first = query.register(f.member, { limit: 1 }), second = query.register(f.member, { limit: 1, cursor: first.nextCursor })
  for (const row of [...first.items, ...second.items]) {
    const full = expected.rows.find(item => item.id === row.id)!
    for (const key of ['overallProgress', 'latestExecution', 'historicalExecution', 'progress', 'progressSource', 'progressWeekStart'] as const) assert.deepEqual(row[key], full[key], `${row.id}.${key}`)
  }
  assert.equal(first.total, 2)
})

test('supporting field evidence suppresses only its own unknown fact and preserves no-change semantics', t => {
  const f = fixture(t), task = f.task('same-text', { currentProgress: '相同正文', completionNote: '相同正文' })
  f.progress(task, 'overall-only', { source: 'progress', note: '总体说明已确认', changes: [{ field: 'task.currentProgress', before: '', after: '相同正文' }] })
  f.compare([task])
  assert.equal(f.store.workspaceTaskProgress([task], f.member.id, false, today)[task.id].historicalExecution[0].text, '相同正文')
  f.progress(task, 'completion-confirmed', { noteType: 'no_change', note: '无需重复更新', changes: [{ field: 'task.completionNote', before: '', after: '相同正文' }] })
  f.compare([task])
  assert.equal(f.store.workspaceTaskProgress([task], f.member.id, false, today)[task.id].historicalExecution.length, 0)
})

test('mixed historical evidence retains complete-projector content across task and weekly sources', t => {
  const f = fixture(t), tasks: Task[] = []
  for (let i = 0; i < 12; i++) {
    const task = f.task(`mixed-${String(i).padStart(2,'0')}`, { currentProgress: `总体${i % 3}`, completionNote: i % 2 ? `完成${i}` : `总体${i % 3}` }); tasks.push(task)
    for (let j = 0; j < 25; j++) {
      const id = `${task.id}-${String(j).padStart(2,'0')}`
      const weekly = f.record(task, `weekly-${id}`, { actualOutcome: `周结果${j % 4}`, weekStart: j % 9 === 0 ? '2026-10-05' : j % 2 ? '2026-09-07' : '2026-09-14', submitted: j % 8 !== 0 })
      if (j % 3 === 0) f.audit(task, `audit-${id}`, { entityType: 'weeklyRecord', entityId: weekly.id, before: { ...weekly, actualOutcome: '' }, after: weekly, createdAt: `2026-09-${String(1 + j % 20).padStart(2,'0')}T01:00:00.000Z` })
      if (j % 4 !== 0) f.progress(task, `event-${id}`, { weeklyRecordId: j % 2 ? weekly.id : null, source: j % 2 ? 'weeklyRecord' : 'progress', note: j % 7 === 0 ? '' : `备注${j}`, noteType: j % 11 === 0 ? 'no_change' : 'progress', actorId: j % 5 === 0 ? f.manager.id : task.ownerId,
        occurredAt: j % 5 === 0 ? '' : `2026-09-${String(1 + j % 20).padStart(2,'0')}T02:00:00.000Z`, changes: [{ field: j % 2 ? 'weeklyRecord.actualOutcome' : 'task.currentProgress', before: '', after: j % 2 ? weekly.actualOutcome : task.currentProgress! }], auditEventIds: j % 3 === 0 ? [`audit-${id}`] : [] })
    }
  }
  f.compare(tasks); f.compare(tasks, f.manager)
})

test('opaque imported ID ties use the same locale-independent ordering before the twenty-row cut', t => {
  const f = fixture(t), task = f.task('id-ties', { currentProgress: '相同总体' })
  const ids = ['a_1', 'a-1', 'a1', 'A1', 'a.1', 'a 1', '中文', 'é', '😀', '\uFFFD', ...Array.from({ length: 20 }, (_, i) => `source-${i}`)]
  for (const id of ids) {
    f.record(task, `record-${id}`, { actualOutcome: `旧进展${id}` })
    f.store.transaction(() => f.store.restoreEntity<ProgressEvent>('progressEvents', { id: `event-${id}`, version: 1, createdAt: '2026-09-20T01:00:00.000Z', updatedAt: '2026-09-20T01:00:00.000Z', mutationId: id, taskId: task.id, weeklyRecordId: null, actorId: task.ownerId, ownerId: task.ownerId, source: 'task', noteType: 'progress', note: `带证据进展${id}`, noChangeReason: '', nextAction: '', proxyReason: '', changes: [{ field: 'task.currentProgress', before: '', after: task.currentProgress! }], meaningfulOwnerProgress: true, occurredAt: '2026-09-20T01:00:00.000Z', auditEventIds: [] }))
  }
  f.compare([task]); f.compare([task], f.manager)
  const result = f.store.workspaceTaskProgress([task], f.member.id, false, today)[task.id]
  assert.equal(result.historicalExecution.length, 20)
  assert.equal(result.latestExecution?.sourceId, 'event-A1')
  assert.equal(result.overallProgress?.evidenceRef, 'event-😀')
})
