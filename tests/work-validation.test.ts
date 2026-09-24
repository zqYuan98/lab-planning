import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import { WorkService } from '../server/domain-work.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import { withCollaborationMutation } from '../server/collaboration-hooks.ts'
import { withSilentImport } from '../server/import-notification-context.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { Store } from '../server/store.ts'
import { createApp } from '../server/app.ts'

const imported = { batchId: 'history', rowId: 'row', sourceId: 'source', sourceStatus: '历史状态' }
const blockers = { blockerReason: '等待外部数据', blockerImpact: '验收延后一天', supportNeeded: '暂不需要支持' }
function fixture(t: TestContext, enabled = false, source: 'formal' | 'temporary' | 'register' | 'imported' = 'temporary') {
  const store = new Store(':memory:'), work = new WorkService(store), collaboration = new CollaborationService(store)
  t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.restoreEntity<User>('users', { id, role, name: id, email: `${id}@validation.test`, position: '', active: true, version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' })
  const manager = user('manager', 'manager'), member = user('member', 'member')
  if (enabled) collaboration.updateSettings(manager, { requestId: 'enable-work-validation', version: 0, enabled: true, pilotUserIds: [member.id] })
  const plan = source === 'formal' ? store.insert<MonthlyPlan>('plans', { month: '2026-09', title: '已发布目标', projectId: null, category: '研发', ownerId: member.id, collaboratorIds: [], expectedOutcome: '成果', acceptanceCriteria: '评审', dueDate: '2026-09-30', priority: 'medium', status: 'published', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', reviewComment: '' }) : null
  let task = source === 'register' ? work.captureTasks(member, { requestId: 'capture-validation-task', titles: ['验证工作'] }).tasks[0]
    : work.createTask(member, { title: '验证工作', ownerId: member.id, dueDate: '2026-09-30', monthlyPlanId: plan?.id, isTemporary: !plan, temporaryReason: plan ? '' : '临时支持' })
  if (source === 'imported') task = store.update<Task>('tasks', task.id, task.version, { importSource: imported })
  const record = work.createWeeklyRecord(member, { taskId: task.id, weekStart: '2026-09-14', commitment: '完成验证' })
  const snapshot = () => JSON.stringify(['tasks', 'weeklyRecords', 'events', 'progressEvents', 'blockerEpisodes', 'taskTrackings', 'followupRequests', 'businessNotificationEvents', 'collaborationEventConsumptions', 'digestItems', 'notifications', 'notificationDeliveries', 'collaborationRequests', 'weeklySubmissions'].map(key => [key, store.list(key)]))
  const rejected = (action: () => unknown, field: string) => {
    const before = snapshot()
    assert.throws(action, (error: unknown) => {
      assert.equal((error as { status: number }).status, 400)
      assert.ok((error as { fieldErrors?: Record<string, string> }).fieldErrors?.[field], `expected field error for ${field}`)
      return true
    })
    assert.equal(snapshot(), before)
  }
  return { store, work, collaboration, member, manager, task, record, snapshot, rejected }
}

for (const enabled of [false, true]) for (const source of ['formal', 'temporary', 'register', 'imported'] as const) {
  test(`task validation is source independent: collaboration=${enabled}, source=${source}`, t => {
    const f = fixture(t, enabled, source)
    for (const completionNote of [undefined, '', '  ']) f.rejected(() => f.work.updateTask(f.member, f.task.id, { version: f.task.version, status: 'done', completionNote, evidenceUrl: 'https://example.test/proof' }), 'completionNote')
    for (const field of ['blockerReason', 'blockerImpact', 'supportNeeded'] as const) f.rejected(() => f.work.updateTask(f.member, f.task.id, { version: f.task.version, status: 'blocked', ...blockers, [field]: '  ' }), field)
    const blocked = f.work.updateTask(f.member, f.task.id, { version: f.task.version, status: 'blocked', ...blockers })
    const done = f.work.updateTask(f.member, f.task.id, { version: blocked.version, status: 'done', completionNote: '  已验收交付  ', waitingForFeedback: true })
    assert.equal(done.completionNote, '已验收交付')
    assert.equal(done.waitingForFeedback, false)
  })

  test(`weekly validation includes drafts and formal reporting: collaboration=${enabled}, source=${source}`, t => {
    const f = fixture(t, enabled, source)
    if (source === 'imported') f.record = f.store.update<WeeklyRecord>('weeklyRecords', f.record.id, f.record.version, { importSource: imported })
    f.rejected(() => f.work.updateWeeklyRecord(f.member, f.record.id, { version: f.record.version, status: 'done', actualOutcome: ' ' }), 'actualOutcome')
    for (const status of ['blocked', 'not_done']) f.rejected(() => f.work.updateWeeklyRecord(f.member, f.record.id, { version: f.record.version, status, blocker: ' ' }), 'blocker')
    const draft = f.work.updateWeeklyRecord(f.member, f.record.id, { version: f.record.version, status: 'blocked', blocker: '等待数据' })
    assert.equal(draft.submitted, false)
    f.rejected(() => f.work.updateWeeklyRecord(f.member, draft.id, { version: draft.version, submitted: true }), 'blockerImpact')
    f.rejected(() => f.work.updateWeeklyRecord(f.member, draft.id, { version: draft.version, submitted: true, blockerImpact: '延期' }), 'supportNeeded')
    const report = f.work.updateWeeklyRecord(f.member, draft.id, { version: draft.version, submitted: true, blockerImpact: '延期', supportNeeded: '暂不需要支持' })
    assert.equal(report.status, 'blocked')
    const done = f.work.updateWeeklyRecord(f.member, report.id, { version: report.version, status: 'done', actualOutcome: '已完成该周阶段' })
    assert.equal(done.actualOutcome, '已完成该周阶段')
    assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'todo')
  })

  test(`progress entry validates task and weekly changes: collaboration=${enabled}, source=${source}`, t => {
    const f = fixture(t, enabled, source)
    const input = { requestId: 'progress-validation-test', version: f.task.version, taskStatus: 'done' }
    if (!enabled) {
      const before = f.snapshot()
      assert.throws(() => f.collaboration.recordProgress(f.member, f.task.id, input), { status: 409 })
      assert.equal(f.snapshot(), before)
      return
    }
    f.rejected(() => f.collaboration.recordProgress(f.member, f.task.id, input), 'completionNote')
    f.rejected(() => f.collaboration.recordProgress(f.member, f.task.id, { ...input, taskStatus: 'blocked', blockerReason: '等待数据' }), 'blockerImpact')
    const row = f.work.updateWeeklyRecord(f.member, f.record.id, { version: f.record.version, submitted: true })
    f.rejected(() => f.collaboration.recordProgress(f.member, f.task.id, { ...input, taskStatus: undefined, weeklyRecordId: row.id, weeklyRecordVersion: row.version, weekly: { status: 'blocked', blocker: '等待数据' } }), 'blockerImpact')
    const result = f.collaboration.recordProgress(f.member, f.task.id, { ...input, taskStatus: 'blocked', ...blockers, weeklyRecordId: row.id, weeklyRecordVersion: row.version, weekly: { status: 'blocked', blocker: '等待数据' } })
    assert.equal(result.task.status, 'blocked')
    assert.equal(result.weeklyRecord?.blockerImpact, blockers.blockerImpact)
  })
}

test('legacy missing evidence permits unrelated changes but status, evidence and formal submission require repair', t => {
  const f = fixture(t)
  let task = f.store.update<Task>('tasks', f.task.id, f.task.version, { status: 'done', importSource: imported })
  task = f.work.updateTask(f.member, task.id, { reason: '测试场景确认承诺调整', version: task.version, title: '修订标题' })
  for (const patch of [{ status: 'done' }, { completionNote: '' }, { evidenceUrl: 'https://example.test/new' }]) f.rejected(() => f.work.updateTask(f.member, task.id, { version: task.version, ...patch }), 'completionNote')
  let row = f.store.update<WeeklyRecord>('weeklyRecords', f.record.id, f.record.version, { status: 'done', actualOutcome: '', importSource: imported })
  row = f.work.updateWeeklyRecord(f.member, row.id, { version: row.version, nextAction: '核对历史资料' })
  for (const patch of [{ status: 'done' }, { actualOutcome: '' }, { submitted: true }]) f.rejected(() => f.work.updateWeeklyRecord(f.member, row.id, { version: row.version, ...patch }), 'actualOutcome')
  f.rejected(() => f.work.updateWeeklyRecord(f.member, row.id, { version: row.version }, { formalSubmission: true }), 'actualOutcome')
})

test('unmarked legacy records also allow unrelated edits and independent cancellation', t => {
  const f = fixture(t)
  let row = f.store.update<WeeklyRecord>('weeklyRecords', f.record.id, f.record.version, { status: 'blocked', blocker: '' })
  row = f.work.updateWeeklyRecord(f.member, row.id, { version: row.version, nextAction: '找回历史说明' })
  f.rejected(() => f.work.updateWeeklyRecord(f.member, row.id, { version: row.version, status: 'blocked' }), 'blocker')
  f.work.deleteWeeklyRecord(f.manager, row.id, { version: row.version, reason: '历史重复安排' })
  const task = f.store.update<Task>('tasks', f.task.id, f.task.version, { status: 'blocked', blockerReason: '' })
  assert.ok(f.work.cancelTask(f.manager, task.id, { version: task.version, reason: '历史重复任务' }).cancellation)
})

test('only server import context can preserve missing terminal evidence', t => {
  const f = fixture(t)
  f.rejected(() => f.work.updateTask(f.member, f.task.id, { version: f.task.version, status: 'done', importSource: imported, authority: 'trusted-import', context: { authority: 'restore' } }), 'completionNote')
  const task = withSilentImport(f.store, () => f.work.updateTask(f.member, f.task.id, { version: f.task.version, status: 'done' }))
  const row = withSilentImport(f.store, () => f.work.updateWeeklyRecord(f.member, f.record.id, { version: f.record.version, status: 'blocked' }))
  assert.equal(task.completionNote, undefined)
  assert.equal(row.blocker, '')
  f.rejected(() => f.work.updateTask(f.member, task.id, { version: task.version, status: 'done' }), 'completionNote')
  f.rejected(() => f.work.updateWeeklyRecord(f.member, row.id, { version: row.version, status: 'blocked' }), 'blocker')
})

test('normalized context evidence is saved and reused by core validation', t => {
  const f = fixture(t, true)
  const result = withCollaborationMutation(f.store, { actor: f.member, mutationId: 'context-completion', now: new Date(), source: 'progress', input: { completionNote: '  进展面板确认已交付  ' } }, () => f.work.updateTask(f.member, f.task.id, { version: f.task.version, status: 'done' }))
  assert.equal(result.value.completionNote, '进展面板确认已交付')
  assert.equal(result.value.waitingForFeedback, false)
})

test('formal whole-week submission requires missing blocker details and rolls back snapshots', t => {
  const f = fixture(t)
  let now = new Date('2026-09-06T07:00:00Z')
  const weekly = new WeeklySubmissionService(f.store, () => now)
  weekly.getRule()
  now = new Date('2026-09-18T07:00:00Z')
  const current = f.store.get<WeeklyRecord>('weeklyRecords', f.record.id)!
  const row = f.store.update<WeeklyRecord>('weeklyRecords', current.id, current.version, { status: 'blocked', blocker: '等待资料', actualOutcome: '已完成一半', submitted: true, importSource: imported })
  const duty = weekly.view(f.member, '2026-09-14').duties.find(row => row.kind === 'results')!
  f.rejected(() => weekly.submit(f.member, { dutyId: duty.id, version: duty.version, manifest: duty.manifest, requestId: 'whole-week-validation', draftAction: 'include' }), 'blockerImpact')
  assert.equal(f.store.get<WeeklyRecord>('weeklyRecords', row.id)?.version, row.version)
})

for (const enabled of [false, true]) test(`weekly creation validates terminal states and rolls back a combined assignment: collaboration=${enabled}`, t => {
  const f = fixture(t, enabled)
  const create = (patch: Record<string, unknown>) => f.work.createWeeklyRecord(f.member, { taskId: f.task.id, weekStart: '2026-09-21', commitment: '继续验证', ...patch })
  f.rejected(() => create({ status: 'done', actualOutcome: '  ' }), 'actualOutcome')
  f.rejected(() => create({ status: 'not_done' }), 'blocker')
  f.rejected(() => create({ status: 'blocked', submitted: true, blocker: '等待资料' }), 'blockerImpact')
  f.rejected(() => f.work.createWeeklyAssignment(f.member, {
    requestId: 'invalid-assignment-evidence', task: { title: '新增任务', isTemporary: true, temporaryReason: '临时支持', dueDate: '' },
    record: { weekStart: '2026-09-21', commitment: '验证', status: 'done' },
  }), 'actualOutcome')
  assert.equal(f.store.list('weeklyAssignmentRequests').length, 0)
  const notDone = create({ status: 'not_done', blocker: '本周未排到，移至下周' })
  assert.equal(notDone.submitted, false)
  assert.equal(notDone.blockerImpact, undefined)
})

test('explicit whole-task completion repairs historical missing evidence while retaining both version checks', t => {
  const f = fixture(t)
  const oldTask = f.store.update<Task>('tasks', f.task.id, f.task.version, { status: 'done', completionNote: '', waitingForFeedback: true, importSource: imported })
  const input = { version: f.record.version, status: 'done', actualOutcome: '负责人重新确认全部已验收', completeTask: true, taskVersion: oldTask.version }
  const before = f.snapshot()
  assert.throws(() => f.work.updateWeeklyRecord(f.member, f.record.id, { ...input, taskVersion: f.task.version }), { status: 409 })
  assert.equal(f.snapshot(), before)
  const row = f.work.updateWeeklyRecord(f.member, f.record.id, input)
  const task = f.store.get<Task>('tasks', f.task.id)!
  assert.equal(task.version, oldTask.version + 1)
  assert.equal(task.completionNote, row.actualOutcome)
  assert.equal(task.waitingForFeedback, false)
})

test('normalized fields combine with stored evidence and explicit empty replacement cannot bypass the rule', t => {
  const f = fixture(t)
  const task = f.work.updateTask(f.member, f.task.id, { version: f.task.version, ...blockers, completionNote: '历史有效说明' })
  const blocked = f.work.updateTask(f.member, task.id, { version: task.version, status: 'blocked' })
  f.rejected(() => f.work.updateTask(f.member, blocked.id, { version: blocked.version, supportNeeded: ' ' }), 'supportNeeded')
  const done = f.work.updateTask(f.member, blocked.id, { version: blocked.version, status: 'done' })
  assert.equal(done.completionNote, '历史有效说明')
  const row = f.work.updateWeeklyRecord(f.member, f.record.id, { version: f.record.version, actualOutcome: '已完成该周阶段' })
  const completed = f.work.updateWeeklyRecord(f.member, row.id, { version: row.version, status: 'done' })
  assert.equal(completed.actualOutcome, row.actualOutcome)
  f.rejected(() => f.work.updateWeeklyRecord(f.member, completed.id, { version: completed.version, actualOutcome: ' ' }), 'actualOutcome')
})

test('HTTP task and weekly failures expose actionable field errors without changing business facts', async t => {
  const store = new Store(':memory:'), server = createApp({ store }).listen(0, '127.0.0.1')
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close() })
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let cookie = ''
  const request = async (path: string, body: unknown, method = 'POST') => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0]
    return { status: response.status, body: await response.json() }
  }
  assert.equal((await request('/auth/setup', { name: '验证负责人', email: 'work-validation@example.test', password: 'Preview-only-2026!' })).status, 201)
  const task = (await request('/tasks', { title: '普通临时任务', dueDate: '', isTemporary: true, temporaryReason: '专项支持' })).body as Task
  const row = (await request('/weekly-records', { taskId: task.id, weekStart: '2026-09-14', commitment: '本周处理' })).body as WeeklyRecord
  const snapshot = () => JSON.stringify(['tasks', 'weeklyRecords', 'events', 'notifications', 'progressEvents', 'businessNotificationEvents'].map(key => store.list(key)))
  const before = snapshot()
  for (const [path, body, field] of [
    [`/tasks/${task.id}`, { version: task.version, status: 'done', completionNote: '  ', context: { authority: 'restore' } }, 'completionNote'],
    [`/tasks/${task.id}`, { version: task.version, status: 'blocked', blockerReason: '等待材料' }, 'blockerImpact'],
    [`/weekly-records/${row.id}`, { version: row.version, status: 'done' }, 'actualOutcome'],
    [`/weekly-records/${row.id}`, { version: row.version, status: 'blocked' }, 'blocker'],
  ] as const) {
    const response = await request(path, body, 'PATCH')
    assert.equal(response.status, 400)
    assert.equal(response.body.code, 'WORK_VALIDATION_FAILED')
    assert.ok(response.body.fieldErrors[field])
    assert.equal(snapshot(), before)
  }
})
