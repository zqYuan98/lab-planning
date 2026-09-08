import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { inflateRawSync } from 'node:zlib'
import { Store } from '../server/store.ts'
import { editReport, exportMarkdown, exportWord, finalizeReport, generateReport } from '../server/reports.ts'
import { reportMetrics, snapshotWarnings, weeklyAssociationLabel } from '../server/report-metrics.ts'
import { getReportSchedule, runScheduledReports, updateReportSchedule } from '../server/scheduler.ts'
import type { AnnualGoal, MonthlyPlan, Report, Task, User, WeeklyRecord } from '../shared/types.ts'

function zipText(buffer: Buffer, fileName: string) {
  for (let i = 0; i < buffer.length - 46; i++) {
    if (buffer.readUInt32LE(i) !== 0x02014b50) continue
    const nameLength = buffer.readUInt16LE(i + 28)
    if (buffer.subarray(i + 46, i + 46 + nameLength).toString() !== fileName) continue
    const size = buffer.readUInt32LE(i + 20), offset = buffer.readUInt32LE(i + 42)
    const dataStart = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28)
    const compressed = buffer.subarray(dataStart, dataStart + size)
    return (buffer.readUInt16LE(i + 10) === 8 ? inflateRawSync(compressed) : compressed).toString()
  }
  throw new Error(`Missing ZIP entry ${fileName}`)
}

function fixture(store: Store) {
  const user = store.insert<User>('users', { name: '经理', email: 'report@test.local', role: 'manager', position: '负责人', active: true })
  const plan = store.insert<MonthlyPlan>('plans', { month: '2026-09', title: '算法交付', projectId: null, category: '算法', ownerId: user.id, collaboratorIds: [], expectedOutcome: '交付评估报告', acceptanceCriteria: '通过评审', dueDate: '2026-09-30', priority: 'high', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '' })
  const task = store.insert<Task>('tasks', { title: '模型评估', monthlyPlanId: plan.id, ownerId: user.id, description: '', dueDate: '2026-09-11', status: 'doing', isTemporary: false, temporaryReason: '' })
  const weekly = (done: boolean) => store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, monthlyPlanId: plan.id, ownerId: user.id, weekStart: '2026-09-07', commitment: '评估', actualOutcome: done ? '完成评估' : '', evidenceUrl: '', blocker: '', nextAction: '', status: done ? 'done' : 'doing', submitted: true })
  return { user, plan, task, weekly }
}

test('full-scope statistics survive selecting three highlights and do not accept monthly outcomes', () => {
  const store = new Store(':memory:')
  try {
    const { user, weekly } = fixture(store)
    for (let i = 0; i < 10; i++) weekly(i < 3)
    const report = generateReport(store, 'weekly', '2026-09-09', user.id)
    const edited = editReport(store, report.id, report.version, user.id, '## TOP 3\n三个已完成重点工作。')
    assert.equal(edited.period, '2026-09-07')
    assert.equal(reportMetrics(edited.snapshot).weekly.total, 10)
    assert.equal(reportMetrics(edited.snapshot).weekly.rate, 30)
    assert.equal(reportMetrics(edited.snapshot).monthly.accepted, 0)
    assert.match(exportMarkdown(edited), /已提交周记录 10 条/)
  } finally { store.close() }
})

test('source changes do not modify saved snapshots; regeneration creates a new revision', () => {
  const store = new Store(':memory:')
  try {
    const { user, plan } = fixture(store)
    const first = generateReport(store, 'monthly', '2026-09', user.id)
    store.update<MonthlyPlan>('plans', plan.id, plan.version, { acceptanceStatus: 'accepted', actualOutcome: '通过评审' })
    assert.equal(store.get<Report>('reports', first.id)!.snapshot.plans[0].acceptanceStatus, 'pending')
    const second = generateReport(store, 'monthly', '2026-09', user.id)
    assert.equal(second.revision, 2)
    assert.notEqual(first.id, second.id)
    assert.equal(reportMetrics(second.snapshot).monthly.rate, 100)
    assert.equal(reportMetrics(first.snapshot).monthly.rate, 0)
  } finally { store.close() }
})

