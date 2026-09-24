/** Local synthetic-data drill. Never accepts a production database or notification destination. */
import assert from 'node:assert/strict'
import { randomUUID, createHash } from 'node:crypto'
import { constants, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { FeedbackService } from '../server/feedback-service.ts'
import { generateReport, finalizeReport } from '../server/reports.ts'
import { PeriodReviewService } from '../server/period-reviews.ts'
import { CarryWorkflowService } from '../server/carry-workflows.ts'
import { getOperationEpoch, rotateOperationEpoch } from '../server/operation-context.ts'
import { STORAGE_VERSION } from '../server/storage-migrations.ts'
import type { MonthlyPlan } from '../shared/types.ts'

if (process.argv.length > 2) throw new Error('本演练只使用新建的本地合成数据，不接收外部数据库参数')
for (const key of Object.keys(process.env)) if (key.startsWith('DINGTALK_')) delete process.env[key]
delete process.env.APP_ORIGIN; delete process.env.TRUST_PROXY
process.env.DINGTALK_NOTIFICATIONS_ENABLED = 'false'; process.env.DINGTALK_NATIVE_ENABLED = 'false'; process.env.DINGTALK_STREAM_ENABLED = 'false'
process.env.DINGTALK_DEPLOYMENT_ID = `isolated-drill-${randomUUID()}`
const sourceDeploymentId = process.env.DINGTALK_DEPLOYMENT_ID
process.env.COOKIE_SECURE = 'false'; process.env.NODE_ENV = 'test'
const { createApp } = await import('../server/app.ts')
const directory = resolve('output', `restore-drill-${new Date().toISOString().replace(/[:.]/g, '-')}`)
mkdirSync(directory, { recursive: true })
const sourcePath = join(directory, 'source.sqlite'), backupPath = join(directory, 'backup.sqlite'), restoredPath = join(directory, 'restored.sqlite')
const source = new Store(sourcePath), domain = new Domain(source), password = `Fixture-${randomUUID()}!`
let restored: Store | undefined, server: Server | undefined
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const databaseRows = (path: string) => {
  const db = new DatabaseSync(path, { readOnly: true })
  try { assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); return db.prepare('SELECT collection,id,data FROM entities ORDER BY collection,id').all() } finally { db.close() }
}
try {
  const manager = domain.setup({ name: '恢复演练管理员', email: 'manager@restore-drill.invalid', password })
  const member = domain.createUser(manager, { name: '恢复演练成员', email: 'member@restore-drill.invalid', password, role: 'member', position: '合成样本' })
  const now = new Date(), period = now.toISOString().slice(0, 7), [year, month] = period.split('-').map(Number)
  const dueDate = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10)
  const nextMonth = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7), nextDue = new Date(Date.UTC(year, month + 1, 0)).toISOString().slice(0, 10)
  let plan = domain.createPlan(manager, { month: period, title: '恢复演练目标', ownerId: member.id, category: '合成业务', expectedOutcome: '可核对结果', acceptanceCriteria: '校验通过', dueDate })
  plan = domain.submitPlan(manager, plan.id, { version: plan.version }); plan = domain.reviewPlan(manager, plan.id, { version: plan.version, decision: 'approve' })
  domain.publishMonth(manager, period, { planIds: [plan.id] }); plan = source.get<MonthlyPlan>('plans', plan.id)!
  const task = domain.createTask(member, { title: '备份时点任务', monthlyPlanId: plan.id, dueDate })
  const week = new Date(`${period}-15T00:00:00Z`); week.setUTCDate(week.getUTCDate() - (week.getUTCDay() + 6) % 7)
  domain.createWeeklyRecord(member, { taskId: task.id, weekStart: week.toISOString().slice(0, 10), commitment: '核对恢复资料', submitted: true, status: 'doing' })
  const generated = generateReport(source, 'monthly', period, manager.id), report = finalizeReport(source, generated.id, generated.version, manager.id)
  const imageBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVBhXY/jPwPCfARkAAB7zAf+x9MCaAAAAAElFTkSuQmCC'
  const feedback = new FeedbackService(source).create(member, { requestId: randomUUID(), description: '恢复演练截图', attachments: [{ name: 'fixture.png', mimeType: 'image/png', dataBase64: imageBase64 }] })
  const epoch = getOperationEpoch(source)
  const carry = new CarryWorkflowService(source).create(manager, { operationEpoch: epoch, requestId: randomUUID(), sourcePlanId: plan.id, sourceVersion: plan.version, targetMonth: nextMonth, dueDate: nextDue, remainingWork: '下月继续核对', reason: '恢复跨期流程验证' })
  const reviews = new PeriodReviewService(source), preview = reviews.preview(manager, { period, cutoffAt: new Date().toISOString() })
  let review = reviews.create(manager, { ...preview, requestId: randomUUID() })
  review = reviews.finalize(manager, review.id, { operationEpoch: epoch, requestId: randomUUID(), version: review.version, contentHash: review.contentHash })
  createApp({ store: source, enableScheduler: false }) // Persist startup defaults before taking the recovery point.
  const expected = databaseRows(sourcePath), recoveryPointAt = new Date().toISOString(), begin = performance.now()
  const connection = new DatabaseSync(sourcePath, { readOnly: true })
  try { await backup(connection, backupPath) } finally { connection.close() }
  const backupFinished = performance.now()
  const backupCompletedAt = new Date().toISOString()
  assert.deepEqual(databaseRows(backupPath), expected)
  domain.updateTask(member, task.id, { version: task.version, title: '备份之后源库的新修改', reason: '验证恢复点独立性' })
  const restoreBegin = performance.now()
  copyFileSync(backupPath, restoredPath, constants.COPYFILE_EXCL)
  assert.deepEqual(databaseRows(restoredPath), expected)
  restored = new Store(restoredPath)
  assert.equal(getOperationEpoch(restored), epoch)
  const newEpoch = rotateOperationEpoch(restored)
  assert.notEqual(newEpoch, epoch)
  process.env.DINGTALK_DEPLOYMENT_ID = `isolated-restored-${randomUUID()}`
  assert.notEqual(process.env.DINGTALK_DEPLOYMENT_ID, sourceDeploymentId)
  const app = createApp({ store: restored, enableScheduler: false })
  server = await new Promise<Server>(resolveServer => { const listening = app.listen(0, '127.0.0.1', () => resolveServer(listening)) })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const login = async (email: string) => {
    const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ email, password }) })
    assert.equal(response.status, 200); const cookie = response.headers.get('set-cookie')?.split(';')[0]; assert.ok(cookie); return cookie
  }
  const managerCookie = await login(manager.email), memberCookie = await login(member.email)
  const get = async (path: string, cookie = managerCookie) => { const response = await fetch(`${origin}/api${path}`, { headers: { Cookie: cookie } }); assert.equal(response.status, 200, path); return response }
  const workspace = await (await get('/workspace')).json() as { operationEpoch: string }
  assert.equal(workspace.operationEpoch, newEpoch)
  const restoredTask = await (await get(`/tasks/${task.id}/view`, memberCookie)).json() as { task: { title: string } }
  assert.equal(restoredTask.task.title, '备份时点任务')
  const restoredReview = await (await get(`/period-reviews/${review.id}`)).json()
  assert.deepEqual(restoredReview, review)
  assert.deepEqual(restored.get('carryWorkflows', carry.workflow.id), source.get('carryWorkflows', carry.workflow.id))
  const staleWorkflow = await fetch(`${origin}/api/carry-workflows/${carry.workflow.id}`, { headers: { Cookie: managerCookie } })
  assert.equal(staleWorkflow.status, 409)
  assert.equal((await staleWorkflow.json() as { code: string }).code, 'OPERATION_CONTEXT_CHANGED')
  assert.ok(restored.get('plans', carry.target.id))
  const history = await (await get(`/tasks/${task.id}/history`, memberCookie)).json() as { items: unknown[] }
  assert.ok(history.items.length)
  const markdown = await (await get(`/reports/${report.id}/export?format=md`)).text(); assert.ok(markdown.includes('恢复演练目标'))
  const word = Buffer.from(await (await get(`/reports/${report.id}/export?format=docx`)).arrayBuffer()); assert.equal(word.subarray(0, 2).toString(), 'PK')
  const attachment = Buffer.from(await (await get(`/feedback/${feedback.feedback.id}/attachments/${feedback.attachments[0].id}`, memberCookie)).arrayBuffer())
  assert.equal(sha(attachment), sha(Buffer.from(imageBase64, 'base64')))
  const evidence = {
    observedAt: new Date().toISOString(), environment: { platform: process.platform, node: process.version, sqliteSchema: STORAGE_VERSION, fixture: 'synthetic-local-only', listening: '127.0.0.1 ephemeral port', schedulers: false, notifications: false, native: false, stream: false, distinctDeploymentId: true },
    recoveryPointAt, backupCompletedAt, backupMs: Math.round(backupFinished - begin), restoreAndHttpVerificationMs: Math.round(performance.now() - restoreBegin),
    recoveryPoint: 'All committed synthetic records through backup start; later source modification excluded. No production RPO/RTO claim.',
    paths: { source: sourcePath, backup: backupPath, restored: restoredPath }, backupSha256: sha(readFileSync(backupPath)), protectedRows: expected.length,
    checks: { integrity: true, allRowsExactBeforeEpochReset: true, twoAccountsLogin: true, operationEpochRotated: true, taskAtRecoveryPoint: true, auditHistory: true, frozenReviewExact: true, carryWorkflowRetainedAndOldEpochRejected: true, markdownExport: true, wordExport: true, attachmentBytesExact: true },
    limits: ['Same-machine synthetic recovery only', 'Offsite copies, production independent keys and production recovery objectives not verified'],
  }
  writeFileSync(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({ evidence: join(directory, 'evidence.json'), protectedRows: expected.length, restoreAndHttpVerificationMs: evidence.restoreAndHttpVerificationMs, passed: true }))
} finally {
  if (server) await new Promise<void>((resolveClose, reject) => { server!.close(error => error ? reject(error) : resolveClose()); server!.closeAllConnections() })
  restored?.close(); source.close()
}
