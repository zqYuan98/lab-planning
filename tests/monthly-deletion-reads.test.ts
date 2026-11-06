import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { PeriodWorkspaceService } from '../server/period-workspace.ts'
import { WorkspaceQueryService } from '../server/workspace-query.ts'
import { ImportWorkspaceService } from '../server/import-workspace.ts'
import { OverviewWorkspaceService } from '../server/overview-workspace.ts'
import { MyActionsService } from '../server/my-actions.ts'
import { DirectoryWorkspaceService } from '../server/directory-workspace.ts'
import { buildReportSnapshot } from '../server/reports.ts'
import { readBusinessExportSources } from '../server/business-export-read.ts'
import { visiblePlan, planVisibilityProjector } from '../server/plan-visibility.ts'
import { readScopeVersion } from '../server/object-access.ts'
import { targetAccessible } from '../server/notifications.ts'
import { annualGoalProgress } from '../shared/annual-goals.ts'
import { buildWorkRegister } from '../shared/work-register.ts'
import type { AnnualGoal, MonthlyPlan, User } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store)
  t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id, name: id, email: `${id}@monthly-delete.test`, role, active: true, position: '' })
  const manager = user('manager', 'manager'), member = user('member', 'member'), peer = user('peer', 'member')
  const goal = store.insert<AnnualGoal>('annualGoals', { title: '年度目标', year: 2026, target: '交付', progress: 0, description: '', ownerId: member.id, status: 'active' })
  const create = (title: string) => domain.createPlan(manager, { month: '2026-11', title, category: '部门工作', ownerId: member.id, collaboratorIds: [], expectedOutcome: '交付结果', acceptanceCriteria: '通过测试', dueDate: '2026-11-30', annualGoalId: goal.id })
  const kept = create('保留的正式来源目标'), draft = create('重复自提目标')
  const submitted = domain.submitPlan(manager, draft.id, { version: draft.version })
  const approved = domain.reviewPlan(manager, draft.id, { version: submitted.version, decision: 'approve' })
  return { store, domain, manager, member, peer, goal, kept, approved }
}

test('deleting a duplicate removes every current read and publication candidate while retaining explicit history and exports', t => {
  const f = fixture(t), period = new PeriodWorkspaceService(f.store), queries = new WorkspaceQueryService(f.store)
  const imports = new ImportWorkspaceService(f.store), actions = new MyActionsService(f.store), overview = new OverviewWorkspaceService(f.store, () => new Date('2026-11-06T04:00:00Z'))
  const beforeScope = readScopeVersion(f.store, f.member)
  assert.equal(period.monthly(f.manager, { month: '2026-11' }).summary.publishable, 1)
  assert.ok(actions.list(f.manager).items.some(item => item.sourceId === f.approved.id))
  const oldSnapshot = buildReportSnapshot(f.store, 'monthly', '2026-11'), frozen = JSON.stringify(oldSnapshot)
  const deleted = f.domain.deletePlan(f.manager, f.approved.id, { version: f.approved.version, reason: '与保留目标重复' })
  assert.notEqual(readScopeVersion(f.store, f.member), beforeScope)
  for (const actor of [f.manager, f.member]) {
    const current = period.monthly(actor, { month: '2026-11' })
    assert.deepEqual(current.items.map(plan => plan.id), [f.kept.id])
    assert.equal(current.summary.statuses.all, 1)
    assert.equal(current.summary.statuses.approved, 0)
    assert.equal(current.summary.statuses.deleted, 1)
    assert.equal(current.summary.publishable, 0)
    assert.deepEqual(period.monthly(actor, { month: '2026-11', scope: 'deleted', status: 'draft' }).items.map(plan => plan.id), [deleted.id])
    assert.equal(period.monthly(actor, { month: '2026-11', id: deleted.id }).detail?.deletion?.reason, '与保留目标重复')
    assert.equal(period.plan(actor, deleted.id).plan.deletion?.deletedBy, f.manager.id)
    assert.ok(!queries.page(actor, 'plans', {}).items.some(row => row.id === deleted.id))
    assert.ok(!imports.candidates(actor, { kind: 'plans', month: '2026-11' }).items.some(row => row.id === deleted.id))
    assert.ok(!actions.list(actor).items.some(item => item.sourceId === deleted.id))
    assert.equal(overview.personal(actor).counts.plans, 1)
    assert.equal(targetAccessible(f.store, actor, { type: 'plan', id: deleted.id, month: deleted.month }), false)
    assert.ok(readBusinessExportSources(f.store, actor).plans.some(plan => plan.id === deleted.id && plan.deletion))
  }
  for (const purpose of ['publish', 'merge', 'relink', 'weekly']) {
    const candidates = period.candidates(f.manager, { kind: 'plans', purpose, ownerId: f.member.id, month: '2026-11' })
    assert.ok(!candidates.items.some(plan => plan.id === deleted.id))
  }
  assert.ok(!queries.register(f.member, {}).items.some(row => row.id === deleted.id))
  const localRegister = buildWorkRegister({ user: f.member, tasks: [], weeklyRecords: [], plans: [f.kept, deleted] }, { today: '2026-11-06' })
  assert.ok(!localRegister.rows.some(row => row.id === deleted.id))
  assert.equal(annualGoalProgress(f.goal, [f.kept, deleted]).linkedPlanCount, 1)
  assert.equal(new DirectoryWorkspaceService(f.store).goalDetail(f.manager, f.goal.id, {}).total, 1)
  assert.deepEqual(buildReportSnapshot(f.store, 'monthly', '2026-11').plans.map(plan => plan.id), [f.kept.id])
  assert.ok(!buildReportSnapshot(f.store, 'monthly', '2026-10').nextPlans.some(plan => plan.id === deleted.id))
  assert.equal(JSON.stringify(oldSnapshot), frozen, 'already-created report evidence stays unchanged')
  assert.deepEqual(f.store.get('plans', f.kept.id), f.kept, 'deletion must not alter the retained duplicate')
  assert.equal(period.monthly(f.peer, { month: '2026-11', scope: 'deleted' }).total, 0)
  assert.throws(() => period.plan(f.peer, deleted.id), { status: 404 })
})

test('former membership cannot resurrect a deleted goal through historical projection or reveal the new deletion reason', t => {
  const f = fixture(t)
  const reassigned = f.domain.updatePlan(f.manager, f.kept.id, { version: f.kept.version, ownerId: f.peer.id })
  const deleted = f.domain.deletePlan(f.manager, reassigned.id, { version: reassigned.version, reason: '新责任人内部核对原因' })
  const direct = visiblePlan(f.store, f.member, deleted)!
  const projector = planVisibilityProjector(f.store, f.member, { plans: f.store.list<MonthlyPlan>('plans'), events: f.store.entityEvents('plan', deleted.id), publications: [] })
  assert.equal(direct.visibility, 'historical')
  assert.ok(direct.deletion)
  assert.equal(direct.deletion?.reason, '目标已删除，删除原因不在当前查看范围')
  assert.deepEqual(projector.visible(deleted), direct)
  const period = new PeriodWorkspaceService(f.store)
  assert.ok(!period.monthly(f.member, { month: '2026-11' }).items.some(row => row.id === deleted.id))
  assert.ok(!period.monthly(f.member, { month: '2026-11', scope: 'deleted' }).items.some(row => row.id === deleted.id))
  assert.ok(period.monthly(f.member, { month: '2026-11', scope: 'historical' }).items.find(row => row.id === deleted.id)?.deletion)
})
