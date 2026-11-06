import { createHash } from 'node:crypto'
import type {
  DingTalkExistingPlanReference, DingTalkImportedItem, DingTalkMappedRow,
  DingTalkMappingIssue, DingTalkMonthlyColumn, DingTalkMonthlyColumnMap,
  DingTalkMonthlyDiff, DingTalkMonthlyMapping, DingTalkMonthlySourceRule,
  DingTalkSheetSnapshot,
} from '../shared/dingtalk-documents.ts'

export class DingTalkMonthlyMappingError extends Error {
  readonly status = 400
  constructor(readonly code: string, message: string) { super(message); this.name = 'DingTalkMonthlyMappingError' }
}
const reject = (code: string, message: string): never => { throw new DingTalkMonthlyMappingError(code, message) }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const clean = (value: string) => value.replace(/\r\n?/g, '\n').trim()
const normalized = (value: string) => clean(value).normalize('NFKC').replace(/\s+/g, '').toLowerCase()
const pad = (value: number) => String(value).padStart(2, '0')

export function monthlySourceRule(targetMonth: string): DingTalkMonthlySourceRule {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(targetMonth)
  if (!match || Number(match[1]) < 1900) reject('INVALID_MONTH', '请选择有效的完整目标月份（YYYY-MM）')
  const year = Number(match![1]), month = Number(match![2])
  const reportYear = month === 1 ? year - 1 : year, reportMonth = month === 1 ? 12 : month - 1
  return {
    targetMonth, reportMonth: `${reportYear}-${pad(reportMonth)}`,
    reportTitles: [`${reportYear}年${reportMonth}月月报材料`, `${reportMonth}月月报材料`],
    sheetNames: [`${month}月目标`, `${year}年${month}月目标`],
  }
}

const columns: DingTalkMonthlyColumn[] = ['number', 'department', 'indicatorType', 'title', 'content', 'deliverable', 'owner', 'dueDate', 'notes']
const labels: Record<DingTalkMonthlyColumn, string> = {
  number: '序号', department: '部门', indicatorType: '指标类型', title: '工作事项',
  content: '工作内容（做什么）', deliverable: '交付产物（可量化验收标准）', owner: '负责人', dueDate: '截至时间', notes: '备注',
}
const aliases: Record<DingTalkMonthlyColumn, string[]> = {
  number: ['序号'], department: ['部门'], indicatorType: ['指标类型', '指标类别'],
  title: ['工作事项', '任务名称'], content: ['工作内容（做什么）', '工作内容'],
  deliverable: ['交付产物（可量化验收标准）', '交付产物', '验收标准'],
  owner: ['负责人', '责任人'], dueDate: ['截至时间', '截止时间', '截至日期', '截止日期'], notes: ['备注', '说明'],
}
const aliasMap = new Map(columns.flatMap(column => aliases[column].map(alias => [normalized(alias), column] as const)))

function identifyHeader(cells: string[]): DingTalkMonthlyColumnMap | undefined {
  const found = new Map<DingTalkMonthlyColumn, number[]>()
  cells.forEach((cell, index) => {
    const column = aliasMap.get(normalized(cell))
    if (column) found.set(column, [...(found.get(column) ?? []), index])
  })
  if (columns.some(column => !found.has(column))) return undefined
  if (columns.some(column => found.get(column)!.length !== 1)) reject('INVALID_HEADER', '目标表包含重复表头，请核对每列对应关系')
  return Object.fromEntries(columns.map(column => [column, found.get(column)![0]])) as DingTalkMonthlyColumnMap
}

function validateSnapshot(snapshot: DingTalkSheetSnapshot) {
  monthlySourceRule(snapshot.targetMonth)
  if (snapshot.complete !== true || snapshot.truncated === true || snapshot.hasMore === true) reject('INCOMPLETE_SOURCE', '目标工作表尚未完整读取，请完成获取后再预览导入')
  if (!Array.isArray(snapshot.merges) || snapshot.merges.length) reject('UNSUPPORTED_MERGES', '目标工作表存在未支持的合并区域，请核对表格结构后重试')
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d*):\$?([A-Z]{1,3})\$?([1-9]\d*)$/.exec(snapshot.range.toUpperCase())
  const columnNumber = (value: string) => [...value].reduce((result, letter) => result * 26 + letter.charCodeAt(0) - 64, 0)
  if (!match) reject('INVALID_RANGE', '目标工作表缺少有效的完整读取范围')
  const firstRow = Number(match![2]), lastRow = Number(match![4]), width = columnNumber(match![3]) - columnNumber(match![1]) + 1
  if (firstRow > lastRow || width < 9 || width > 256 || lastRow - firstRow + 1 > 10000) reject('INVALID_RANGE', '目标工作表读取范围无效或超过限额')
  if (!Array.isArray(snapshot.rows) || !snapshot.rows.length) reject('INVALID_HEADER', '目标工作表为空，无法识别月度目标表头')
  const seen = new Set<number>()
  let cellCount = 0, textCount = 0
  for (const row of snapshot.rows) {
    if (!Number.isInteger(row.rowNumber) || row.rowNumber < firstRow || row.rowNumber > lastRow || seen.has(row.rowNumber)) reject('INVALID_RANGE', '读取的原始行号重复或超出目标范围')
    seen.add(row.rowNumber)
    if (!Array.isArray(row.cells) || row.cells.length > width || row.cells.some(cell => typeof cell !== 'string')) reject('INVALID_RANGE', '读取的单元格内容与目标范围不一致')
    cellCount += row.cells.length
    textCount += row.cells.reduce((sum, cell) => sum + cell.length, 0)
  }
  if (cellCount > 100000 || textCount > 1200000) reject('INVALID_RANGE', '目标工作表超过导入限额，请缩小范围')
}

