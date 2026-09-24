import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import type { AuditEvent, MonthlyPlan, Task, User } from '../shared/types.ts'
import type { ImportRow } from '../shared/import-types.ts'
import type { HistoricalRecord } from '../server/import-service.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { exportBusinessData, exportCsv, exportXlsx, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'

function account(t: TestContext) {
  const store = new Store(':memory:')
  t.after(() => store.close())
  const domain = new Domain(store)
  const manager = domain.setup({ name: '临时工作管理员', email: 'temporary-transfer@example.test', password: 'Fixture-password-2026!' })
  return { store, domain, manager }
}

function sourceRow(owner: User): ImportRow {
  return {
    id: 'temporary-source-row', kind: 'weekly', selected: true, sourceSheet: '临时交办', sourceRow: 2, sourceText: '领导临时交办：演示环境检查',
    ownerName: owner.name, ownerId: owner.id, projectName: '', projectId: '', category: '', title: '演示环境检查', month: '', weekStart: '2026-09-14', dueDate: '',
    expectedOutcome: '', acceptanceCriteria: '', actualOutcome: '', blocker: '', nextAction: '', sourceStatus: '待启动', monthlyPlanId: '', linkedRowId: '', taskId: '', issues: [],
  }
}

function temporaryWork(t: TestContext) {
  const f = account(t)
  const reason = '领导临时交办，保障本周演示'
  const plan = f.domain.createPlan(f.manager, {
    month: '2026-09', title: '临时演示保障', category: '部门工作', expectedOutcome: '完成演示准备', acceptanceCriteria: '检查记录齐全', dueDate: '2026-09-30',
    isTemporary: true, temporaryReason: reason,
  })
  const task = f.domain.createTask(f.manager, { title: '演示环境检查', dueDate: '2026-09-18', isTemporary: true, temporaryReason: reason })
  const legacy = f.store.insert<HistoricalRecord>('historicalRecords', {
    importedBy: f.manager.id, batchId: 'historical-batch', sourceId: 'historical-source', row: sourceRow(f.manager),
  })
  const corrected = f.store.update<HistoricalRecord>('historicalRecords', legacy.id, legacy.version, {
    row: { ...legacy.row, isTemporary: true, temporaryReason: reason },
  })
  const audit = f.store.insert<AuditEvent>('events', {
    entityType: 'historicalRecord', entityId: corrected.id, actorId: f.manager.id, action: 'correct', reason: '核对临时交办来源', before: legacy, after: corrected,
  })
  const incomplete = f.store.insert<HistoricalRecord>('historicalRecords', {
    importedBy: f.manager.id, batchId: 'incomplete-batch', sourceId: 'incomplete-source', row: { ...sourceRow(f.manager), id: 'incomplete-row', isTemporary: true },
  })
  const oldRecord = f.store.insert<HistoricalRecord>('historicalRecords', {
    importedBy: f.manager.id, batchId: 'legacy-batch', sourceId: 'legacy-source', row: { ...sourceRow(f.manager), id: 'legacy-row' },
  })
  return { ...f, reason, plan, task, corrected, audit, incomplete, oldRecord }
}

