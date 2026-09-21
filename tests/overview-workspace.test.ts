import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkspace, filterWorkRows, summarizeWorkRows } from '../src/overview-workspace-data.ts'
import type { Bootstrap, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'

const entity = { version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }
const user = (id: string, patch: Partial<User> = {}): User => ({ ...entity, id, name: id, email: `${id}@test.example`, role: 'member', position: '开发', active: true, ...patch })
const manager = user('manager', { role: 'manager' })
const member = user('member')
const plan = (id: string, patch: Partial<MonthlyPlan> = {}): MonthlyPlan => ({ ...entity, id, title: id, month: '2026-09', ownerId: member.id, collaboratorIds: [], projectId: null, category: '研发', expectedOutcome: '', acceptanceCriteria: '', dueDate: '2026-09-30', priority: 'medium', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', ...patch })
const task = (id: string, patch: Partial<Task> = {}): Task => ({ ...entity, id, title: id, ownerId: member.id, monthlyPlanId: 'september', description: '', dueDate: '2026-09-30', status: 'todo', isTemporary: false, temporaryReason: '', ...patch })
const record = (id: string, patch: Partial<WeeklyRecord> = {}): WeeklyRecord => ({ ...entity, id, taskId: 'task', ownerId: member.id, monthlyPlanId: 'september', weekStart: '2026-09-07', commitment: id, actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'planned', submitted: true, ...patch })
const base = (): Bootstrap => ({ user: manager, users: [manager, member], projects: [], plans: [plan('september')], tasks: [], weeklyRecords: [], annualGoals: [], publications: [], reports: [], aiConfigured: false })
const all = (data: Bootstrap) => buildWorkspace(data, { period: 'all', date: '2026-09-17' }, '2026-09-17')

test('one task across weeks is counted once; latest draft remains distinct from official completion', () => {
  const data = base()
  data.tasks = [task('task', { dueDate: '2026-09-16', status: 'done' }), task('task', { dueDate: '2026-09-16', status: 'done' })]
  data.weeklyRecords = [
    record('old', { status: 'done', actualOutcome: '已完成' }),
    record('new', { weekStart: '2026-09-14', status: 'done', submitted: false }),
    record('new', { weekStart: '2026-09-14', status: 'done', submitted: false }),
  ]
  const view = all(data)
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].status, 'draft')
  assert.equal(view.rows[0].records.length, 2)
  assert.equal(view.rows[0].record?.id, 'new')
  assert.equal(view.rows[0].taskStatus, 'done')
  assert.equal(view.rows[0].overdue, true)
  assert.deepEqual(summarizeWorkRows(view.rows), { total: 1, planned: 0, done: 0, doing: 0, blocked: 0, notDone: 0, drafts: 1, unscheduled: 0, overdue: 1, officialCount: 1, draftCount: 1 })
})

test('manager workspace defaults to usable accounts and explicitly includes represented inactive history', () => {
  const data = base()
  data.users.push(user('empty'), user('former', { active: false }), user('inactive', { active: false }), user('pending', { active: false, registrationStatus: 'pending' }), user('rejected-active', { registrationStatus: 'rejected' }))
  data.tasks = [task('former-task', { ownerId: 'former' }), task('pending-task', { ownerId: 'pending' }), task('rejected-task', { ownerId: 'rejected-active' })]
  const original = JSON.stringify(data)
  assert.deepEqual(all(data).members.map(row => row.id).sort(), ['empty', 'manager', 'member'])
  assert.deepEqual(all(data).rows, [])
  const historical = buildWorkspace(data, { period: 'all', date: '2026-09-17', includeInactive: true }, '2026-09-17')
  assert.deepEqual(historical.members.map(row => row.id).sort(), ['empty', 'former', 'manager', 'member'])
  assert.deepEqual(historical.rows.map(row => row.id), ['former-task'])
  assert.equal(summarizeWorkRows(historical.rows).total, 1)
  assert.equal(JSON.stringify(data), original, 'filtering never rewrites historical data')
  data.users.find(user => user.id === 'former')!.active = true
  assert.equal(all(data).rows.length, 1, 'reenabled member returns without rewriting the task')
})

test('member workspace never exposes peer rows or names even when a broad payload is supplied', () => {
  const data = base()
  data.user = member
  data.users.push(user('peer'))
  data.tasks = [task('own'), task('peer-secret', { ownerId: 'peer' })]
  data.weeklyRecords = [record('peer-note', { taskId: 'peer-secret', ownerId: 'peer' }), record('own-note', { taskId: 'own' })]
  const view = all(data)
  assert.deepEqual(view.rows.map(row => row.taskId), ['own'])
  assert.deepEqual(view.members.map(row => row.id), ['member'])
  assert.ok(!JSON.stringify(view).includes('peer-secret'))
})

test('same-named members and tasks remain separate identities under owner filters', () => {
  const data = base()
  data.users = [manager, user('person-a', { name: '张伟' }), user('person-b', { name: '张伟' })]
  data.tasks = [task('task-a', { title: '模型验证', ownerId: 'person-a' }), task('task-b', { title: '模型验证', ownerId: 'person-b' })]
  data.weeklyRecords = [record('work-a', { taskId: 'task-a', ownerId: 'person-a' }), record('work-b', { taskId: 'task-b', ownerId: 'person-b' })]
  const view = all(data)
  assert.equal(view.rows.length, 2)
  assert.equal(view.members.filter(row => row.name === '张伟').length, 2)
  assert.equal(filterWorkRows(view.rows, { query: '张伟' }).length, 2)
  assert.deepEqual(filterWorkRows(view.rows, { ownerId: 'person-b' }).map(row => row.id), ['task-b'])
})

test('missing historical account identities retain their work in the member matrix', () => {
  const data = base()
  data.tasks = [task('lost-owner-task', { ownerId: 'missing-owner' })]
  data.weeklyRecords = [record('lost-owner-work', { taskId: 'lost-task', ownerId: 'another-missing-owner' })]
  assert.equal(all(data).rows.length, 0)
  const { rows, members } = buildWorkspace(data, { period: 'all', date: '2026-09-17', includeInactive: true }, '2026-09-17')
  assert.equal(rows.length, 2)
  assert.ok(rows.every(row => members.some(person => person.id === row.ownerId)))
  const historical = members.filter(person => person.id.includes('missing-owner'))
  assert.equal(historical.length, 2)
  assert.ok(historical.every(person => !person.active && person.name === '历史成员' && person.email === ''))
  assert.equal(data.users.length, 2)
  data.user = member
  assert.ok(all(data).members.every(person => person.id === member.id))
  assert.equal(all(data).rows.length, 0)
})

test('historical month and project follow the record link after the task is relinked', () => {
  const data = base()
  data.plans = [plan('september', { projectId: 'old-project' }), plan('october', { month: '2026-10', projectId: 'new-project' })]
  data.projects = ['old-project', 'new-project'].map(id => ({ ...entity, id, name: id, code: id, description: '', ownerId: manager.id, status: 'active' }))
  data.tasks = [task('task', { monthlyPlanId: 'october', dueDate: '2026-10-30' })]
  data.weeklyRecords = [record('old', { weekStart: '2026-09-28' }), record('new', { weekStart: '2026-10-05', monthlyPlanId: 'october', status: 'doing' })]
  const september = buildWorkspace(data, { period: 'month', date: '2026-09' }, '2026-10-10')
  const october = buildWorkspace(data, { period: 'month', date: '2026-10' }, '2026-10-10')
  assert.equal(september.rows[0].planId, 'september')
  assert.equal(september.rows[0].projectId, 'old-project')
  assert.deepEqual(september.rows[0].records.map(row => row.id), ['old'])
  assert.equal(october.rows[0].planId, 'october')
  assert.deepEqual(october.rows[0].records.map(row => row.id), ['new'])
  data.weeklyRecords[0].monthlyPlanId = null
  const temporary = buildWorkspace(data, { period: 'month', date: '2026-09' }, '2026-10-10').rows[0]
  assert.equal(temporary.planId, null)
  assert.equal(temporary.isTemporary, true)
})

test('week includes due tasks and missing task references; task status cannot imply weekly completion', () => {
  const data = base()
  data.tasks = [task('due', { dueDate: '2026-09-16', status: 'done' }), task('later'), task('unknown-date', { dueDate: '' })]
  data.weeklyRecords = [record('orphan', { taskId: 'missing-task', weekStart: '2026-09-14', status: 'blocked', blocker: '待权限' })]
  const view = buildWorkspace(data, { period: 'week', date: '2026-09-17' }, '2026-09-17')
  assert.equal(view.startDate, '2026-09-14')
  assert.equal(view.endDate, '2026-09-20')
  assert.deepEqual(view.rows.map(row => row.taskId), ['due', 'missing-task'])
  assert.equal(view.rows[0].status, 'unscheduled')
  assert.equal(view.rows[0].taskStatus, 'done')
  assert.equal(view.rows[0].overdue, false)
  assert.equal(view.rows[1].task, undefined)
  assert.equal(view.rows[1].title, 'orphan')
  assert.equal(view.rows[1].overdue, false)
  assert.equal(all(data).rows.find(row => row.taskId === 'unknown-date')?.overdue, false)
})

test('a completed task with only previous-week records is not overdue when the selected week has no record', () => {
  const data = base()
  data.tasks = [task('finished', { dueDate: '2026-09-16', status: 'done' })]
  data.weeklyRecords = [record('finished-last-week', { taskId: 'finished', weekStart: '2026-09-07', status: 'done', actualOutcome: '已交付' })]
  const { rows } = buildWorkspace(data, { period: 'week', date: '2026-09-17' }, '2026-09-17')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'unscheduled')
  assert.equal(rows[0].records.length, 0)
  assert.equal(rows[0].taskStatus, 'done')
  assert.equal(rows[0].overdue, false)
  assert.equal(summarizeWorkRows(rows).overdue, 0)
  assert.equal(filterWorkRows(rows, { riskOnly: true }).length, 0)
})

