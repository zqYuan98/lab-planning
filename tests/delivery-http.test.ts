import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { Task } from '../shared/types.ts'
import type { BlockerEpisode } from '../shared/collaboration.ts'
import type { DeliveryMutationResult, TaskDeliveriesView } from '../shared/deliveries.ts'
import type { BlockerView, DecisionRequest } from '../shared/support.ts'
import type { MyActions } from '../shared/my-actions.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { Store } from '../server/store.ts'
import type { DingTalkClient } from '../server/dingtalk.ts'

const provider: DingTalkClient = { configured: false, corpId: '', clientId: '', async getIdentity() { throw new Error('No external I/O') }, async send() { throw new Error('No external I/O') }, async result() { throw new Error('No external I/O') } }
async function fixture(t: TestContext) {
  const store = new Store(':memory:')
  const user = (id: string, role: StoredUser['role']) => store.insert<StoredUser>('users', { id, name: id, email: `${id}@example.test`, role, position: '', active: true, credentialVersion: 1, passwordHash: 'unused' })
  const manager = user('manager', 'manager'), member = user('member', 'member'), coordinator = user('coordinator', 'member'), otherManager = user('other-manager', 'manager'), observer = user('observer', 'observer')
  const server = createApp({ store, enableScheduler: false, dingtalkClient: provider }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close() })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const client = (actor: StoredUser) => {
    const cookie = `lab_session=${createSession(store, actor)}`
    return async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', expected = 200): Promise<T> {
      const response = await fetch(base + path, { method, headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
      const result = await response.text()
      assert.equal(response.status, expected, `${actor.id} ${method} ${path}: ${result}`)
      return JSON.parse(result) as T
    }
  }
  const owner = client(member), admin = client(manager)
  const task = await owner<Task>('/tasks', { title: 'HTTP 完整交付流程', description: '不向协调人展示完整说明', dueDate: '2099-01-20', isTemporary: true, temporaryReason: '实验' }, 'POST', 201)
  return { store, manager, member, coordinator, otherManager, observer, task, owner, admin, coordinatorClient: client(coordinator), otherAdmin: client(otherManager), observerClient: client(observer) }
}

test('HTTP owner submits, only designated reviewer gets action, decision leaves independent task status and retry reprojects current state', async t => {
  const f = await fixture(t)
  const input = { requestId: 'http-delivery-submit', taskVersion: f.task.version, previousRevision: 0, actualOutcome: '三组实验报告', evidenceRefs: ['复核记录已归档'], acceptanceCriteria: '全部三组样本通过复核', reviewerId: f.manager.id }
  const submitted = await f.owner<DeliveryMutationResult>(`/tasks/${f.task.id}/deliveries`, input, 'POST', 201)
  const managerActions = await f.admin<MyActions>('/my-actions'), otherActions = await f.otherAdmin<MyActions>('/my-actions')
  assert.equal(managerActions.items.some(row => row.kind === 'delivery_review' && row.sourceId === submitted.delivery.id), true)
  assert.equal(otherActions.items.some(row => row.kind === 'delivery_review' && row.sourceId === submitted.delivery.id), false)
  const review = { requestId: 'http-delivery-review', seriesVersion: submitted.series.version, action: 'review', conclusion: 'accepted', note: '全部样本通过复核' }
  await f.otherAdmin(`/deliveries/${submitted.delivery.id}/decisions`, review, 'POST', 403)
  const accepted = await f.admin<DeliveryMutationResult>(`/deliveries/${submitted.delivery.id}/decisions`, review)
  assert.equal(accepted.task.status, 'todo')
  assert.equal((await f.owner<TaskDeliveriesView>(`/tasks/${f.task.id}/deliveries`)).items[0].series.status, 'accepted')
  const replay = await f.owner<DeliveryMutationResult>(`/tasks/${f.task.id}/deliveries`, input, 'POST', 201)
  assert.equal(replay.delivery.id, submitted.delivery.id)
  assert.equal(replay.series.status, 'accepted')
  assert.equal((await f.admin<MyActions>('/my-actions')).counts.delivery_review, 0)
  await f.observerClient(`/tasks/${f.task.id}/deliveries`, input, 'POST', 403)
  assert.equal(f.store.list('taskDeliveries').length, 1)
})

test('HTTP assigned unrelated coordinator responds through legacy handler without full task access; manager closes independently and decision owner acts', async t => {
  const f = await fixture(t)
  const blocked = await f.owner<Task>(`/tasks/${f.task.id}`, { version: f.task.version, status: 'blocked', blockerReason: '实验环境故障', blockerImpact: '第三组无法验证', supportNeeded: '恢复环境' }, 'PATCH')
  const episode = f.store.list<BlockerEpisode>('blockerEpisodes').find(row => row.parentTaskId === f.task.id)!
  assert.ok(episode)
  const assigned = await f.admin<{ episode: BlockerEpisode }>(`/blockers/${episode.id}/assign`, { requestId: 'http-support-assign', version: episode.version, coordinatorId: f.coordinator.id, responseDueAt: '2099-01-18T09:00:00Z', reason: '指派环境协调人' })
  await f.coordinatorClient(`/tasks/${f.task.id}/view`, undefined, 'GET', 404)
  const minimal = await f.coordinatorClient<BlockerView>(`/blockers/${episode.id}`)
  assert.equal(minimal.minimalContext, true)
  assert.equal(JSON.stringify(minimal).includes('不向协调人展示完整说明'), false)
  assert.equal((await f.coordinatorClient<MyActions>('/my-actions')).counts.support, 1)
  const responded = await f.coordinatorClient<{ episode: BlockerEpisode }>(`/blockers/${episode.id}/handle`, { requestId: 'http-support-respond', version: assigned.episode.version, action: 'respond', note: '已恢复，执行人可复测' })
  assert.equal((await f.coordinatorClient<MyActions>('/my-actions')).counts.support, 0)
  const closed = await f.admin<{ episode: BlockerEpisode }>(`/blockers/${episode.id}/handle`, { requestId: 'http-support-close', version: responded.episode.version, action: 'close', note: '管理支持已完成' })
  assert.equal(closed.episode.resolvedAt, null)
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.status, 'blocked')
  const request = await f.admin<DecisionRequest>('/decision-requests', { requestId: 'http-decision-create', taskId: f.task.id, taskVersion: blocked.version, question: '是否继续验证', options: ['继续'], decisionOwnerId: f.otherManager.id, responseDueAt: '2099-01-18T09:00:00Z' }, 'POST', 201)
  assert.equal((await f.otherAdmin<MyActions>('/my-actions')).counts.decision, 1)
  const decided = await f.otherAdmin<DecisionRequest>(`/decision-requests/${request.id}/decide`, { requestId: 'http-decision-decide', version: request.version, result: '继续完成本轮验证' })
  assert.equal(decided.status, 'decided')
  assert.equal((await f.otherAdmin<MyActions>('/my-actions')).counts.decision, 0)
})
