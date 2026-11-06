import type { ImportBatch, ImportKind, ImportRow } from '../shared/import-types'
import type { Task } from '../shared/types'
import type { DingTalkBatchReview, DingTalkImportReviewRow } from '../shared/dingtalk-monthly-api'

export type ImportReviewSection = 'source' | 'rows' | 'completeness' | 'mode' | 'commit'
export interface ImportCommitBlocker { section: ImportReviewSection; message: string; action: string }
export type ImportSourceRelation = 'pending' | 'linked' | 'excluded'
export type ImportSourceRelations = Record<string, ImportSourceRelation>
export interface ImportSourceReviewState { id: string; version: number; ready: boolean; relations?: ImportSourceRelations }

/** The visible next step and the submit guard must describe the same contract. */
export function importCommitBlockers(batch: ImportBatch, manager: boolean, sourceReady = true): ImportCommitBlocker[] {
  const blockers: ImportCommitBlocker[] = []
  const selected = batch.rows.filter(row => row.selected)
  const counts = importReviewCounts(batch.rows)
  const directCommit = manager || batch.mode !== 'existing'
  if (batch.dingtalk && !sourceReady) blockers.push({ section: 'source', message: '先处理来源差异：疑似重复、来源变更和已有目标关联都需要明确选择。', action: '去处理来源差异' })
  if (!manager && batch.mode === 'draft' && selected.some(row => row.kind === 'monthly' && !row.isTemporary)) blockers.push({ section: 'mode', message: '常规团队月度目标由管理员创建。请由管理员接续处理；若原表是已在使用的计划，可选择“导入已有计划”后交管理员核对。', action: '查看导入方式' })
  if (directCommit && !selected.length && !batch.dingtalk) blockers.push({ section: 'rows', message: '尚未选择要导入的事项，请先勾选需要保留的记录。', action: '去选择记录' })
  if (directCommit && counts.missingReasons > 0) blockers.push({ section: 'rows', message: `${counts.missingReasons} 项未选择且缺少排除原因，请逐项补充原因。`, action: '去补充排除原因' })
  const issueCount = selected.filter(row => row.issues.length > 0).length
  if (directCommit && batch.mode !== 'history' && issueCount > 0) blockers.push({ section: 'rows', message: `${issueCount} 条已选记录有待补项，请点击该行“校对内容”补齐。`, action: '去校对内容' })
  if (directCommit && importReviewRequired(batch)) blockers.push({ section: 'completeness', message: '内容校对后，请打开原始资料、填写事项数量，再保存完整性核对。', action: '去核对原始资料' })
  if (batch.mode === 'existing' && !manager && batch.reviewRequestedAt) blockers.push({ section: 'commit', message: '本批次已交管理员核对，确认后会直接生效；修改内容会取消本次申请。', action: '查看确认状态' })
  return blockers
}

export function dingtalkRowNeedsReview(row: DingTalkImportReviewRow, candidate: ImportRow | undefined) {
  if (!candidate) return true
  if (candidate.result) return false
  if (row.requiresResolution) return true
  if (row.resolution?.action === 'new') return !candidate.selected
  if (row.resolution?.action === 'link' || row.resolution?.action === 'exclude') return candidate.selected
  // A unique previously imported row is linked automatically, never recreated.
  return row.status === 'imported' && row.plans.length === 1 && candidate.selected
}

export function dingtalkSourceReviewReady(review: Pick<DingTalkBatchReview, 'rows'>, candidates: ImportRow[]) {
  const byId = new Map(candidates.map(row => [row.id, row]))
  return review.rows.every(row => !dingtalkRowNeedsReview(row, byId.get(row.rowId)))
}

