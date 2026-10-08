import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeEffort } from '../shared/effort.ts'
import type { Report, WeeklyRecord } from '../shared/types.ts'
import type { CollaborationSettings } from '../shared/collaboration.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { readCollaborationSettings } from '../server/collaboration-policy.ts'
import { generateReport } from '../server/reports.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { schemas } from '../server/data-transfer-schema.ts'

function record(weekStart: string, plannedEffortDays: number, actualEffortDays = 0): WeeklyRecord {
  return { id: weekStart, version: 1, ownerId: 'member', taskId: 'task', weekStart, submitted: true, plannedEffortDays, actualEffortDays } as WeeklyRecord
}

test('national holiday weeks use actual workdays for planned and actual capacity', () => {
  const summary = summarizeEffort([
    record('2026-10-05', 4), record('2026-09-28', 3, 4),
    record('2026-09-14', 6), record('2026-02-16', 0.5),
  ])
  assert.deepEqual(summary.byOwnerWeek.map(row => [row.weekStart, row.capacityDays, row.overCapacity]), [
    ['2026-10-05', 3, true], ['2026-09-28', 3, true], ['2026-09-14', 6, false], ['2026-02-16', 0, true],
  ])
  assert.equal(summarizeEffort([record('2026-10-05', 3, 3)]).byOwnerWeek[0].overCapacity, false)
})

test('company calendar exceptions override national workdays and holidays in effort capacity', () => {
  const offSaturday = summarizeEffort([record('2026-10-05', 3)], [], [], { '2026-10-10': false })
  assert.equal(offSaturday.byOwnerWeek[0].capacityDays, 2)
  assert.equal(offSaturday.byOwnerWeek[0].overCapacity, true)
  const extraWorkday = summarizeEffort([record('2026-10-05', 4)], [], [], { '2026-10-07': true })
  assert.equal(extraWorkday.byOwnerWeek[0].capacityDays, 4)
  assert.equal(extraWorkday.byOwnerWeek[0].overCapacity, false)
})

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store)
  t.after(() => store.close())
  const manager = domain.setup({ name: '管理者', email: 'manager@holiday-effort.test', password: 'Fixture-password-2026!' })
  return { store, domain, manager }
}

test('report capacity freezes the generation calendar and survives new and legacy migrations', t => {
  const source = fixture(t)
  const task = source.domain.createTask(source.manager, { title: '节后工作', isTemporary: true, temporaryReason: '支持', dueDate: '' })
  source.store.insert<WeeklyRecord>('weeklyRecords', {
    taskId: task.id, monthlyPlanId: null, ownerId: source.manager.id, weekStart: '2026-10-05', commitment: '节后推进',
    actualOutcome: '已推进', evidenceUrl: '', blocker: '', nextAction: '', status: 'doing', submitted: true,
    plannedEffortDays: 3, actualEffortDays: 3,
  })
  const first = generateReport(source.store, 'weekly', '2026-10-05', source.manager.id)
  assert.equal(first.snapshot.effortSummary!.byOwnerWeek[0].capacityDays, 3)
  assert.equal(first.snapshot.effortSummary!.byOwnerWeek[0].overCapacity, false)
  source.store.insert<CollaborationSettings>('collaborationSettings', {
    ...readCollaborationSettings(source.store), calendarOverrides: { '2026-10-10': false },
  })
  const second = generateReport(source.store, 'weekly', '2026-10-05', source.manager.id)
  assert.equal(second.snapshot.effortSummary!.byOwnerWeek[0].capacityDays, 2)
  assert.equal(second.snapshot.effortSummary!.byOwnerWeek[0].overCapacity, true)
  assert.deepEqual(source.store.get<Report>('reports', first.id)!.snapshot.effortSummary, first.snapshot.effortSummary)

  const packet = exportBusinessData(source.store, source.manager), target = fixture(t)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  for (const original of [first, second]) {
    const expected = structuredClone(original.snapshot.effortSummary!)
    expected.byOwnerWeek[0].ownerId = target.manager.id
    assert.deepEqual(target.store.get<Report>('reports', original.id)!.snapshot.effortSummary, expected)
  }

  const legacy = structuredClone(packet), legacyTarget = fixture(t)
  for (const report of legacy.collections.reports) for (const row of report.snapshot.effortSummary!.byOwnerWeek) {
    delete row.capacityDays
    row.overCapacity = false
  }
  const legacyPreview = previewRestore(legacyTarget.store, legacyTarget.manager, legacy)
  assert.equal(legacyPreview.canRestore, true, legacyPreview.issues.join('\n'))
  restoreBusinessData(legacyTarget.store, legacyTarget.manager, legacy, {}, legacyPreview.fingerprint)
  const legacyRow = legacyTarget.store.get<Report>('reports', second.id)!.snapshot.effortSummary!.byOwnerWeek[0]
  assert.equal(Object.hasOwn(legacyRow, 'capacityDays'), false)
  assert.equal(legacyRow.overCapacity, false)

  for (const capacityDays of [-1, 0.5, 8]) {
    const invalid = structuredClone(first)
    invalid.snapshot.effortSummary!.byOwnerWeek[0].capacityDays = capacityDays
    assert.equal(schemas.reports.safeParse(invalid).success, false)
  }
})
