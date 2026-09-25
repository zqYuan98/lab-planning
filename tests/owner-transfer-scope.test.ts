import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Store } from '../server/store.ts'
import { TestDomain } from './fixtures/legacy-domain.ts'
import { PeriodWorkspaceService } from '../server/period-workspace.ts'
import { OverviewWorkspaceService } from '../server/overview-workspace.ts'
import { MonthlyBody } from '../src/pages/Monthly.tsx'
import type { MonthlyPlan, Publication, Task, User } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const domain = new TestDomain(store), period = new PeriodWorkspaceService(store), overview = new OverviewWorkspaceService(store, () => new Date('2026-09-24T08:00:00Z'))
  const user = (id: string, role: User['role'] = 'member') => store.insert<User>('users', { id, name: id, email: `${id}@transfer-scope.test`, role, position: '', active: true })
  const manager = user('manager', 'manager'), former = user('former'), next = user('next'), collaborator = user('collaborator'), outsider = user('outsider')
  const plan = (title: string, ownerId = former.id, collaboratorIds: string[] = []) => {
    let row = domain.createPlan(manager, { title, ownerId, collaboratorIds, month: '2026-09', category: '算法研究', expectedOutcome: '历史成果要求', acceptanceCriteria: '验收通过', dueDate: '2026-09-30' })
    row = domain.submitPlan(manager, row.id, { version: row.version })
    row = domain.reviewPlan(manager, row.id, { version: row.version, decision: 'approve' })
    domain.publishMonth(manager, row.month, { planIds: [row.id], reason: '发布月度目标' })
    return store.get<MonthlyPlan>('plans', row.id)!
  }
  return { store, domain, period, overview, manager, former, next, collaborator, outsider, plan }
}

test('published owner transfer moves current counts and focus while preserving only authorized history and publication originals', t => {
  const f = fixture(t), transferred = f.plan('移交目标'), retained = f.plan('仍参与目标')
  const originalPublication = f.store.list<Publication>('publications').find(row => row.plans.some(plan => plan.id === transferred.id))!
  const published = structuredClone(originalPublication)
  f.domain.updatePlan(f.manager, transferred.id, { version: transferred.version, ownerId: f.next.id, expectedOutcome: '新负责人私有修订', reason: '变更负责人' })
  const oldCurrent = f.period.monthly(f.former, { month: '2026-09', id: transferred.id })
  assert.deepEqual(oldCurrent.items.map(row => row.id), [retained.id])
  assert.equal(oldCurrent.total, 1)
  assert.equal(oldCurrent.summary.statuses.all, 1)
  assert.equal(oldCurrent.summary.statuses.published, 1)
  assert.equal(oldCurrent.summary.historical, 1)
  assert.equal(oldCurrent.detail?.visibility, 'historical', 'deep links remain available independently of current rows')
  assert.equal(oldCurrent.detail?.ownerId, f.former.id)
  assert.equal(oldCurrent.detail?.expectedOutcome, transferred.expectedOutcome)
  assert.ok(!JSON.stringify(oldCurrent).includes('新负责人私有修订'))
  const history = f.period.monthly(f.former, { month: '2026-09', scope: 'historical' })
  assert.deepEqual(history.items.map(row => [row.id, row.visibility]), [[transferred.id, 'historical']])
  assert.deepEqual(history.summary.statuses, oldCurrent.summary.statuses, 'historical rows never inflate current status counts')
  const newCurrent = f.period.monthly(f.next, { month: '2026-09' })
  assert.deepEqual(newCurrent.items.map(row => row.id), [transferred.id])
  assert.equal(newCurrent.items[0].visibility, undefined)
  assert.equal(newCurrent.items[0].expectedOutcome, '新负责人私有修订')
  assert.equal(newCurrent.summary.historical, 0)
  const oldOverview = f.overview.personal(f.former), newOverview = f.overview.personal(f.next)
  assert.equal(oldOverview.counts.plans, 1)
  assert.equal(oldOverview.counts.published, 1)
  assert.equal(oldOverview.monthTrend.at(-1)?.value, 1)
  assert.deepEqual(oldOverview.focusPlans.map(row => row.id), [retained.id])
  assert.equal(newOverview.counts.plans, 1)
  assert.equal(newOverview.monthTrend.at(-1)?.value, 1)
  assert.deepEqual(newOverview.focusPlans.map(row => row.id), [transferred.id])
  assert.equal(f.period.monthly(f.manager, { month: '2026-09' }).total, 2)
  assert.equal(f.overview.personal(f.manager).counts.plans, 2)
  assert.deepEqual(f.store.get('publications', published.id), published, 'the saved publication is unchanged')
  assert.equal(f.period.publication(f.former, published.id).publication.plans.find(row => row.id === transferred.id)?.ownerId, f.former.id)
  assert.throws(() => f.period.plan(f.outsider, transferred.id), { status: 404 })
  assert.throws(() => f.period.monthly(f.former, { month: '2026-09', scope: 'unknown' }), { status: 400 })
})

