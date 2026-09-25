import test from 'node:test'
import assert from 'node:assert/strict'
import { Children, createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Bootstrap, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { WeeklyDutyView, WeeklySubmission } from '../shared/weekly-submissions.ts'
import { weeklyPlanFingerprint } from '../shared/weekly-record-state.ts'
import { submissionChangeNotice, submissionProgress, weeklyRecordState } from '../src/weekly-submission-flow.ts'
import { PlanReviewStatus, WeeklySubmissionSnapshot } from '../src/components/WeeklySubmissionPanel.tsx'
import { WeeklyBody as Weekly, DeletedWeeklyRecordNotice } from '../src/pages/Weekly.tsx'
import TaskProgressSummary from '../src/components/TaskProgressSummary.tsx'

const entity = { version:1, createdAt:'2026-09-20T00:00:00Z', updatedAt:'2026-09-20T00:00:00Z' }
const manager: User = { ...entity, id:'manager', name:'管理员', email:'manager@example.test', role:'manager', active:true, position:'' }
const member: User = { ...manager, id:'member', name:'责任成员', role:'member' }
const task: Task = { ...entity, id:'task', title:'当前任务已改名', monthlyPlanId:null, ownerId:member.id, description:'当前任务说明', dueDate:'2026-10-01', status:'doing', isTemporary:true, temporaryReason:'临时支持' }
const row: WeeklyRecord = { ...entity, id:'row', taskId:task.id, monthlyPlanId:'goal', ownerId:member.id, weekStart:'2026-09-28', commitment:'提交时的周承诺', actualOutcome:'已完成第一阶段', evidenceUrl:'', blocker:'', nextAction:'', status:'doing', submitted:true, planApproval:{ required:true, approvedSubmissionId:null, approvedFingerprint:null } }
const deletion = { deletedAt:'2026-09-21T00:00:00Z', deletedBy:manager.id, reason:'关联错误重建' }
function bootstrap(user = manager): Bootstrap {
  return { user, users:[manager, member], tasks:[task], weeklyRecords:[row], projects:[], annualGoals:[], plans:[], publications:[], reports:[], aiConfigured:false }
}
function duty(patch: Partial<WeeklyDutyView> = {}): WeeklyDutyView {
  return { ...entity, id:'duty', ownerId:member.id, cycleWeek:'2026-09-21', kind:'plan', contentWeek:'2026-09-28', deadlineAt:'2026-09-25T08:00:00Z', status:'on_time', firstSubmittedAt:'2026-09-24T00:00:00Z', latestSubmittedAt:'2026-09-24T00:00:00Z', latestSubmission:null, missingAtDeadline:false, exemptionReason:'', changedSinceSubmission:false, records:[row], manifest:[], submissions:[], adjustments:[], planReviewRequired:true, planReviewStatus:'pending', ...patch }
}

test('review labels keep punctuality separate and do not ask to re-review execution-only changes', () => {
  const approved = duty({ planReviewStatus:'approved', changedSinceSubmission:true })
  assert.equal(submissionProgress(approved).label, '按时提交')
  assert.match(submissionChangeNotice(approved), /计划审核结论不变/)
  assert.doesNotMatch(submissionChangeNotice(approved), /待重提|重新.*审核/)
  assert.match(submissionChangeNotice(duty({ planReviewStatus:'changed' })), /重新核对并提交审核/)
  const returned = duty({ planReviewStatus:'returned', latestPlanReview:{ ...entity, id:'review', dutyId:'duty', ownerId:member.id, cycleWeek:'2026-09-21', submissionId:'receipt', decision:'returned', reviewedBy:manager.id, reviewedAt:'2026-09-24T01:00:00Z', reason:'请补充验收内容', requestId:'request' } })
  const html = renderToStaticMarkup(createElement(PlanReviewStatus, { duty:returned }))
  assert.match(html, /已退回修改/)
  assert.match(html, /退回意见：请补充验收内容/)
  assert.equal(submissionProgress(returned).label, '按时提交')
  assert.equal(renderToStaticMarkup(createElement(PlanReviewStatus, { duty:duty({kind:'results'}) })), '')
})

test('record labels and progress counts distinguish pending, approved, revised, assigned and deleted records', () => {
  assert.match(weeklyRecordState(row).label, /待审核.*未纳入/)
  const approved = { ...row, planApproval:{ required:true as const, approvedSubmissionId:'receipt', approvedFingerprint:weeklyPlanFingerprint(row) } }
  assert.match(weeklyRecordState(approved).label, /已审核/)
  assert.match(weeklyRecordState({ ...approved, actualOutcome:'新增日常进展', version:3 }).label, /已审核/)
  assert.match(weeklyRecordState({ ...approved, commitment:'调整后的计划' }).label, /待重新审核/)
  assert.equal(weeklyRecordState({ ...row, planApproval:{ ...row.planApproval!, suspended:true } }).label, '本周期无需审核 · 纳入周统计')
  assert.match(weeklyRecordState({ ...row, planApproval:undefined, workOrigin:{ kind:'assigned', actorId:manager.id, reason:'' } }).label, /管理员已确认/)
  const deleted = { ...row, id:'deleted', deletion }
  assert.equal(submissionProgress(duty({ records:[row, deleted] })).total, 1)
  assert.equal(weeklyRecordState(deleted).label, '已删除')
})

test('review preview freezes submitted task, goal and commitment while marking later deletion separately', () => {
  const submission: WeeklySubmission = { ...entity, id:'receipt', dutyId:'duty', ownerId:member.id, cycleWeek:'2026-09-21', kind:'plan', submittedAt:'2026-09-24T00:00:00Z', actorId:member.id, reason:'', note:'', requestId:'request', records:[row], retainedDraftIds:[], retainedDraftManifest:[], planTaskSnapshots:[{ id:task.id, title:'提交时的任务名称', description:'提交时的任务说明', dueDate:'2026-09-30' }], planGoalSnapshots:[{ id:'goal', month:'2026-09', title:'提交时的月度目标' }] }
  const data = bootstrap()
  data.weeklyRecords = [{ ...row, commitment:'当前承诺已更改', deletion }]
  const html = renderToStaticMarkup(createElement(WeeklySubmissionSnapshot, { submission, data }))
  for (const expected of ['提交时的任务名称', '提交时的任务说明', '提交时的月度目标', '提交时的周承诺', '2026-09-30', '当前记录已删除', '历史快照保留']) assert.ok(html.includes(expected), expected)
  assert.doesNotMatch(html, /当前任务已改名|当前任务说明|当前承诺已更改|2026-10-01/)
})

test('weekly screen exposes delete only to managers and hides deleted rows from current lists and statistics', () => {
  const data = bootstrap()
  data.weeklyRecords = [row, { ...row, id:'deleted', commitment:'删除的独有内容', deletion }]
  const props = { data, refresh:async () => {}, notify:() => {}, intent:{ weekStart:'2026-09-28' } }
  const managerHtml = renderToStaticMarkup(createElement(Weekly, props))
  assert.match(managerHtml, /删除周安排/)
  assert.match(managerHtml, /待审核生效 <strong>1<\/strong>/)
  assert.match(managerHtml, /已纳入周统计 <strong>0<\/strong>/)
  assert.doesNotMatch(managerHtml, /删除的独有内容/)
  const memberHtml = renderToStaticMarkup(createElement(Weekly, { ...props, data:{ ...data, user:member } }))
  assert.doesNotMatch(memberHtml, /删除周安排/)
  assert.match(memberHtml, /提交时的周承诺/)
})

test('task progress summary preserves execution feedback and identifies review-pending plans without calling them drafts', () => {
  const html = renderToStaticMarkup(createElement(TaskProgressSummary, { task, overallStatusNeedsConfirmation:false, weeklySummary:{ recordId:row.id, weekStart:row.weekStart, status:row.status, actualOutcome:row.actualOutcome, submitted:false, planReviewPending:true, isCurrentWeek:true, isImported:false } }))
  assert.match(html, /计划待审核 · 未纳入周统计/)
  assert.match(html, /已完成第一阶段/)
  assert.doesNotMatch(html, /草稿/)
})

test('deletion notice allows linking the surviving task and recreates from its refreshed association', () => {
  const data = bootstrap(), deleted = { ...row, deletion }
  let recreated: Task | undefined
  const props = { data, record:deleted, onRelink:() => {}, onRecreate:(task: Task) => { recreated = task }, onDismiss:() => {} }
  const before = renderToStaticMarkup(createElement(DeletedWeeklyRecordNotice, props))
  assert.match(before, /调整原任务月度关联/)
  assert.match(before, /沿用原任务重新安排该周/)
  data.tasks = [{ ...task, monthlyPlanId:'corrected-month-goal', isTemporary:false, version:2 }]
  const notice = DeletedWeeklyRecordNotice(props)
  const recreateButton = Children.toArray(notice.props.children).find(child => isValidElement<{children:string}>(child) && child.props.children === '沿用原任务重新安排该周')
  assert.ok(isValidElement<{onClick:() => void}>(recreateButton))
  recreateButton.props.onClick()
  assert.equal(recreated?.monthlyPlanId, 'corrected-month-goal')
  assert.equal(recreated?.isTemporary, false)
  assert.match(renderToStaticMarkup(notice), /原任务当前月度关联：目标 #H-GOAL/)
  assert.doesNotMatch(renderToStaticMarkup(createElement(DeletedWeeklyRecordNotice, { ...props, data:{ ...data, user:member } })), /调整原任务月度关联/)
  assert.doesNotMatch(renderToStaticMarkup(createElement(DeletedWeeklyRecordNotice, { ...props, data:{ ...data, tasks:[] } })), /调整原任务月度关联|沿用原任务重新安排该周/)
})
