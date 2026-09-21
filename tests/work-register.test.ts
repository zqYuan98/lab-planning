import assert from 'node:assert/strict'
import test from 'node:test'
import type { Task, User, WeeklyRecord } from '../shared/types'
import { buildWorkRegister, createWorkRegisterSnapshot, workRegisterToday } from '../shared/work-register'
import { workRegisterReportCsv } from '../src/work-register-export'

const entity = { version: 1, createdAt: '2025-12-01T00:00:00.000Z', updatedAt: '2025-12-01T00:00:00.000Z' }
const user: User = { ...entity, id: 'owner', name: '本人', email: 'owner@example.test', role: 'member', position: '', active: true }
const today = '2026-01-01'
const currentWeek = '2025-12-29'
function task(id: string, patch: Partial<Task> = {}): Task {
  return { ...entity, id, title: id, monthlyPlanId: null, ownerId: user.id, description: '', dueDate: '', status: 'todo', isTemporary: true, temporaryReason: '领导交办', ...patch }
}
function weekly(id: string, taskId: string, weekStart: string, patch: Partial<WeeklyRecord> = {}): WeeklyRecord {
  return { ...entity, id, taskId, monthlyPlanId: null, ownerId: user.id, weekStart, commitment: '推进事项', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'planned', submitted: false, ...patch }
}

test('Beijing calendar and Monday are stable across UTC day and year boundaries', () => {
  assert.equal(workRegisterToday(new Date('2025-12-31T15:59:59Z')), '2025-12-31')
  assert.equal(workRegisterToday(new Date('2025-12-31T16:00:00Z')), '2026-01-01')
  const result = buildWorkRegister({ user, tasks: [task('old')], weeklyRecords: [] }, { today })
  assert.equal(result.weekStart, currentWeek)
  assert.equal(result.rows.length, 1)
  assert.throws(() => buildWorkRegister({ user, tasks: [], weeklyRecords: [] }, { today: '2026-02-30' }), RangeError)
})

test('member and manager registers only include their own latest task versions, without a month cutoff', () => {
  const old = task('old', { title: '旧内容', createdAt: '2024-01-01T00:00:00.000Z' })
  const newest = { ...old, title: '最新内容', version: 2 }
  const other = task('other', { ownerId: 'another-person' })
  for (const role of ['member', 'manager'] as const) {
    const result = buildWorkRegister({ user: { ...user, role }, tasks: [old, other, newest, old], weeklyRecords: [] }, { today })
    assert.deepEqual(result.rows.map(row => row.title), ['最新内容'])
    assert.equal(result.counts.active, 1)
    assert.deepEqual(result.owner, { id: user.id, name: user.name })
  }
})

test('views distinguish future scheduling, past-only records, current drafts and completed tasks', () => {
  const tasks = [task('past'), task('future'), task('current'), task('none'), task('complete', { status: 'done', waitingForFeedback: true })]
  const weeklyRecords = [
    weekly('p', 'past', '2025-12-22'), weekly('f', 'future', '2026-01-05'),
    weekly('c', 'current', currentWeek), weekly('c-old', 'current', '2025-12-15'),
    weekly('complete', 'complete', currentWeek),
    // A malformed record owned by another person must not schedule this user's task.
    weekly('foreign', 'none', currentWeek, { ownerId: 'another-person' }),
  ]
  const data = { user, tasks, weeklyRecords }
  const ids = (view: Parameters<typeof buildWorkRegister>[1] = {}) => buildWorkRegister(data, { today, ...view }).rows.map(row => row.id).sort()
  assert.deepEqual(ids(), ['current', 'future', 'none', 'past'])
  assert.deepEqual(ids({ view: 'unscheduled' }), ['none', 'past'])
  assert.deepEqual(ids({ view: 'week' }), ['current'])
  assert.deepEqual(ids({ view: 'done' }), ['complete'])
  assert.deepEqual(ids({ view: 'waiting' }), [])
  const result = buildWorkRegister(data, { today })
  assert.deepEqual(result.counts, { active: 4, leader: 0, unscheduled: 2, week: 1, waiting: 0, done: 1, coordination: 0, 'source-review': 4, 'completion-review': 0 })
  assert.equal(result.rows.find(row => row.id === 'current')?.currentWeekRecord?.submitted, false)
  assert.match(createWorkRegisterSnapshot(result).rows.find(row => row.id === 'current')!.schedule, /草稿/)
})

test('explicit source takes precedence while reliable legacy assignments remain visible as leadership work', () => {
  const tasks = [
    task('explicit', { workSource: 'leader', workOrigin: { kind: 'self', actorId: user.id, reason: '' } }),
    task('self', { workSource: 'self', workOrigin: { kind: 'assigned', actorId: 'manager', reason: '' } }),
    task('legacy', { workOrigin: { kind: 'assigned', actorId: 'manager', reason: '' } }),
    task('finished-leader', { workSource: 'leader', status: 'done' }),
  ]
  const result = buildWorkRegister({ user, tasks, weeklyRecords: [] }, { today, view: 'leader' })
  assert.deepEqual(result.rows.map(row => row.id), ['explicit', 'legacy'])
  assert.equal(result.counts.leader, 2)
})

