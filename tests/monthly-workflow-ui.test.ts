import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Store } from '../server/store.ts'
import { TestDomain as Domain } from './fixtures/legacy-domain.ts'
import type { MonthlyPlan, User } from '../shared/types.ts'
import { monthlyWorkflow, monthlyIntentModal, monthlyPublishInput } from '../src/monthly-workflow.ts'
import { MonthlyBody } from '../src/pages/Monthly.tsx'

function fixture(t: { after: (callback: () => void) => void }) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const domain = new Domain(store)
  const manager = domain.setup({ name: '管理者', email: 'workflow-manager@example.test', password: 'password123' })
  const member = domain.createUser(manager, { name: '成员', email: 'workflow-member@example.test', password: 'password123', role: 'member', position: '工程师' })
  const peer = domain.createUser(manager, { name: '协作人', email: 'workflow-peer@example.test', password: 'password123', role: 'member', position: '工程师' })
  const plan = domain.createPlan(manager, { month: '2026-11', title: '目标甲', category: '研发', ownerId: member.id, collaboratorIds: [peer.id], expectedOutcome: '交付结果', acceptanceCriteria: '通过核对', dueDate: '2026-11-30' })
  const as = (status: MonthlyPlan['status'], patch: Partial<MonthlyPlan> = {}) => ({ ...plan, status, ...patch })
  const render = (actor: User, target: MonthlyPlan, action?: 'submit' | 'review' | 'publish', extra: MonthlyPlan[] = []) => {
    const data = { ...domain.bootstrap(actor), plans: [target, ...extra] }
    const html = renderToStaticMarkup(createElement(MonthlyBody, { data, refresh: async () => {}, notify: () => {}, intent: { id: target.id, month: target.month, action } }))
    return html.slice(html.indexOf('role="dialog"'))
  }
  return { manager, member, peer, plan, as, render }
}

test('monthly workflow gives managers an actionable next step for every pre-publication state', t => {
  const f = fixture(t)
  for (const [status, action] of [['draft', 'submit'], ['returned', 'submit'], ['submitted', 'review'], ['approved', 'publish']] as const) {
    const flow = monthlyWorkflow(f.as(status), f.manager)
    assert.equal(flow.primary?.action, action, status)
    assert.equal(flow.canPublish, status === 'approved')
    assert.equal(flow.canSubmit, status === 'draft' || status === 'returned')
  }
  assert.equal(monthlyWorkflow(f.as('published', { ownerId: f.manager.id }), f.manager).primary?.action, 'create-task')
})

test('monthly workflow retains member temporary submission and blocks standard or peer approval actions', t => {
  const f = fixture(t)
  for (const actor of [f.member, f.peer]) {
    for (const status of ['draft', 'returned', 'submitted', 'approved', 'published'] as const) {
      const flow = monthlyWorkflow(f.as(status), actor)
      assert.equal(flow.canEdit, false)
      assert.equal(flow.canSubmit, false)
      assert.equal(flow.canReview, false)
      assert.equal(flow.canPublish, false)
      assert.equal(flow.canCreateOwnTask, true)
    }
  }
  const temporary = f.as('draft', { isTemporary: true, temporaryReason: '临时专项' })
  assert.equal(monthlyWorkflow(temporary, f.member).primary?.action, 'submit')
  assert.equal(monthlyWorkflow(temporary, f.peer).canSubmit, false)
  assert.equal(monthlyWorkflow({ ...temporary, status: 'submitted' }, f.member).canEdit, false)
})

test('archived, historical, merged and observer views do not expose publish or submit capabilities', t => {
  const f = fixture(t)
  for (const status of ['draft', 'approved', 'published'] as const) {
    const archived = monthlyWorkflow(f.as(status), f.manager, true)
    assert.equal(archived.canSubmit, false)
    assert.equal(archived.canPublish, false)
    assert.equal(archived.canCreateOwnTask, false)
    assert.match(archived.nextStep, /项目已归档/)
  }
  for (const plan of [f.as('draft', { visibility: 'historical' }), f.as('approved', { visibility: 'reference' }), f.as('merged')]) {
    const flow = monthlyWorkflow(plan, f.manager)
    assert.equal(flow.primary, null)
    assert.equal(flow.canEdit || flow.canPublish || flow.canSubmit || flow.canReview || flow.canResult || flow.canCreateOwnTask, false)
  }
  const observer = { ...f.manager, role: 'observer' as const }
  assert.equal(monthlyWorkflow(f.as('approved'), observer).primary, null)
})

test('an explicit single-goal publish intent keeps its scope and cannot bypass role or state checks', t => {
  const f = fixture(t)
  assert.equal(monthlyIntentModal(f.as('approved'), f.manager, 'publish'), 'publish-one')
  assert.equal(monthlyIntentModal(f.as('draft'), f.manager, 'publish'), 'detail')
  assert.equal(monthlyIntentModal(f.as('approved'), f.member, 'publish'), 'detail')
  assert.equal(monthlyIntentModal(f.as('approved'), f.manager, 'publish', true), 'detail')
  assert.equal(monthlyIntentModal(f.as('draft'), f.manager, 'submit'), 'submit')
})

test('publish requests include exactly the visible selected goal versions', t => {
  const f = fixture(t), first = f.as('approved', { version: 4 }), second = { ...first, id: 'another-goal', version: 8 }
  const request = monthlyPublishInput([first], '确认单条发布')
  assert.deepEqual(request, { planIds: [first.id], planVersions: { [first.id]: 4 }, reason: '确认单条发布' })
  first.version = 5
  assert.equal(request.planVersions[first.id], 4, 'a prepared request must not silently adopt a later version')
  assert.deepEqual(monthlyPublishInput([first, second], '').planVersions, { [first.id]: 5, [second.id]: 8 })
  for (const invalid of [[], [f.as('draft')], [f.as('approved', { visibility: 'historical' })], [first, { ...second, month: '2026-12' }]]) assert.throws(() => monthlyPublishInput(invalid, ''))
})

test('goal details expose clear submit, review and publish actions instead of an execution-only dead end', t => {
  const f = fixture(t)
  assert.match(f.render(f.manager, f.as('draft')), />提交审核<\/button>/)
  assert.match(f.render(f.manager, f.as('submitted')), />审核目标<\/button>/)
  assert.match(f.render(f.manager, f.as('approved')), />发布此目标<\/button>/)
  const member = f.render(f.member, f.as('draft'))
  assert.match(member, /等待管理员核对并提交审核/)
  assert.doesNotMatch(member, />提交审核<\/button>|>审核目标<\/button>|>发布此目标<\/button>/)
})

test('single-goal confirmation names only the requested goal even with other approved goals in the month', t => {
  const f = fixture(t)
  const html = f.render(f.manager, f.as('approved'), 'publish', [f.as('approved', { id: 'other', title: '本次不发布的目标乙' })])
  assert.match(html, /本次仅发布下面这 1 条目标/)
  assert.match(html, /目标甲/)
  assert.doesNotMatch(html, /本次不发布的目标乙/)
  assert.match(html, /确认发布这 1 条目标/)
})
