import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { MonthlyService } from '../server/domain-plans.ts'
import { Store } from '../server/store.ts'
import type { Entity, MonthlyPlan, Publication } from '../shared/types.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), monthly = new MonthlyService(store)
  t.after(() => store.close())
  const user = (id: string, role: StoredUser['role']) => store.insert<StoredUser>('users', {
    id, name: id, email: `${id}@example.test`, role, active: true, position: '', passwordHash: 'unused', credentialVersion: 1,
  })
  const manager = user('manager', 'manager'), member = user('member', 'member'), observer = user('observer', 'observer')
  const approve = (title: string, month = '2026-11') => {
    let plan = monthly.create(manager, { title, month, ownerId: member.id, category: '研发',
      expectedOutcome: '提交验证报告', acceptanceCriteria: '评审通过', dueDate: `${month}-20` })
    plan = monthly.submit(manager, plan.id, { version: plan.version })
    return monthly.review(manager, plan.id, { version: plan.version, decision: 'approve' })
  }
  const snapshot = () => store.selectRows('SELECT collection,id,version,data FROM entities ORDER BY collection,id')
  return { store, monthly, manager, member, observer, approve, snapshot }
}
const payload = (plans: MonthlyPlan[]) => ({ planIds: plans.map(plan => plan.id), planVersions: Object.fromEntries(plans.map(plan => [plan.id, plan.version])) })
const conflict = { status: 409, code: 'VERSION_CONFLICT' }

test('publication requires an exact version manifest and never infers missing versions', t => {
  const f = fixture(t), plan = f.approve('完整发布版本'), baseline = f.snapshot()
  const inherited = Object.create({ [plan.id]: plan.version })
  for (const versions of [undefined, null, [], {}, inherited, { [plan.id]: '3' }, { [plan.id]: 0 },
    { [plan.id]: 1.5 }, { [plan.id]: NaN }, { [plan.id]: plan.version, extra: 1 }, { unknown: plan.version }]) {
    assert.throws(() => f.monthly.publish(f.manager, plan.month, { planIds: [plan.id], planVersions: versions }), conflict)
    assert.deepEqual(f.snapshot(), baseline)
  }
})

test('a changed approved goal invalidates the whole pending publication, including unchanged siblings', t => {
  const f = fixture(t), first = f.approve('第一项目标'), second = f.approve('第二项目标')
  const preview = payload([first, second])
  const changed = f.monthly.update(f.manager, second.id, { version: second.version, expectedOutcome: '确认后修改的新范围' })
  assert.equal(changed.status, 'approved', 'manager editing behavior remains unchanged')
  const baseline = f.snapshot()
  assert.throws(() => f.monthly.publish(f.manager, first.month, preview), conflict)
  assert.deepEqual(f.snapshot(), baseline)
  assert.equal(f.store.get<MonthlyPlan>('plans', first.id)?.status, 'approved')
  assert.equal(f.store.list('publications').length, 0)
})

test('matching versions do not bypass approval or month scope and failures are atomic', t => {
  const f = fixture(t), first = f.approve('待发布目标'), differentMonth = f.approve('其他月份', '2026-12')
  const draft = f.monthly.create(f.manager, { title: '尚未审核', month: first.month, ownerId: f.member.id,
    category: '研发', expectedOutcome: '报告', acceptanceCriteria: '通过', dueDate: '2026-11-20' })
  for (const second of [differentMonth, draft]) {
    const baseline = f.snapshot()
    assert.throws(() => f.monthly.publish(f.manager, first.month, payload([first, second])), { status: 409 })
    assert.deepEqual(f.snapshot(), baseline)
  }
})

test('publication commits only confirmed versions and preserves its immutable snapshot', t => {
  const f = fixture(t), first = f.approve('已确认第一项'), second = f.approve('已确认第二项')
  const publication = f.monthly.publish(f.manager, first.month, payload([first, second]))
  assert.equal(publication.plans.length, 2)
  assert.ok(publication.plans.every(plan => plan.status === 'published' && plan.publishedVersion === publication.revision))
  const published = f.store.get<MonthlyPlan>('plans', first.id)!
  f.monthly.update(f.manager, first.id, { version: published.version, expectedOutcome: '发布后的新范围', reason: '新增交付需求' })
  assert.equal(f.store.get<Publication>('publications', publication.id)?.plans.find(plan => plan.id === first.id)?.expectedOutcome, first.expectedOutcome)
  const beforeRetry = f.snapshot()
  assert.throws(() => f.monthly.publish(f.manager, first.month, payload([first, second])), conflict)
  assert.deepEqual(f.snapshot(), beforeRetry)
})

test('publication rechecks live role and account eligibility even with valid preview versions', t => {
  const f = fixture(t), plan = f.approve('权限验证'), input = payload([plan])
  for (const actor of [f.member, f.observer]) assert.throws(() => f.monthly.publish(actor, plan.month, input), { status: 403 })
  for (const patch of [{ role: 'member' as const }, { role: 'observer' as const }, { role: 'manager' as const, active: false }]) {
    const current = f.store.get<StoredUser>('users', f.manager.id)!
    f.store.update<StoredUser>('users', current.id, current.version, patch)
    const baseline = f.snapshot()
    assert.throws(() => f.monthly.publish(f.manager, plan.month, input), { status: 403 })
    assert.deepEqual(f.snapshot(), baseline)
  }
})

test('a failure while creating the publication snapshot rolls back every selected goal and side effect', t => {
  const f = fixture(t), first = f.approve('事务第一项'), second = f.approve('事务第二项'), baseline = f.snapshot()
  const original = f.store.insert.bind(f.store)
  f.store.insert = <T extends Entity>(collection: string, value: Omit<T, keyof Entity> & Partial<Entity>): T => {
    if (collection === 'publications') throw new Error('Injected snapshot failure')
    return original<T>(collection, value)
  }
  assert.throws(() => f.monthly.publish(f.manager, first.month, payload([first, second])), /Injected snapshot failure/)
  assert.deepEqual(f.snapshot(), baseline)
})

test('HTTP publication rejects legacy bodies, stale previews and unprivileged accounts', async t => {
  const f = fixture(t), server = createApp({ store: f.store, enableScheduler: false }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const cookies = new Map([f.manager, f.member, f.observer].map(actor => [actor.id, `lab_session=${createSession(f.store, actor)}`]))
  const plan = f.approve('HTTP发布目标'), input = payload([plan])
  const send = async (actor: StoredUser, body: unknown, expected: number) => {
    const response = await fetch(`${base}/months/${plan.month}/publish`, { method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookies.get(actor.id)! }, body: JSON.stringify(body) })
    const value = await response.json()
    assert.equal(response.status, expected, JSON.stringify(value))
    return value
  }
  assert.equal((await send(f.manager, { planIds: [plan.id] }, 409)).code, 'VERSION_CONFLICT')
  await send(f.member, input, 403)
  await send(f.observer, input, 403)
  const changed = f.monthly.update(f.manager, plan.id, { version: plan.version, title: 'HTTP预览后修改' })
  assert.equal((await send(f.manager, input, 409)).code, 'VERSION_CONFLICT')
  assert.equal(f.store.list('publications').length, 0)
  const confirmed = await send(f.manager, payload([changed]), 200)
  assert.equal(confirmed.plans[0].title, changed.title)
})
