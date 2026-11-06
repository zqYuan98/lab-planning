import test from 'node:test'
import assert from 'node:assert/strict'
import { compareMonthlyRows, DingTalkMonthlyMappingError, mapMonthlySheet, monthlySourceRule } from '../server/dingtalk-monthly-mapping.ts'
import type { DingTalkImportedItem, DingTalkMappedRow, DingTalkSheetSnapshot } from '../shared/dingtalk-documents.ts'

const headers = ['序号', '部门', '指标类型', '工作事项', '工作内容（做什么）', '交付产物（可量化验收标准）', '负责人', '截至时间', '备注']
const dataRow = (number = 1, overrides: Partial<Record<number, string>> = {}) => ['' + number, '人工智能实验室', '部门重点任务', `月度工作${number}`, '1. 调试接口\n2. 验证数据', '提交可验证的接口清单', '成员甲', '2026年11月25日', '保留依赖条件\n由负责人核实'].map((value, index) => overrides[index] ?? value)
function snapshot(rows = [dataRow()]): DingTalkSheetSnapshot {
  return {
    connectionId: 'connection-test', folderId: 'folder-test', documentId: 'document-test',
    documentTitle: '10月月报材料', documentUrl: 'https://alidocs.dingtalk.com/i/nodes/document-test', path: ['人工智能实验室管理'],
    sheetId: 'sheet-test', sheetName: '11月目标', targetMonth: '2026-11',
    range: `A1:I${rows.length + 1}`, rows: [headers, ...rows].map((cells, index) => ({ rowNumber: index + 1, cells: [...cells] })),
    merges: [], complete: true, readAt: '2026-11-06T01:00:00.000Z',
  }
}
function imported(row: DingTalkMappedRow, planId = 'plan-1'): DingTalkImportedItem {
  return { sourceKey: row.sourceKey, contentHash: row.contentHash, sourceNumber: row.sourceNumber, title: row.candidate.title, ownerName: row.candidate.ownerName, planId }
}
function fails(source: DingTalkSheetSnapshot, code: string) {
  assert.throws(() => mapMonthlySheet(source), error => error instanceof DingTalkMonthlyMappingError && error.code === code)
}

test('month discovery crosses the year and retains actual unqualified title as a candidate', () => {
  assert.deepEqual(monthlySourceRule('2027-01'), {
    targetMonth: '2027-01', reportMonth: '2026-12', reportTitles: ['2026年12月月报材料', '12月月报材料'], sheetNames: ['1月目标', '2027年1月目标'],
  })
  assert.equal(monthlySourceRule('2026-11').reportMonth, '2026-10')
  for (const month of ['11', '2026-1', '2026-00', '2026-13', '2026-11x', '']) assert.throws(() => monthlySourceRule(month), { code: 'INVALID_MONTH' })
})

test('seven source rows produce seven drafts candidates with the entire nine-column evidence', () => {
  const source = snapshot(Array.from({ length: 7 }, (_, index) => dataRow(index + 1)))
  const result = mapMonthlySheet(source)
  assert.equal(result.rows.length, 7)
  assert.equal(result.sourceItemCount, 7)
  assert.equal(result.canImport, true)
  assert.deepEqual(result.excludedRows, [{ sourceRow: 1, reason: 'header' }])
  const row = result.rows[0]
  assert.equal(row.candidate.category, '部门重点任务')
  assert.equal(row.department, '人工智能实验室')
  assert.equal(row.notes, '保留依赖条件\n由负责人核实')
  assert.equal(row.candidate.expectedOutcome, '1. 调试接口\n2. 验证数据\n\n补充说明（原表备注）：\n保留依赖条件\n由负责人核实')
  assert.equal(row.candidate.acceptanceCriteria, '提交可验证的接口清单')
  assert.equal(row.candidate.dueDate, '2026-11-25')
  assert.equal(row.candidate.sourceRow, 2)
  assert.match(row.candidate.sourceText, /序号：1\n部门：人工智能实验室/)
  assert.match(row.candidate.sourceText, /截至时间：2026年11月25日/)
  assert.equal(row.candidate.id, undefined)
  assert.equal(row.candidate.ownerId, undefined)
  assert.equal(row.candidate.projectId, undefined)
  assert.equal(row.candidate.actualOutcome, '')
  assert.equal(row.candidate.monthlyResult, 'pending')
  assert.equal(row.candidate.blocker, '')
  assert.equal(row.candidate.isTemporary, false)
  assert.equal('status' in row.candidate, false)
})