test('annual progress stays independent from monthly plan count', () => {
  const store = new Store(':memory:')
  try {
    const { user, plan } = fixture(store)
    store.insert<AnnualGoal>('annualGoals', { title: '年度方向', year: 2026, target: '建设能力', progress: 42, description: '', ownerId: user.id, status: 'active' })
    const first = generateReport(store, 'monthly', '2026-09', user.id)
    const { id, version, createdAt, updatedAt, ...input } = plan
    for (let i = 0; i < 10; i++) store.insert<MonthlyPlan>('plans', { ...input, title: `未来计划${i}`, month: '2026-12' })
    const second = generateReport(store, 'monthly', '2026-09', user.id)
    assert.equal(first.snapshot.annualGoals[0].progress, 42)
    assert.equal(second.snapshot.annualGoals[0].progress, 42)
    assert.equal(second.snapshot.plans.length, 1)
  } finally { store.close() }
})

test('finalization locks editing, repeated finalization and stale writes', () => {
  const store = new Store(':memory:')
  try {
    const { user } = fixture(store)
    const report = generateReport(store, 'monthly', '2026-09', user.id)
    const final = finalizeReport(store, report.id, report.version, user.id)
    assert.equal(final.status, 'finalized')
    assert.throws(() => editReport(store, final.id, final.version, user.id, 'changed'), { status: 409 })
    assert.throws(() => finalizeReport(store, final.id, final.version, user.id), { status: 409 })
    assert.throws(() => editReport(store, report.id, report.version, user.id, 'stale'), { status: 409 })
  } finally { store.close() }
})

test('empty denominators display no statistics, not zero performance', async () => {
  const store = new Store(':memory:')
  try {
    const user = store.insert<User>('users', { name: '经理', email: 'empty@test.local', role: 'manager', position: '', active: true })
    const report = generateReport(store, 'monthly', '2026-09', user.id)
    assert.equal(reportMetrics(report.snapshot).monthly.rate, null)
    assert.equal(reportMetrics(report.snapshot).weekly.rate, null)
    assert.match(exportMarkdown(report), /暂无统计口径/)
    const word = await exportWord(report)
    assert.equal(word.subarray(0, 2).toString(), 'PK')
  } finally { store.close() }
})

test('scheduler is opt-in, uses Shanghai time and is idempotent after restart', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lab-report-test-')), path = join(dir, 'reports.sqlite')
  let store = new Store(path)
  try {
    fixture(store)
    assert.equal(getReportSchedule(store).enabled, false)
    assert.deepEqual(runScheduledReports(store, new Date('2026-09-11T09:00:00Z')), [])
    const config = getReportSchedule(store)
    updateReportSchedule(store, { ...config, enabled: true, weeklyDay: 5, weeklyTime: '17:00' })
    assert.deepEqual(runScheduledReports(store, new Date('2026-09-11T08:59:00Z')), [])
    assert.equal(runScheduledReports(store, new Date('2026-09-11T09:00:00Z')).length, 1)
    assert.deepEqual(runScheduledReports(store, new Date('2026-09-11T09:01:00Z')), [])
    store.close(); store = new Store(path)
    assert.deepEqual(runScheduledReports(store, new Date('2026-09-11T10:00:00Z')), [])
    assert.equal(store.list<Report>('reports').length, 1)
    assert.equal(store.list<Report>('reports')[0].period, '2026-09-07')
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }) }
})

test('monthly schedule creates current month on last day and preceding month on other days', () => {
  const store = new Store(':memory:')
  try {
    fixture(store)
    updateReportSchedule(store, { ...getReportSchedule(store), enabled: true, monthlyDay: 0, monthlyTime: '18:00' })
    runScheduledReports(store, new Date('2026-09-30T10:00:00Z'))
    assert.equal(store.list<Report>('reports').filter(r => r.type === 'monthly')[0].period, '2026-09')
    updateReportSchedule(store, { ...getReportSchedule(store), monthlyDay: 1 })
    runScheduledReports(store, new Date('2026-10-01T10:00:00Z'))
    assert.equal(store.list<Report>('reports').filter(r => r.type === 'monthly').length, 1)
  } finally { store.close() }
})

test('snapshot users are sanitized and members cannot generate reports', () => {
  const store = new Store(':memory:')
  try {
    const { user } = fixture(store)
    store.update<User & { passwordHash: string }>('users', user.id, user.version, { passwordHash: 'secret-hash' })
    const report = generateReport(store, 'monthly', '2026-09', user.id)
    assert.ok(!JSON.stringify(report.snapshot).includes('secret-hash'))
    const member = store.insert<User>('users', { name: '成员', email: 'member@test.local', role: 'member', position: '', active: true })
    assert.throws(() => generateReport(store, 'monthly', '2026-09', member.id), { status: 403 })
  } finally { store.close() }
})

