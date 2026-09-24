import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { PeriodReviewPreview, PeriodReviewSnapshot } from '../shared/period-reviews.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { Store } from '../server/store.ts'
import { WorkService } from '../server/domain-work.ts'
import type { DingTalkClient } from '../server/dingtalk.ts'

const provider: DingTalkClient = { configured: false, corpId: '', clientId: '', async getIdentity() { throw new Error('No external I/O') }, async send() { throw new Error('No external I/O') }, async result() { throw new Error('No external I/O') } }
test('HTTP history preview/freeze/finalize/export enforce fresh roles and member period projections', async t => {
  const store = new Store(':memory:'), work = new WorkService(store)
  const user = (id: string, role: StoredUser['role']) => store.insert<StoredUser>('users', { id, role, name: id, email: `${id}@review.test`, active: true, position: '', passwordHash: 'unused', credentialVersion: 1 })
  const manager = user('manager', 'manager'), member = user('member', 'member'), other = user('other', 'member'), observer = user('observer', 'observer')
  const today = new Date().toISOString().slice(0, 10)
  work.createTask(member, { title: '本人历史成果', dueDate: today, isTemporary: true, temporaryReason: '实验' })
  work.createTask(other, { title: '另一成员不应泄露的成果', dueDate: today, isTemporary: true, temporaryReason: '实验' })
  const server = createApp({ store, enableScheduler: false, dingtalkClient: provider }).listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); store.close() })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const cookies = new Map([manager, member, other, observer].map(actor => [actor.id, `lab_session=${createSession(store, actor)}`]))
  async function request<T>(actor: StoredUser, path: string, expected = 200, body?: unknown): Promise<T> {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { cookie: cookies.get(actor.id)!, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) })
    const text = await response.text(); assert.equal(response.status, expected, text)
    return (response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text) as T
  }
  const period = today.slice(0, 7), cutoffAt = new Date().toISOString()
  await request(member, '/period-reviews/preview', 403, { period, cutoffAt })
  await request(observer, '/period-reviews', 404)
  const preview = await request<PeriodReviewPreview>(manager, '/period-reviews/preview', 200, { period, cutoffAt })
  const body = { ...preview, requestId: 'http-review-freeze' }
  const draft = await request<PeriodReviewSnapshot>(manager, '/period-reviews', 201, body)
  assert.equal((await request<PeriodReviewSnapshot>(manager, '/period-reviews', 201, body)).id, draft.id)
  await request(member, `/period-reviews/${draft.id}`, 404)
  const final = await request<PeriodReviewSnapshot>(manager, `/period-reviews/${draft.id}/finalize`, 200, { operationEpoch: preview.operationEpoch, requestId: 'http-review-finalize', version: draft.version, contentHash: draft.contentHash })
  const own = await request<PeriodReviewSnapshot>(member, `/period-reviews/${final.id}`)
  assert.equal(own.entries.length, 1); assert.equal(own.entries[0].ownerId, member.id); assert.equal(own.evidenceCoverage.total, 1)
  assert.equal(JSON.stringify(own).includes('另一成员不应泄露'), false)
  const exported = await request<string>(member, `/period-reviews/${final.id}/export`)
  assert.match(exported, /历史周期复盘/); assert.match(exported, /仅期末已知事实/); assert.doesNotMatch(exported, /另一成员不应泄露/)
  await request(observer, `/period-reviews/${final.id}/export`, 404)
  store.update<StoredUser>('users', manager.id, manager.version, { role: 'observer' })
  await request(manager, `/period-reviews/${final.id}`, 404)
})
