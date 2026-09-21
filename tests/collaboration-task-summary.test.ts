import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Task, User, WeeklyRecord } from '../shared/types.ts'
import type { CollaborationTaskStatusSummary, CollaborationTaskView } from '../shared/collaboration.ts'
import { summarizeCollaborationTask } from '../shared/collaboration-task-summary.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import { shanghaiDate, shiftDay, weekOf } from '../server/collaboration-calendar.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { Store } from '../server/store.ts'
import type { DingTalkClient } from '../server/dingtalk.ts'

const entity = { version: 1, createdAt: '2025-01-01T00:00:00Z', updatedAt: '2025-01-01T00:00:00Z' }
const owner = { id: 'owner', role: 'member' as const }
const manager = { id: 'manager', role: 'manager' as const }
const peer = { id: 'peer', role: 'member' as const }
const now = new Date('2026-01-01T01:00:00Z')
const currentWeek = '2025-12-29'
function task(patch: Partial<Task> = {}): Task {
  return { ...entity, id: 'task', title: '跨周事项', ownerId: owner.id, monthlyPlanId: null, description: '', dueDate: '2026-12-31', status: 'todo', isTemporary: true, temporaryReason: '测试', ...patch }
}
function weekly(id: string, weekStart: string, patch: Partial<WeeklyRecord> = {}): WeeklyRecord {
  return { ...entity, id, taskId: 'task', ownerId: owner.id, monthlyPlanId: null, weekStart, commitment: '本周推进', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'planned', submitted: true, ...patch }
}

test('current-week summary remains separate from overall task status and ignores future records', () => {
  const overall = task()
  const records = [
    weekly('old', '2025-12-22', { status: 'doing', actualOutcome: '旧周成果' }),
    weekly('current', currentWeek, { status: 'done', actualOutcome: '当前阶段已完成' }),
    weekly('future', '2026-01-05', { status: 'planned', actualOutcome: '未来文本' }),
  ]
  const before = JSON.stringify({ overall, records })
  assert.deepEqual(summarizeCollaborationTask(overall, records, manager, now), {
    weeklySummary: { recordId: 'current', weekStart: currentWeek, status: 'done', actualOutcome: '当前阶段已完成', submitted: true, isCurrentWeek: true, isImported: false },
    overallStatusNeedsConfirmation: true,
  })
  assert.equal(JSON.stringify({ overall, records }), before)
  assert.equal(overall.status, 'todo')
})

test('without a current week, the latest past week supplies context and future-only tasks have none', () => {
  const records = [weekly('older', '2025-12-15', { status: 'done' }), weekly('latest', '2025-12-22', { status: 'doing' }), weekly('future', '2026-01-05', { status: 'done' })]
  const summary = summarizeCollaborationTask(task(), records, owner, now)
  assert.equal(summary.weeklySummary?.recordId, 'latest')
  assert.equal(summary.weeklySummary?.isCurrentWeek, false)
  assert.equal(summary.overallStatusNeedsConfirmation, false)
  for (const rows of [[], [records[2]]]) {
    assert.deepEqual(summarizeCollaborationTask(task(), rows, owner, now), { weeklySummary: null, overallStatusNeedsConfirmation: false })
  }
})

test('an explicit current-week plan supersedes a previous completed stage without prompting overall completion', () => {
  const summary = summarizeCollaborationTask(task(), [weekly('previous-stage', '2025-12-22', { status: 'done' }), weekly('new-stage', currentWeek)], manager, now)
  assert.equal(summary.weeklySummary?.status, 'planned')
  assert.equal(summary.weeklySummary?.recordId, 'new-stage')
  assert.equal(summary.overallStatusNeedsConfirmation, false)
})