function dateValue(raw: string, targetMonth: string): { value: string; inferredYear: boolean; valid: boolean } {
  const value = clean(raw).normalize('NFKC')
  let match: string[] | null = /^(\d{4})\s*(?:[-/.]|年)\s*(\d{1,2})\s*(?:[-/.]|月)\s*(\d{1,2})\s*日?$/.exec(value)
  let inferredYear = false
  if (!match) {
    const short = /^(\d{1,2})\s*(?:[-/.]|月)\s*(\d{1,2})\s*日?$/.exec(value)
    if (short) { match = [short[0], targetMonth.slice(0, 4), short[1], short[2]]; inferredYear = true }
  }
  if (!match) return { value: '', inferredYear: false, valid: false }
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3])
  const maxDay = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
  if (year < 1900 || month < 1 || month > 12 || day < 1 || day > maxDay) return { value: '', inferredYear, valid: false }
  return { value: `${year}-${pad(month)}-${pad(day)}`, inferredYear, valid: true }
}

export function mapMonthlySheet(snapshot: DingTalkSheetSnapshot): DingTalkMonthlyMapping {
  validateSnapshot(snapshot)
  const ordered = [...snapshot.rows].sort((a, b) => a.rowNumber - b.rowNumber)
  const header = ordered.map(row => ({ row, map: identifyHeader(row.cells) })).find(entry => entry.map)
  if (!header?.map) reject('INVALID_HEADER', '未识别到完整的月度目标九列表头，请核对列名及对应关系')
  const columnMap = header!.map!, headerRow = header!.row.rowNumber
  const sheetPeriod = /^(?:(\d{4})年)?(0?[1-9]|1[0-2])月目标$/.exec(normalized(snapshot.sheetName))
  if (!sheetPeriod) reject('INVALID_SHEET', '所选工作表不是月度目标表，请选择对应月份的“目标”工作表')
  const sheetMonth = `${sheetPeriod![1] || snapshot.targetMonth.slice(0, 4)}-${pad(Number(sheetPeriod![2]))}`
  const rows: DingTalkMappedRow[] = [], excludedRows: DingTalkMonthlyMapping['excludedRows'] = [], warnings: string[] = [...(snapshot.warnings ?? [])]
  if (snapshot.mergesKnown === false) warnings.push('钉钉接口未提供合并单元格信息；未自动填充空白单元格，请逐行对照源表确认完整性')
  for (const original of ordered) {
    if (original.cells.every(cell => !clean(cell))) { excludedRows.push({ sourceRow: original.rowNumber, reason: 'empty' }); continue }
    if (original.rowNumber < headerRow) { excludedRows.push({ sourceRow: original.rowNumber, reason: 'preamble' }); continue }
    if (identifyHeader(original.cells)) { excludedRows.push({ sourceRow: original.rowNumber, reason: 'header' }); continue }
    const values = Object.fromEntries(columns.map(column => [column, clean(original.cells[columnMap[column]] ?? '')])) as Record<DingTalkMonthlyColumn, string>
    const issues: DingTalkMappingIssue[] = []
    const issue = (field: DingTalkMappingIssue['field'], code: DingTalkMappingIssue['code'], message: string, severity: DingTalkMappingIssue['severity'] = 'error') => issues.push({ sourceRow: original.rowNumber, field, code, message, severity })
    for (const field of ['indicatorType', 'title', 'content', 'deliverable', 'owner', 'dueDate'] as const) if (!values[field]) issue(field, 'required', `原表缺少${labels[field]}，请校对补充`)
    const due = dateValue(values.dueDate, snapshot.targetMonth)
    if (values.dueDate && !due.valid) issue('dueDate', 'invalid_date', `无法确定截止日期：${values.dueDate}；请填写明确日期`)
    if (due.valid && due.inferredYear) issue('dueDate', 'year_inferred', `截止日期年份来自所选月份 ${snapshot.targetMonth}，请确认`, 'confirmation')
    if (due.valid && !due.value.startsWith(snapshot.targetMonth)) issue('dueDate', 'month_conflict', `原表截止日期 ${due.value} 与目标月份 ${snapshot.targetMonth} 不一致`)
    if (sheetMonth !== snapshot.targetMonth) issue('month', 'month_conflict', `工作表“${snapshot.sheetName}”与目标月份 ${snapshot.targetMonth} 不一致`)
    const contentHash = hash(columns.filter(column => column !== 'number').map(column => values[column]))
    rows.push({
      sourceRow: original.rowNumber, sourceNumber: values.number, department: values.department,
      indicatorType: values.indicatorType, notes: values.notes, contentHash,
      sourceKey: hash([values.number, contentHash]), issues,
      candidate: {
        kind: 'monthly', sourceSheet: snapshot.sheetName, sourceRow: original.rowNumber,
        sourceText: columns.map(column => `${labels[column]}：${values[column]}`).join('\n'),
        title: values.title, ownerName: values.owner, month: snapshot.targetMonth,
        dueDate: due.value, category: values.indicatorType,
        expectedOutcome: values.content + (values.notes ? `${values.content ? '\n\n' : ''}补充说明（原表备注）：\n${values.notes}` : ''),
        acceptanceCriteria: values.deliverable, actualOutcome: '', blocker: '', nextAction: '', sourceStatus: '',
        isTemporary: false, monthlyResult: 'pending',
      },
    })
  }
  if (excludedRows.some(row => row.reason === 'preamble')) warnings.push('表头前的非空行未作为目标，请在原始资料中核对')
  if (!rows.length) warnings.push('所选工作表没有可导入的目标行')
  const issues = rows.flatMap(row => row.issues)
  return {
    rows, warnings: [...new Set(warnings)], issues, canImport: rows.length > 0 && issues.length === 0 && snapshot.mergesKnown !== false,
    sourceItemCount: rows.length, headerRow, columnMap, excludedRows,
    // Keep original coordinates and every cell: range/header/reordering changes invalidate a preview.
    contentHash: hash({ targetMonth: snapshot.targetMonth, sheetName: snapshot.sheetName, range: snapshot.range, merges: snapshot.merges, rows: ordered }),
  }
}

