import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Bootstrap, MonthlyPlan, User } from '../shared/types.ts'
import { monthlyWorkflow, monthlyIntentModal, monthlyPublishInput } from '../src/monthly-workflow.ts'
import { MonthlyBody } from '../src/pages/Monthly.tsx'
import { submitMonthlyPlanDeletion, MonthlyPlanDeletionNotice } from '../src/components/MonthlyPlanDeletionDialog.tsx'
import { SavedResultError } from '../src/api.ts'

const manager: User = { id: 'manager', version: 1, createdAt: '', updatedAt: '', name: '管理者', email: 'manager@example.test', role: 'manager', position: '', active: true }
const member: User = { ...manager, id: 'member', role: 'member', name: '成员' }
const plan: MonthlyPlan = { id: 'proposal', version: 7, createdAt: '', updatedAt: '', month: '2026-11', title: '重复月目标', projectId: null, category: '研发', ownerId: member.id, collaboratorIds: [], expectedOutcome: '交付结果', acceptanceCriteria: '通过验收', dueDate: '2026-11-30', priority: 'medium', status: 'returned', reviewComment: '请核对重复项', publishedVersion: null, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '' }
const deletion = { deletedAt: '2026-11-06T10:00:00.000Z', deletedBy: manager.id, reason: '与钉钉导入目标重复' }
const deleted = { ...plan, version: 8, deletion }
const data = (actor: User, plans: MonthlyPlan[] = [plan]): Bootstrap => ({ user: actor, users: [manager, member], projects: [], plans, tasks: [], weeklyRecords: [], annualGoals: [], publications: [], reports: [], aiConfigured: false })

test('deletion presentation permits manager review cleanup and only offers member proposals for authoritative preview', () => {
  for (const status of ['draft', 'returned', 'submitted', 'approved'] as const) assert.equal(monthlyWorkflow({ ...plan, status }, manager).canDelete, true, status)
  for (const status of ['draft', 'returned'] as const) {
    assert.equal(monthlyWorkflow({ ...plan, status }, member).canDelete, true, 'legacy ordinary proposals require the server creation audit')
    assert.equal(monthlyWorkflow({ ...plan, status, isTemporary: true }, member).canDelete, true)
  }
  for (const target of [deleted, { ...plan, status: 'published' as const }, { ...plan, status: 'merged' as const }, { ...plan, publishedVersion: 1 }, { ...plan, visibility: 'historical' as const }]) {
    assert.equal(monthlyWorkflow(target, manager).canDelete, false)
    assert.equal(monthlyWorkflow(target, member).canDelete, false)
  }
  for (const target of [{ ...plan, status: 'submitted' as const }, { ...plan, status: 'approved' as const }, { ...plan, ownerId: 'peer' }, { ...plan, importSource: { batchId: 'b', sourceId: 's', rowId: 'r', sourceStatus: '' } }]) assert.equal(monthlyWorkflow(target, member).canDelete, false)
  assert.equal(monthlyWorkflow(plan, { ...manager, active: false }).canDelete, false)
  assert.equal(monthlyWorkflow(plan, { ...manager, role: 'observer' }).canDelete, false)
})

test('deleted targets and old action links are always read-only and cannot enter a publication request', () => {
  for (const actor of [manager, member]) {
    for (const status of ['draft', 'returned', 'submitted', 'approved', 'published', 'merged'] as const) {
      const target = { ...deleted, status }, flow = monthlyWorkflow(target, actor)
      assert.equal(flow.primary, null)
      assert.equal(flow.canEdit || flow.canSubmit || flow.canReview || flow.canPublish || flow.canCreateOwnTask || flow.canResult || flow.canDelete, false)
      assert.equal(flow.stateLabel, '已删除')
      for (const action of ['submit', 'review', 'publish', 'create-task', 'result'] as const) assert.equal(monthlyIntentModal(target, actor, action), 'detail')
    }
  }
  assert.throws(() => monthlyPublishInput([{ ...deleted, status: 'approved' }], '发布'), /重新核对/)
})