/** Presentation comes from reviewed relationships, never the placeholder exclusion reason. */
export function dingtalkSourceRelations(review: Pick<DingTalkBatchReview, 'rows'>, candidates: ImportRow[]): ImportSourceRelations {
  const byId = new Map(candidates.map(row => [row.id, row]))
  const relations: ImportSourceRelations = {}
  for (const row of review.rows) {
    const candidate = byId.get(row.rowId)
    if (candidate?.result) continue
    if (dingtalkRowNeedsReview(row, candidate)) relations[row.rowId] = 'pending'
    else if (row.resolution?.action === 'link' || row.status === 'imported' && row.plans.length === 1 && !row.resolution) relations[row.rowId] = 'linked'
    else if (row.resolution?.action === 'exclude' || row.status === 'new' && !row.resolution && !candidate?.selected && candidate?.exclusionReason?.trim()) relations[row.rowId] = 'excluded'
  }
  return relations
}

/** An unfinished read must not reuse another batch/version's decisions. */
export function currentImportSourceRelations(batch: ImportBatch | null | undefined, review: ImportSourceReviewState | null): ImportSourceRelations {
  if (!batch?.dingtalk || batch.status === 'committed') return {}
  if (review?.id === batch.id && review.version === batch.version && review.relations) return review.relations
  return Object.fromEntries(batch.rows.filter(row => !row.result).map(row => [row.id, 'pending']))
}

export function importDisplayCounts(rows: ImportRow[], relations: ImportSourceRelations = {}) {
  const counts = importReviewCounts(rows)
  const sourcePending = rows.filter(row => !row.result && relations[row.id] === 'pending')
  const linked = rows.filter(row => !row.result && relations[row.id] === 'linked')
  return { ...counts, sourcePending: sourcePending.length, linked: linked.length,
    excluded: counts.excluded - sourcePending.filter(row => !row.selected).length - linked.filter(row => !row.selected).length,
    pending: counts.pending - sourcePending.filter(row => row.selected).length - linked.filter(row => row.selected).length }
}

export function dingtalkConfirmedExclusions(review: Pick<DingTalkBatchReview, 'rows'>, candidates: ImportRow[] = []) {
  // Unselected ambiguous/imported rows are not human exclusion decisions.
  const byId = new Map(candidates.map(row => [row.id, row]))
  return review.rows.filter(row => {
    const candidate = byId.get(row.rowId)
    if (row.requiresResolution || candidate?.result || candidate?.selected) return false
    if (row.resolution?.action === 'exclude') return true
    return row.status === 'new' && !row.resolution && !!candidate?.exclusionReason?.trim()
  }).length
}

export function importedDraftMonths(batch: ImportBatch) {
  if (batch.status !== 'committed' || batch.mode !== 'draft') return []
  return [...new Set(batch.rows.filter(row => row.kind === 'monthly' && row.result?.collection === 'plans').map(row => row.month).filter(month => /^\d{4}-\d{2}$/.test(month)))].sort()
}

export type ImportWorkFields = Pick<ImportRow, 'workSource' | 'assignedBy' | 'assignedOn' | 'remainingEffortDays'>

export function importWorkFields(row: ImportWorkFields): ImportWorkFields {
  // Empty strings explicitly clear fields when the server sees a complete edited row.
  // Unknown effort is explicit null when changing a link: omission would preserve a
  // previous candidate estimate in normalizeRow even though the control shows blank.
  return { workSource: (row.workSource || '') as ImportRow['workSource'], assignedBy: row.assignedBy || '', assignedOn: row.assignedOn || '', remainingEffortDays: row.remainingEffortDays ?? null }
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

export function importRowOutcomeLabel(row: ImportRow, relation?: ImportSourceRelation) {
  if (!row.result && relation) return relation === 'pending' ? '等待确认来源关系' : relation === 'linked' ? '关联已有目标，不新建' : '本次已确认排除'
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

export function importReconciliationText(rows: ImportRow[], relations: ImportSourceRelations = {}) {
  const counts = importDisplayCounts(rows, relations)
  return `候选 ${counts.total} 项 · 实际事项 ${counts.expectedSourceCount} 项 · 已落地 ${counts.recorded + counts.existing} 项${counts.sourcePending ? ` · 待确认来源关系 ${counts.sourcePending} 项` : ''}${counts.linked ? ` · 关联已有 ${counts.linked} 项` : ''} · 未选择未导入 ${counts.excluded} 项 · 待处理 ${counts.pending} 项`
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
