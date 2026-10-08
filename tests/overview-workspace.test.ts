import test from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkspace, filterWorkRows, isCarryoverTask, previewWorkRows, summarizeWorkRows } from '../src/overview-workspace-data.ts'
import type { Bootstrap, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import { workRegisterNeedsCompletionReview } from '../shared/work-register.ts'

const entity = { version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }
const user = (id: string, patch: Partial<User> = {}): User => ({ ...entity, id, name: id, email: `${id}@test.example`, role: 'member', position: '开发', active: true, ...patch })
const manager = user('manager', { role: 'manager' })
const member = user('member')
const plan = (id: string, patch: Partial<MonthlyPlan> = {}): MonthlyPlan => ({ ...entity, id, title: id, month: '2026-09', ownerId: member.id, collaboratorIds: [], projectId: null, category: '研发', expectedOutcome: '', acceptanceCriteria: '', dueDate: '2026-09-30', priority: 'medium', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', ...patch })
const task = (id: string, patch: Partial<Task> = {}): Task => ({ ...entity, id, title: id, ownerId: member.id, monthlyPlanId: 'september', description: '', dueDate: '2026-09-30', status: 'todo', isTemporary: false, temporaryReason: '', ...patch })
const record = (id: string, patch: Partial<WeeklyRecord> = {}): WeeklyRecord => ({ ...entity, id, taskId: 'task', ownerId: member.id, monthlyPlanId: 'september', weekStart: '2026-09-07', commitment: id, actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'planned', submitted: true, ...patch })
const base = (): Bootstrap => ({ user: manager, users: [manager, member], projects: [], plans: [plan('september')], tasks: [], weeklyRecords: [], annualGoals: [], publications: [], reports: [], aiConfigured: false })
const all = (data: Bootstrap) => buildWorkspace(data, { period: 'all', date: '2026-09-17' }, '2026-09-17')

test('explicitly cancelled work exits every overview period while deleted scheduling alone preserves the task', () => {
  const data = base()
  const deletion = { deletedAt: '2026-09-17T01:00:00Z', deletedBy: manager.id, reason: '关联错误' }
  const original = task('obsolete', { dueDate: '2026-09-16', status: 'doing', monthlyPlanId: null, isTemporary: true })
  const cancelled = { ...original, version: 2, cancellation: { cancelledAt: '2026-09-17T02:00:00Z', cancelledBy: manager.id, reason: '旧任务已不用' } }
  data.tasks = [original, task('keep', { dueDate: '2026-09-16', status: 'doing' })]
  data.weeklyRecords = [record('removed', { taskId: original.id, weekStart: '2026-09-14', deletion })]
  assert.equal(all(data).rows.find(row => row.taskId === original.id)?.status, 'doing', 'a deleted week never implicitly cancels or resets real work')
  data.tasks.push(cancelled)
  // A broad or cached payload must not revive a cancelled task from old record data.
  data.weeklyRecords.push(record('stale', { taskId: original.id, weekStart: '2026-09-14' }))
  const before = JSON.stringify(data)
  for (const period of ['all', 'month', 'week'] as const) {
    const { rows } = buildWorkspace(data, { period, date: '2026-09-17' }, '2026-09-17')
    assert.deepEqual(rows.map(row => row.taskId), ['keep'])
    const summary = summarizeWorkRows(rows)
    assert.equal(summary.total, 1)
    assert.equal(summary.unscheduled, period === 'all' ? 0 : 1)
    assert.equal(summary.doing, period === 'all' ? 1 : 0)
    assert.equal(summary.drafts, 0)
    assert.equal(summary.overdue, 1)
  }
  assert.equal(JSON.stringify(data), before, 'statistics preserve historical objects')
})

test('one task across weeks is counted once; whole-task completion survives later draft records', () => {
  const data = base()
  data.tasks = [task('task', { dueDate: '2026-09-16', status: 'done' }), task('task', { dueDate: '2026-09-16', status: 'done' })]
  data.weeklyRecords = [
    record('old', { status: 'done', actualOutcome: '已完成' }),
    record('new', { weekStart: '2026-09-14', status: 'done', submitted: false }),
    record('new', { weekStart: '2026-09-14', status: 'done', submitted: false }),
  ]
  const view = all(data)
  assert.equal(view.rows.length, 1)
  assert.equal(view.rows[0].status, 'done')
  assert.equal(view.rows[0].statusScope, 'task')
  assert.equal(view.rows[0].records.length, 2)
  assert.equal(view.rows[0].record?.id, 'old')
  assert.equal(view.rows[0].weeklyStatus, 'done')
  assert.equal(view.rows[0].taskStatus, 'done')
  assert.equal(view.rows[0].overdue, false)
  assert.deepEqual(summarizeWorkRows(view.rows), { total: 1, planned: 0, done: 1, doing: 0, blocked: 0, notDone: 0, drafts: 0, unscheduled: 0, unknown: 0, overdue: 0, officialCount: 1, draftCount: 1 })
  const dated = buildWorkspace(data, { period: 'month', date: '2026-09' }, '2026-09-17').rows[0]
  assert.equal(dated.status, 'draft', 'dated views retain the selected period latest draft')
  assert.equal(dated.statusScope, 'period')
  assert.equal(dated.record?.id, 'new')
  assert.equal(dated.overdue, false, 'a finished overall task is not overdue in a historical view')
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

test('relinked work retains temporary provenance and inherits priority from each record historical goal', () => {
  const data = base()
  data.plans = [plan('september', { priority: 'high' }), plan('october', { month: '2026-10', priority: 'low' })]
  // Relinking clears the domain flag but retains the original temporary reason.
  data.tasks = [task('task', { monthlyPlanId: 'october', dueDate: '2026-10-30', isTemporary: false, temporaryReason: '临时支持客户演示' })]
  data.weeklyRecords = [record('old', { weekStart: '2026-09-28' }), record('new', { weekStart: '2026-10-05', monthlyPlanId: 'october', status: 'doing' })]
  const rowFor = (month: string) => buildWorkspace(data, { period: 'month', date: month }, '2026-10-10').rows[0]
  const original = JSON.stringify(data)
  assert.equal(rowFor('2026-09').workKind, 'temporary')
  assert.equal(rowFor('2026-10').workKind, 'temporary')
  assert.equal(rowFor('2026-09').priority, 'high')
  assert.equal(rowFor('2026-10').priority, 'low')
  assert.equal(rowFor('2026-09').isTemporary, false, 'presentation does not rewrite the legacy business flag')
  assert.equal(rowFor('2026-10').isTemporary, false)
  assert.equal(JSON.stringify(data), original)

  data.tasks[0].priority = 'medium'
  assert.equal(rowFor('2026-09').priority, 'medium', 'explicit task priority overrides its historical goal')
  assert.equal(rowFor('2026-10').priority, 'medium', 'explicit task priority overrides its current goal')
  data.tasks[0].temporaryReason = '  '
  data.plans[0].isTemporary = true
  assert.equal(rowFor('2026-09').workKind, 'temporary', 'historical goal retains its own temporary source')
  assert.equal(rowFor('2026-10').workKind, 'monthly', 'whitespace is not a temporary reason')
})

test('member previews surface active risks and priority before completed work without changing full row order', () => {
  const data = base()
  data.tasks = [
    task('completed', { priority: 'high', status: 'done' }),
    task('routine', { priority: 'low' }),
    task('important', { priority: 'high' }),
    task('overdue', { priority: 'medium', dueDate: '2026-09-16' }),
    task('blocked', { priority: 'low' }),
    task('important-second', { priority: 'high' }),
  ]
  data.weeklyRecords = data.tasks.map(item => record(item.id, {
    taskId: item.id,
    status: item.id === 'completed' ? 'done' : item.id === 'blocked' ? 'blocked' : 'doing',
  }))
  const { rows } = all(data)
  const initialOrder = rows.map(row => row.id)
  const summary = summarizeWorkRows(rows)
  assert.deepEqual(previewWorkRows(rows).map(row => row.id), ['overdue', 'blocked', 'important'])
  assert.deepEqual(previewWorkRows(rows, 6).map(row => row.id), ['overdue', 'blocked', 'important', 'important-second', 'routine', 'completed'])
  assert.deepEqual(rows.map(row => row.id), initialOrder, 'full table and drill order remains intact')
  assert.deepEqual(summarizeWorkRows(rows), summary, 'preview selection does not alter counts')
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
  data.tasks = [task('done', { dueDate: '2026-09-01', status: 'done' }), task('blocked', { dueDate: '2026-09-17' }), task('notdone', { dueDate: '2026-09-16' }), task('draft', { dueDate: '2026-09-31' })]
  data.weeklyRecords = [record('done', { taskId: 'done', status: 'done' }), record('blocked', { taskId: 'blocked', status: 'blocked', blocker: '等待GPU' }), record('notdone', { taskId: 'notdone', status: 'not_done' }), record('draft', { taskId: 'draft', status: 'blocked', submitted: false })]
  const { rows } = all(data)
  const summary = summarizeWorkRows(rows)
  assert.equal(summary.done + summary.planned + summary.doing + summary.blocked + summary.notDone + summary.drafts + summary.unscheduled + summary.unknown, summary.total)
  assert.equal(summary.overdue, 1)
  assert.deepEqual(filterWorkRows(rows, { riskOnly: true }).map(row => row.id), ['blocked', 'notdone'])
  assert.deepEqual(filterWorkRows(rows, { query: ' gpu ', ownerId: member.id, status: 'blocked', projectId: 'none' }).map(row => row.id), ['blocked'])
  assert.equal(filterWorkRows(rows, { ownerId: 'nobody' }).length, 0)
  assert.equal(filterWorkRows(rows, { projectId: 'missing' }).length, 0)
  assert.deepEqual(filterWorkRows(rows, { status: 'overdue', projectId: '__none__' }).map(row => row.id), ['notdone'])
  assert.equal(filterWorkRows(rows, { status: '', ownerId: '', projectId: '' }).length, 4)
})

test('weekly stage completion does not finish an ongoing task or erase its overdue risk', () => {
  const data = base()
  data.tasks = [task('ongoing', { status: 'doing', dueDate: '2026-09-16' }), task('not-confirmed', { dueDate: '2026-09-16' })]
  data.weeklyRecords = data.tasks.map(item => record(`stage-${item.id}`, { taskId: item.id, weekStart: '2026-09-14', status: 'done', actualOutcome: '本周阶段完成，下周继续' }))
  const allRows = all(data).rows
  assert.deepEqual(allRows.map(row => row.status), ['doing', 'planned'])
  assert.ok(allRows.every(row => row.weeklyStatus === 'done' && row.weeklyWeekStart === '2026-09-14' && row.overdue))
  assert.equal(summarizeWorkRows(allRows).done, 0)
  for (const period of ['month', 'week'] as const) {
    const rows = buildWorkspace(data, { period, date: '2026-09-17' }, '2026-09-17').rows
    assert.ok(rows.every(row => row.status === 'done' && row.statusScope === 'period' && row.overdue))
    assert.equal(summarizeWorkRows(rows).done, 2, 'dated completion remains a weekly-stage fact')
  }
})

test('future plans and unapproved current edits cannot overwrite effective current execution', () => {
  const data = base()
  data.tasks = [task('risk'), task('working', { status: 'doing' }), task('overall-blocked', { status: 'blocked' }), task('future-only')]
  data.weeklyRecords = [
    record('risk-current', { taskId: 'risk', weekStart: '2026-09-14', status: 'not_done', blocker: '仍待交付' }),
    record('risk-next-week', { taskId: 'risk', weekStart: '2026-09-21', status: 'planned' }),
    record('working-current', { taskId: 'working', weekStart: '2026-09-14', status: 'planned' }),
    record('blocked-current', { taskId: 'overall-blocked', weekStart: '2026-09-14', status: 'planned' }),
    record('only-future', { taskId: 'future-only', weekStart: '2026-09-21', status: 'planned' }),
  ]
  let rows = all(data).rows
  assert.equal(rows.find(row => row.id === 'risk')?.status, 'not_done')
  assert.equal(rows.find(row => row.id === 'risk')?.record?.id, 'risk-current')
  assert.equal(rows.find(row => row.id === 'risk')?.officialCount, 2, 'future plans remain visible in record totals')
  assert.equal(rows.find(row => row.id === 'working')?.status, 'doing')
  assert.equal(rows.find(row => row.id === 'overall-blocked')?.status, 'blocked')
  assert.equal(rows.find(row => row.id === 'future-only')?.status, 'planned', 'a future-only arrangement is not labelled unscheduled')
  assert.equal(rows.find(row => row.id === 'future-only')?.weeklyStatus, undefined, 'future work is not reported as current execution')
  data.weeklyRecords.find(row => row.id === 'risk-current')!.weekStart = '2026-09-07'
  data.weeklyRecords.push(record('risk-unapproved', { taskId: 'risk', weekStart: '2026-09-14', status: 'done', submitted: false }))
  rows = all(data).rows
  assert.equal(rows.find(row => row.id === 'risk')?.status, 'not_done')
  assert.equal(rows.find(row => row.id === 'risk')?.draftCount, 1)
})

test('missing whole-task evidence remains unknown even when its historical weekly stage is done', () => {
  const data = base()
  data.weeklyRecords = [record('orphan-stage', { taskId: 'missing-task', weekStart: '2026-09-14', status: 'done', actualOutcome: '完成本周验证' })]
  const row = all(data).rows[0]
  assert.equal(row.status, 'unknown')
  assert.equal(row.statusScope, 'task')
  assert.equal(row.taskStatus, undefined)
  assert.equal(row.weeklyStatus, 'done')
  assert.equal(row.weeklyWeekStart, '2026-09-14')
  assert.equal(row.title, 'orphan-stage')
  assert.equal(row.ownerId, member.id)
  const summary = summarizeWorkRows([row])
  assert.equal(summary.total, 1)
  assert.equal(summary.done, 0)
  assert.equal(summary.unknown, 1)
  assert.equal(summary.officialCount, 1)
  assert.equal(filterWorkRows([row], { status: 'unknown' }).length, 1)
  const dated = buildWorkspace(data, { period: 'week', date: '2026-09-17' }, '2026-09-17').rows[0]
  assert.equal(dated.status, 'done', 'a historical weekly stage can still be known independently')
  assert.equal(dated.statusScope, 'period')
})

test('future-only orphan records retain identity without claiming future execution already happened', () => {
  const data = base()
  data.weeklyRecords = [record('future-orphan', { taskId: 'missing-task', weekStart: '2026-09-21', status: 'done' })]
  const row = all(data).rows[0]
  assert.equal(row.status, 'unknown')
  assert.equal(row.title, 'future-orphan')
  assert.equal(row.ownerId, member.id)
  assert.equal(row.planId, 'september')
  assert.equal(row.weeklyStatus, undefined)
  assert.equal(row.record, undefined)
  assert.equal(row.officialCount, 1)
})

test('confirmed whole-task completion takes precedence over old blockers and future arrangements', () => {
  const data = base()
  data.tasks = [task('completed-risk', { status: 'done', dueDate: '2026-09-01' })]
  data.weeklyRecords = [
    record('old-blocker', { taskId: 'completed-risk', weekStart: '2026-09-14', status: 'blocked', blocker: '已解决的旧问题' }),
    record('next-arrangement', { taskId: 'completed-risk', weekStart: '2026-09-21', status: 'planned' }),
  ]
  const row = all(data).rows[0]
  assert.equal(row.status, 'done')
  assert.equal(row.weeklyStatus, 'blocked', 'old weekly facts remain auditable')
  assert.equal(row.record?.id, 'old-blocker')
  assert.equal(row.overdue, false)
  assert.equal(filterWorkRows([row], { riskOnly: true }).length, 0)
  assert.equal(summarizeWorkRows([row]).done, 1)
})

test('unconfirmed imported completion stays actionable consistently with the personal work register', () => {
  const data = base()
  const importSource = { batchId: 'legacy', sourceId: 'source', rowId: 'row', sourceStatus: '本周完成' }
  data.tasks = [
    task('ordinary-done', { status: 'done', dueDate: '2026-09-10', priority: 'high' }),
    task('legacy-unconfirmed', { status: 'done', importSource, completionNote: '  ', dueDate: '2026-09-10', priority: 'low' }),
    task('legacy-confirmed', { status: 'done', importSource, completionNote: '全部交付完成', dueDate: '2026-09-10', priority: 'high' }),
    task('active', { status: 'doing', priority: 'high' }),
  ]
  data.weeklyRecords = data.tasks.map(item => record(`week-${item.id}`, { taskId: item.id, weekStart: '2026-09-14', status: 'done', actualOutcome: '本周阶段完成' }))
  const before = JSON.stringify(data)
  const { rows } = all(data)
  const pending = rows.find(row => row.id === 'legacy-unconfirmed')!
  assert.equal(workRegisterNeedsCompletionReview(data.tasks[1]), true)
  assert.equal(pending.needsCompletionReview, true)
  assert.equal(pending.status, 'unknown')
  assert.equal(pending.taskStatus, 'done', 'the original imported state remains unchanged')
  assert.equal(pending.weeklyStatus, 'done')
  assert.equal(pending.overdue, true)
  assert.equal(summarizeWorkRows(rows).done, 2)
  assert.equal(summarizeWorkRows(rows).unknown, 1)
  assert.equal(previewWorkRows(rows)[0].id, pending.id, 'pending completion must not be demoted with finished tasks')
  assert.equal(rows.find(row => row.id === 'legacy-confirmed')?.needsCompletionReview, undefined)
  assert.equal(rows.find(row => row.id === 'legacy-confirmed')?.overdue, false)
  assert.equal(isCarryoverTask(data.tasks[1], data.plans[0], '2026-10-01'), true)
  assert.equal(isCarryoverTask(data.tasks[2], data.plans[0], '2026-10-01'), false)
  const nextMonth = buildWorkspace(data, { period: 'month', date: '2026-10-08', includeCarryover: true }, '2026-10-08').rows
  assert.deepEqual(nextMonth.map(row => row.id), ['legacy-unconfirmed', 'active'])
  assert.equal(nextMonth[0].status, 'unscheduled')
  assert.equal(nextMonth[0].needsCompletionReview, true)
  assert.equal(nextMonth[0].carryover, true)
  assert.equal(nextMonth[0].overdue, true)
  const historical = buildWorkspace(data, { period: 'month', date: '2026-09-17' }, '2026-10-08').rows.find(row => row.id === pending.id)!
  assert.equal(historical.status, 'done', 'historical weekly-stage completion remains independently true')
  assert.equal(historical.needsCompletionReview, true)
  assert.equal(historical.overdue, true)
  assert.equal(JSON.stringify(data), before)
})

test('all-time grouping uses the current task goal while dated views preserve historical goal facts', () => {
  const data = base()
  data.plans = [plan('september', { projectId: 'old-project' }), plan('october', { month: '2026-10', projectId: 'new-project', priority: 'high' })]
  data.projects = ['old-project', 'new-project'].map(id => ({ ...entity, id, name: id, code: id, description: '', ownerId: manager.id, status: 'active' }))
  data.tasks = [task('carried', { monthlyPlanId: 'october', dueDate: '2026-10-30', status: 'doing' })]
  data.weeklyRecords = [record('september-stage', { taskId: 'carried', weekStart: '2026-09-28', status: 'done' })]
  const allTime = buildWorkspace(data, { period: 'all', date: '2026-10-08' }, '2026-10-08').rows[0]
  assert.equal(allTime.planId, 'october')
  assert.equal(allTime.projectId, 'new-project')
  assert.equal(allTime.priority, 'high')
  assert.equal(allTime.status, 'doing')
  assert.equal(allTime.weeklyStatus, 'done')
  assert.equal(allTime.weeklyWeekStart, '2026-09-28')
  const historical = buildWorkspace(data, { period: 'month', date: '2026-09-01' }, '2026-10-08').rows[0]
  assert.equal(historical.planId, 'september')
  assert.equal(historical.projectId, 'old-project')
  assert.equal(historical.status, 'done')
})

test('opt-in carryover includes older unfinished tasks without changing the default period or inventing weekly records', () => {
  const data = base()
  data.plans.push(plan('october', { month: '2026-10' }))
  data.tasks = [
    task('old-active', { status: 'doing' }),
    task('old-done', { status: 'done' }),
    task('old-cancelled', { cancellation: { cancelledAt: '2026-10-01T00:00:00Z', cancelledBy: manager.id, reason: '不再执行' } }),
    task('undated', { monthlyPlanId: null, dueDate: '', isTemporary: true }),
    task('same-period-old-due', { monthlyPlanId: 'october', dueDate: '2026-09-30' }),
    task('future-created', { createdAt: '2026-11-01T00:00:00Z' }),
  ]
  data.weeklyRecords = [record('old-stage', { taskId: 'old-active', weekStart: '2026-09-21', status: 'done' })]
  const initial = JSON.stringify(data)
  const normal = buildWorkspace(data, { period: 'month', date: '2026-10-08' }, '2026-10-08')
  assert.deepEqual(normal.rows.map(row => row.id), ['same-period-old-due'])
  const included = buildWorkspace(data, { period: 'month', date: '2026-10-08', includeCarryover: true }, '2026-10-08')
  assert.deepEqual(included.rows.map(row => row.id), ['old-active', 'undated', 'same-period-old-due'])
  assert.ok(included.rows.every(row => row.carryover && row.status === 'unscheduled' && !row.records.length && !row.weeklyStatus))
  assert.equal(included.rows.find(row => row.id === 'old-active')?.taskStatus, 'doing')
  assert.equal(included.rows.find(row => row.id === 'old-active')?.planId, 'september')
  assert.equal(summarizeWorkRows(included.rows).officialCount, 0)
  assert.equal(JSON.stringify(data), initial)
  const weekly = buildWorkspace(data, { period: 'week', date: '2026-10-08', includeCarryover: true }, '2026-10-08')
  assert.deepEqual(weekly.rows.map(row => row.id), ['old-active', 'undated', 'same-period-old-due'])
})

test('carryover identity uses Shanghai creation dates for undated tasks and counts scheduled older work once', () => {
  assert.equal(isCarryoverTask(task('late', { monthlyPlanId: null, dueDate: '', createdAt: '2026-09-30T16:00:00Z' }), undefined, '2026-10-01'), false)
  assert.equal(isCarryoverTask(task('earlier', { monthlyPlanId: null, dueDate: '', createdAt: '2026-09-30T15:59:59Z' }), undefined, '2026-10-01'), true)
  assert.equal(isCarryoverTask(task('finished', { status: 'done' }), plan('september'), '2026-10-01'), false)
  const data = base()
  data.tasks = [task('scheduled-old', { dueDate: '2026-09-30' })]
  data.weeklyRecords = [record('this-week', { taskId: 'scheduled-old', weekStart: '2026-09-28', status: 'doing' })]
  const rows = buildWorkspace(data, { period: 'week', date: '2026-10-02', includeCarryover: true }, '2026-10-02').rows
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'doing')
  assert.equal(rows[0].records.length, 1)
})