test('known header aliases and reordered columns map by name', () => {
  const source = snapshot()
  source.rows[0].cells[7] = '截止时间'
  source.rows[0].cells[4] = '工作内容'
  for (const row of source.rows) [row.cells[3], row.cells[6]] = [row.cells[6], row.cells[3]]
  const result = mapMonthlySheet(source)
  assert.equal(result.rows[0].candidate.ownerName, '成员甲')
  assert.equal(result.rows[0].candidate.title, '月度工作1')
  assert.equal(result.columnMap.owner, 3)
  assert.equal(result.columnMap.title, 6)
})

test('partial, paginated, truncated, merged, and structurally uncertain reads are rejected', () => {
  fails({ ...snapshot(), complete: false }, 'INCOMPLETE_SOURCE')
  fails({ ...snapshot(), truncated: true }, 'INCOMPLETE_SOURCE')
  fails({ ...snapshot(), hasMore: true }, 'INCOMPLETE_SOURCE')
  fails({ ...snapshot(), merges: ['A2:A3'] }, 'UNSUPPORTED_MERGES')
  fails({ ...snapshot(), range: 'A1:H2' }, 'INVALID_RANGE')
  const invalidHeader = snapshot(); invalidHeader.rows[0].cells[2] = '未定义列'
  fails(invalidHeader, 'INVALID_HEADER')
  const duplicateHeader = snapshot(); duplicateHeader.range = 'A1:J2'; duplicateHeader.rows[0].cells.push('截止日期')
  fails(duplicateHeader, 'INVALID_HEADER')
  const duplicateRow = snapshot(); duplicateRow.rows[1].rowNumber = 1
  fails(duplicateRow, 'INVALID_RANGE')
})

test('completion sheets cannot enter the deterministic monthly target mapper', () => {
  fails({ ...snapshot(), sheetName: '10月目标完成情况' }, 'INVALID_SHEET')
})

test('unknown merge metadata permits preview, never fills blank cells, and requires source review', () => {
  const source = snapshot([dataRow(), dataRow(2, { 6: '' })])
  source.mergesKnown = false
  source.warnings = ['接口仅返回单元格值']
  const result = mapMonthlySheet(source)
  assert.equal(result.rows.length, 2)
  assert.equal(result.rows[1].candidate.ownerName, '')
  assert.equal(result.canImport, false)
  assert.ok(result.warnings.includes('接口仅返回单元格值'))
  assert.ok(result.warnings.some(warning => warning.includes('合并单元格')))
  assert.ok(result.issues.some(issue => issue.sourceRow === 3 && issue.field === 'owner'))
})

test('blank rows and repeated headers remain accounted for without creating targets', () => {
  const source = snapshot([dataRow(), ['', '', '', '', '', '', '', '', ''], headers, dataRow(2)])
  const result = mapMonthlySheet(source)
  assert.equal(result.sourceItemCount, 2)
  assert.deepEqual(result.excludedRows, [{ sourceRow: 1, reason: 'header' }, { sourceRow: 3, reason: 'empty' }, { sourceRow: 4, reason: 'header' }])
})

test('missing draft fields and invalid dates are preserved for manual preview correction', () => {
  const result = mapMonthlySheet(snapshot([dataRow(1, { 2: '', 3: '', 4: '', 5: '', 6: '', 7: '待定' })]))
  assert.equal(result.rows.length, 1)
  assert.equal(result.canImport, false)
  assert.equal(result.rows[0].candidate.title, '')
  assert.equal(result.rows[0].candidate.category, '')
  assert.equal(result.rows[0].candidate.dueDate, '')
  assert.ok(result.issues.some(issue => issue.code === 'invalid_date'))
  assert.ok(result.issues.some(issue => issue.field === 'content' && issue.code === 'required'))
  assert.match(result.rows[0].candidate.sourceText, /截至时间：待定/)
})

test('conflicting original dates are never silently moved into the selected month', () => {
  const result = mapMonthlySheet(snapshot([dataRow(1, { 7: '2025/11/30' }), dataRow(2, { 7: '2026-12-01' })]))
  assert.equal(result.canImport, false)
  assert.deepEqual(result.rows.map(row => row.candidate.dueDate), ['2025-11-30', '2026-12-01'])
  assert.equal(result.issues.filter(issue => issue.code === 'month_conflict').length, 2)
  const sheetMismatch = mapMonthlySheet({ ...snapshot(), sheetName: '2025年11月目标' })
  assert.ok(sheetMismatch.issues.some(issue => issue.field === 'month' && issue.code === 'month_conflict'))
})

