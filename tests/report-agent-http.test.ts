import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { randomBytes } from 'node:crypto'
import type { Report } from '../shared/types.ts'
import type { ReportAgentJob, ReportAssetSummary, ReportTemplate } from '../shared/report-agent.ts'
import { Store } from '../server/store.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { runReportAgentWorker } from '../server/report-agent-jobs.ts'
import { getReportSchedule, runScheduledReports, updateReportSchedule } from '../server/scheduler.ts'
import { fixture, p } from './report-docx-fixtures.ts'

async function setup(t: TestContext) {
  const store = new Store(':memory:')
  const user = (id: string, role: 'manager' | 'member') => store.insert<StoredUser>('users', { id, name: id, email: `${id}@agent-http.test`, role, active: true, position: '', passwordHash: 'session-only', credentialVersion: 1 })
  const manager = user('manager', 'manager'), member = user('member', 'member')
  const cookies = new Map([manager, member].map(user => [user.id, `lab_session=${createSession(store, user)}`]))
  const server = createApp({ store, enableScheduler: false }).listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); store.close() })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const request = (path: string, body?: unknown, actor = manager.id, method = body === undefined ? 'GET' : 'POST', headers: Record<string, string> = {}) => fetch(base + path, { method, headers: { ...(actor ? { cookie: cookies.get(actor)! } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  return { store, manager, member, request }
}

test('report upload authorizes before large body parsing and keeps normal route limits', async t => {
  const f = await setup(t), contentBase64 = (await fixture(p('测试'), { 'word/media/image.png': randomBytes(280_000) })).toString('base64')
  const input = { filename: '测试.docx', contentBase64, purpose: 'template' }
  assert.equal((await f.request('/report-agent/assets', input, '')).status, 401)
  assert.equal((await f.request('/report-agent/assets', input, f.member.id)).status, 403)
  assert.equal((await f.request('/report-agent/assets', input, f.manager.id, 'POST', { Origin: 'https://untrusted.example' })).status, 403)
  const response = await f.request('/report-agent/assets', input)
  assert.equal(response.status, 201)
  const asset = await response.json() as ReportAssetSummary
  assert.equal('contentBase64' in asset, false)
  assert.equal((await f.request(`/report-agent/assets/${asset.id}/download`, undefined, f.member.id)).status, 403)
  const download = await f.request(`/report-agent/assets/${asset.id}/download`)
  assert.equal(download.status, 200)
  assert.equal(download.headers.get('x-content-sha256'), asset.sha256)
  assert.deepEqual(Buffer.from(await download.arrayBuffer()), Buffer.from(contentBase64, 'base64'))
  assert.equal((await f.request('/reports', { type: 'weekly', period: '2026-09-21', padding: 'a'.repeat(300000) })).status, 413)
  const editing = { padding: 'a'.repeat(300000) }
  assert.equal((await f.request('/report-agent/reports/missing', editing, f.member.id, 'PATCH')).status, 403)
  assert.equal((await f.request('/report-agent/reports/missing', editing, f.manager.id, 'PATCH')).status, 400, 'large edit reaches schema validation instead of generic body rejection')
  assert.equal((await f.request('/report-agent/assets', { ...input, padding: 'a'.repeat(18 * 1024 * 1024) })).status, 413)
  assert.equal(f.store.list('reportAssets').length, 1)
})

test('HTTP template review, job, versioned preview and final archive form a closed workflow', async t => {
  const f = await setup(t)
  const asset = await (await f.request('/report-agent/assets', { filename: '周报.docx', contentBase64: (await fixture(p('报告标题'))).toString('base64'), purpose: 'template' })).json() as ReportAssetSummary
  let template = await (await f.request('/report-agent/templates', { sourceAssetId: asset.id, name: '周报格式', effectiveWeek: '2026-09-21' })).json() as ReportTemplate
  assert.equal((await f.request(`/report-agent/templates/${template.id}/activate`, { expectedVersion: template.version, layoutVerified: true, layoutNote: '试图跳过试填' })).status, 409)
  template = await (await f.request(`/report-agent/templates/${template.id}`, { expectedVersion: template.version, name: template.name, bindings: [{ regionId: 'p:0', label: '报告标题', kind: 'meta', meta: 'title', required: true }], rules: [], rulesConfirmed: true, exampleAssetIds: [], effectiveWeek: template.effectiveWeek }, f.manager.id, 'PATCH')).json() as ReportTemplate
  template = await (await f.request(`/report-agent/templates/${template.id}/preview`, { expectedVersion: template.version })).json() as ReportTemplate
  template = await (await f.request(`/report-agent/templates/${template.id}/activate`, { expectedVersion: template.version, layoutVerified: true, layoutNote: '已核对' })).json() as ReportTemplate
  assert.equal(template.status, 'active')
  const request = { requestId: 'http-weekly', templateId: template.id, period: '2026-09-21', useAi: false }
  const queued = await f.request('/report-agent/jobs', request)
  assert.equal(queued.status, 202)
  const job = await queued.json() as ReportAgentJob
  assert.equal((await (await f.request('/report-agent/jobs', request)).json() as ReportAgentJob).id, job.id)
  await runReportAgentWorker(f.store)
  let report = await (await f.request(`/report-agent/reports/${job.reportId}`)).json() as Report
  assert.equal((await f.request(`/report-agent/reports/${report.id}/docx?expectedVersion=1`)).status, 409)
  assert.equal((await f.request(`/report-agent/reports/${report.id}/docx?expectedVersion=bad`)).status, 400)
  const preview = await f.request(`/report-agent/reports/${report.id}/docx?expectedVersion=${report.version}`)
  assert.equal(preview.status, 200)
  const finalized = await f.request(`/report-agent/reports/${report.id}/finalize`, { expectedVersion: report.version, reviewNote: '测试核验通过' })
  assert.equal(finalized.status, 200)
  report = await finalized.json() as Report
  const a = await f.request(`/report-agent/reports/${report.id}/docx`), b = await f.request(`/reports/${report.id}/export?format=docx`)
  assert.deepEqual(Buffer.from(await a.arrayBuffer()), Buffer.from(await b.arrayBuffer()))
  assert.equal((await f.request(`/reports/${report.id}`, { version: report.version, narrative: '试图绕过' }, f.manager.id, 'PATCH')).status, 409)
  assert.equal((await f.request('/report-agent', undefined, f.member.id)).status, 403)
})

test('active weekly template suppresses legacy weekly generation with paused scheduler while monthly stays available', async t => {
  const f = await setup(t), schedule = getReportSchedule(f.store)
  updateReportSchedule(f.store, { version: schedule.version, enabled: true, weeklyDay: 3, weeklyTime: '00:00', monthlyDay: 0, monthlyTime: '00:00' })
  const asset = await (await f.request('/report-agent/assets', { filename: 'weekly.docx', contentBase64: (await fixture(p('周报'))).toString('base64'), purpose: 'template' })).json() as ReportAssetSummary
  let template = await (await f.request('/report-agent/templates', { sourceAssetId: asset.id, name: '正式周报', effectiveWeek: '2026-09-21' })).json() as ReportTemplate
  template = await (await f.request(`/report-agent/templates/${template.id}`, { expectedVersion: template.version, name: template.name, bindings: template.bindings, rules: [], rulesConfirmed: true, exampleAssetIds: [], effectiveWeek: template.effectiveWeek }, f.manager.id, 'PATCH')).json() as ReportTemplate
  template = await (await f.request(`/report-agent/templates/${template.id}/preview`, { expectedVersion: template.version })).json() as ReportTemplate
  await f.request(`/report-agent/templates/${template.id}/activate`, { expectedVersion: template.version, layoutVerified: true, layoutNote: '已核对' })
  f.store.insert('settings', { id: 'report-agent-schedule', enabled: false } as never)
  const ids = runScheduledReports(f.store, new Date('2026-09-30T12:00:00+08:00'))
  assert.equal(ids.length, 1)
  assert.equal(f.store.get<Report>('reports', ids[0])!.type, 'monthly')
})
