import test from 'node:test'
import assert from 'node:assert/strict'
import { inflateRawSync } from 'node:zlib'
import { Store } from '../server/store.ts'
import { editReport, exportMarkdown, exportWord, finalizeReport, generateReport, polishReport } from '../server/reports.ts'
import { planOriginLabel, reportMetrics, weeklyAssociationLabel } from '../server/report-metrics.ts'
import { getReportSchedule, runScheduledReports, updateReportSchedule } from '../server/scheduler.ts'
import { buildWorkspaceSearchIndex, filterWorkspaceSearch } from '../src/components/WorkspaceSearch.tsx'
import { buildOverview } from '../src/overview-data.ts'
import type { Bootstrap, MonthlyPlan, Report, Task, User, WeeklyRecord } from '../shared/types.ts'

function fixture() {
  const store = new Store(':memory:')
  const manager = store.insert<User & { passwordHash: string }>('users', { name: '经理', email: 'audit@example.test', role: 'manager', position: '', active: true, passwordHash: 'must-never-leave-store' })
  const plan = (month: string, title: string, patch: Partial<MonthlyPlan> = {}) => store.insert<MonthlyPlan>('plans', {
    month, title, projectId: null, category: '研发', ownerId: manager.id, collaboratorIds: [], expectedOutcome: '交付验证报告', acceptanceCriteria: '评审通过',
    dueDate: `${month}-28`, priority: 'medium', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', ...patch,
  })
  const task = (monthlyPlanId: string, title: string) => store.insert<Task>('tasks', {
    title, monthlyPlanId, ownerId: manager.id, description: '', dueDate: '2026-09-30', status: 'doing', isTemporary: false, temporaryReason: '',
  })
  const record = (task: Task, weekStart: string, commitment: string, patch: Partial<WeeklyRecord> = {}) => store.insert<WeeklyRecord>('weeklyRecords', {
    taskId: task.id, monthlyPlanId: task.monthlyPlanId, ownerId: task.ownerId, weekStart, commitment, actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'planned', submitted: true, ...patch,
  })
  const bootstrap = (): Bootstrap => ({ user: manager, users: [manager], projects: [], annualGoals: [], plans: store.list('plans'), tasks: store.list('tasks'), weeklyRecords: store.list('weeklyRecords'), publications: [], reports: [], aiConfigured: false })
  return { store, manager, plan, task, record, bootstrap }
}

function zipText(buffer: Buffer, fileName: string) {
  for (let i = 0; i < buffer.length - 46; i++) {
    if (buffer.readUInt32LE(i) !== 0x02014b50) continue
    const nameLength = buffer.readUInt16LE(i + 28)
    if (buffer.subarray(i + 46, i + 46 + nameLength).toString() !== fileName) continue
    const size = buffer.readUInt32LE(i + 20), offset = buffer.readUInt32LE(i + 42)
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28)
    const content = buffer.subarray(start, start + size)
    return (buffer.readUInt16LE(i + 10) === 8 ? inflateRawSync(content) : content).toString()
  }
  throw new Error(`ZIP entry missing: ${fileName}`)
}

test('cross-month and subsequently linked plans remain named frozen context without entering the monthly denominator', async () => {
  const f = fixture()
  try {
    const august = f.plan('2026-08', '八月接口交付')
    f.plan('2026-09', '九月模型交付')
    const november = f.plan('2026-11', '十一月承接')
    const oldTask = f.task(august.id, '跨月接口联调')
    f.record(oldTask, '2026-08-31', '跨月验证')
    const linkedTask = f.task(november.id, '紧急排障')
    f.store.update<Task>('tasks', linkedTask.id, linkedTask.version, { temporaryReason: '线上故障支援' })
    f.record(linkedTask, '2026-09-07', '恢复服务', { monthlyPlanId: null })
    const report = generateReport(f.store, 'monthly', '2026-09', f.manager.id)
    assert.equal(reportMetrics(report.snapshot).monthly.total, 1)
    assert.equal(report.snapshot.plans[0].title, '九月模型交付')
    assert.deepEqual(report.snapshot.contextPlans?.map(p => p.id).sort(), [august.id, november.id].sort())
    const markdown = exportMarkdown(report)
    assert.match(markdown, /当期月计划：2026-08 · 八月接口交付/)
    assert.match(markdown, /任务已补关联：2026-11 · 十一月承接/)
    const xml = zipText(await exportWord(report), 'word/document.xml')
    assert.match(xml, /当期月计划：2026-08 · 八月接口交付/)
    assert.match(xml, /任务已补关联：2026-11 · 十一月承接/)
    f.store.update<MonthlyPlan>('plans', august.id, august.version, { title: '后续改名' })
    assert.match(exportMarkdown(f.store.get<Report>('reports', report.id)!), /八月接口交付/)
    const legacy = structuredClone(report.snapshot)
    delete legacy.contextPlans
    assert.doesNotThrow(() => weeklyAssociationLabel(legacy, legacy.weeklyRecords[0]))
    assert.equal(reportMetrics(legacy).monthly.total, 1)
  } finally { f.store.close() }
})

