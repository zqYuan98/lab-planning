import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { accountDisplayName, assignmentAccounts, historicalRosterAccounts, visibleAccounts, visibleMonthlyPlan } from '../src/account-options.ts'
import { buildWorkspaceSearchIndex, filterWorkspaceSearch } from '../src/components/WorkspaceSearch.tsx'
import Weekly from '../src/pages/Weekly.tsx'
import Monthly from '../src/pages/Monthly.tsx'
import type { Bootstrap, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'

const entity = { version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z' }
const user = (id: string, patch: Partial<User> = {}): User => ({ ...entity, id, name: id, email: `${id}@example.test`, role: 'member', position: '', active: true, ...patch })
const users = [user('manager', { role: 'manager' }), user('active', { registrationStatus: 'approved' }), user('inactive', { active: false, registrationStatus: 'approved' }), user('pending', { registrationStatus: 'pending' }), user('rejected', { active: false, registrationStatus: 'rejected' })]
const plan = (id: string, ownerId: string, collaboratorIds: string[] = []): MonthlyPlan => ({ ...entity, id, title: id, ownerId, collaboratorIds, month: '2026-09', projectId: null, category: '研发', expectedOutcome: '交付成果', acceptanceCriteria: '确认通过', dueDate: '2026-09-30', priority: 'medium', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '' })
const task = (ownerId: string): Task => ({ ...entity, id: `task-${ownerId}`, title: `${ownerId}任务`, monthlyPlanId: null, ownerId, description: '', dueDate: '2026-09-30', status: 'doing', isTemporary: true, temporaryReason: '临时需求' })
const record = (ownerId: string): WeeklyRecord => ({ ...entity, id: `record-${ownerId}`, taskId: `task-${ownerId}`, monthlyPlanId: null, ownerId, weekStart: '2026-09-14', commitment: `${ownerId}专属承诺`, actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'doing', submitted: true })
function fixture(): Bootstrap {
  return { user: users[0], users, projects: [], annualGoals: [], plans: [plan('停用独占目标', 'inactive'), plan('仍在协作目标', 'inactive', ['active'])], tasks: users.map(person => task(person.id)), weeklyRecords: users.map(person => record(person.id)), publications: [], reports: [], aiConfigured: false }
}

test('new assignments exclude inactive and unapproved accounts while retaining existing responsibility', () => {
  assert.deepEqual(assignmentAccounts(users).map(person => person.id), ['manager', 'active'])
  assert.deepEqual(assignmentAccounts(users, ['inactive']).map(person => person.id), ['manager', 'active', 'inactive'])
  assert.equal(accountDisplayName(users[2]), 'inactive（已停用）')
  assert.equal(accountDisplayName(users[3]), 'pending（待审批）')
})

test('history mode includes approved inactive users without turning registrations into members', () => {
  assert.deepEqual(visibleAccounts(users).map(person => person.id), ['manager', 'active'])
  assert.deepEqual(visibleAccounts(users, true).map(person => person.id), ['manager', 'active', 'inactive'])
  assert.equal(visibleMonthlyPlan(plan('old', 'inactive'), users), false)
  assert.equal(visibleMonthlyPlan(plan('old', 'inactive'), users, true), true)
  assert.equal(visibleMonthlyPlan(plan('shared', 'inactive', ['active']), users), true)
  assert.equal(visibleMonthlyPlan(plan('pending', 'pending'), users, true), false)
})

test('ambiguous historical rosters can restore approved inactive members without treating pending accounts as staff', () => {
  assert.deepEqual(historicalRosterAccounts(users).map(person => person.id), ['active', 'inactive'])
  assert.equal(accountDisplayName(historicalRosterAccounts(users)[1]), 'inactive（已停用）')
  assert.ok(!assignmentAccounts(users).some(person => person.id === 'inactive'))
})

test('search hides unavailable member shortcuts and preserves labeled historical work with its deep link', () => {
  const index = buildWorkspaceSearchIndex(fixture(), '2026-09-14')
  assert.deepEqual(index.filter(item => item.category === '团队成员').map(item => item.title), ['manager', 'active'])
  const history = filterWorkspaceSearch(index, 'inactive任务').find(item => item.category === '个人任务')!
  assert.match(history.description, /inactive（已停用）/)
  assert.equal(history.intent.id, 'task-inactive')
  assert.equal(history.intent.weekStart, '2026-09-14')
})

test('search omits cancelled tasks and never uses deleted weeks as active navigation targets', () => {
  const data = fixture()
  data.tasks.find(task => task.ownerId === 'active')!.cancellation = { cancelledAt: '2026-09-22T02:00:00Z', cancelledBy: 'manager', reason: '旧任务不用' }
  data.weeklyRecords.find(record => record.ownerId === 'manager')!.deletion = { deletedAt: '2026-09-22T01:00:00Z', deletedBy: 'manager', reason: '重排' }
  const index = buildWorkspaceSearchIndex(data, '2026-09-21')
  assert.ok(!index.some(item => item.intent.id === 'task-active'))
  const retained = index.find(item => item.intent.id === 'task-manager')!
  assert.match(retained.description, /尚未安排周记录/)
  assert.equal(retained.intent.weekStart, '2026-09-21')
  assert.deepEqual(retained.taskWeeks, [])
})

test('weekly default view excludes inactive records and an explicit historical task opens them', () => {
  const props = { data: fixture(), refresh: async () => {}, notify: () => {} }
  const normal = renderToStaticMarkup(createElement(Weekly, { ...props, intent: { weekStart: '2026-09-14' } }))
  assert.match(normal, /active专属承诺/)
  assert.doesNotMatch(normal, /inactive专属承诺|pending专属承诺|rejected专属承诺/)
  assert.match(normal, /包含停用成员/)
  const history = renderToStaticMarkup(createElement(Weekly, { ...props, intent: { id: 'task-inactive', weekStart: '2026-09-14' } }))
  assert.match(history, /inactive专属承诺/)
  assert.match(history, /inactive（已停用）/)
  assert.doesNotMatch(history, /pending专属承诺/)
})

test('monthly default keeps active collaborations and deep-linked inactive goals remain available', () => {
  const props = { data: fixture(), refresh: async () => {}, notify: () => {} }
  const normal = renderToStaticMarkup(createElement(Monthly, { ...props, intent: { month: '2026-09' } }))
  assert.doesNotMatch(normal, /停用独占目标/)
  assert.match(normal, /仍在协作目标/)
  assert.match(normal, /inactive（已停用）/)
  const history = renderToStaticMarkup(createElement(Monthly, { ...props, intent: { id: '停用独占目标', month: '2026-09' } }))
  assert.match(history, /停用独占目标/)
})
