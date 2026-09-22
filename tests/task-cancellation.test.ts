import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { createApp } from '../server/app.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { buildWorkspace, summarizeWorkRows } from '../src/overview-workspace-data.ts'
import type { AuditEvent, Bootstrap, Entity, Task, User, WeeklyRecord } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store)
  t.after(() => store.close())
  const user = (id: string, role: User['role'] = 'member') => store.insert<User>('users', {
    id, name: id, email: `${id}@task-cancel.test`, role, active: true, position: '',
  })
  const manager = user('manager', 'manager'), member = user('member'), peer = user('peer')
  const task = domain.createTask(member, { title: '原任务不再使用', isTemporary: true, temporaryReason: '待补月度关联', dueDate: '2026-09-25' })
  const record = (weekStart = '2026-09-21', submitted = true) => domain.createWeeklyRecord(member, {
    taskId: task.id, weekStart, commitment: '阶段工作', submitted,
  })
  return { store, domain, manager, member, peer, task, record }
}

test('task cancellation requires manager, fresh version and a nonempty reason; repeats do not write', t => {
  const f = fixture(t), input = { version: f.task.version, reason: '确认不再使用旧任务' }
  assert.throws(() => f.domain.cancelTask(f.member, f.task.id, input), { status: 403 })
  assert.throws(() => f.domain.cancelTask(f.peer, f.task.id, input), { status: 403 })
  for (const patch of [{ reason: '' }, { reason: '   ' }, { reason: null }]) {
    assert.throws(() => f.domain.cancelTask(f.manager, f.task.id, { ...input, ...patch }), { status: 400 })
  }
  for (const version of [undefined, 999, '1']) assert.throws(() => f.domain.cancelTask(f.manager, f.task.id, { ...input, version }), { status: 409 })
  const cancelled = f.domain.cancelTask(f.manager, f.task.id, input)
  assert.equal(isActiveTask(cancelled), false)
  assert.equal(cancelled.version, f.task.version + 1)
  assert.equal(cancelled.cancellation?.cancelledBy, f.manager.id)
  assert.equal(cancelled.cancellation?.reason, input.reason)
  assert.equal(new Date(cancelled.cancellation!.cancelledAt).toISOString(), cancelled.cancellation!.cancelledAt)
  assert.throws(() => f.domain.cancelTask(f.manager, f.task.id, { ...input, version: cancelled.version }), { status: 409 })
  assert.deepEqual(f.store.get('tasks', f.task.id), cancelled)
  const audits = f.store.list<AuditEvent>('events').filter(event => event.entityId === f.task.id && event.action === 'cancel')
  assert.equal(audits.length, 1)
  assert.deepEqual(audits[0].before, f.task)
  assert.deepEqual(audits[0].after, cancelled)
  assert.equal(audits[0].reason, input.reason)
})

test('any retained weekly arrangement blocks cancellation, including drafts, historical weeks and other owners', t => {
  const f = fixture(t)
  for (const [week, submitted] of [['2026-08-03', true], ['2026-09-21', false], ['2026-10-12', false]] as const) {
    const row = f.record(week, submitted)
    assert.throws(() => f.domain.cancelTask(f.manager, f.task.id, { version: f.task.version, reason: '已不用' }), { status: 409 })
    assert.deepEqual(f.store.get('tasks', f.task.id), f.task)
    f.domain.deleteWeeklyRecord(f.manager, row.id, { version: row.version, reason: '撤回该周安排' })
  }
  const inconsistent = f.record()
  const reassigned = f.store.update<WeeklyRecord>('weeklyRecords', inconsistent.id, inconsistent.version, { ownerId: f.peer.id })
  assert.throws(() => f.domain.cancelTask(f.manager, f.task.id, { version: f.task.version, reason: '已不用' }), { status: 409 })
  f.domain.deleteWeeklyRecord(f.manager, reassigned.id, { version: reassigned.version, reason: '修正旧资料' })
  assert.equal(isActiveTask(f.domain.cancelTask(f.manager, f.task.id, { version: f.task.version, reason: '整项任务已不用' })), false)
})

