import type { ImportBatch, ImportKind, ImportRow } from '../shared/import-types'
import type { Task } from '../shared/types'

export type ImportWorkFields = Pick<ImportRow, 'workSource' | 'assignedBy' | 'assignedOn'>

export function importWorkFields(row: ImportWorkFields): ImportWorkFields {
  // Empty strings explicitly clear fields when the server sees a complete edited row.
  return { workSource: (row.workSource || '') as ImportRow['workSource'], assignedBy: row.assignedBy || '', assignedOn: row.assignedOn || '' }
}

export function selectImportTask(row: ImportRow, task: Task | undefined, sourceBeforeLink?: ImportWorkFields): ImportRow {
  return task ? {
    ...row, taskId: task.id, monthlyPlanId: task.monthlyPlanId || '', ownerId: task.ownerId,
    linkedRowId: '', isTemporary: task.isTemporary, temporaryReason: task.temporaryReason,
    taskCompleted: false, completionNote: '', ...importWorkFields(task),
  } : { ...row, taskId: '', taskCompleted: false, completionNote: '', ...importWorkFields(sourceBeforeLink || row) }
}

export function canRequestImportReview(manager: boolean, batch: ImportBatch) {
  // A member may not see other owners' candidates. The server validates actual emptiness.
  return !manager && batch.mode === 'existing' && batch.status === 'parsed'
}

/** A saved batch is not evidence that every candidate was imported. */
export function importRowDisposition(row: ImportRow) {
  if (row.result) return row.resultDisposition === 'existing' ? 'existing' : 'recorded'
  return row.selected ? 'pending' : 'excluded'
}

export function importRowOutcomeLabel(row: ImportRow) {
  if (!row.result) return row.selected ? '待处理' : '未导入（未选择）'
  return row.resultDisposition === 'existing' ? '已有记录' : row.resultDisposition === 'created' ? '已写入' : '已导入'
}

export function importReviewCounts(rows: ImportRow[]) {
  const counts = rows.reduce((counts, row) => {
    const disposition = importRowDisposition(row)
    counts[disposition]++
    if (!row.selected && !row.result && !row.exclusionReason?.trim()) counts.missingReasons++
    if (!row.selected && row.exclusionReason?.trim() && row.exclusionKind === 'duplicate') counts.duplicates++
    if (!row.selected && row.exclusionReason?.trim() && row.exclusionKind === 'not_task') counts.nonTasks++
    return counts
  }, { total: rows.length, recorded: 0, existing: 0, pending: 0, excluded: 0, missingReasons: 0, duplicates: 0, nonTasks: 0 })
  return { ...counts, expectedSourceCount: counts.total - counts.duplicates - counts.nonTasks }
}

export function importReconciliationText(rows: ImportRow[]) {
  const counts = importReviewCounts(rows)
  return `候选 ${counts.total} 项 · 实际事项 ${counts.expectedSourceCount} 项 · 已落地 ${counts.recorded + counts.existing} 项 · 未选择未导入 ${counts.excluded} 项 · 待处理 ${counts.pending} 项`
}

export function restoredImportOptions(batch: ImportBatch) {
  const options = batch.analysisOptions
  const available = batch.sourceSheets.map(sheet => sheet.name)
  return {
    sheetNames: options ? options.sheetNames.filter(name => available.includes(name)) : available,
    instruction: options?.instruction || '',
    period: options?.period || '',
    kind: (options?.kind === 'weekly' ? 'weekly' : 'monthly') as ImportKind,
  }
}

export function importReviewRequired(batch: ImportBatch) {
  return batch.requiresCompletionReview === true && !batch.completionReview
}

export function importAnalysisRequest(batch: ImportBatch, current: ReturnType<typeof restoredImportOptions>, resumeFailed = false) {
  if (resumeFailed && batch.analysis?.status !== 'failed') throw new Error('只有失败的解析可以续跑')
  const options = resumeFailed ? restoredImportOptions(batch) : current
  return {
    version: batch.version,
    ...(batch.kind === 'table' ? { sheets: options.sheetNames } : {}),
    instruction: options.instruction, forceRefresh: !resumeFailed, kind: options.kind,
    ...(options.period ? { period: options.period } : {}),
  }
}

export function newImportCandidate(batch: ImportBatch, uniqueId: string): ImportRow {
  if (batch.status === 'committed') throw new Error('历史已保存批次不能补录，请对照当前记录后另建批次')
  const options = restoredImportOptions(batch)
  return {
    id: `new:${uniqueId}`, kind: options.kind, selected: true,
    sourceSheet: options.sheetNames[0] || '', sourceRow: 1, sourceText: '',
    title: '', ownerName: '', ownerId: '', projectName: '', projectId: '', category: '',
    month: options.kind === 'monthly' ? options.period : '',
    weekStart: options.kind === 'weekly' ? options.period : '', dueDate: '',
    expectedOutcome: '', acceptanceCriteria: '', actualOutcome: '', blocker: '', nextAction: '',
    sourceStatus: '', monthlyPlanId: '', linkedRowId: '', taskId: '', issues: [],
    collaboratorNames: [],
  }
}