test('searching a historical commitment navigates to its actual week, and never combines separate weeks into a false match', () => {
  const f = fixture()
  try {
    const plan = f.plan('2026-09', '联调计划'), task = f.task(plan.id, '持续联调')
    f.record(task, '2026-08-31', '历史独有接口验收')
    f.record(task, '2026-09-07', '当前独有性能压测')
    const data = f.bootstrap(), index = buildWorkspaceSearchIndex(data, '2026-09-07')
    const old = filterWorkspaceSearch(index, '历史独有接口验收').find(item => item.page === 'weekly')!
    assert.equal(old.intent.weekStart, '2026-08-31')
    assert.equal(old.intent.id, task.id)
    assert.match(old.description, /2026-08-31.*历史独有接口验收/)
    assert.equal(filterWorkspaceSearch(index, '持续联调').find(item => item.page === 'weekly')!.intent.weekStart, '2026-09-07')
    assert.equal(filterWorkspaceSearch(index, '历史独有 当前独有').filter(item => item.page === 'weekly').length, 0)
    assert.equal(filterWorkspaceSearch(index, '经理 历史独有').find(item => item.page === 'weekly')!.intent.weekStart, '2026-08-31')
    data.user = { ...data.user, role: 'member' }
    assert.equal(buildWorkspaceSearchIndex(data).filter(item => item.category === '团队成员').length, 0)
  } finally { f.store.close() }
})

test('merged next-month carryovers preserve both original responsibilities and source months without counting the merged proposals twice', () => {
  const f = fixture()
  try {
    const first = f.plan('2026-08', '算法交付责任'), second = f.plan('2026-08', '评测交付责任')
    const nextFirst = f.plan('2026-09', '算法承接建议', { status: 'merged', sourcePlanId: first.id })
    const nextSecond = f.plan('2026-09', '评测承接建议', { status: 'merged', sourcePlanId: second.id })
    const merged = f.plan('2026-09', '统一验收成果', { status: 'approved', mergedFromIds: [nextFirst.id, nextSecond.id] })
    const report = generateReport(f.store, 'monthly', '2026-08', f.manager.id)
    assert.deepEqual(report.snapshot.nextPlans.map(p => p.id), [merged.id])
    assert.equal(reportMetrics(report.snapshot).monthly.total, 2)
    const source = planOriginLabel(report.snapshot, report.snapshot.nextPlans[0])
    for (const title of ['算法承接建议', '评测承接建议', '算法交付责任', '评测交付责任']) assert.ok(source.includes(title))
    assert.match(report.narrative, /统一验收成果.*未发布草案.*来源：合并/)
    assert.match(exportMarkdown(report), /月计划承接与合并来源/)
    f.store.update<MonthlyPlan>('plans', nextFirst.id, nextFirst.version, { title: '之后的修订' })
    assert.ok(planOriginLabel(f.store.get<Report>('reports', report.id)!.snapshot, merged).includes('算法承接建议'))
  } finally { f.store.close() }
})

