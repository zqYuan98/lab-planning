import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ImportBatch, ImportRow } from '../shared/import-types.ts'
import type { Task } from '../shared/types.ts'
import { canRequestImportReview, currentImportSourceRelations, importAnalysisRequest, importCommitBlockers, dingtalkConfirmedExclusions, dingtalkSourceRelations, dingtalkSourceReviewReady, importDisplayCounts, importedDraftMonths, importReconciliationText, importReviewCounts, importReviewRequired, importRowOutcomeLabel, importWorkFields, newImportCandidate, restoredImportOptions, selectImportTask } from '../src/import-review.ts'
import ImportSourceReview from '../src/components/ImportSourceReview.tsx'
import ImportWorkflowProgress from '../src/components/ImportWorkflowProgress.tsx'
import type { DingTalkImportReviewRow } from '../shared/dingtalk-monthly-api.ts'

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

test('import submit blockers identify actionable rows and completeness without conflating saving and importing', () => {
  const value = batch({ mode: 'draft', rows: [row('a', { issues: ['负责人待确认'] }), row('b', { selected: false })] })
  const blockers = importCommitBlockers(value, true)
  assert.deepEqual(blockers.map(item => item.section), ['rows', 'rows', 'completeness'])
  assert.match(blockers[0].message, /1 项未选择且缺少排除原因/)
  assert.match(blockers[1].message, /1 条已选记录有待补项/)
  assert.match(blockers[2].action, /核对原始资料/)
  const valid = batch({ mode: 'draft', requiresCompletionReview: false, rows: [row('valid')] })
  assert.deepEqual(importCommitBlockers(valid, true), [])
  const html = renderToStaticMarkup(createElement(ImportWorkflowProgress, { batch: valid, manager: true, sourceReady: true, blockers: [], disabled: false, onGo: () => {} }))
  assert.match(html, /导入后仍需审核发布/)
  assert.match(html, /不会自动成为正式月度目标/)
  const sourceHtml = renderToStaticMarkup(createElement(ImportSourceReview, { batch: value, disabled: false, onConfirm: async () => {} }))
  assert.match(sourceHtml, /此处只保存核对记录，不会导入或发布计划/)
})

test('members can still request manager review with hidden or incomplete existing rows, but regular draft goals explain the permission boundary', () => {
  assert.deepEqual(importCommitBlockers(batch({ rows: [] }), false), [])
  assert.deepEqual(importCommitBlockers(batch({ rows: [row('a', { issues: ['负责人待确认'] }), row('b', { selected: false })] }), false), [])
  const delegatedHtml = renderToStaticMarkup(createElement(ImportWorkflowProgress, { batch: batch({ rows: [] }), manager: false, sourceReady: true, blockers: [], disabled: false, onGo: () => {} }))
  assert.match(delegatedHtml, /由管理员核对/)
  const pending = importCommitBlockers(batch({ reviewRequestedAt: '2026-11-06T00:00:00Z' }), false)
  assert.deepEqual(pending.map(item => item.section), ['commit'])
  assert.match(pending[0].message, /已交管理员核对/)
  const regular = batch({ mode: 'draft', requiresCompletionReview: false, rows: [row('a', { kind: 'monthly' })] })
  assert.deepEqual(importCommitBlockers(regular, false).map(item => item.section), ['mode'])
  assert.match(importCommitBlockers(regular, false)[0].message, /常规团队月度目标由管理员创建/)
  assert.deepEqual(importCommitBlockers({ ...regular, rows: [row('a', { kind: 'monthly', isTemporary: true })] }, false), [])
})

test('history ignores optional row issues but still requires source completeness and explicit omission reasons', () => {
  const value = batch({ mode: 'history', rows: [row('a', { issues: ['日期缺失'] })] })
  assert.deepEqual(importCommitBlockers(value, true).map(item => item.section), ['completeness'])
  assert.deepEqual(importCommitBlockers({ ...value, requiresCompletionReview: false }, true), [])
  assert.deepEqual(importCommitBlockers({ ...value, requiresCompletionReview: false, rows: [row('a', { selected: false })] }, true).map(item => item.section), ['rows', 'rows'])
})