test('year inference is visible and requires confirmation; invalid calendar days stay unresolved', () => {
  const inferred = mapMonthlySheet(snapshot([dataRow(1, { 7: '11月30日' })]))
  assert.equal(inferred.rows[0].candidate.dueDate, '2026-11-30')
  assert.equal(inferred.canImport, false)
  assert.equal(inferred.issues[0].severity, 'confirmation')
  assert.equal(inferred.issues[0].code, 'year_inferred')
  const invalid = mapMonthlySheet(snapshot([dataRow(1, { 7: '2026-11-31' })]))
  assert.equal(invalid.rows[0].candidate.dueDate, '')
  const leap = snapshot([dataRow(1, { 7: '2028-02-29' })]); leap.targetMonth = '2028-02'; leap.sheetName = '2月目标'
  assert.equal(mapMonthlySheet(leap).rows[0].candidate.dueDate, '2028-02-29')
  leap.rows[1].cells[7] = '2027-02-29'
  assert.equal(mapMonthlySheet(leap).rows[0].candidate.dueDate, '')
})

test('snapshot hashes ignore fetch time but detect changed content and physical row position', () => {
  const source = snapshot([dataRow(), dataRow(2)])
  const first = mapMonthlySheet(source)
  assert.equal(mapMonthlySheet({ ...source, readAt: '2026-11-07T01:00:00.000Z', remoteVersion: 'v2' }).contentHash, first.contentHash)
  const swapped = snapshot([dataRow(2), dataRow()])
  assert.notEqual(mapMonthlySheet(swapped).contentHash, first.contentHash)
  assert.equal(mapMonthlySheet(swapped).rows[1].contentHash, first.rows[0].contentHash)
})

test('unchanged imported content remains imported after sorting, insertion, and renumbering', () => {
  const old = mapMonthlySheet(snapshot()).rows[0]
  const current = mapMonthlySheet(snapshot([dataRow(8, { 3: '全新工作' }), dataRow(9, { 3: old.candidate.title })])).rows
  const diff = compareMonthlyRows(current, [imported(old)])
  assert.deepEqual(diff.rows.map(row => row.status), ['new', 'imported'])
  assert.deepEqual(diff.rows[1].planIds, ['plan-1'])
  assert.equal(diff.removed.length, 0)
})

test('changed source contents are flagged and never expressed as an update operation', () => {
  const old = mapMonthlySheet(snapshot()).rows[0]
  const current = mapMonthlySheet(snapshot([dataRow(1, { 4: '新的工作内容' })])).rows
  const diff = compareMonthlyRows(current, [imported(old)])
  assert.equal(diff.rows[0].status, 'changed')
  assert.deepEqual(diff.rows[0].planIds, ['plan-1'])
  assert.equal(diff.removed.length, 0)
})

test('same original number with a renamed or replaced task is ambiguous, never an automatic identity', () => {
  const old = mapMonthlySheet(snapshot()).rows[0]
  const current = mapMonthlySheet(snapshot([dataRow(1, { 3: '改名后的工作' })])).rows
  assert.equal(compareMonthlyRows(current, [imported(old)]).rows[0].status, 'ambiguous')
})

test('identical current or previously imported rows require human disambiguation', () => {
  const old = mapMonthlySheet(snapshot()).rows[0]
  const current = mapMonthlySheet(snapshot([dataRow(), dataRow(2, { 3: old.candidate.title })])).rows
  assert.ok(compareMonthlyRows(current, [imported(old)]).rows.every(row => row.status === 'ambiguous'))
  assert.equal(compareMonthlyRows([old], [imported(old), imported(old, 'plan-2')]).rows[0].status, 'ambiguous')
})

test('cross-document or manual-entry same-month duplicate is flagged without automatic merging', () => {
  const row = mapMonthlySheet(snapshot()).rows[0]
  const diff = compareMonthlyRows([row], [], [
    { id: 'older-month', month: '2026-10', title: row.candidate.title },
    { id: 'same-month', month: '2026-11', title: row.candidate.title, ownerName: '成员甲' },
  ])
  assert.equal(diff.rows[0].status, 'ambiguous')
  assert.deepEqual(diff.rows[0].planIds, ['same-month'])
})

test('removed source rows are reported separately and do not imply deleting plans', () => {
  const old = mapMonthlySheet(snapshot([dataRow(), dataRow(2)])).rows
  const diff = compareMonthlyRows([old[1]], old.map((row, index) => imported(row, `plan-${index + 1}`)))
  assert.equal(diff.rows[0].status, 'imported')
  assert.deepEqual(diff.removed.map(item => item.planId), ['plan-1'])
  assert.deepEqual(diff.counts, { new: 0, imported: 1, changed: 0, ambiguous: 0 })
})