test('deleted detail exposes cause and history while an old review intent cannot expose any write buttons', () => {
  const html = renderToStaticMarkup(createElement(MonthlyBody, { data: data(manager, [deleted]), refresh: async () => {}, notify() {}, intent: { id: deleted.id, month: deleted.month, action: 'review' } }))
  const detail = html.slice(html.indexOf('role="dialog"'))
  assert.match(detail, /已删除 · 只读/)
  assert.match(detail, /与钉钉导入目标重复/)
  assert.match(detail, /操作人：管理者/)
  assert.match(detail, />查看变更历史<\/button>/)
  assert.doesNotMatch(detail, />删除目标<\/button>|>提交审核<\/button>|>审核目标<\/button>|>发布此目标<\/button>|>编辑目标内容<\/button>|>关联个人任务<\/button>/)
  assert.match(html, /已删除<span>1<\/span>/)
  assert.match(html, /当前目标<span>0<\/span>/)
})

test('current monthly rows and all count exclude deleted proposals even when fallback data includes them', () => {
  const active = { ...plan, id: 'retained', title: '保留的目标' }
  const html = renderToStaticMarkup(createElement(MonthlyBody, { data: data(manager, [active, deleted]), refresh: async () => {}, notify() {}, intent: { month: plan.month } }))
  assert.match(html, /保留的目标/)
  assert.doesNotMatch(html, /重复月目标/)
  assert.match(html, /全部<span>1<\/span>/)
  assert.match(html, /已删除<span>1<\/span>/)
})

test('manager review offers a separate deletion confirmation and pending permission reload removes writes', () => {
  const target = { ...plan, status: 'submitted' as const }, props = { data: data(manager, [target]), refresh: async () => {}, notify() {}, intent: { id: target.id, month: target.month, action: 'review' as const } }
  const review = renderToStaticMarkup(createElement(MonthlyBody, props))
  assert.match(review, /type="button" class="button danger"[^>]*>删除重复目标<\/button>/)
  assert.match(review, /保存审核决定/)
  const pending = renderToStaticMarkup(createElement(MonthlyBody, { ...props, period: { value: null, setQuery() {}, reload: async () => {} } }))
  const detail = pending.slice(pending.indexOf('role="dialog"'))
  assert.match(detail, /正在重新读取当前权限/)
  assert.doesNotMatch(detail, />删除目标<\/button>|>审核目标<\/button>|>删除重复目标<\/button>/)
})

test('a redacted historical deletion marker does not fabricate author, time or reason', () => {
  const html = renderToStaticMarkup(createElement(MonthlyPlanDeletionNotice, { plan: { ...deleted, visibility: 'historical', deletion: { deletedAt: '', deletedBy: '', reason: '' } }, data: data(member) }))
  assert.match(html, /已删除 · 只读/)
  assert.doesNotMatch(html, /操作人|删除时间|删除原因|Invalid Date/)
})

test('deletion sends the reviewed version and trimmed reason; failed refresh retries reads only', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  const writes: { url: string; method?: string; body: unknown }[] = []
  globalThis.fetch = async (url, init) => {
    writes.push({ url: String(url), method: init?.method, body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(deleted))
  }
  let reads = 0, saved: SavedResultError | undefined
  try { await submitMonthlyPlanDeletion({ plan, canDelete: true, blockers: [] }, '  重复目标  ', async result => { assert.deepEqual(result, deleted); if (++reads === 1) throw new Error('refresh failed') }) }
  catch (error) { assert.ok(error instanceof SavedResultError); saved = error }
  assert.ok(saved)
  assert.deepEqual(writes, [{ url: '/api/plans/proposal', method: 'DELETE', body: { version: 7, reason: '重复目标' } }])
  await saved.retry()
  assert.equal(reads, 2)
  assert.equal(writes.length, 1)
})

test('blocked previews and blank reasons never issue a delete request', async t => {
  const original = globalThis.fetch; t.after(() => { globalThis.fetch = original })
  let writes = 0
  globalThis.fetch = async () => { writes++; return new Response('{}') }
  await assert.rejects(submitMonthlyPlanDeletion({ plan, canDelete: false, blockers: ['已有任务'] }, '重复', async () => {}), /不能删除/)
  await assert.rejects(submitMonthlyPlanDeletion({ plan: deleted, canDelete: true, blockers: [] }, '重复', async () => {}), /不能删除/)
  await assert.rejects(submitMonthlyPlanDeletion({ plan, canDelete: true, blockers: [] }, '  ', async () => {}), /填写删除原因/)
  assert.equal(writes, 0)
})
