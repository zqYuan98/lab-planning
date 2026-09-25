import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ImportBatch, ImportRow } from '../shared/import-types.ts'
import type { Task } from '../shared/types.ts'
import { canRequestImportReview, importAnalysisRequest, importReconciliationText, importReviewCounts, importReviewRequired, importRowOutcomeLabel, importWorkFields, newImportCandidate, restoredImportOptions, selectImportTask } from '../src/import-review.ts'
import ImportSourceReview from '../src/components/ImportSourceReview.tsx'

function batch(patch: Partial<ImportBatch> = {}): ImportBatch {
  return { id: 'source-batch', version: 3, createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', ownerId: 'manager', sourceId: 'source', fileName: '原始任务.xlsx', kind: 'table', status: 'parsed', mode: 'existing', rows: [], warnings: [], sourceSheets: [{ name: '第一张', rowCount: 3 }, { name: '第二张', rowCount: 5 }], requiresCompletionReview: true, ...patch }
}
function row(id: string, patch: Partial<ImportRow> = {}): ImportRow {
  return { ...newImportCandidate(batch(), id), id, title: `事项 ${id}`, ...patch }
}

test('three historical candidates reconcile to two saved and one visibly unimported without claiming a reason', () => {
  const rows = [row('a', { result: { collection: 'plans', id: 'plan-a' } }), row('b', { result: { collection: 'plans', id: 'plan-b' } }), row('c', { selected: false, issues: [] })]
  const counts = importReviewCounts(rows)
  assert.equal(counts.total, 3)
  assert.equal(counts.recorded, 2)
  assert.equal(counts.excluded, 1)
  assert.equal(counts.pending, 0)
  assert.equal(counts.missingReasons, 1)
  assert.equal(importRowOutcomeLabel(rows[2]), '未导入（未选择）')
  assert.match(importReconciliationText(rows), /候选 3 项.*已落地 2 项.*未选择未导入 1 项.*待处理 0 项/)
  const html = renderToStaticMarkup(createElement(ImportSourceReview, { batch: batch({ status: 'committed', rows }), disabled: false, onConfirm: async () => {} }))
  assert.match(html, /历史批次未记录完整性核对/)
  assert.match(html, /对照当前工作后另建批次/)
  assert.doesNotMatch(html, /保存完整性核对<\/button>/)
})

test('explicit duplicate and non-task exclusions reduce source count; omitted real tasks and unexplained rows do not', () => {
  const rows = [row('a'), row('b', { selected: false, exclusionReason: '已另有任务登记' }), row('c', { selected: false, exclusionKind: 'duplicate', exclusionReason: '与 a 同一事项' }), row('d', { selected: false, exclusionKind: 'not_task', exclusionReason: '表头' }), row('e', { selected: false, exclusionKind: 'not_task' })]
  const counts = importReviewCounts(rows)
  assert.equal(counts.total, 5)
  assert.equal(counts.excluded, 4)
  assert.equal(counts.expectedSourceCount, 3)
  assert.equal(counts.duplicates, 1)
  assert.equal(counts.nonTasks, 1)
  assert.equal(counts.missingReasons, 1)
  const html = renderToStaticMarkup(createElement(ImportSourceReview, { batch: batch({ rows }), disabled: false, onConfirm: async () => {} }))
  assert.match(html, /重复候选 1 项、非工作事项 1 项/)
  assert.match(html, /应对应原文 3 件工作/)
  assert.match(html, /本次不导入的真实工作仍计入原文事项数/)
})

test('new workbook covers all sheets while reopening restores the exact saved scope and period', () => {
  assert.deepEqual(restoredImportOptions(batch()).sheetNames, ['第一张', '第二张'])
  const saved = batch({ analysisOptions: { sheetNames: ['第二张'], kind: 'weekly', instruction: '逐项核对', period: '2026-09-21' } })
  assert.deepEqual(restoredImportOptions(saved), { sheetNames: ['第二张'], kind: 'weekly', instruction: '逐项核对', period: '2026-09-21' })
  const html = renderToStaticMarkup(createElement(ImportSourceReview, { batch: saved, disabled: false, onConfirm: async () => {} }))
  assert.match(html, /第一张 未纳入本批次/)
})

test('re-identification always requests fresh AI output, but failed continuation uses persisted options and cache', () => {
  const failed = batch({ analysis: { status: 'failed', completedChunks: 1, totalChunks: 2 }, analysisOptions: { sheetNames: ['第二张'], kind: 'weekly', instruction: '原解析要求', period: '2026-09-21' } })
  const changed = { sheetNames: ['第一张'], kind: 'monthly' as const, instruction: '新要求', period: '2026-09' }
  assert.deepEqual(importAnalysisRequest(failed, changed), { version: 3, sheets: ['第一张'], instruction: '新要求', forceRefresh: true, kind: 'monthly', period: '2026-09' })
  assert.deepEqual(importAnalysisRequest(failed, changed, true), { version: 3, sheets: ['第二张'], instruction: '原解析要求', forceRefresh: false, kind: 'weekly', period: '2026-09-21' })
  assert.throws(() => importAnalysisRequest(batch(), changed, true), /只有失败/)
  assert.equal('sheets' in importAnalysisRequest(batch({ kind: 'image' }), changed), false)
})

test('new manual candidates keep explicit source slots and cannot mutate committed historical batches', () => {
  const original = batch({ analysisOptions: { sheetNames: ['第二张'], instruction: '', period: '2026-09-21', kind: 'weekly' } })
  const candidate = newImportCandidate(original, 'new-unique')
  assert.equal(candidate.id, 'new:new-unique')
  assert.equal(candidate.kind, 'weekly')
  assert.equal(candidate.sourceSheet, '第二张')
  assert.equal(candidate.weekStart, '2026-09-21')
  assert.equal(candidate.sourceText, '', 'the user must supply evidence rather than inventing it')
  assert.equal(candidate.collaboratorIds, undefined, 'manual source names should resolve unless a human explicitly clears mappings')
  assert.equal(original.rows.length, 0)
  assert.throws(() => newImportCandidate(batch({ status: 'committed' }), 'unsafe'), /历史已保存批次不能补录/)
})

test('linking an existing task adopts locked source metadata and unlinking restores the candidate source', () => {
  const candidate = row('link', { kind: 'weekly', workSource: 'coordination', assignedBy: '原文交办人', assignedOn: '2026-09-10', taskCompleted: true, completionNote: '旧候选依据' })
  const originalSource = importWorkFields(candidate)
  const task: Task = { id: 'existing-task', version: 1, createdAt: '', updatedAt: '', title: '已有任务', ownerId: 'member', monthlyPlanId: null, description: '', status: 'doing', dueDate: '', isTemporary: true, temporaryReason: '原任务原因', workSource: 'leader', assignedBy: '原任务交办人', assignedOn: '2026-09-12' }
  const linked = selectImportTask(candidate, task)
  assert.equal(linked.taskId, task.id)
  assert.deepEqual(importWorkFields(linked), importWorkFields(task))
  assert.equal(linked.taskCompleted, false)
  assert.equal(linked.completionNote, '')
  const detached = selectImportTask(linked, undefined, originalSource)
  assert.equal(detached.taskId, '')
  assert.deepEqual(importWorkFields(detached), originalSource)
  const legacy = selectImportTask(candidate, { ...task, workSource: undefined, assignedBy: undefined, assignedOn: undefined })
  assert.deepEqual(importWorkFields(legacy), { workSource: '', assignedBy: '', assignedOn: '', remainingEffortDays: null })
})

test('selecting existing tasks replaces locked effort and unlinking restores the candidate estimate with source metadata', () => {
  const candidate = row('effort-link', { kind: 'weekly', remainingEffortDays: 5, plannedEffortDays: 1.5, actualEffortDays: 0, workSource: 'coordination', assignedBy: '原文交办人' })
  const original = importWorkFields(candidate)
  const task = { id: 'existing', ownerId: 'member', monthlyPlanId: null, isTemporary: true, temporaryReason: '支持', workSource: 'leader', remainingEffortDays: 2 } as Task
  const linked = selectImportTask(candidate, task)
  assert.equal(linked.remainingEffortDays, 2)
  assert.equal(linked.plannedEffortDays, 1.5); assert.equal(linked.actualEffortDays, 0)
  const switched = selectImportTask(linked, { ...task, id: 'zero-task', remainingEffortDays: 0 }, original)
  assert.equal(switched.remainingEffortDays, 0)
  const unknown = selectImportTask(switched, { ...task, id: 'unknown-task', remainingEffortDays: undefined }, original)
  assert.equal(unknown.remainingEffortDays, null)
  assert.equal(JSON.parse(JSON.stringify(unknown)).remainingEffortDays, null, 'clearing must survive JSON rather than preserve a stale server value')
  const detached = selectImportTask(unknown, undefined, original)
  assert.equal(detached.remainingEffortDays, 5)
  assert.equal(detached.workSource, candidate.workSource); assert.equal(detached.assignedBy, candidate.assignedBy)
  for (const remainingEffortDays of [0, null, undefined]) {
    const source = { ...candidate, remainingEffortDays }, saved = importWorkFields(source)
    assert.equal(selectImportTask(selectImportTask(source, task), undefined, saved).remainingEffortDays, remainingEffortDays ?? null)
  }
})

test('members can hand off parsed batches even when all candidates belong to other owners', () => {
  assert.equal(canRequestImportReview(false, batch({ rows: [] })), true)
  assert.equal(canRequestImportReview(false, batch({ rows: [], status: 'uploaded' })), false)
  assert.equal(canRequestImportReview(false, batch({ rows: [], status: 'committed' })), false)
  assert.equal(canRequestImportReview(false, batch({ mode: 'draft' })), false)
  assert.equal(canRequestImportReview(true, batch()), false)
})

test('file confirmation is required separately from row validity; structured batches keep their existing contract', () => {
  assert.equal(importReviewRequired(batch({ rows: [row('a', { issues: [] })] })), true)
  assert.equal(importReviewRequired(batch({ requiresCompletionReview: false })), false)
  assert.equal(importReviewRequired(batch({ completionReview: { sourceItemCount: 1, reviewedBy: 'manager', reviewedAt: '2026-09-20T00:00:00Z', reviewedVersion: 3, contentFingerprint: 'confirmed' } })), false)
  assert.equal(importRowOutcomeLabel(row('existing', { result: { collection: 'plans', id: 'existing-plan' }, resultDisposition: 'existing' })), '已有记录')
  assert.equal(importRowOutcomeLabel(row('fresh', { result: { collection: 'plans', id: 'fresh-plan' }, resultDisposition: 'created' })), '已写入')
})