test('DingTalk unresolved and previously imported rows do not count as confirmed exclusions', () => {
  const base: DingTalkImportReviewRow = { rowId: 'row', sourceRow: 2, title: '目标', status: 'ambiguous', reason: '同月同名', plans: [], requiresResolution: true }
  const rows: DingTalkImportReviewRow[] = [base, { ...base, rowId: 'imported', status: 'imported', requiresResolution: false }, { ...base, rowId: 'linked', resolution: { action: 'link', planId: 'old', reason: '同一事项' }, requiresResolution: false }, { ...base, rowId: 'excluded', resolution: { action: 'exclude', reason: '本月不纳入' }, requiresResolution: false }, { ...base, rowId: 'stale', resolution: { action: 'exclude', reason: '需要重新核对' } }]
  assert.equal(dingtalkConfirmedExclusions({ rows }), 1)
  assert.equal(dingtalkConfirmedExclusions({ rows: rows.slice(0, 3) }), 0)
  const provenance = { sourceIdentity: 's', snapshotId: 'snapshot', documentId: 'doc', sheetId: 'sheet', documentTitle: '月报材料', sheetName: '11月目标', documentUrl: 'https://alidocs.dingtalk.com/i/nodes/doc', targetMonth: '2026-11', contentHash: 'hash', fetchedAt: '2026-11-06T00:00:00Z' }
  const value = batch({ dingtalk: provenance, mode: 'draft', requiresCompletionReview: false, rows: [] })
  assert.deepEqual(importCommitBlockers(value, true, false).map(item => item.section), ['source'])
  assert.deepEqual(importCommitBlockers(value, true, true), [], 'all-linked or excluded source batches can confirm without new drafts')
})

test('DingTalk review remains blocked when selection disagrees with a saved decision or a previous import', () => {
  const base: DingTalkImportReviewRow = { rowId: 'a', sourceRow: 2, title: '目标', status: 'ambiguous', reason: '同月同名', plans: [{ id: 'old', title: '目标', month: '2026-11', ownerName: '负责人' }], requiresResolution: false }
  for (const [action, expectedSelected] of [['new', true], ['link', false], ['exclude', false]] as const) {
    const review = { rows: [{ ...base, resolution: { action, reason: '人工确认', ...(action === 'link' ? { planId: 'old' } : {}) } }] }
    assert.equal(dingtalkSourceReviewReady(review, [row('a', { selected: expectedSelected })]), true, `${action}: accepted selection`)
    assert.equal(dingtalkSourceReviewReady(review, [row('a', { selected: !expectedSelected })]), false, `${action}: disagreeing selection cannot enable import`)
  }
  const imported = { rows: [{ ...base, status: 'imported' as const }] }
  assert.equal(dingtalkSourceReviewReady(imported, [row('a', { selected: true })]), false)
  assert.equal(dingtalkSourceReviewReady(imported, [row('a', { selected: false })]), true)
  assert.equal(dingtalkSourceReviewReady(imported, [row('a', { selected: true, result: { collection: 'plans', id: 'old' } })]), true, 'committed results are not pending choices')
  assert.equal(dingtalkSourceReviewReady(imported, []), false, 'missing candidate fails closed')
  const newReview = { rows: [{ ...base, status: 'new' as const, plans: [] }] }
  assert.equal(dingtalkConfirmedExclusions(newReview, [row('a', { selected: false })]), 0)
  assert.equal(dingtalkConfirmedExclusions(newReview, [row('a', { selected: false, exclusionReason: '本月暂不纳入' })]), 1)
  assert.equal(dingtalkConfirmedExclusions({ rows: [{ ...base, requiresResolution: true }] }, [row('a', { selected: false, exclusionReason: '等待核对来源差异' })]), 0, 'system placeholder is not a human exclusion')
})

test('committed monthly drafts surface the publication handoff only for actual imported plan results', () => {
  const value = batch({ mode: 'draft', status: 'committed', rows: [row('created', { month: '2026-11', result: { collection: 'plans', id: 'plan-a' } }), row('other-month', { month: '2026-12', result: { collection: 'plans', id: 'plan-b' } }), row('excluded', { month: '2027-01', selected: false }), row('weekly', { kind: 'weekly', month: '2026-10', result: { collection: 'weeklyRecords', id: 'weekly-a' } })] })
  assert.deepEqual(importedDraftMonths(value), ['2026-11', '2026-12'])
  assert.deepEqual(importedDraftMonths({ ...value, status: 'parsed' }), [])
  assert.deepEqual(importedDraftMonths({ ...value, mode: 'existing' }), [])
  const html = renderToStaticMarkup(createElement(ImportWorkflowProgress, { batch: value, manager: true, sourceReady: true, blockers: [], disabled: false, onGo: () => {}, navigate: () => {} }))
  assert.match(html, /草稿已生成，下一步审核发布/)
  assert.match(html, /前往 2026-11 月度目标/)
  assert.match(html, /前往 2026-12 月度目标/)
  assert.doesNotMatch(html, /前往 2027-01/)
})

