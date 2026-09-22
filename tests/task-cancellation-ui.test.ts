import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Bootstrap, Task, User, WeeklyRecord } from '../shared/types.ts'
import { ApiError, SavedResultError } from '../src/api.ts'
import { canCancelTask, submitTaskCancellation, TaskCancellationAction, TaskCancellationModal } from '../src/components/TaskCancellation.tsx'
import { DeletedWeeklyRecordNotice } from '../src/pages/Weekly.tsx'

const entity = { version: 3, createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-22T00:00:00.000Z' }
const manager: User = { ...entity, id: 'manager', name: '管理员', email: 'manager@example.test', role: 'manager', active: true, position: '' }
const member: User = { ...manager, id: 'member', name: '责任成员', role: 'member' }
const task: Task = { ...entity, id: 'old-task', title: '不再使用的旧任务', monthlyPlanId: null, ownerId: member.id, description: '', dueDate: '2026-09-30', status: 'doing', isTemporary: true, temporaryReason: '早期临时录入' }
const row: WeeklyRecord = { ...entity, id: 'old-row', taskId: task.id, ownerId: member.id, monthlyPlanId: null, weekStart: '2026-09-21', commitment: '旧周安排', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'planned', submitted: false }
const deletion = { deletedAt: '2026-09-22T00:00:00.000Z', deletedBy: manager.id, reason: '调整安排' }
function bootstrap(): Bootstrap {
  return { user: manager, users: [manager, member], tasks: [task], weeklyRecords: [{ ...row, deletion }], projects: [], annualGoals: [], plans: [], publications: [], reports: [], aiConfigured: false }
}

test('task cancellation action requires a manager and checks all weeks including drafts and pending review', () => {
  const data = bootstrap()
  const render = () => renderToStaticMarkup(createElement(TaskCancellationAction, { data, task, onCancel: () => {} }))
  assert.equal(canCancelTask(data, task), true)
  assert.match(render(), /作废任务/)
  for (const otherWeek of [
    { ...row, id: 'future-draft', weekStart: '2026-10-12', submitted: false },
    { ...row, id: 'old-submitted', weekStart: '2026-08-03', submitted: true },
    { ...row, id: 'pending', weekStart: '2026-09-28', submitted: true, planApproval: { required: true as const, approvedSubmissionId: null, approvedFingerprint: null } },
  ]) {
    data.weeklyRecords = [{ ...row, deletion }, otherWeek]
    assert.equal(canCancelTask(data, task), false)
    assert.equal(render(), '')
  }
  data.weeklyRecords = []
  data.user = member
  assert.equal(render(), '')
  data.user = manager
  data.tasks = []
  assert.equal(render(), '')
  data.tasks = [{ ...task, cancellation: { cancelledAt: entity.updatedAt, cancelledBy: manager.id, reason: '已作废' } }]
  assert.equal(render(), '')
})

test('deleted weekly notice offers cancellation alongside relinking and recreation only for an orphan task', () => {
  const data = bootstrap()
  const props = { data, record: { ...row, deletion }, onRelink: () => {}, onRecreate: () => {}, onCancelTask: () => {}, onDismiss: () => {} }
  const html = renderToStaticMarkup(createElement(DeletedWeeklyRecordNotice, props))
  for (const label of ['调整原任务月度关联', '沿用原任务重新安排该周', '作废原任务']) assert.ok(html.includes(label))
  data.weeklyRecords.push({ ...row, id: 'other-week', weekStart: '2026-10-05' })
  assert.doesNotMatch(renderToStaticMarkup(createElement(DeletedWeeklyRecordNotice, props)), /作废原任务/)
  data.weeklyRecords = []
  data.user = member
  assert.doesNotMatch(renderToStaticMarkup(createElement(DeletedWeeklyRecordNotice, props)), /作废原任务/)
})

test('cancellation confirmation identifies the task and owner and explains counts, history and alternative continuation', () => {
  const html = renderToStaticMarkup(createElement(TaskCancellationModal, { data: bootstrap(), task, onClose: () => {}, onSaved: async () => {} }))
  for (const phrase of ['不再使用的旧任务', '责任成员', '退出任务总数', '未排周列表及待办', '历史保留', '月度目标保持不变', '补充月度关联或重新安排周工作', '作废原因', '确认作废任务']) assert.ok(html.includes(phrase), phrase)
  assert.match(html, /<textarea[^>]*name="reason"[^>]*required=""/)
})

test('cancellation submits exact task version and trimmed reason, and retries only refresh after a saved mutation', async t => {
  const requests: { url: string; body: unknown; method: string | undefined }[] = []
  t.mock.method(globalThis, 'fetch', async (url: string, options: RequestInit) => {
    requests.push({ url, body: JSON.parse(String(options.body)), method: options.method })
    return new Response(JSON.stringify({ ...task, cancellation: { cancelledAt: entity.updatedAt, cancelledBy: manager.id, reason: '旧任务不再使用' } }), { status: 200 })
  })
  let refreshed = 0
  const onSaved = async () => { if (++refreshed === 1) throw new Error('temporary read failure') }
  await assert.rejects(submitTaskCancellation(bootstrap(), task, '   ', onSaved), /请填写作废原因/)
  assert.equal(requests.length, 0)
  let savedError: SavedResultError | undefined
  try { await submitTaskCancellation(bootstrap(), task, '  旧任务不再使用  ', onSaved) } catch (error) {
    assert.ok(error instanceof SavedResultError)
    savedError = error
  }
  assert.ok(savedError)
  assert.deepEqual(requests, [{ url: '/api/tasks/old-task/cancel', method: 'POST', body: { version: 3, reason: '旧任务不再使用' } }])
  await savedError.retry()
  assert.equal(requests.length, 1)
  assert.equal(refreshed, 2)
})

test('server rejection keeps cancellation unfinished when a concurrent weekly arrangement blocks it', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({ error: '任务仍有未删除周安排' }), { status: 409 }))
  let completed = false
  await assert.rejects(submitTaskCancellation(bootstrap(), task, '不再使用', async () => { completed = true }), (error: unknown) => error instanceof ApiError && error.status === 409)
  assert.equal(completed, false)
})
