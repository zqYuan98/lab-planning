import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { DirectoryWorkspaceService } from '../server/directory-workspace.ts'
import type { AnnualGoal, AuditEvent, MonthlyPlan, Project, User } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const user = (id: string, role: User['role'] = 'member', patch: Partial<User> = {}) => store.insert<User>('users', { id, name: id, email: `${id}@test.invalid`, position: '测试岗位', active: true, role, ...{ passwordHash: 'secret' }, ...patch })
  const manager = user('manager', 'manager'), member = user('member'), peer = user('peer'), observer = user('observer', 'observer')
  const service = new DirectoryWorkspaceService(store)
  const project = (id: string, status: Project['status'] = 'active') => store.insert<Project>('projects', { id, name: id, code: id, ownerId: peer.id, description: '', status })
  return { store, service, user, manager, member, peer, observer, project }
}
test('team and registration paging keep complete independent account counts and safe fields', t => {
  const f = fixture(t)
  for (let i = 0; i < 81; i++) f.user(`person-${i}`, 'member', { active: i % 3 !== 0 })
  f.user('pending', 'member', { active: false, registrationStatus: 'pending', registrationReviewComment: '需要补充' })
  f.user('rejected', 'member', { active: false, registrationStatus: 'rejected' })
  const first = f.service.team(f.manager, { limit: '7', status: 'all' })
  assert.equal(first.total, 85); assert.equal(first.counts.all, 85); assert.equal(first.counts.activeManagers, 1)
  assert.equal(first.items.length, 7); assert.equal(first.counts.pending, 1); assert.equal(first.counts.rejected, 1)
  const names: string[] = []; let cursor: string | null = null
  do { const page = f.service.team(f.manager, { limit: '7', status: 'all', ...(cursor ? { cursor } : {}) }); names.push(...page.items.map(row => row.id)); assert.deepEqual(page.counts, first.counts); cursor = page.nextCursor } while (cursor)
  assert.equal(new Set(names).size, 85)
  const search = f.service.team(f.manager, { q: 'person-70', focusId: 'person-0' })
  assert.equal(search.total, 1); assert.equal(search.focus?.active, false); assert.deepEqual(search.counts, first.counts)
  assert.ok(!JSON.stringify(first).includes('secret')); assert.ok(!('passwordHash' in first.items[0]))
  const registrations = f.service.registrations(f.manager, { limit: '1' })
  assert.equal(registrations.total, 2); assert.equal(registrations.items[0].id, 'pending'); assert.equal(registrations.items[0].registrationReviewComment, '需要补充')
})
test('directory enforces exact query contracts, live actor, safe selected references and bound cursors', t => {
  const f = fixture(t), inactive = f.user('inactive', 'member', { active: false }), pending = f.user('pending', 'member', { registrationStatus: 'pending', active: false })
  const selectedIds = JSON.stringify([inactive.id, pending.id])
  const member = f.service.accounts(f.member, { selectedIds, limit: '1' })
  assert.deepEqual(member.selected.map(row => row.id), [inactive.id]); assert.equal(member.total, 4)
  assert.ok(member.items.every(row => !('email' in row) && !('passwordHash' in row)))
  assert.equal(f.service.accounts(f.manager, { purpose: 'usage', selectedIds }).selected.length, 2)
  assert.throws(() => f.service.accounts(f.member, { purpose: 'diagnostics' }), /管理者/)
  assert.throws(() => f.service.accounts(f.observer, {}), /观察者/)
  assert.throws(() => f.service.accounts(f.manager, { selectedIds: JSON.stringify(Array(101).fill('member')) }), /100/)
  assert.throws(() => f.service.accounts(f.manager, { selectedIds: '[1]' }), /无效/)
  for (const read of ['team', 'registrations', 'accounts', 'projects', 'goals'] as const) assert.throws(() => f.service[read](f.manager, { arbitrary: 'value' }), /不支持/)
  const page = f.service.accounts(f.member, { limit: '1' })
  assert.throws(() => f.service.accounts(f.peer, { limit: '1', cursor: page.nextCursor! }), /已更新/)
  f.store.update<User>('users', f.manager.id, f.manager.version, { role: 'member' })
  assert.throws(() => f.service.team(f.manager, {}), /管理者/)
  f.store.update<User>('users', f.member.id, f.member.version, { active: false })
  assert.throws(() => f.service.accounts(f.member, {}), /账号|登录|权限/)
})
test('projects retain member archive visibility and count only authorized published plan versions', t => {
  const f = fixture(t), a = f.project('archive', 'archived'), b = f.project('active')
  for (let i = 0; i < 60; i++) f.project(`project-${i}`)
  const plan = (id: string, patch: Partial<MonthlyPlan> = {}) => f.store.insert<MonthlyPlan>('plans', { id, title: id, month: '2026-09', projectId: a.id, ownerId: f.peer.id, collaboratorIds: [], category: '', expectedOutcome: '', acceptanceCriteria: '', dueDate: '', priority: 'medium', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', ...patch })
  plan('hidden'); plan('direct', { ownerId: f.member.id }); plan('collaboration', { collaboratorIds: [f.member.id] }); plan('draft', { ownerId: f.member.id, status: 'draft' })
  const old = plan('historic', { projectId: b.id })
  f.store.insert<AuditEvent>('events', { entityType: 'plan', entityId: old.id, actorId: f.manager.id, action: 'update', reason: '', before: { ...old, projectId: a.id, ownerId: f.member.id }, after: old })
  const page = f.service.projects(f.member, { limit: '3', status: 'all', focusId: a.id })
  assert.equal(page.total, 62); assert.equal(page.items.length, 3); assert.equal(page.focus?.publishedPlanCount, 3)
  assert.equal(f.service.projects(f.manager, { focusId: a.id }).focus?.publishedPlanCount, 3)
  assert.equal(f.service.projects(f.member, { q: 'archive', status: 'all' }).items[0].id, a.id)
  assert.throws(() => f.service.projects(f.observer, {}), /观察者/)
})
test('annual goal paging and full year counts exclude other years without parsing unrelated bodies', t => {
  const f = fixture(t)
  for (let i = 0; i < 70; i++) f.store.insert<AnnualGoal>('annualGoals', { title: `目标${i}`, year: 2026, target: '', ownerId: f.member.id, progress: 0, status: i % 2 ? 'active' : 'completed', description: '' })
  f.store.insert<AnnualGoal>('annualGoals', { title: '去年', year: 2025, target: '大正文'.repeat(100000), ownerId: f.member.id, progress: 0, status: 'active', description: '' })
  f.store.resetReadMetrics()
  const page = f.service.goals(f.member, { year: '2026', limit: '5' })
  assert.equal(page.total, 70); assert.deepEqual(page.counts, { all: 70, active: 35, completed: 35 }); assert.equal(page.items.length, 5)
  assert.equal(page.items[0].owner?.id, f.member.id); assert.ok(f.store.getReadMetrics().parsedBytes < 20000)
  assert.throws(() => f.service.goals(f.member, { year: ['2026'] }), /请选择/)
})