test('weekly completion never closes a task and future plans never become actual progress', () => {
  const data = {
    user, tasks: [task('ongoing'), task('future-only'), task('manual', { currentProgress: '本人维护的总体进展' })],
    weeklyRecords: [
      weekly('prior', 'ongoing', '2025-12-22', { actualOutcome: '上周成果' }),
      weekly('current', 'ongoing', currentWeek, { status: 'done', actualOutcome: '本周成果' }),
      weekly('future', 'ongoing', '2026-01-05', { actualOutcome: '未来文本不能当成果' }),
      weekly('future-only', 'future-only', '2026-01-05', { actualOutcome: '未来成果' }),
      weekly('manual', 'manual', currentWeek, { actualOutcome: '周记录文字' }),
    ],
  }
  const result = buildWorkRegister(data, { today })
  const ongoing = result.rows.find(row => row.id === 'ongoing')!
  assert.equal(ongoing.displayStatus, '未开始')
  assert.equal(ongoing.kind, 'task')
  assert.equal(ongoing.task!.status, 'todo')
  assert.equal(ongoing.progress, '本周成果')
  assert.equal(ongoing.progressSource, 'weekly')
  assert.equal(ongoing.progressWeekStart, currentWeek)
  assert.equal(ongoing.latestRecord?.id, 'future')
  assert.equal(result.rows.find(row => row.id === 'future-only')?.progress, '')
  assert.equal(result.rows.find(row => row.id === 'manual')?.progress, '本人维护的总体进展')
  const report = createWorkRegisterSnapshot(result)
  assert.equal(report.rows.find(row => row.id === 'ongoing')?.status, '未开始')
  assert.match(report.rows.find(row => row.id === 'ongoing')!.progress, /2025-12-29 周记录/)
})

test('waiting, blocked and decision requests are coordinated once each; unknown dates are never overdue', () => {
  const tasks = [
    task('waiting', { waitingForFeedback: true, decisionNeeded: '批准方案' }),
    task('blocked', { status: 'blocked', dueDate: '2025-12-31' }),
    task('decision', { decisionNeeded: '安排资源', dueDate: today }),
    task('unknown'), task('done', { status: 'done', dueDate: '2025-12-01', waitingForFeedback: true, decisionNeeded: '旧决策' }),
  ]
  const data = { user, tasks, weeklyRecords: [] }
  const result = buildWorkRegister(data, { today })
  assert.equal(result.counts.coordination, 3)
  assert.equal(result.rows.find(row => row.id === 'unknown')?.isOverdue, false)
  assert.equal(result.rows.find(row => row.id === 'blocked')?.isOverdue, true)
  assert.equal(result.rows.find(row => row.id === 'decision')?.isOverdue, false)
  assert.deepEqual(buildWorkRegister(data, { today, view: 'waiting' }).rows.map(row => row.id), ['waiting'])
  const report = createWorkRegisterSnapshot(result)
  assert.equal(report.coordinationCount, 3)
  assert.equal(report.unknownDueDateCount, 2)
  assert.equal(report.rows.find(row => row.id === 'unknown')?.dueDate, '待确认')
})

test('sort uses priority, known deadline, creation time and identifier; unspecified priority is last', () => {
  const tasks = [
    task('none', { dueDate: '2020-01-01' }), task('low', { priority: 'low' }),
    task('medium', { priority: 'medium', dueDate: '2026-01-01' }),
    task('high-unknown', { priority: 'high' }),
    task('high-later', { priority: 'high', dueDate: '2026-01-02' }),
    task('high-first', { priority: 'high', dueDate: '2026-01-01', createdAt: '2025-01-01T00:00:00Z' }),
    task('high-next', { priority: 'high', dueDate: '2026-01-01' }),
  ]
  assert.deepEqual(buildWorkRegister({ user, tasks, weeklyRecords: [] }, { today }).rows.map(row => row.id),
    ['high-first', 'high-next', 'high-later', 'high-unknown', 'medium', 'low', 'none'])
})

test('completed reports show completion notes and coordination reports preserve blocker and support details', () => {
  const data = { user, weeklyRecords: [], tasks: [
    task('completed', { status: 'done', completionNote: '最终成果已交付验收', currentProgress: '旧进度', supportNeeded: '历史支持需求' }),
    task('blocked', { status: 'blocked', currentProgress: '已完成一部分', blockerReason: '等待测试环境', supportNeeded: '协调测试服务器', decisionNeeded: '批准调整交付时间' }),
    task('support', { status: 'doing', supportNeeded: '需要产品确认范围' }),
  ] }
  const completed = buildWorkRegister(data, { today, view: 'done' })
  assert.equal(completed.rows[0].progress, '最终成果已交付验收')
  assert.equal(completed.rows[0].progressSource, 'task')
  assert.equal(createWorkRegisterSnapshot(completed).coordinationCount, 0)
  assert.equal(createWorkRegisterSnapshot(completed).rows[0].progress, '最终成果已交付验收')
  assert.equal(createWorkRegisterSnapshot(completed).rows[0].schedule, '任务已结束')
  const active = buildWorkRegister(data, { today })
  const report = createWorkRegisterSnapshot(active)
  assert.equal(report.coordinationCount, 2)
  const blocked = report.rows.find(row => row.id === 'blocked')!
  assert.equal(blocked.progress, '已完成一部分\n受阻原因：等待测试环境')
  assert.equal(blocked.decisionNeeded, '批准调整交付时间\n需要支持：协调测试服务器')
  assert.ok(workRegisterReportCsv(report).includes('受阻原因：等待测试环境'))
  assert.ok(workRegisterReportCsv(report).includes('需要支持：协调测试服务器'))
})

