import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { performanceFixture } from '../scripts/r2-performance-fixture.ts'
import type { MonthlyPlan, Task, WeeklyRecord } from '../shared/types.ts'

test('HTTP owner entry returns only current linked DTOs and never grants the general task edit API', async t => {
  const f = performanceFixture(1); t.after(() => f.store.close())
  for (const actor of Object.values(f.actors)) f.store.update<StoredUser>('users', actor.id, actor.version, { credentialVersion: 1 })
  const plan = f.store.get<MonthlyPlan>('plans', 'plan-2026-09-0')!
  f.store.update<MonthlyPlan>('plans', plan.id, plan.version, { ownerId: f.actors.member.id })
  const task = f.store.get<Task>('tasks', 'task-2026-09-01')!
  f.store.update<Task>('tasks', task.id, task.version, { monthlyPlanId: plan.id })
  const record = f.store.get<WeeklyRecord>('weeklyRecords', `weekly-${task.id}-2`)!
  f.store.update<WeeklyRecord>('weeklyRecords', record.id, record.version, { monthlyPlanId: plan.id, evidenceUrl: 'https://private.invalid/r4', actualOutcome: '允许共享的已提交周进展' })
  const server = createApp({ store: f.store }).listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()) }))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const cookie = `lab_session=${createSession(f.store, f.store.get<StoredUser>('users', f.actors.member.id)!)}`
  const read = (path: string) => fetch(base + path, { headers: { cookie } })
  const response = await read(`/workspace/goal-owner/plans/${plan.id}/tasks`)
  assert.equal(response.status, 200)
  const dto = await response.json(); assert.ok(dto.items.some((item: {id:string}) => item.id === task.id))
  const progress = await read(`/workspace/goal-owner/plans/${plan.id}/tasks/${task.id}/weekly`)
  assert.equal(progress.status, 200); const body = await progress.text()
  assert.match(body, /允许共享的已提交周进展/); assert.doesNotMatch(body, /private.invalid|evidenceUrl|description/)
  for (const path of [`/tasks/${task.id}/view`, `/tasks/${task.id}/editable`]) assert.equal((await read(path)).status, 404)
  const edited = await fetch(base + `/tasks/${task.id}`, { method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ version: task.version + 1, title: '越权修改' }) })
  assert.ok([403,404].includes(edited.status)); assert.equal(f.store.get<Task>('tasks', task.id)!.title, task.title)
  const current = f.store.get<MonthlyPlan>('plans', plan.id)!
  f.store.update<MonthlyPlan>('plans', current.id, current.version, { ownerId: 'member-02' })
  assert.equal((await read(`/workspace/goal-owner/plans/${plan.id}/tasks`)).status, 404)
  const outsider = await fetch(base + `/workspace/goal-owner/plans/${plan.id}/tasks`, { headers: { cookie: `lab_session=${createSession(f.store, f.store.get<StoredUser>('users', f.actors.observer.id)!)}` } })
  assert.equal(outsider.status, 404, 'observer route guard hides the business-only route')
})
