import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import express, { type Request, type Response, type NextFunction } from 'express'
import { Store } from '../server/store.ts'
import { editReport, finalizeReport, generateReport, polishReport } from '../server/reports.ts'
import { createReportRouter } from '../server/report-routes.ts'
import type { MonthlyPlan, Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { ReportAsset } from '../shared/report-agent.ts'
import { fixture as docxFixture } from './report-docx-fixtures.ts'

function setup() {
  const store = new Store(':memory:')
  const actor = store.insert<User>('users', { name: '经理', email: 'polish@example.test', role: 'manager', position: '', active: true })
  const plan = store.insert<MonthlyPlan>('plans', { month: '2026-09', title: '月目标甲', projectId: null, category: '', ownerId: actor.id, collaboratorIds: [], expectedOutcome: '计划覆盖 900 人', acceptanceCriteria: '通过评审', dueDate: '2026-09-30', priority: 'high', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '试点推进', acceptanceStatus: 'pending', acceptanceNote: '' })
  const make = (title: string, count: number) => {
    const task = store.insert<Task>('tasks', { title, monthlyPlanId: plan.id, ownerId: actor.id, description: '', dueDate: '', status: 'doing', isTemporary: false, temporaryReason: '' })
    const record = store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, monthlyPlanId: plan.id, ownerId: actor.id, weekStart: '2026-09-07', commitment: '计划覆盖 900 人', actualOutcome: `完成 ${count} 人试点`, evidenceUrl: '', blocker: '等待确认', nextAction: '继续验证', status: 'done', submitted: true })
    return { task, record }
  }
  const a = make('项目甲', 620), b = make('项目乙', 250)
  const report = generateReport(store, 'weekly', '2026-09-07', actor.id)
  return { store, actor, plan, a, b, report }
}
const envelope = (candidate: unknown) => Response.json({ choices: [{ message: { content: JSON.stringify(candidate) }, finish_reason: 'stop' }] })
async function withAI(work: () => Promise<void>) {
  const previous = { AI_BASE_URL: process.env.AI_BASE_URL, AI_MODEL: process.env.AI_MODEL, AI_API_KEY: process.env.AI_API_KEY }, fetch = globalThis.fetch
  Object.assign(process.env, { AI_BASE_URL: 'https://model.example.invalid/v1', AI_MODEL: 'test', AI_API_KEY: 'secret' })
  try { await work() } finally {
    globalThis.fetch = fetch
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
}

test('legacy polish accepts structured single-subject facts and archives sentence references in its audit', async () => {
  const f = setup()
  try {
    const sentences = [f.a, f.b].map(({ task, record }) => ({ section: 'outcomes', text: `${task.title}：${record.actualOutcome}。`, factIds: [`weekly:${record.id}:outcome`] }))
    await withAI(async () => {
      let sent = ''
      globalThis.fetch = async (_url, options) => { sent = String(options?.body); return envelope({ sentences }) }
      const result = await polishReport(f.store, f.report.id, f.report.version, f.actor.id)
      assert.match(result.narrative, /项目甲：完成 620 人试点/)
      assert.match(result.narrative, /项目乙：完成 250 人试点/)
      assert.deepEqual(result.snapshot, f.report.snapshot)
      assert.ok(sent.includes('sourceVersion')); assert.ok(!sent.includes('secret'))
      const event = f.store.list<{ action: string; after: { sentences: unknown } }>('events').find(e => e.action === 'polish')
      assert.deepEqual(event?.after.sentences, sentences)
    })
  } finally { f.store.close() }
})

test('wrong-subject numbers, pooled citations, claimed acceptance and plans as outcomes preserve original draft', async () => {
  const f = setup()
  try {
    const invalid = [
      { text: '项目乙完成 620 人试点。', factIds: [`weekly:${f.a.record.id}:outcome`] },
      { text: '项目乙完成 620 人试点。', factIds: [`weekly:${f.a.record.id}:outcome`, `weekly:${f.b.record.id}:outcome`] },
      { text: '项目甲已验收。', factIds: [`weekly:${f.a.record.id}:status`] },
      { text: '项目甲完成 900 人试点。', factIds: [`weekly:${f.a.record.id}:commitment`] },
      { text: '项目甲完成 620 人试点。项目乙通过评审。', factIds: [`weekly:${f.a.record.id}:outcome`] },
    ]
    await withAI(async () => {
      for (const sentence of invalid) {
        globalThis.fetch = async () => envelope({ sentences: [{ section: 'outcomes', ...sentence }] })
        await assert.rejects(polishReport(f.store, f.report.id, f.report.version, f.actor.id), { status: 502 })
        assert.deepEqual(f.store.get('reports', f.report.id), f.report)
        assert.equal(f.store.list('events').length, 0)
      }
    })
  } finally { f.store.close() }
})

test('timeout, malformed or untyped provider output never changes text, snapshot or audit', async () => {
  const f = setup()
  try {
    await withAI(async () => {
      for (const provider of [
        async () => { throw new DOMException('timeout', 'TimeoutError') },
        async () => Response.json({ choices: [{ message: { content: 'not JSON' } }] }),
        async () => envelope({ narrative: 'untyped report text' }),
        async () => envelope({ sentences: [] }),
      ]) {
        globalThis.fetch = provider
        await assert.rejects(polishReport(f.store, f.report.id, f.report.version, f.actor.id), { status: 502 })
        assert.deepEqual(f.store.get('reports', f.report.id), f.report)
        assert.equal(f.store.list('events').length, 0)
      }
    })
  } finally { f.store.close() }
})

test('concurrent human save wins over a late candidate and is not overwritten', async () => {
  const f = setup()
  try {
    await withAI(async () => {
      globalThis.fetch = async () => {
        editReport(f.store, f.report.id, f.report.version, f.actor.id, '管理者最新正文')
        return envelope({ sentences: [{ section: 'outcomes', text: '项目甲完成 620 人试点。', factIds: [`weekly:${f.a.record.id}:outcome`] }] })
      }
      await assert.rejects(polishReport(f.store, f.report.id, f.report.version, f.actor.id), { status: 409 })
      assert.equal(f.store.get<Report>('reports', f.report.id)?.narrative, '管理者最新正文')
      assert.deepEqual(f.store.get<Report>('reports', f.report.id)?.snapshot, f.report.snapshot)
    })
  } finally { f.store.close() }
})

test('agent reports cannot be edited, finalized or polished through legacy mutation paths', async () => {
  const f = setup()
  try {
    const agent = f.store.update<Report>('reports', f.report.id, f.report.version, { agent: {} as NonNullable<Report['agent']> })
    assert.throws(() => editReport(f.store, agent.id, agent.version, f.actor.id, 'bypass'), { status: 409 })
    assert.throws(() => finalizeReport(f.store, agent.id, agent.version, f.actor.id), { status: 409 })
    await assert.rejects(polishReport(f.store, agent.id, agent.version, f.actor.id), { status: 409 })
  } finally { f.store.close() }
})

test('legacy docx download returns the exact archived agent bytes', async () => {
  const f = setup(), bytes = await docxFixture(), sha256 = createHash('sha256').update(bytes).digest('hex')
  const asset = f.store.insert<ReportAsset>('reportAssets', { filename: '已定稿原版式.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', size: bytes.length, sha256, contentBase64: bytes.toString('base64'), purpose: 'final', uploadedBy: f.actor.id, inspection: null })
  const report = f.store.update<Report>('reports', f.report.id, f.report.version, { status: 'finalized', agent: { schemaVersion: 'weekly-v1', template: { type: 'weekly' }, finalAssetId: asset.id, finalHash: sha256 } as NonNullable<Report['agent']> })
  const app = express()
  app.use((req, _res, next) => { (req as Request & { user: User }).user = f.actor; next() })
  app.use(createReportRouter(f.store))
  app.use((error: { status?: number; message: string }, _req: Request, res: Response, _next: NextFunction) => res.status(error.status || 500).json({ error: error.message }))
  const server = app.listen(0, '127.0.0.1')
  try {
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const response = await fetch(`http://127.0.0.1:${address.port}/reports/${report.id}/export?format=docx`)
    assert.equal(response.status, 200)
    assert.ok(Buffer.from(await response.arrayBuffer()).equals(bytes), 'download must match archived bytes')
    assert.ok(decodeURIComponent(response.headers.get('content-disposition') || '').includes('已定稿原版式'))
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); f.store.close() }
})