test('unresolved DingTalk source rows are pending relationships, not omitted or linked work', () => {
  const candidates = [row('new'), row('pending-a', { selected: false, exclusionReason: '等待核对来源差异' }), row('pending-b', { selected: false, exclusionReason: '等待核对来源差异' })]
  const base: DingTalkImportReviewRow = { rowId: 'new', sourceRow: 2, title: '目标', status: 'new', reason: '', plans: [], requiresResolution: false }
  const review = { rows: [base, { ...base, rowId: 'pending-a', status: 'ambiguous' as const, requiresResolution: true }, { ...base, rowId: 'pending-b', status: 'changed' as const, requiresResolution: true }] }
  const relations = dingtalkSourceRelations(review, candidates)
  assert.deepEqual(relations, { 'pending-a': 'pending', 'pending-b': 'pending' } as const)
  const counts = importDisplayCounts(candidates, relations)
  assert.equal(counts.sourcePending, 2); assert.equal(counts.excluded, 0); assert.equal(counts.pending, 1)
  assert.equal(importRowOutcomeLabel(candidates[1], relations['pending-a']), '等待确认来源关系')
  assert.match(importReconciliationText(candidates, relations), /待确认来源关系 2 项.*未选择未导入 0 项/)
  assert.equal(importReviewCounts(candidates).excluded, 2, 'presentation does not change completeness or server submission inputs')
  assert.equal(importRowOutcomeLabel(candidates[1]), '未导入（未选择）', 'generic file import remains unchanged')
})

test('DingTalk presentation separates confirmed links and exclusions, and invalidated decisions return to pending', () => {
  const base: DingTalkImportReviewRow = { rowId: 'linked', sourceRow: 2, title: '目标', status: 'ambiguous', reason: '', plans: [{ id: 'old', title: '目标', month: '2026-11', ownerName: '负责人' }], requiresResolution: false }
  const candidates = [row('linked', { selected: false }), row('excluded', { selected: false }), row('imported', { selected: false })]
  const review = { rows: [{ ...base, resolution: { action: 'link' as const, planId: 'old', reason: '同一目标' } }, { ...base, rowId: 'excluded', resolution: { action: 'exclude' as const, reason: '本月不纳入' } }, { ...base, rowId: 'imported', status: 'imported' as const }] }
  const relations = dingtalkSourceRelations(review, candidates)
  assert.deepEqual(relations, { linked: 'linked', excluded: 'excluded', imported: 'linked' } as const)
  const counts = importDisplayCounts(candidates, relations)
  assert.equal(counts.linked, 2); assert.equal(counts.excluded, 1); assert.equal(counts.sourcePending, 0)
  assert.equal(importRowOutcomeLabel(candidates[0], relations.linked), '关联已有目标，不新建')
  assert.equal(importRowOutcomeLabel(candidates[1], relations.excluded), '本次已确认排除')
  assert.deepEqual(dingtalkSourceRelations(review, candidates.map(candidate => ({ ...candidate, selected: true }))), { linked: 'pending', excluded: 'pending', imported: 'pending' })
  assert.deepEqual(dingtalkSourceRelations({ rows: [{ ...review.rows[0], requiresResolution: true }] }, candidates), { linked: 'pending' })
})

test('source relationship display fails closed while loading and never reuses another batch or version', () => {
  const provenance = { sourceIdentity: 's', snapshotId: 'snapshot', documentId: 'doc', sheetId: 'sheet', documentTitle: '月报材料', sheetName: '11月目标', documentUrl: 'https://alidocs.dingtalk.com/i/nodes/doc', targetMonth: '2026-11', contentHash: 'hash', fetchedAt: '2026-11-06T00:00:00Z' }
  const value = batch({ dingtalk: provenance, rows: [row('a', { selected: false }), row('recorded', { result: { collection: 'plans', id: 'old' } })] })
  const pending = { a: 'pending' }
  assert.deepEqual(currentImportSourceRelations(value, null), pending)
  const state = { id: value.id, version: value.version, ready: true, relations: { a: 'linked' as const } }
  assert.deepEqual(currentImportSourceRelations(value, state), { a: 'linked' })
  assert.deepEqual(currentImportSourceRelations(value, { ...state, id: 'other-batch' }), pending)
  assert.deepEqual(currentImportSourceRelations(value, { ...state, version: value.version - 1 }), pending)
  assert.deepEqual(currentImportSourceRelations(value, { ...state, ready: false, relations: undefined }), pending)
  assert.deepEqual(currentImportSourceRelations({ ...value, status: 'committed' }, state), {})
  assert.deepEqual(currentImportSourceRelations({ ...value, dingtalk: undefined }, state), {})
})
