import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { TestDomain as Domain } from './fixtures/legacy-domain.ts'
import { getOperationEpoch } from '../server/operation-context.ts'
import { Store } from '../server/store.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { schemas } from '../server/data-transfer-schema.ts'
import type { MonthlyPlan, User } from '../shared/types.ts'
import { MonthlyBody as Monthly } from '../src/pages/Monthly.tsx'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store)
  const user = (id: string, role: User['role'] = 'member') => store.restoreEntity<StoredUser>('users', { id, version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', name: id, email: `${id}@temporary.test`, role, active: true, position: '', credentialVersion: 1, passwordHash: 'unused-test-credentials' })
  const manager = user('manager', 'manager'), member = user('member'), peer = user('peer')
  const input = { month: '2026-09', title: '专项研究第一阶段', category: '算法研究', expectedOutcome: '完成方案验证', acceptanceCriteria: '提交验证报告', dueDate: '2026-09-30', isTemporary: true, temporaryReason: '新增长期专项，本月验证方案' }
  const publish = (plan: MonthlyPlan) => {
    plan = domain.submitPlan(manager, plan.id, { version: plan.version })
    plan = domain.reviewPlan(manager, plan.id, { version: plan.version, decision: 'approve' })
    domain.publishMonth(manager, plan.month, { planIds: [plan.id] })
    return store.get<MonthlyPlan>('plans', plan.id)!
  }
  t.after(() => store.close())
  return { store, domain, manager, member, peer, input, publish }
}

test('members can propose only their own temporary monthly goals with a reason and month-scoped deadline', t => {
  const f = fixture(t)
  for (const extra of [{ isTemporary: false }, { isTemporary: undefined }, { ownerId: f.peer.id }]) {
    assert.throws(() => f.domain.createPlan(f.member, { ...f.input, ...extra }), { status: 403 })
  }
  for (const extra of [{ isTemporary: 'true' }, { temporaryReason: '' }, { temporaryReason: undefined }, { dueDate: '2026-10-01' }]) {
    assert.throws(() => f.domain.createPlan(f.member, { ...f.input, ...extra }), { status: 400 })
  }
  const plan = f.domain.createPlan(f.member, { ...f.input, status: 'published', acceptanceStatus: 'accepted', publishedVersion: 9 })
  assert.equal(plan.ownerId, f.member.id)
  assert.equal(plan.status, 'draft')
  assert.equal(plan.acceptanceStatus, 'pending')
  assert.equal(plan.publishedVersion, null)
  assert.deepEqual(f.domain.bootstrap(f.member).plans.map(item => item.id), [plan.id])
  assert.equal(f.domain.bootstrap(f.peer).plans.length, 0)
  assert.throws(() => f.domain.updatePlan(f.peer, plan.id, { version: plan.version, title: '篡改' }), { status: 403 })
  assert.throws(() => f.domain.updatePlan(f.member, plan.id, { version: plan.version, ownerId: f.peer.id }), { status: 403 })
  assert.throws(() => f.domain.updatePlan(f.member, plan.id, { version: plan.version, isTemporary: false }), { status: 400 })
  assert.throws(() => f.domain.updatePlan(f.member, plan.id, { version: plan.version, temporaryReason: ' ' }), { status: 400 })
  assert.throws(() => f.domain.createPlan(f.member, { ...f.input, month: '2026-10', dueDate: '2026-10-31', sourcePlanId: plan.id }), { status: 403 })
  const standard = f.domain.createPlan(f.manager, { ...f.input, ownerId: f.member.id, isTemporary: false })
  assert.throws(() => f.domain.updatePlan(f.member, standard.id, { version: standard.version, isTemporary: true }), { status: 403 })
  assert.throws(() => f.domain.submitPlan(f.member, standard.id, { version: standard.version }), { status: 403 })
})

test('temporary goals support member revision and manager review without bypassing weekly publication gates', t => {
  const f = fixture(t)
  let plan = f.domain.createPlan(f.member, { ...f.input, collaboratorIds: [f.peer.id] })
  plan = f.domain.updatePlan(f.member, plan.id, { version: plan.version, expectedOutcome: '补充验证报告' })
  assert.throws(() => f.domain.updatePlan(f.member, plan.id, { version: 1, title: '过期修改' }), { status: 409 })
  plan = f.domain.submitPlan(f.member, plan.id, { version: plan.version })
  assert.throws(() => f.domain.updatePlan(f.member, plan.id, { version: plan.version, title: '已提交修改' }), { status: 403 })
  assert.throws(() => f.domain.reviewPlan(f.member, plan.id, { version: plan.version, decision: 'approve' }), { status: 403 })
  assert.throws(() => f.domain.publishMonth(f.member, plan.month, { planIds: [plan.id] }), { status: 403 })
  plan = f.domain.reviewPlan(f.manager, plan.id, { version: plan.version, decision: 'return', comment: '请补充本月阶段验收指标' })
  assert.equal(f.domain.bootstrap(f.member).plans[0].reviewComment, plan.reviewComment)
  assert.equal(f.domain.bootstrap(f.peer).plans[0].reviewComment, '')
  plan = f.domain.updatePlan(f.member, plan.id, { version: plan.version, acceptanceCriteria: '形成三项评测指标' })
  const task = f.domain.createTask(f.member, { monthlyPlanId: plan.id, title: '第一周验证', dueDate: '2026-09-20' })
  assert.throws(() => f.domain.createWeeklyRecord(f.member, { taskId: task.id, weekStart: '2026-09-14', commitment: '验证方案', submitted: true }), { status: 400 })
  plan = f.publish(plan)
  const week = f.domain.createWeeklyRecord(f.member, { taskId: task.id, weekStart: '2026-09-14', commitment: '验证方案', submitted: true })
  assert.equal(week.monthlyPlanId, plan.id)
  assert.equal(task.isTemporary, false, 'a task linked to a temporary monthly goal still follows the published-goal workflow')
  assert.throws(() => f.domain.updatePlan(f.member, plan.id, { version: plan.version, title: '发布后修改' }), { status: 403 })
})

test('monthly carry preserves temporary provenance and prior results while later stages remain editable drafts', t => {
  const f = fixture(t)
  let source = f.publish(f.domain.createPlan(f.member, f.input))
  source = f.domain.planResult(f.manager, source.id, { version: source.version, acceptanceStatus: 'not_completed', actualOutcome: '完成部分验证', acceptanceNote: '样本仍需补充' })
  const before = structuredClone(source)
  assert.throws(() => f.domain.carryPlan(f.member, source.id, { month: '2026-10', dueDate: '2026-10-31', reason: '继续研究' }), { status: 403 })
  const carryCommand = { requestId: 'temporary-carry-request', sourceVersion: source.version, operationEpoch: getOperationEpoch(f.store) }
  assert.throws(() => f.domain.carryPlan(f.manager, source.id, { ...carryCommand, month: '2026-10', dueDate: '2026-11-01', reason: '继续研究' }), { status: 400 })
  let next = f.domain.carryPlan(f.manager, source.id, { ...carryCommand, month: '2026-10', dueDate: '2026-10-31', reason: '继续第二阶段研究' })
  assert.equal(next.sourcePlanId, source.id)
  assert.equal(next.isTemporary, true)
  assert.equal(next.temporaryReason, source.temporaryReason)
  assert.equal(next.status, 'draft')
  assert.equal(next.actualOutcome, '')
  assert.equal(next.acceptanceStatus, 'pending')
  next = f.domain.updatePlan(f.member, next.id, { version: next.version, title: '专项研究第二阶段', expectedOutcome: '补齐样本并验收' })
  assert.equal(next.title, '专项研究第二阶段')
  assert.deepEqual(f.store.get('plans', source.id), before)
  const packet = exportBusinessData(f.store, f.manager)
  const target = fixture(t)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  assert.equal(target.store.get<MonthlyPlan>('plans', next.id)!.isTemporary, true)
  assert.equal(target.store.get<MonthlyPlan>('plans', next.id)!.sourcePlanId, source.id)
  const { isTemporary: _temporary, temporaryReason: _reason, ...legacy } = before
  assert.equal(schemas.plans.safeParse(legacy).success, true, 'legacy plans remain valid')
  assert.equal(schemas.plans.safeParse({ ...before, temporaryReason: '' }).success, false)
})

test('merged temporary proposals keep private source reasons out of peer projections and preserve manager control of the combined goal', t => {
  const f = fixture(t)
  let first = f.domain.createPlan(f.member, { ...f.input, temporaryReason: 'SOURCE_PRIVATE_REASON', collaboratorIds: [f.peer.id] })
  first = f.domain.submitPlan(f.member, first.id, { version: first.version })
  let second = f.domain.createPlan(f.peer, { ...f.input, title: '第二项提议' })
  second = f.domain.submitPlan(f.peer, second.id, { version: second.version })
  const combined = f.domain.mergePlans(f.manager, { planIds: [first.id, second.id], title: '统一团队目标', reason: '合并成果范围' })
  const peerSource = f.domain.bootstrap(f.peer).plans.find(plan => plan.id === first.id)!
  assert.equal(peerSource.isTemporary, true)
  assert.notEqual(peerSource.temporaryReason, first.temporaryReason)
  assert.equal(f.store.get<MonthlyPlan>('plans', first.id)!.temporaryReason, first.temporaryReason)
  assert.throws(() => f.domain.updatePlan(f.member, combined.id, { version: combined.version, title: '篡改整体承诺' }), { status: 403 })
  const carry = f.domain.carryPlan(f.manager, combined.id, { requestId: 'temporary-merged-carry', sourceVersion: combined.version, operationEpoch: getOperationEpoch(f.store), month: '2026-10', dueDate: '2026-10-31', reason: '延续团队目标' })
  assert.throws(() => f.domain.updatePlan(f.member, carry.id, { version: carry.version, title: '篡改承接团队目标' }), { status: 403 })
})

test('monthly UI exposes member temporary drafts and hides peer and standard edit controls', t => {
  const f = fixture(t), plan = f.domain.createPlan(f.member, f.input)
  const render = (actor: User) => renderToStaticMarkup(createElement(Monthly, { data: f.domain.bootstrap(actor), refresh: async () => {}, notify: () => {}, intent: { month: plan.month } }))
  const memberMarkup = render(f.member)
  assert.match(memberMarkup, /新增临时目标/)
  assert.match(memberMarkup, />编辑<\/button>/)
  assert.match(memberMarkup, />提交<\/button>/)
  assert.doesNotMatch(memberMarkup, />新增月度目标<\/button>/)
  assert.doesNotMatch(render(f.peer), new RegExp(plan.title))
  const submitted = f.domain.submitPlan(f.member, plan.id, { version: plan.version })
  assert.doesNotMatch(render(f.member), />编辑<\/button>/)
  assert.equal(submitted.status, 'submitted')
})

test('HTTP monthly endpoints authorize member temporary submission while reserving review and carry for managers', async t => {
  const f = fixture(t), server = createApp({ store: f.store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const cookie = `lab_session=${createSession(f.store, f.member)}`
  const request = (path: string, body: unknown, method = 'POST') => fetch(`${origin}/api${path}`, { method, headers: { origin, cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
  try {
    const response = await request('/plans', f.input)
    assert.equal(response.status, 201)
    const plan = await response.json() as MonthlyPlan
    assert.equal((await request(`/plans/${plan.id}`, { version: plan.version, temporaryReason: '调整阶段目标' }, 'PATCH')).status, 200)
    assert.equal((await request(`/plans/${plan.id}/submit`, { version: plan.version + 1 })).status, 200)
    assert.equal((await request(`/plans/${plan.id}/review`, { version: plan.version + 2, decision: 'approve' })).status, 403)
    assert.equal((await request(`/plans/${plan.id}/carry`, { month: '2026-10', dueDate: '2026-10-31', reason: '继续' })).status, 403)
    assert.equal((await request('/plans', { ...f.input, ownerId: f.peer.id })).status, 403)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})