test('owner sees own draft while manager sees only a submitted member record and peers see nothing', () => {
  const records = [
    weekly('official', '2025-12-22', { status: 'done', actualOutcome: '公开成果' }),
    weekly('private-draft', currentWeek, { status: 'doing', actualOutcome: '尚未确认的私有草稿', submitted: false }),
    weekly('wrong-owner', currentWeek, { ownerId: 'someone-else', updatedAt: '2099-01-01T00:00:00Z' }),
    weekly('wrong-task', currentWeek, { taskId: 'another-task', updatedAt: '2099-01-01T00:00:00Z' }),
  ]
  assert.equal(summarizeCollaborationTask(task(), records, owner, now).weeklySummary?.recordId, 'private-draft')
  const managerSummary = summarizeCollaborationTask(task(), records, manager, now)
  assert.equal(managerSummary.weeklySummary?.recordId, 'official')
  assert.equal(managerSummary.overallStatusNeedsConfirmation, true)
  assert.ok(!JSON.stringify(managerSummary).includes('私有草稿'))
  assert.deepEqual(summarizeCollaborationTask(task(), records, peer, now), { weeklySummary: null, overallStatusNeedsConfirmation: false })
  assert.equal(summarizeCollaborationTask(task({ ownerId: manager.id }), [weekly('own-draft', currentWeek, { ownerId: manager.id, submitted: false })], manager, now).weeklySummary?.recordId, 'own-draft')
})

test('ties within one week select latest update then version without mutating input order', () => {
  const records = [
    weekly('first', currentWeek, { version: 9, updatedAt: '2025-12-29T00:00:00Z' }),
    weekly('updated', currentWeek, { version: 1, updatedAt: '2025-12-30T00:00:00Z' }),
    weekly('latest-version', currentWeek, { version: 2, updatedAt: '2025-12-30T00:00:00Z' }),
  ]
  const before = JSON.stringify(records)
  assert.equal(summarizeCollaborationTask(task(), records, owner, now).weeklySummary?.recordId, 'latest-version')
  assert.equal(JSON.stringify(records), before)
})

test('Beijing Sunday-to-Monday boundary matches the existing collaboration calendar', () => {
  const records = [weekly('last-week', '2025-12-29', { status: 'done' }), weekly('next-week', '2026-01-05')]
  const sunday = new Date('2026-01-04T15:59:59Z'), monday = new Date('2026-01-04T16:00:00Z')
  assert.equal(weekOf(shanghaiDate(sunday)), '2025-12-29')
  assert.equal(weekOf(shanghaiDate(monday)), '2026-01-05')
  assert.equal(summarizeCollaborationTask(task(), records, owner, sunday).weeklySummary?.recordId, 'last-week')
  assert.equal(summarizeCollaborationTask(task(), records, owner, monday).weeklySummary?.recordId, 'next-week')
})

test('overall completion suppresses the confirmation prompt without rewriting the weekly summary', () => {
  const records = [weekly('done-week', currentWeek, { status: 'done' })]
  assert.equal(summarizeCollaborationTask(task({ status: 'done' }), records, owner, now).overallStatusNeedsConfirmation, false)
  assert.equal(summarizeCollaborationTask(task({ status: 'blocked' }), records, owner, now).overallStatusNeedsConfirmation, true)
})

test('historical imported completion is identified without attributing it to a member self-report', () => {
  const record = weekly('imported', currentWeek, { status: 'done', importSource: { batchId: 'batch', sourceId: 'source', rowId: 'row', sourceStatus: '已完成' } })
  const summary = summarizeCollaborationTask(task(), [record], manager, now)
  assert.equal(summary.weeklySummary?.isImported, true)
  assert.equal(summary.weeklySummary?.status, 'done')
  assert.equal(summary.overallStatusNeedsConfirmation, true)
})

test('taskView uses current role and clock, keeps reads inert, and preserves peer denial', () => {
  const store = new Store(':memory:')
  try {
    for (const actor of [owner, manager, peer]) store.restoreEntity<User>('users', { ...entity, ...actor, name: actor.id, email: `${actor.id}@summary.test`, position: '', active: true })
    store.restoreEntity('tasks', task())
    store.restoreEntity('weeklyRecords', weekly('submitted', '2025-12-22', { status: 'done', actualOutcome: '已交付' }))
    store.restoreEntity('weeklyRecords', weekly('draft', currentWeek, { submitted: false, actualOutcome: '待确认文字' }))
    const service = new CollaborationService(store, () => now)
    const snapshot = () => ['tasks', 'weeklyRecords', 'events', 'progressEvents', 'taskTrackings', 'businessNotificationEvents', 'notifications'].map(collection => store.list(collection))
    const before = snapshot()
    const member = store.get<User>('users', owner.id)!, admin = store.get<User>('users', manager.id)!
    assert.equal(service.taskView(member, 'task').weeklySummary?.recordId, 'draft')
    assert.equal(service.taskView(admin, 'task').weeklySummary?.recordId, 'submitted')
    assert.equal(service.taskView(admin, 'task').overallStatusNeedsConfirmation, true)
    assert.throws(() => service.taskView(store.get<User>('users', peer.id)!, 'task'), { status: 404 })
    // A caller's stale role must not grant access after the stored role changes.
    store.update<User>('users', admin.id, admin.version, { role: 'member' })
    assert.throws(() => service.taskView(admin, 'task'), { status: 404 })
    assert.deepEqual(snapshot(), before)
  } finally { store.close() }
})