test('month includes unscheduled goal work and due temporary work while a boundary week retains its goal month', () => {
  const data = base()
  data.plans.push(plan('august', { month: '2026-08' }))
  data.tasks = [task('goal-work', { dueDate: '2026-10-02' }), task('temporary', { monthlyPlanId: null, isTemporary: true, dueDate: '2026-09-20' }), task('old-task', { monthlyPlanId: 'august', dueDate: '2026-08-31' })]
  data.weeklyRecords = [record('old-work', { taskId: 'old-task', monthlyPlanId: 'august', weekStart: '2026-08-31' })]
  const view = buildWorkspace(data, { period: 'month', date: '2026-09' }, '2026-09-17')
  assert.equal(view.startDate, '2026-09-01')
  assert.equal(view.endDate, '2026-09-30')
  assert.deepEqual(view.rows.map(row => row.taskId), ['goal-work', 'temporary'])
  assert.ok(view.rows.every(row => row.status === 'unscheduled'))
  assert.equal(view.rows[1].isTemporary, true)
  assert.throws(() => buildWorkspace(data, { period: 'month', date: '2026-13' }), /Invalid calendar date/)
})

test('task states are exclusive, overdue uses a valid elapsed date, filters match shared row facts', () => {
  const data = base()
  data.tasks = [task('done', { dueDate: '2026-09-01' }), task('blocked', { dueDate: '2026-09-17' }), task('notdone', { dueDate: '2026-09-16' }), task('draft', { dueDate: '2026-09-31' })]
  data.weeklyRecords = [record('done', { taskId: 'done', status: 'done' }), record('blocked', { taskId: 'blocked', status: 'blocked', blocker: '等待GPU' }), record('notdone', { taskId: 'notdone', status: 'not_done' }), record('draft', { taskId: 'draft', status: 'blocked', submitted: false })]
  const { rows } = all(data)
  const summary = summarizeWorkRows(rows)
  assert.equal(summary.done + summary.planned + summary.doing + summary.blocked + summary.notDone + summary.drafts + summary.unscheduled, summary.total)
  assert.equal(summary.overdue, 1)
  assert.deepEqual(filterWorkRows(rows, { riskOnly: true }).map(row => row.id), ['blocked', 'notdone'])
  assert.deepEqual(filterWorkRows(rows, { query: ' gpu ', ownerId: member.id, status: 'blocked', projectId: 'none' }).map(row => row.id), ['blocked'])
  assert.equal(filterWorkRows(rows, { ownerId: 'nobody' }).length, 0)
  assert.equal(filterWorkRows(rows, { projectId: 'missing' }).length, 0)
  assert.deepEqual(filterWorkRows(rows, { status: 'overdue', projectId: '__none__' }).map(row => row.id), ['notdone'])
  assert.equal(filterWorkRows(rows, { status: '', ownerId: '', projectId: '' }).length, 4)
})