test('removed collaborators become historical; a former owner retained as collaborator stays current', t => {
  const f = fixture(t), plan = f.plan('团队协作目标', f.former.id, [f.collaborator.id])
  f.domain.updatePlan(f.manager, plan.id, { version: plan.version, ownerId: f.next.id, collaboratorIds: [f.former.id], reason: '交接并调整参与人员' })
  assert.equal(f.period.monthly(f.former, { month: plan.month }).items[0].visibility, undefined)
  assert.equal(f.period.monthly(f.next, { month: plan.month }).total, 1)
  const removed = f.period.monthly(f.collaborator, { month: plan.month })
  assert.equal(removed.total, 0)
  assert.equal(removed.summary.statuses.all, 0)
  assert.equal(removed.summary.historical, 1)
  assert.equal(f.period.monthly(f.collaborator, { month: plan.month, scope: 'historical' }).items[0].visibility, 'historical')
  const overview = f.overview.personal(f.collaborator)
  assert.equal(overview.counts.plans, 0)
  assert.equal(overview.counts.published, 0)
  assert.equal(overview.monthTrend.at(-1)?.value, 0, 'old publications cannot resurrect a current assignment')
  assert.deepEqual(overview.focusPlans, [])
})

test('historical pagination and search preserve full current counts and keep cursors bound to their scope', t => {
  const f = fixture(t), first = f.plan('移交一'), second = f.plan('移交二'), current = f.plan('当前目标')
  for (const row of [first, second]) f.domain.updatePlan(f.manager, row.id, { version: row.version, ownerId: f.next.id, reason: '交接目标' })
  const page = f.period.monthly(f.former, { month: '2026-09', scope: 'historical', limit: 1 })
  assert.equal(page.total, 2)
  assert.equal(page.summary.statuses.all, 1)
  assert.equal(page.summary.historical, 2)
  assert.ok(page.nextCursor)
  const tail = f.period.monthly(f.former, { month: '2026-09', scope: 'historical', limit: 1, cursor: page.nextCursor })
  assert.deepEqual([...page.items, ...tail.items].map(row => row.id), [first.id, second.id])
  assert.equal(tail.nextCursor, null)
  assert.throws(() => f.period.monthly(f.former, { month: '2026-09', scope: 'current', limit: 1, cursor: page.nextCursor }), { status: 409 })
  const search = f.period.monthly(f.former, { month: '2026-09', scope: 'historical', q: '移交二' })
  assert.deepEqual(search.items.map(row => row.id), [second.id])
  assert.equal(search.summary.statuses.all, 1)
  assert.deepEqual(f.period.monthly(f.former, { month: '2026-09' }).items.map(row => row.id), [current.id])
})