test('cancellation keeps task progress, deleted weekly history, receipts and frozen reports without claiming completion', t => {
  const f = fixture(t)
  const task = f.domain.updateTask(f.member, f.task.id, { version: f.task.version, status: 'doing', currentProgress: '已完成页面框架' })
  const row = f.record()
  const progress = f.store.list('progressEvents')
  const receipt = f.store.insert<Entity & { ownerId: string; records: WeeklyRecord[]; kind: string }>('weeklySubmissions', { ownerId: f.member.id, records: [row], kind: 'plan' })
  const report = f.store.insert<Entity & { title: string; snapshot: { tasks: Task[]; weeklyRecords: WeeklyRecord[] } }>('reports', { title: '历史快照', snapshot: { tasks: [task], weeklyRecords: [row] } })
  const deleted = f.domain.deleteWeeklyRecord(f.manager, row.id, { version: row.version, reason: '本周误排' })
  const cancelled = f.domain.cancelTask(f.manager, task.id, { version: task.version, reason: '旧任务已不再使用' })
  const { cancellation: _cancellation, version: _version, updatedAt: _updatedAt, ...preserved } = cancelled
  const { version: _beforeVersion, updatedAt: _beforeUpdatedAt, ...original } = task
  assert.deepEqual(preserved, original)
  assert.equal(cancelled.status, 'doing')
  assert.deepEqual(f.store.list('progressEvents'), progress)
  assert.deepEqual(f.store.get('weeklyRecords', deleted.id), deleted)
  assert.deepEqual(f.store.get('weeklySubmissions', receipt.id), receipt)
  assert.deepEqual(f.store.get('reports', report.id), report)
  assert.equal(f.domain.bootstrap(f.manager).tasks.some(item => item.id === task.id), false)
  assert.equal(f.domain.bootstrap(f.member).tasks.some(item => item.id === task.id), false)
  const archive = f.domain.bootstrap(f.member, false, true)
  assert.deepEqual(archive.tasks.find(item => item.id === task.id), cancelled)
  assert.deepEqual(archive.weeklyRecords.find(item => item.id === row.id), deleted)
  assert.equal(f.domain.bootstrap(f.peer, false, true).tasks.some(item => item.id === task.id), false)
})

test('audit persistence failure rolls back cancellation and collaboration closure together', t => {
  const f = fixture(t)
  f.store.insert<Entity & { taskId: string; ownerId: string; state: string }>('taskTrackings', { id: f.task.id, taskId: f.task.id, ownerId: f.member.id, state: 'active' })
  f.store.insert<Entity & { taskId: string; ownerId: string; status: string }>('followupRequests', { taskId: f.task.id, ownerId: f.member.id, status: 'open' })
  f.store.insert<Entity & { taskId: string; ownerId: string; status: string }>('deadlineChangeRequests', { taskId: f.task.id, ownerId: f.member.id, status: 'open' })
  const collections = ['tasks', 'taskTrackings', 'followupRequests', 'deadlineChangeRequests', 'events']
  const before = collections.map(collection => f.store.list(collection))
  const insert = f.store.insert.bind(f.store)
  f.store.insert = ((collection: string, row: never) => {
    if (collection === 'events') throw new Error('audit unavailable')
    return insert(collection, row)
  }) as typeof f.store.insert
  assert.throws(() => f.domain.cancelTask(f.manager, f.task.id, { version: f.task.version, reason: '取消不用的任务' }), /audit unavailable/)
  assert.deepEqual(collections.map(collection => f.store.list(collection)), before)
})