test('the overview submitted-review denominator includes returned submissions but excludes untouched drafts', () => {
  const f = fixture()
  try {
    f.plan('2026-09', '等待审核', { status: 'submitted' })
    f.plan('2026-09', '已审核退回', { status: 'returned' })
    f.plan('2026-09', '未提交草稿', { status: 'draft' })
    const result = buildOverview(f.bootstrap(), '2026-09-08')
    assert.equal(result.pending.length, 1)
    assert.equal(result.reviewScope.length, 2)
  } finally { f.store.close() }
})

async function withAI(work: () => Promise<void>) {
  const previous = { AI_BASE_URL: process.env.AI_BASE_URL, AI_API_KEY: process.env.AI_API_KEY, AI_MODEL: process.env.AI_MODEL }
  const previousFetch = globalThis.fetch
  Object.assign(process.env, { AI_BASE_URL: 'https://ai.example.test/v1', AI_API_KEY: 'provider-secret', AI_MODEL: 'test-model' })
  try { await work() } finally {
    globalThis.fetch = previousFetch
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

test('AI failure and whitespace-only output preserve the saved draft, snapshot and audit trail', async () => {
  const f = fixture()
  try {
    const report = generateReport(f.store, 'monthly', '2026-09', f.manager.id)
    await withAI(async () => {
      for (const response of [new Response('failure', { status: 503 }), Response.json({ choices: [{ message: { content: ' \n\t ' } }] })]) {
        globalThis.fetch = async () => response
        await assert.rejects(polishReport(f.store, report.id, report.version, f.manager.id), { status: 502 })
        assert.deepEqual(f.store.get<Report>('reports', report.id), report)
        assert.equal(f.store.list('events').length, 0)
      }
    })
  } finally { f.store.close() }
})

test('AI sends only the explicit polish request and cannot overwrite a concurrent save or finalized report', async () => {
  const f = fixture()
  try {
    f.plan('2026-09', '计划事实')
    const report = generateReport(f.store, 'monthly', '2026-09', f.manager.id)
    await withAI(async () => {
      let requests = 0, transmitted = ''
      globalThis.fetch = async (_url, options) => {
        requests++
        transmitted = String(options?.body)
        editReport(f.store, report.id, report.version, f.manager.id, '另一位管理者已经保存的文字')
        return Response.json({ choices: [{ message: { content: '迟到的模型回复' } }] })
      }
      await assert.rejects(polishReport(f.store, report.id, report.version, f.manager.id), { status: 409 })
      assert.equal(requests, 1)
      assert.ok(!transmitted.includes('must-never-leave-store'))
      assert.ok(!transmitted.includes('provider-secret'))
      const saved = f.store.get<Report>('reports', report.id)!
      assert.equal(saved.narrative, '另一位管理者已经保存的文字')
      assert.deepEqual(saved.snapshot, report.snapshot)
      const finalized = finalizeReport(f.store, report.id, saved.version, f.manager.id)
      await assert.rejects(polishReport(f.store, report.id, finalized.version, f.manager.id), { status: 409 })
      assert.equal(requests, 1, 'finalized reports must be rejected before any provider request')
      assert.equal(f.store.get<Report>('reports', report.id)!.narrative, saved.narrative)
    })
  } finally { f.store.close() }
})

test('a shared weekly/monthly trigger produces exactly two drafts and cannot repeat within either period', () => {
  const f = fixture()
  try {
    updateReportSchedule(f.store, { ...getReportSchedule(f.store), enabled: true, weeklyDay: 3, weeklyTime: '18:00', monthlyDay: 0, monthlyTime: '18:00' })
    const before = new Date('2026-09-30T09:59:59Z'), due = new Date('2026-09-30T10:00:00Z')
    assert.deepEqual(runScheduledReports(f.store, before), [])
    assert.equal(runScheduledReports(f.store, due).length, 2)
    assert.deepEqual(f.store.list<Report>('reports').map(r => [r.type, r.period, r.status]), [['weekly', '2026-09-28', 'draft'], ['monthly', '2026-09', 'draft']])
    assert.deepEqual(runScheduledReports(f.store, new Date('2026-09-30T15:59:00Z')), [])
    assert.equal(f.store.list('scheduleRuns').length, 2)
  } finally { f.store.close() }
})