test('HTTP list and detail expose the same permitted weekly summary without changing list scope or data', async t => {
  const store = new Store(':memory:')
  const actor = (id: string, role: StoredUser['role']) => store.insert<StoredUser>('users', { id, role, name: id, email: `${id}@summary-http.test`, position: '', active: true, credentialVersion: 1, passwordHash: 'unused' })
  const admin = actor(manager.id, 'manager'), member = actor(owner.id, 'member'), outsider = actor(peer.id, 'member')
  const dates = weekOf(shanghaiDate(new Date()))
  store.restoreEntity('tasks', task())
  store.restoreEntity('tasks', task({ id: 'old-finished', status: 'done', ownerId: outsider.id, dueDate: '2020-01-01' }))
  store.restoreEntity('weeklyRecords', weekly('submitted-past', shiftDay(dates, -7), { status: 'done', actualOutcome: '最近正式阶段成果' }))
  store.restoreEntity('weeklyRecords', weekly('draft-now', dates, { submitted: false, actualOutcome: '本人尚未发布的草稿' }))
  store.restoreEntity('weeklyRecords', weekly('future', shiftDay(dates, 7), { status: 'done', actualOutcome: '未来不能覆盖' }))
  const provider: DingTalkClient = { configured: false, corpId: '', clientId: '', async getIdentity() { throw new Error('No external I/O') }, async send() { throw new Error('No external I/O') }, async result() { throw new Error('No external I/O') } }
  const server = createApp({ store, enableScheduler: false, dingtalkClient: provider }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close() })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const client = (user: StoredUser) => {
    const cookie = `lab_session=${createSession(store, user)}`
    return async <T>(path: string, status = 200) => {
      const response = await fetch(base + path, { headers: { cookie } })
      assert.equal(response.status, status)
      return await response.json() as T
    }
  }
  const asAdmin = client(admin), asOwner = client(member), asPeer = client(outsider)
  type Dashboard = { tasks: (CollaborationTaskStatusSummary & { task: Task })[] }
  const snapshot = () => ['tasks', 'weeklyRecords', 'events', 'progressEvents', 'taskTrackings', 'businessNotificationEvents', 'notifications'].map(collection => store.list(collection))
  const before = snapshot()
  const adminRows = (await asAdmin<Dashboard>('/collaboration')).tasks
  assert.deepEqual(adminRows.map(row => row.task.id).sort(), ['old-finished', 'task'])
  const adminTask = adminRows.find(row => row.task.id === 'task')!
  assert.equal(adminTask.weeklySummary?.recordId, 'submitted-past')
  assert.equal(adminTask.overallStatusNeedsConfirmation, true)
  assert.ok(!JSON.stringify(adminRows).includes('本人尚未发布的草稿'))
  const adminDetail = await asAdmin<CollaborationTaskView>('/collaboration/tasks/task')
  assert.deepEqual(adminDetail.weeklySummary, adminTask.weeklySummary)
  assert.equal(adminDetail.overallStatusNeedsConfirmation, adminTask.overallStatusNeedsConfirmation)
  const ownerRows = (await asOwner<Dashboard>('/collaboration')).tasks
  assert.deepEqual(ownerRows.map(row => row.task.id), ['task'])
  assert.equal(ownerRows[0].weeklySummary?.recordId, 'draft-now')
  assert.equal(ownerRows[0].weeklySummary?.submitted, false)
  assert.deepEqual((await asOwner<CollaborationTaskView>('/collaboration/tasks/task')).weeklySummary, ownerRows[0].weeklySummary)
  assert.deepEqual((await asPeer<Dashboard>('/collaboration')).tasks.map(row => row.task.id), ['old-finished'])
  await asPeer('/collaboration/tasks/task', 404)
  assert.deepEqual(snapshot(), before)
})