test('cancelled tasks cannot be edited, relinked, scheduled, or revived by assignment/capture retries', t => {
  const f = fixture(t)
  const assignment = { requestId: 'cancel_assignment_replay_001', taskId: f.task.id, record: { weekStart: '2026-09-21', commitment: '旧周安排', submitted: false } }
  const arranged = f.domain.createWeeklyAssignment(f.member, assignment)
  f.domain.deleteWeeklyRecord(f.manager, arranged.record.id, { version: arranged.record.version, reason: '撤销安排' })
  const cancelled = f.domain.cancelTask(f.manager, f.task.id, { version: f.task.version, reason: '确认不再使用' })
  assert.throws(() => f.domain.updateTask(f.member, f.task.id, { version: cancelled.version, status: 'done', cancellation: null }), { status: 409 })
  assert.throws(() => f.domain.updateTask(f.manager, f.task.id, { version: cancelled.version, currentProgress: '新进展' }), { status: 409 })
  assert.throws(() => f.domain.relinkTask(f.manager, f.task.id, { version: cancelled.version, monthlyPlanId: 'another', reason: '重关联' }), { status: 409 })
  assert.throws(() => f.record(), { status: 409 })
  assert.throws(() => f.domain.createWeeklyAssignment(f.member, assignment), { status: 409 })
  assert.throws(() => f.domain.createWeeklyAssignment(f.member, { ...assignment, requestId: 'cancel_assignment_new_001' }), { status: 409 })
  const capture = { requestId: 'cancel_capture_replay_001', titles: ['暂存事项'] }
  const captured = f.domain.captureTasks(f.member, capture).tasks[0]
  f.domain.cancelTask(f.manager, captured.id, { version: captured.version, reason: '收件事项已不用' })
  assert.throws(() => f.domain.captureTasks(f.member, capture), { status: 409 })
  assert.equal(f.store.list<Task>('tasks').length, 2)
  assert.deepEqual(f.store.get('tasks', f.task.id), cancelled)
})

test('bootstrap never resurrects cancelled tasks from inconsistent live records or old audit snapshots', t => {
  const f = fixture(t), row = f.record()
  const deleted = f.domain.deleteWeeklyRecord(f.manager, row.id, { version: row.version, reason: '先撤销安排' })
  const cancelled = f.domain.cancelTask(f.manager, f.task.id, { version: f.task.version, reason: '任务作废' })
  // Deliberately inconsistent legacy input must not bypass the live projection.
  const stale = f.store.update<WeeklyRecord>('weeklyRecords', row.id, deleted.version, { deletion: undefined })
  assert.throws(() => f.domain.updateWeeklyRecord(f.member, stale.id, { version: stale.version, actualOutcome: '不可更新' }), { status: 409 })
  for (const actor of [f.manager, f.member]) {
    assert.equal(f.domain.bootstrap(actor).tasks.length, 0)
    assert.equal(f.domain.bootstrap(actor).weeklyRecords.length, 0)
  }
  f.store.delete('tasks', f.task.id, cancelled.version)
  for (const actor of [f.manager, f.member]) {
    assert.equal(f.domain.bootstrap(actor).tasks.length, 0, 'latest cancellation snapshot wins over an earlier active snapshot')
    assert.equal(f.domain.bootstrap(actor).weeklyRecords.length, 0)
    assert.equal(f.domain.bootstrap(actor, false, true).tasks[0]?.cancellation?.reason, '任务作废')
  }
})

test('weekly deletion alone keeps a reusable task and cancellation does not rewrite completed status', t => {
  const f = fixture(t), row = f.record()
  f.domain.deleteWeeklyRecord(f.manager, row.id, { version: row.version, reason: '重新关联后排周' })
  assert.equal(f.domain.bootstrap(f.member).tasks.length, 1)
  assert.equal(isActiveTask(f.store.get<Task>('tasks', f.task.id)!), true)
  const replacement = f.record()
  assert.notEqual(replacement.id, row.id)
  f.domain.deleteWeeklyRecord(f.manager, replacement.id, { version: replacement.version, reason: '不再使用此安排' })
  const done = f.domain.updateTask(f.member, f.task.id, { version: f.task.version, status: 'done', completionNote: '保留原始完成证据' })
  const cancelled = f.domain.cancelTask(f.manager, f.task.id, { version: done.version, reason: '重复建项，不再纳入清单' })
  assert.equal(cancelled.status, 'done')
  assert.equal(cancelled.completionNote, '保留原始完成证据')
})

