import test from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createApp } from '../server/app.ts'
import { Domain } from '../server/domain.ts'
import { Store } from '../server/store.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { shanghaiWeek, fridayDeadline, addWeekDays } from '../server/weekly-submission-clock.ts'
import type { WeeklyRule, WeeklyCycle, WeeklySubmissionView } from '../shared/weekly-submissions.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import type { WeeklyRecord } from '../shared/types.ts'
import { isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'

test('HTTP weekly submission endpoints enforce self scope, atomic receipts and manager-only corrections', async () => {
  const store = new Store(':memory:'), domain = new Domain(store)
  const manager = domain.setup({ name: '管理员', email: 'manager@weekly.test', password: 'weekly-test-pass' })
  const member = domain.createUser(manager, { name: '成员', email: 'member@weekly.test', password: 'weekly-test-pass', role: 'member' })
  const peer = domain.createUser(manager, { name: '其他成员', email: 'peer@weekly.test', password: 'weekly-test-pass', role: 'member' })
  const service = new WeeklySubmissionService(store), rule = service.getRule(), week = shanghaiWeek(new Date())
  store.update<WeeklyRule>('weeklyRules', rule.id, rule.version, { effectiveWeek: week, windows: [{ fromWeek: week, toWeek: null }] })
  store.insert<WeeklyCycle>('weeklyCycles', { id: week, week, deadlineAt: fridayDeadline(week), rosterIds: [member.id, peer.id], needsReview: false, confirmedBy: manager.id, confirmationReason: '测试名单', frozenAt: new Date().toISOString() })
  const server = createApp({ store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  let cookie = ''
  async function request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie
    const json = await response.json(); assert.equal(response.status, expected, JSON.stringify(json)); return json
  }
  try {
    await request('/weekly-submissions', undefined, 401)
    await request('/auth/login', { email: member.email, password: 'weekly-test-pass' })
    const own = await request(`/weekly-submissions?week=${week}`) as WeeklySubmissionView
    assert.deepEqual(own.cycle?.rosterIds, [member.id])
    assert.equal(own.duties.length, 2)
    const peerDuty = service.view(peer, week).duties[0]
    await request('/weekly-submissions/submit', { dutyId: peerDuty.id, version: peerDuty.version, manifest: [], note: '伪造', requestId: 'tamper' }, 403)
    const duty = own.duties[0]
    const input = { dutyId: duty.id, version: duty.version, manifest: [], note: '本周无工作安排', requestId: 'once' }
    const receipt = await request('/weekly-submissions/submit', input)
    assert.equal((await request('/weekly-submissions/submit', input)).id, receipt.id)
    await request('/weekly-submissions/adjust', { dutyId: duty.id, version: 2, action: 'exempt', reason: '自行豁免' }, 403)
    await request('/auth/logout', {})
    await request('/auth/login', { email: manager.email, password: 'weekly-test-pass' })
    const all = await request(`/weekly-submissions?week=${week}`) as WeeklySubmissionView
    assert.equal(all.duties.length, 4)
    await request('/weekly-submissions/submit', { dutyId: peerDuty.id, version: peerDuty.version, manifest: [], note: '无安排', requestId: 'proxy-no-reason' }, 400)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close() }
})

test('HTTP confirmation rejects task progress saved after the weekly preview and accepts a refreshed event snapshot', async () => {
  const store = new Store(':memory:'), domain = new Domain(store)
  const manager = domain.setup({ name: '管理员', email: 'manager@progress.test', password: 'weekly-test-pass' })
  const member = domain.createUser(manager, { name: '成员', email: 'member@progress.test', password: 'weekly-test-pass', role: 'member' })
  const service = new WeeklySubmissionService(store), rule = service.getRule(), week = shanghaiWeek(new Date())
  store.update<WeeklyRule>('weeklyRules', rule.id, rule.version, { effectiveWeek: week, windows: [{ fromWeek: week, toWeek: null }] })
  store.insert<WeeklyCycle>('weeklyCycles', { id: week, week, deadlineAt: fridayDeadline(week), rosterIds: [member.id], needsReview: false, confirmedBy: manager.id, confirmationReason: '测试名单', frozenAt: new Date().toISOString() })
  const task = domain.createTask(manager, { ownerId: member.id, title: '提报核对任务', dueDate: '2099-01-20', isTemporary: true, temporaryReason: '专项支持' })
  domain.createWeeklyRecord(member, { taskId: task.id, weekStart: week, commitment: '交付验证', actualOutcome: '完成第一轮验证', status: 'doing', submitted: true })
  new CollaborationService(store).updateSettings(manager, { requestId: 'enable-api-progress', version: 0, enabled: true, pilotUserIds: [member.id] })
  const server = createApp({ store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  let cookie = ''
  async function request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie
    const json = await response.json(); assert.equal(response.status, expected, JSON.stringify(json)); return json
  }
  try {
    await request('/auth/login', { email: member.email, password: 'weekly-test-pass' })
    const view = await request(`/weekly-submissions?week=${week}`) as WeeklySubmissionView
    const duty = view.duties.find(row => row.kind === 'results')!
    const input = { dutyId: duty.id, version: duty.version, manifest: duty.manifest, progressEventIds: duty.progressEventIds, requestId: 'reviewed-events-once' }
    await request(`/tasks/${task.id}/progress`, { version: task.version, requestId: 'api-progress-command', note: '第二轮验证发现新的关键结论' })
    await request('/weekly-submissions/submit', input, 409)
    assert.equal(store.list('weeklySubmissions').length, 0)
    const refreshed = (await request(`/weekly-submissions?week=${week}`) as WeeklySubmissionView).duties.find(row => row.kind === 'results')!
    assert.deepEqual(refreshed.manifest, duty.manifest)
    assert.equal(refreshed.progressEvents![0].note, '第二轮验证发现新的关键结论')
    const receipt = await request('/weekly-submissions/submit', { ...input, progressEventIds: refreshed.progressEventIds })
    assert.deepEqual(receipt.progressEventIds, refreshed.progressEventIds)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close() }
})

test('HTTP next-week review requires a manager and approves the submitted sheet exactly once', async () => {
  const store = new Store(':memory:'), domain = new Domain(store)
  const manager = domain.setup({ name: '管理员', email: 'manager@review.test', password: 'weekly-test-pass' })
  const member = domain.createUser(manager, { name: '成员', email: 'member@review.test', password: 'weekly-test-pass', role: 'member' })
  const service = new WeeklySubmissionService(store), rule = service.getRule(), week = shanghaiWeek(new Date())
  store.update<WeeklyRule>('weeklyRules', rule.id, rule.version, { effectiveWeek: week, windows: [{ fromWeek: week, toWeek: null }], planReviewEffectiveWeek: week })
  store.insert<WeeklyCycle>('weeklyCycles', { id: week, week, deadlineAt: fridayDeadline(week), rosterIds: [member.id], needsReview: false, confirmedBy: manager.id, confirmationReason: '测试名单', frozenAt: new Date().toISOString() })
  const task = domain.createTask(member, { title: '需审核的自报事项', dueDate: '2099-01-20', isTemporary: true, temporaryReason: '专项支持' })
  const record = domain.createWeeklyRecord(member, { taskId: task.id, weekStart: addWeekDays(week, 7), commitment: '下周交付验证结果' })
  const server = createApp({ store }).listen(0, '127.0.0.1'); await once(server, 'listening')
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  let cookie = ''
  async function request(path: string, body?: unknown, expected = 200) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) })
    cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie
    const json = await response.json(); assert.equal(response.status, expected, JSON.stringify(json)); return json
  }
  try {
    await request('/auth/login', { email: member.email, password: 'weekly-test-pass' })
    let duty = (await request(`/weekly-submissions?week=${week}`) as WeeklySubmissionView).duties.find(row => row.kind === 'plan')!
    const receipt = await request('/weekly-submissions/submit', { dutyId: duty.id, version: duty.version, manifest: duty.manifest, draftAction: 'include', requestId: 'member-review-submit' })
    duty = (await request(`/weekly-submissions?week=${week}`) as WeeklySubmissionView).duties.find(row => row.kind === 'plan')!
    assert.equal(duty.planReviewStatus, 'pending')
    assert.equal(isEffectiveWeeklyRecord(store.get<WeeklyRecord>('weeklyRecords', record.id)!), false)
    const input = { dutyId: duty.id, version: duty.version, submissionId: receipt.id, decision: 'approved', requestId: 'review-command-once' }
    await request('/weekly-submissions/review', input, 403)
    await request('/auth/logout', {})
    await request('/auth/login', { email: manager.email, password: 'weekly-test-pass' })
    const review = await request('/weekly-submissions/review', input)
    assert.equal((await request('/weekly-submissions/review', input)).id, review.id)
    assert.equal(store.list('weeklyPlanReviews').length, 1)
    assert.equal(isEffectiveWeeklyRecord(store.get<WeeklyRecord>('weeklyRecords', record.id)!), true)
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); store.close() }
})
