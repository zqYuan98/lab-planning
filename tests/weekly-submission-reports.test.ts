import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { shanghaiWeek, addWeekDays, fridayDeadline } from '../server/weekly-submission-clock.ts'
import { generateReport, exportMarkdown } from '../server/reports.ts'
import { reportMetrics } from '../server/report-metrics.ts'
import type { User, Report } from '../shared/types.ts'
import type { WeeklyRule } from '../shared/weekly-submissions.ts'

test('new reports freeze submission facts separately; old reports and outcome metrics stay intact', () => {
  const store = new Store(':memory:')
  try {
    const week = addWeekDays(shanghaiWeek(new Date()), -7)
    const entity = { version: 1, createdAt: '2020-01-01T00:00:00.000Z', updatedAt: '2020-01-01T00:00:00.000Z', position: '', active: true }
    const manager = store.restoreEntity<User>('users', { ...entity, id: 'manager', name: '管理员', email: 'manager@test.local', role: 'manager' })
    const member = store.restoreEntity<User>('users', { ...entity, id: 'member', name: '成员', email: 'member@test.local', role: 'member' })
    const service = new WeeklySubmissionService(store)
    const rule = service.getRule()
    store.update<WeeklyRule>('weeklyRules', rule.id, rule.version, { effectiveWeek: week, windows: [{ fromWeek: week, toWeek: null }] })
    const report = generateReport(store, 'weekly', week, manager.id)
    const frozen = structuredClone(report.snapshot)
    assert.equal(frozen.weeklySubmissions?.filter(row => row.status === 'missing').length, 2)
    const duty = service.view(member, week).duties.find(row => row.kind === 'results')!
    service.submit(member, { dutyId: duty.id, version: duty.version, manifest: [], requestId: 'fill', note: '本周无工作安排' })
    const next = generateReport(store, 'weekly', week, manager.id)
    assert.equal(next.snapshot.weeklySubmissions?.find(row => row.kind === 'results')?.status, 'late')
    assert.deepEqual(store.get<Report>('reports', report.id)!.snapshot, frozen)
    assert.deepEqual(reportMetrics(report.snapshot), reportMetrics(next.snapshot))
    assert.ok(exportMarkdown(next).includes('周五提报状态明细'))
    assert.ok(exportMarkdown(next).includes('逾期补交'))
    assert.equal(next.snapshot.weeklySubmissions?.[0].deadlineAt, fridayDeadline(week))
    const legacy = structuredClone(report)
    delete legacy.snapshot.weeklySubmissions
    assert.ok(!exportMarkdown(legacy).includes('周五提报状态明细'))
  } finally { store.close() }
})