test('temporary work survives business export and account-mapped restore, including correction snapshots and incomplete historical sources', t => {
  const source = temporaryWork(t), target = account(t)
  const packet = exportBusinessData(source.store, source.manager)
  assert.equal(packet.formatVersion, 6, 'new live commitment events require the historical-facts format')
  assert.equal(packet.collections.history.find(row => row.id === source.corrected.id)!.row.temporaryReason, source.reason)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  const restored = target.store.get<HistoricalRecord>('historicalRecords', source.corrected.id)!
  assert.equal(restored.row.isTemporary, true)
  assert.equal(restored.row.temporaryReason, source.reason)
  assert.equal(restored.row.ownerId, target.manager.id)
  assert.equal(restored.importedBy, target.manager.id)
  assert.equal(target.store.get<MonthlyPlan>('plans', source.plan.id)!.temporaryReason, source.reason)
  assert.equal(target.store.get<Task>('tasks', source.task.id)!.isTemporary, true)
  assert.equal(target.store.get<Task>('tasks', source.task.id)!.temporaryReason, source.reason)
  const audit = target.store.get<AuditEvent>('events', source.audit.id)!
  assert.equal((audit.before as HistoricalRecord).row.isTemporary, undefined, 'legacy snapshots gain no invented classification')
  assert.equal((audit.after as HistoricalRecord).row.isTemporary, true)
  assert.equal((audit.after as HistoricalRecord).row.temporaryReason, source.reason)
  assert.equal((audit.after as HistoricalRecord).row.ownerId, target.manager.id)
  const incomplete = target.store.get<HistoricalRecord>('historicalRecords', source.incomplete.id)!
  assert.equal(incomplete.row.isTemporary, true)
  assert.equal(incomplete.row.temporaryReason, undefined, 'archives may keep missing source details')
  const legacy = target.store.get<HistoricalRecord>('historicalRecords', source.oldRecord.id)!
  assert.equal(legacy.row.isTemporary, undefined)
  assert.equal(legacy.row.temporaryReason, undefined)
})

test('migration rejects non-boolean temporary flags in historical records and nested audit snapshots before writing', t => {
  const source = temporaryWork(t), target = account(t)
  const packet = exportBusinessData(source.store, source.manager)
  for (const value of ['true', 1, null]) {
    const malformed = structuredClone(packet)
    Object.assign(malformed.collections.history[0].row, { isTemporary: value })
    assert.throws(() => previewRestore(target.store, target.manager, malformed), { status: 400 })
  }
  const malformedAudit = structuredClone(packet)
  const audit = malformedAudit.collections.events.find(event => event.id === source.audit.id)!
  Object.assign((audit.after as HistoricalRecord).row, { isTemporary: 'true' })
  assert.throws(() => previewRestore(target.store, target.manager, malformedAudit), { status: 400 })
  assert.equal(target.store.list('historicalRecords').length, 0)
  assert.equal(target.store.list('plans').length, 0)
})

test('CSV and Excel retain temporary fields in historical rows, audit snapshots and goal/task columns', async t => {
  const source = temporaryWork(t)
  const packet = exportBusinessData(source.store, source.manager)
  const csv = exportCsv(packet, 'history')
  assert.ok(csv.includes('""isTemporary"":true'))
  assert.ok(csv.includes(source.reason))
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await exportXlsx(packet) as unknown as ExcelJS.Buffer)
  const cell = (sheetName: string, id: string, column: string) => {
    const sheet = workbook.getWorksheet(sheetName)!
    const headers = sheet.getRow(1).values as string[]
    const idColumn = headers.indexOf('id')
    const valueColumn = headers.indexOf(column)
    assert.ok(idColumn > 0 && valueColumn > 0, `${sheetName} includes ${column}`)
    const row = sheet.getRows(2, sheet.rowCount - 1)!.find(row => row.getCell(idColumn).value === id)!
    assert.ok(row, `${sheetName} contains the exported record`)
    return row.getCell(valueColumn).value
  }
  const historyRow = JSON.parse(String(cell('history', source.corrected.id, 'row'))) as ImportRow
  assert.equal(historyRow.isTemporary, true)
  assert.equal(historyRow.temporaryReason, source.reason)
  const after = JSON.parse(String(cell('events', source.audit.id, 'after'))) as HistoricalRecord
  assert.equal(after.row.isTemporary, true)
  assert.equal(after.row.temporaryReason, source.reason)
  assert.equal(cell('plans', source.plan.id, 'isTemporary'), true)
  assert.equal(cell('plans', source.plan.id, 'temporaryReason'), source.reason)
  assert.equal(cell('tasks', source.task.id, 'isTemporary'), true)
  assert.equal(cell('tasks', source.task.id, 'temporaryReason'), source.reason)
})