test('Word export contains proper OOXML tables, repeated headers and pagination', async () => {
  const store = new Store(':memory:')
  try {
    const { user, weekly } = fixture(store)
    weekly(true)
    const word = await exportWord(generateReport(store, 'monthly', '2026-09', user.id))
    const xml = zipText(word, 'word/document.xml')
    assert.match(xml, /<w:tbl>/)
    assert.match(xml, /<w:tblHeader/)
    assert.match(xml, /完整月计划事实明细/)
    assert.match(xml, /完整周记录事实明细/)
    assert.match(xml, /w:w="11906"/)
    assert.ok(!xml.includes('| --- |'))
    assert.match(zipText(word, 'word/footer1.xml'), /NUMPAGES/)
  } finally { store.close() }
})

test('next month excludes merged source proposals and marks remaining plans as drafts', () => {
  const store = new Store(':memory:')
  try {
    const { user, plan } = fixture(store)
    const { id, version, createdAt, updatedAt, ...input } = plan
    store.insert<MonthlyPlan>('plans', { ...input, title: '已合并源提报', month: '2026-10', status: 'merged' })
    store.insert<MonthlyPlan>('plans', { ...input, title: '新的下月承诺', month: '2026-10', status: 'draft' })
    const report = generateReport(store, 'monthly', '2026-09', user.id)
    assert.equal(report.snapshot.nextPlans.length, 1)
    assert.match(report.narrative, /未发布草案，待审核发布/)
    assert.ok(!report.narrative.includes('已合并源提报'))
  } finally { store.close() }
})

test('historical temporary records distinguish unresolved and subsequently linked tasks', () => {
  const store = new Store(':memory:')
  try {
    const { user, plan, task, weekly } = fixture(store)
    const record = weekly(false)
    store.update<WeeklyRecord>('weeklyRecords', record.id, record.version, { monthlyPlanId: null })
    const temp = store.update<Task>('tasks', task.id, task.version, { monthlyPlanId: null, isTemporary: true, temporaryReason: '紧急故障支援' })
    const before = generateReport(store, 'weekly', '2026-09-07', user.id)
    assert.ok(snapshotWarnings(before).some(w => w.includes('仍未补充月计划关联')))
    store.update<Task>('tasks', temp.id, temp.version, { monthlyPlanId: plan.id, isTemporary: false })
    const after = generateReport(store, 'weekly', '2026-09-07', user.id)
    assert.equal(after.snapshot.weeklyRecords[0].monthlyPlanId, null)
    assert.ok(!snapshotWarnings(after).some(w => w.includes('仍未补充月计划关联')))
    assert.match(weeklyAssociationLabel(after.snapshot, after.snapshot.weeklyRecords[0]), /当期为临时工作；生成报告时任务已补关联：2026-09/)
    assert.match(weeklyAssociationLabel(after.snapshot, after.snapshot.weeklyRecords[0]), /紧急故障支援/)
    assert.ok(snapshotWarnings(before).some(w => w.includes('仍未补充月计划关联')))
  } finally { store.close() }
})

test('Word preserves historical month attribution, blockers and next actions from full snapshot', async () => {
  const store = new Store(':memory:')
  try {
    const { user, plan, task, weekly } = fixture(store)
    const record = weekly(false)
    store.update<WeeklyRecord>('weeklyRecords', record.id, record.version, { status: 'blocked', blocker: '评测服务器等待资源', nextAction: '协调测试机并于周四复测' })
    const { id, version, createdAt, updatedAt, ...planInput } = plan
    const october = store.insert<MonthlyPlan>('plans', { ...planInput, month: '2026-10', title: '十月承接', dueDate: '2026-10-30' })
    store.update<Task>('tasks', task.id, task.version, { monthlyPlanId: october.id })
    const report = generateReport(store, 'weekly', '2026-09-07', user.id)
    const edited = editReport(store, report.id, report.version, user.id, '仅保留管理者摘要。')
    const xml = zipText(await exportWord(edited), 'word/document.xml')
    assert.match(xml, /周记录月归属与风险协调/)
    assert.match(xml, /当期月计划：2026-09 · 算法交付/)
    assert.match(xml, /评测服务器等待资源/)
    assert.match(xml, /协调测试机并于周四复测/)
    assert.ok(!weeklyAssociationLabel(report.snapshot, report.snapshot.weeklyRecords[0]).includes('十月承接'))
  } finally { store.close() }
})