test('keyword search includes assignment metadata while report counts reflect the filtered snapshot', () => {
  const tasks = [task('matched', { assignedBy: '张主任', workSource: 'leader', decisionNeeded: '确认交付', dueDate: '' }), task('hidden', { dueDate: '' })]
  const result = buildWorkRegister({ user, tasks, weeklyRecords: [] }, { today, query: ' 张主任 ' })
  assert.equal(result.counts.active, 2)
  assert.deepEqual(result.rows.map(row => row.id), ['matched'])
  const report = createWorkRegisterSnapshot(result, { generatedAt: '2026-01-01T00:00:00Z' })
  assert.equal(report.totalCount, 1)
  assert.equal(report.unknownDueDateCount, 1)
  assert.equal(report.coordinationCount, 1)
  assert.equal(report.rangeLabel, '全部在手 · 关键词：张主任')
})

test('snapshot and CSV stay unchanged after input objects, result rows and owner mutate', () => {
  const original = task('stable', { requestedOutcome: '交付物', waitingForFeedback: true, nextAction: '下一步' })
  const record = weekly('record', 'stable', currentWeek, { actualOutcome: '已完成的部分' })
  const result = buildWorkRegister({ user: { ...user }, tasks: [original], weeklyRecords: [record] }, { today })
  const snapshot = createWorkRegisterSnapshot(result, { generatedAt: '2026-01-01T02:00:00Z' })
  const before = workRegisterReportCsv(snapshot)
  original.title = '后台已改标题'
  original.requestedOutcome = '后台已改交付物'
  record.actualOutcome = '后台已改周成果'
  result.owner.name = '被修改的人名'
  result.rows.length = 0
  assert.equal(workRegisterReportCsv(snapshot), before)
  assert.equal(snapshot.rows[0].title, 'stable')
  assert.equal(snapshot.owner.name, '本人')
  assert.equal(snapshot.rows[0].waitingForFeedback, '待反馈')
  assert.equal(snapshot.rows[0].estimatedEffort, '未填写')
  assert.equal(snapshot.rows[0].decisionNeeded, '未填写')
  assert.equal(Object.isFrozen(snapshot), true)
  assert.equal(Object.isFrozen(snapshot.owner), true)
  assert.equal(Object.isFrozen(snapshot.rows), true)
  assert.equal(Object.isFrozen(snapshot.rows[0]), true)
})

test('CSV quotes commas, quotes and line breaks, and neutralizes formulas in data and metadata', () => {
  const tasks = [
    task('unsafe', { title: '=SUM(1,2)', requestedOutcome: '交付,"带引号"\n第二行', assignedBy: '\t@危险', nextAction: '  +CMD', decisionNeeded: '\u0000-1', estimatedEffort: '-2小时' }),
    task('at', { title: '@危险' }), task('control', { title: '\n内容' }),
  ]
  const result = buildWorkRegister({ user: { ...user, name: '=领导' }, tasks, weeklyRecords: [] }, { today })
  const csv = workRegisterReportCsv(createWorkRegisterSnapshot(result, { generatedAt: '2026-01-01T00:00:00Z' }))
  assert.ok(csv.startsWith('\uFEFF"我的工作清单汇报"\r\n'))
  assert.ok(csv.endsWith('\r\n'))
  for (const value of ["\"'=SUM(1,2)\"", "\"'\t@危险\"", "\"'  +CMD\"", "\"'\u0000-1\"", "\"'-2小时\"", "\"'@危险\"", "\"'=领导\"", "\"'\n内容\""]) {
    assert.ok(csv.includes(value), `missing escaped cell ${JSON.stringify(value)}`)
  }
  assert.ok(csv.includes('"交付,""带引号""\n第二行"'))
  assert.ok(csv.includes('"截止待确认数","3"'))
  assert.ok(csv.includes('"事项","来源","交办人"'))
})

test('an empty filtered report still exports its owner, range, counts and column headers', () => {
  const result = buildWorkRegister({ user, tasks: [task('one')], weeklyRecords: [] }, { today, query: '不存在的事项' })
  const report = createWorkRegisterSnapshot(result)
  assert.equal(report.totalCount, 0)
  assert.equal(report.unknownDueDateCount, 0)
  assert.equal(report.coordinationCount, 0)
  assert.deepEqual(report.rows, [])
  const csv = workRegisterReportCsv(report)
  assert.ok(csv.includes('"事项数","0"'))
  assert.ok(csv.includes('不存在的事项'))
  assert.ok(csv.includes('"事项","来源"'))
})