test('legacy task references stay readable without becoming current assignments or leaking present responsibility', t => {
  const f = fixture(t), plan = f.plan('不可见当前目标', f.next.id)
  f.store.insert<Task>('tasks', { title: '历史关联任务', monthlyPlanId: plan.id, ownerId: f.former.id, description: '', dueDate: '2026-09-30', status: 'done', isTemporary: false, temporaryReason: '' })
  assert.equal(f.period.monthly(f.former, { month: plan.month }).total, 0)
  const history = f.period.monthly(f.former, { month: plan.month, scope: 'historical' })
  assert.equal(history.total, 1)
  assert.equal(history.items[0].visibility, 'reference')
  assert.equal(history.summary.statuses.draft, 0)
  assert.equal(f.period.plan(f.former, plan.id).plan.visibility, 'reference')
  assert.equal(f.overview.personal(f.former).counts.plans, 0)
  const data = f.domain.bootstrap(f.former), html = renderToStaticMarkup(createElement(MonthlyBody, { data, refresh: async () => {}, notify() {}, intent: { month: plan.month, id: plan.id } }))
  assert.match(html, /历史引用 · 只读/)
  assert.match(html, /历史责任信息不可用/)
  assert.doesNotMatch(html, /不可见当前目标|>提交成果<|>关联个人任务<|>编辑</)
})

test('historical deep link opens a clearly read-only snapshot without adding it to current table rows', t => {
  const f = fixture(t), plan = f.plan('原负责人历史目标')
  f.domain.updatePlan(f.manager, plan.id, { version: plan.version, ownerId: f.next.id, reason: '交接目标' })
  const data = f.domain.bootstrap(f.former), value = f.period.monthly(f.former, { month: plan.month, id: plan.id })
  const html = renderToStaticMarkup(createElement(MonthlyBody, { data, refresh: async () => {}, notify() {}, intent: { month: plan.month, id: plan.id }, period: { value, setQuery() {}, reload: async () => {} } }))
  assert.match(html, /历史记录 · 只读/)
  assert.match(html, /当时负责人 \/ 参与人员/)
  assert.match(html, /不计入当前参与目标/)
  assert.match(html, /本月暂无你参与的月度目标/)
  assert.doesNotMatch(html, /class="table-title"|>提交成果<|>关联个人任务<|>编辑<|当前已发布/)
})

test('a cleared monthly page cannot rebuild rows or counts from retained detail references', t => {
  const f = fixture(t), selected = f.plan('保留打开详情的目标'), historical = f.plan('旧负责人历史目标')
  f.store.update<MonthlyPlan>('plans', selected.id, selected.version, { status: 'approved' })
  f.domain.updatePlan(f.manager, historical.id, { version: historical.version, ownerId: f.next.id, reason: '交接目标' })
  // The detail/editor snapshot may outlive a revoked or changing page query. Exercise
  // the actual rendered boundary with those retained references and an absent page.
  const render = (actor: User) => renderToStaticMarkup(createElement(MonthlyBody, {
    data: f.domain.bootstrap(actor), refresh: async () => {}, notify() {}, intent: { month: selected.month, id: selected.id },
    period: { value: null, setQuery() {}, reload: async () => {} },
  }))
  const member = render(f.former)
  assert.match(member, /当前参与<span>0<\/span>/)
  assert.match(member, /历史记录<span>0<\/span>/)
  assert.match(member, /审核通过<span>0<\/span>/)
  assert.doesNotMatch(member, /class="table-title"|>编辑<|>提交成果<|>关联个人任务</)
  assert.match(member, /保留打开详情的目标/)
  assert.match(member, /历史成果要求/, 'the independent detail content remains available')
  const manager = render(f.manager)
  assert.doesNotMatch(manager, /class="table-title"|发布已审核计划（|发布版本 [1-9]/)
  assert.match(manager, /<button class="button primary" disabled="">[\s\S]*?发布已审核计划<\/button>/)
  assert.match(manager, /保留打开详情的目标/)
})