test('bootstrap to department totals removes only explicitly cancelled work in all, month and week views', t => {
  const f = fixture(t)
  const working = f.domain.updateTask(f.member, f.task.id, { version: f.task.version, status: 'doing', currentProgress: '已记录的独立进展' })
  const row = f.record()
  // Same title does not mean the same identity: a genuinely unscheduled task stays visible.
  const unscheduled = f.domain.createTask(f.member, { title: f.task.title, isTemporary: true, temporaryReason: '另一个独立工作项', dueDate: '2026-09-24' })
  f.domain.deleteWeeklyRecord(f.manager, row.id, { version: row.version, reason: '删除未关联月度目标的安排' })
  const deletedOnly = f.domain.bootstrap(f.manager)
  for (const period of ['all', 'month', 'week'] as const) {
    const view = buildWorkspace(deletedOnly, { period, date: '2026-09-22' }, '2026-09-22')
    assert.equal(summarizeWorkRows(view.rows).total, 2, 'deleting a schedule never silently cancels a task')
    assert.equal(view.rows.find(item => item.taskId === f.task.id)?.status, 'unscheduled')
  }
  f.domain.cancelTask(f.manager, working.id, { version: working.version, reason: '用户确认旧任务已不用' })
  for (const actor of [f.manager, f.member]) for (const period of ['all', 'month', 'week'] as const) {
    const data = f.domain.bootstrap(actor)
    const view = buildWorkspace(data, { period, date: '2026-09-22' }, '2026-09-22')
    assert.deepEqual(view.rows.map(item => item.taskId), [unscheduled.id])
    const summary = summarizeWorkRows(view.rows)
    assert.equal(summary.total, 1)
    assert.equal(summary.unscheduled, 1)
    assert.equal(summary.drafts, 0)
  }
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.currentProgress, '已记录的独立进展')
})

test('HTTP cancellation requires authentication and manager authority, and drops the task from normal bootstrap', async () => {
  const store = new Store(':memory:'), server = createApp({ store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let cookie = ''
  const request = async (path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const response = await fetch(`${origin}/api${path}`, { method, headers: { origin, cookie, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const session = response.headers.get('set-cookie')
    if (session) cookie = session.split(';')[0]
    return { status: response.status, data: await response.json() }
  }
  try {
    assert.equal((await request('/tasks/missing/cancel', { version: 1, reason: '作废' })).status, 401)
    assert.equal((await request('/auth/setup', { name: '管理员', email: 'cancel-admin@example.test', password: 'Preview-only-2026!' })).status, 201)
    const created = await request('/tasks', { title: '待作废事项', isTemporary: true, temporaryReason: '测试', dueDate: '2026-09-25' })
    assert.equal(created.status, 201)
    const task = created.data as Task
    assert.equal((await request('/users', { name: '成员', email: 'cancel-member@example.test', password: 'Preview-only-2026!', role: 'member', position: '' })).status, 201)
    await request('/auth/login', { email: 'cancel-member@example.test', password: 'Preview-only-2026!' })
    assert.equal((await request(`/tasks/${task.id}/cancel`, { version: task.version, reason: '无权作废' })).status, 403)
    assert.equal((await request('/auth/login', { email: 'cancel-admin@example.test', password: 'Preview-only-2026!' })).status, 200)
    const response = await request(`/tasks/${task.id}/cancel`, { version: task.version, reason: '已明确不再使用' })
    assert.equal(response.status, 200)
    assert.equal(response.data.cancellation.reason, '已明确不再使用')
    assert.equal(((await request('/bootstrap')).data as Bootstrap).tasks.some(item => item.id === task.id), false)
    assert.equal((await request(`/tasks/${task.id}`, { version: response.data.version, title: '复活' }, 'PATCH')).status, 409)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    store.close()
  }
})