/** Conservative matching: only unique, unchanged source content can be classified imported. */
export function compareMonthlyRows(rows: DingTalkMappedRow[], priorItems: DingTalkImportedItem[], existingPlans: DingTalkExistingPlanReference[] = []): DingTalkMonthlyDiff {
  const counts: DingTalkMonthlyDiff['counts'] = { new: 0, imported: 0, changed: 0, ambiguous: 0 }
  const potentiallyPresent = new Set<DingTalkImportedItem>()
  const result = rows.map(row => {
    const exact = priorItems.filter(item => item.contentHash === row.contentHash)
    const exactPlans = new Set(exact.map(item => item.planId))
    const sameIdentity = row.candidate.title && row.candidate.ownerName ? priorItems.filter(item => normalized(item.title) === normalized(row.candidate.title) && normalized(item.ownerName) === normalized(row.candidate.ownerName)) : []
    const identityPlans = new Set(sameIdentity.map(item => item.planId))
    const sameNumber = row.sourceNumber ? priorItems.filter(item => item.sourceNumber === row.sourceNumber) : []
    const duplicates = rows.filter(other => other.contentHash === row.contentHash)
    const matchingPlans = existingPlans.filter(plan => plan.month === row.candidate.month && normalized(plan.title) === normalized(row.candidate.title))
    const possible = exact.length ? exact : sameIdentity.length ? sameIdentity : sameNumber
    for (const item of possible) potentiallyPresent.add(item)
    let status: DingTalkMonthlyDiff['rows'][number]['status'] = 'new', reason = '未发现已导入来源项或同月同名目标'
    if (duplicates.length > 1) { status = 'ambiguous'; reason = '原表包含内容完全相同的多行，请逐项确认关联或确为新增' }
    else if (exactPlans.size === 1) { status = 'imported'; reason = '与唯一已导入目标的来源内容一致' }
    else if (exactPlans.size > 1) { status = 'ambiguous'; reason = '内容对应多个已导入目标，需人工关联' }
    else if (identityPlans.size === 1 && rows.filter(other => normalized(other.candidate.title) === normalized(row.candidate.title) && normalized(other.candidate.ownerName) === normalized(row.candidate.ownerName)).length === 1) { status = 'changed'; reason = '同名同负责人来源事项内容变化，请在原目标中核对修改' }
    else if (possible.length || matchingPlans.length) { status = 'ambiguous'; reason = possible.length ? '原始序号或事项信息可能对应已导入目标，不能按行号或序号自动认定' : '同月已有同名目标，请确认关联已有、确为新增或排除' }
    counts[status]++
    return { sourceRow: row.sourceRow, sourceKey: row.sourceKey, status, planIds: [...new Set([...possible.map(item => item.planId), ...(status === 'ambiguous' ? matchingPlans.map(plan => plan.id) : [])])], priorSourceKeys: [...new Set(possible.map(item => item.sourceKey))], reason }
  })
  const presentPlans = new Set([...potentiallyPresent].map(item => item.planId))
  const removed = [...new Map(priorItems.filter(item => !presentPlans.has(item.planId)).map(item => [item.planId, item])).values()]
  return { rows: result, removed, counts }
}
