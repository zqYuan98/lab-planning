import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createApp } from '../server/app.ts'
import { Store } from '../server/store.ts'
import type { Bootstrap, Task, WeeklyRecord } from '../shared/types.ts'
import { entryLocation, navigationUrl } from '../src/notification-navigation.ts'

test('authenticated personal capture can schedule the same task without granting peer access', async () => {
  const store = new Store(':memory:')
  const server = createApp({ store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  let cookie = ''
  async function request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
    const response = await fetch(`${origin}/api${path}`, {
      method, headers: { origin, cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    const session = response.headers.get('set-cookie')
    if (session) cookie = session.split(';')[0]
    return { status: response.status, data: await response.json() }
  }
  try {
    const input = { requestId: 'capture_api_retry_20260920', titles: ['实验室发展规划提纲', '专题汇报口径确认'], assignedBy: '示例领导', workSource: 'leader' }
    assert.equal((await request('/work-register/capture', input)).status, 401)
    assert.equal((await request('/auth/setup', { name: '测试负责人', email: 'register-manager@example.test', password: 'Preview-only-2026!' })).status, 201)
    const captured = await request('/work-register/capture', input)
    assert.equal(captured.status, 201)
    const tasks = captured.data.tasks as Task[]
    assert.equal(tasks.length, 2)
    assert.equal(tasks[0].dueDate, '')
    const replay = await request('/work-register/capture', input)
    assert.deepEqual(replay.data.tasks.map((row: Task) => row.id), tasks.map(row => row.id))
    assert.equal((await request('/work-register/capture', { ...input, titles: ['另一条任务'] })).status, 409)

    const scheduled = await request('/weekly-assignments', {
      requestId: 'register_schedule_20260920', taskId: tasks[0].id,
      record: { weekStart: '2026-09-14', commitment: '完成规划提纲供讨论', submitted: false },
    })
    assert.equal(scheduled.status, 201)
    const record = scheduled.data.record as WeeklyRecord
    assert.equal(record.taskId, tasks[0].id)
    const data = { tasks: (await request('/workspace/tasks')).data.items as Task[], weeklyRecords: (await request('/workspace/weekly-records')).data.items as WeeklyRecord[] }
    assert.equal(data.tasks.length, 2)
    assert.equal(data.weeklyRecords.length, 1)
    assert.equal(data.tasks.find(row => row.id === record.taskId)?.assignedBy, '示例领导')
    assert.equal(data.weeklyRecords[0].submitted, false)

    const createdMember = await request('/users', { name: '测试成员', email: 'register-member@example.test', password: 'Preview-only-2026!', role: 'member', position: '' })
    assert.equal(createdMember.status, 201)
    await request('/auth/logout', {})
    await request('/auth/login', { email: 'register-member@example.test', password: 'Preview-only-2026!' })
    assert.equal((await request('/workspace/tasks')).data.items.length, 0)
    assert.equal((await request(`/tasks/${tasks[0].id}`, { version: tasks[0].version, currentProgress: '越权修改' }, 'PATCH')).status, 403)
    assert.equal((await request('/work-register/capture', { ...input, requestId: 'invalid_capture_owner_2026', ownerId: tasks[0].ownerId })).status, 403)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    store.close()
  }
})

test('work register URL survives refresh and supports browser history', () => {
  const url = navigationUrl('work-register')
  assert.equal(url, '/work?view=work-register')
  assert.deepEqual(entryLocation(new URL(url, 'http://localhost')), { page: 'work-register', intent: {} })
})
