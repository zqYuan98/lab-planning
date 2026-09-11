import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import type { Bootstrap, MonthlyPlan, Project, Report, Task, User, WeeklyRecord } from '../shared/types.ts'

test('real HTTP workflow from manager goal to published month, weekly evidence and immutable report', async () => {
  const store = new Store(':memory:')
  const app = createApp({ store, enableScheduler: false })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  function client() {
    let cookie = ''
    return async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', expected = 200): Promise<T> {
      const response = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const setCookie = response.headers.get('set-cookie')
      if (setCookie) cookie = setCookie.split(';')[0]
      const text = await response.text()
      assert.equal(response.status >= 200 && response.status < 300 ? 200 : response.status, expected, `${method} ${path}: ${text}`)
      return (text ? JSON.parse(text) : undefined) as T
    }
  }
  const manager = client(), member = client(), outsider = client()
  try {
    const lead = await manager<User>('/auth/setup', { name: '测试负责人', email: 'manager@example.test', password: 'Fixture-pass-2026!' })
    const person = await manager<User>('/users', { name: '测试算法成员', email: 'member@example.test', password: 'Fixture-pass-2026!', position: '算法', role: 'member' })
    await manager<User>('/users', { name: '测试平台成员', email: 'outsider@example.test', password: 'Fixture-pass-2026!', position: '平台', role: 'member' })
    await member('/auth/login', { email: 'member@example.test', password: 'Fixture-pass-2026!' })
    await outsider('/auth/login', { email: 'outsider@example.test', password: 'Fixture-pass-2026!' })
    const project = await manager<Project>('/projects', { name: '验证项目', code: 'QA-01', description: '隔离测试数据', ownerId: lead.id })
    let plan = await manager<MonthlyPlan>('/plans', { ownerId: person.id, month: '2026-09', title: '形成可验收算法成果', projectId: project.id, category: '算法研发', expectedOutcome: '交付评测和部署包', acceptanceCriteria: '固定测试集评测通过并提供记录', dueDate: '2026-09-30', priority: 'high' })
    await outsider(`/plans/${plan.id}`, { version: plan.version, title: '越权改写' }, 'PATCH', 403)
    plan = await manager<MonthlyPlan>(`/plans/${plan.id}/submit`, { version: plan.version })
    plan = await manager<MonthlyPlan>(`/plans/${plan.id}/review`, { version: plan.version, decision: 'return', comment: '请补充交付版本要求' })
    assert.equal(plan.status, 'returned')
    plan = await manager<MonthlyPlan>(`/plans/${plan.id}`, { version: plan.version, expectedOutcome: '交付 v1 评测记录与部署包' }, 'PATCH')
    plan = await manager<MonthlyPlan>(`/plans/${plan.id}/submit`, { version: plan.version })
    plan = await manager<MonthlyPlan>(`/plans/${plan.id}/review`, { version: plan.version, decision: 'approve', comment: '按此成果发布' })
    await manager('/months/2026-09/publish', { planIds: [plan.id] })
    let data = await member<Bootstrap>('/bootstrap')
    plan = data.plans.find(p => p.id === plan.id)!
    assert.equal(plan.status, 'published')
    assert.equal((await outsider<Bootstrap>('/bootstrap')).plans.length, 0)
    const task = await member<Task>('/tasks', { title: '补全固定测试集评测', monthlyPlanId: plan.id, description: '输出可重复的评测记录', dueDate: '2026-09-11' })
    let week = await member<WeeklyRecord>('/weekly-records', { taskId: task.id, weekStart: '2026-09-07', commitment: '交付评测记录', status: 'doing', submitted: true })
    week = await member<WeeklyRecord>(`/weekly-records/${week.id}`, { version: week.version, status: 'done', actualOutcome: '已交付评测记录 v1，固定测试集验证通过', evidenceUrl: 'https://example.test/evidence/v1' }, 'PATCH')
    data = await member<Bootstrap>('/bootstrap')
    assert.equal(data.plans.find(p => p.id === plan.id)!.acceptanceStatus, 'pending', 'weekly self completion must not accept monthly result')
    const carried = await member<WeeklyRecord>(`/weekly-records/${week.id}/carry`, { weekStart: '2026-09-14', commitment: '复核剩余边界场景' })
    assert.equal(carried.taskId, task.id)
    assert.equal(carried.status, 'planned')
    assert.equal(carried.actualOutcome, '')
    let report = await manager<Report>('/reports', { type: 'weekly', period: '2026-09-07' })
    const frozen = structuredClone(report.snapshot)
    week = await member<WeeklyRecord>(`/weekly-records/${week.id}`, { version: week.version, actualOutcome: '新增补充说明，原报告应保持不变' }, 'PATCH')
    assert.deepEqual((await manager<Report[]>('/reports')).find(r => r.id === report.id)!.snapshot, frozen)
    report = await manager<Report>(`/reports/${report.id}`, { version: report.version, narrative: report.narrative + '\n管理者补充：下周复核边界场景。' }, 'PATCH')
    report = await manager<Report>(`/reports/${report.id}/finalize`, { version: report.version })
    assert.equal(report.status, 'finalized')
    await manager(`/reports/${report.id}`, { version: report.version, narrative: '不允许覆盖定稿' }, 'PATCH', 409)
    const fresh = await manager<Report>('/reports', { type: 'weekly', period: '2026-09-07' })
    assert.ok(fresh.revision > report.revision)
    plan = (await member<Bootstrap>('/bootstrap')).plans.find(p => p.id === plan.id)!
    plan = await member<MonthlyPlan>(`/plans/${plan.id}/result`, { version: plan.version, actualOutcome: '已提交 v1 部署包及评测记录', acceptanceStatus: 'submitted' })
    plan = await manager<MonthlyPlan>(`/plans/${plan.id}/result`, { version: plan.version, actualOutcome: plan.actualOutcome, acceptanceStatus: 'accepted', acceptanceNote: '按月初标准确认通过' })
    assert.equal(plan.acceptanceStatus, 'accepted')
    assert.equal(person.id, week.ownerId)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    store.close()
  }
})
