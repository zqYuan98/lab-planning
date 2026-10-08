import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { WeeklyDeadlineRepairPreview, WeeklySubmissionView } from '../shared/weekly-submissions.ts'
import { deadlinePolicyRequest, deadlineRepairRequest, formatWorkCalendar, parseWorkCalendar, weeklyDeadlineLabel } from '../src/weekly-deadline-flow.ts'
import { WeeklyDeadlineBanner } from '../src/components/WeeklySubmissionPanel.tsx'
import WeeklyDeadlineSettings, { WeeklyDeadlineRepairSummary } from '../src/components/WeeklyDeadlineSettings.tsx'
import WorkCalendarField from '../src/components/WorkCalendarField.tsx'
import WorkWeekCalendarSummary from '../src/components/WorkWeekCalendarSummary.tsx'
import { WeeklyCapacityNotice, WeeklyRecordSubmissionGuidance, WeeklyTaskDeadlineField } from '../src/pages/Weekly.tsx'
import { getWorkWeekCalendar } from '../shared/china-work-calendar.ts'

function view(patch: Partial<WeeklySubmissionView> = {}): WeeklySubmissionView {
  return { rule:{ id:'rule', version:4, createdAt:'2026-09-21T00:00:00Z', updatedAt:'2026-09-21T00:00:00Z', enabled:true, effectiveWeek:'2026-09-21', timezone:'Asia/Shanghai', windows:[{fromWeek:'2026-09-21',toWeek:null}], deadlinePolicies:[{version:2,fromWeek:'2026-09-28',mode:'last_workday',calendarOverrides:{'2026-10-01':false,'2026-10-02':false}}] }, week:'2026-09-28', nextWeek:'2026-10-05', deadlineAt:'2026-09-30T08:00:00Z', serverNow:'2026-09-28T01:00:00Z', cycle:null, duties:[], deadlinePolicy:{ policyVersion:2, mode:'last_workday', workingDays:['2026-09-28','2026-09-29','2026-09-30'] }, workCalendar:{version:7,overrides:{'2026-10-01':false,'2026-10-02':false}}, ...patch }
}

function preview(patch: Partial<WeeklyDeadlineRepairPreview> = {}): WeeklyDeadlineRepairPreview {
  return { week:'2026-09-28', cycleVersion:3, previousDeadlineAt:'2026-10-02T08:00:00Z', deadlineAt:'2026-09-30T08:00:00Z', deadlinePolicy:{policyVersion:2,mode:'last_workday',workingDays:['2026-09-28','2026-09-29','2026-09-30']}, dutyCount:8, eligible:true, unchanged:false, reasons:[], token:'bound-preview-token', ...patch }
}

test('deadline banner uses the calculated Shanghai date and keeps next-week planning separate', () => {
  const html = renderToStaticMarkup(createElement(WeeklyDeadlineBanner, { view:view() }))
  for (const expected of ['2026/09/30', '16:00', '周三', '按当周最后一个工作日截止', '2026-09-28', '2026-10-05', '2026-10-11']) assert.ok(html.includes(expected), expected)
  assert.doesNotMatch(html, /固定周五截止|10\/02|尚未提交/)
  assert.match(weeklyDeadlineLabel('2026-10-10T08:00:00Z'), /周六.*16:00/)
})

test('a week without workdays has no missing receipt or roster-exclusion claim', () => {
  const html = renderToStaticMarkup(createElement(WeeklyDeadlineBanner, { view:view({ deadlineAt:null, deadlinePolicy:{policyVersion:2,mode:'last_workday',workingDays:[]} }) }))
  assert.match(html, /整周休息，本周期无提报义务/)
  assert.match(html, /无须正式提报，不计缺交/)
  assert.doesNotMatch(html, /尚未提交|逾期|不在.*名单|截止：/)
})

test('rest-week record guidance and expanded help do not ask for a whole-sheet submission', () => {
  const html = renderToStaticMarkup(createElement(WeeklyRecordSubmissionGuidance, {noSubmissionDuty:true}))
  assert.match(html, /仍可保存周工作记录/)
  assert.match(html, /无须正式提报，也不计缺交/)
  assert.doesNotMatch(html, /请核对并提交|完成填写后/)
  assert.match(renderToStaticMarkup(createElement(WeeklyRecordSubmissionGuidance, {noSubmissionDuty:false})), /完成记录后，请核对并提交整份提报/)
})

test('shared calendar round trips holiday and adjusted weekend rules and rejects invalid or duplicate dates', () => {
  const overrides = {'2026-10-10':true,'2026-10-01':false}
  assert.equal(formatWorkCalendar(overrides), '2026-10-01 休息\n2026-10-10 工作')
  assert.deepEqual(parseWorkCalendar(`\n ${formatWorkCalendar(overrides)} \n`), {'2026-10-01':false,'2026-10-10':true})
  assert.deepEqual(parseWorkCalendar(''), {})
  for (const input of ['2026-02-30 休息', '2026-13-01 工作', '2026-10-01 放假', '2026-10-01 休息\n2026-10-01 工作']) assert.throws(() => parseWorkCalendar(input))
  const html = renderToStaticMarkup(createElement(WorkCalendarField, {overrides}))
  assert.match(html, /共享工作日历/)
  assert.match(html, /删除某行将恢复该日期的默认规则/)
  assert.match(html, /2026-10-10 工作/)
})

test('policy writes carry both rule and calendar versions and preserve the complete shared calendar', () => {
  const request = deadlinePolicyRequest(view(), 'last_workday', '2026-10-01 休息\n2026-10-02 休息\n2026-10-10 工作')
  assert.deepEqual(request, {version:4,mode:'last_workday',calendarVersion:7,calendarOverrides:{'2026-10-01':false,'2026-10-02':false,'2026-10-10':true}})
  assert.deepEqual(deadlinePolicyRequest(view({workCalendar:undefined}), 'friday', ''), {version:4,mode:'friday'})
  assert.throws(() => deadlinePolicyRequest(view(), 'invalid', ''), /请选择截止方式/)
})

test('repair preview renders both dates, affected duties and reasons without promising changes to history', () => {
  const eligible = renderToStaticMarkup(createElement(WeeklyDeadlineRepairSummary, {preview:preview()}))
  for (const expected of ['原截止', '2026/10/02', '新截止', '2026/09/30', '涉及应交项：8', '周期版本：3', '可以修复']) assert.ok(eligible.includes(expected), expected)
  const refused = renderToStaticMarkup(createElement(WeeklyDeadlineRepairSummary, {preview:preview({eligible:false,reasons:['已有正式提交，不能修复该周期']})}))
  assert.match(refused, /不可修复，原有记录保持不变/)
  assert.match(refused, /已有正式提交，不能修复该周期/)
  assert.doesNotMatch(refused, /可以修复，填写原因/)
  assert.match(renderToStaticMarkup(createElement(WeeklyDeadlineRepairSummary, {preview:preview({unchanged:true})})), /无需修复/)
  assert.match(renderToStaticMarkup(createElement(WeeklyDeadlineRepairSummary, {preview:preview({deadlineAt:null})})), /整周休息，本周期无提报义务/)
})

test('repair confirmation sends the preview token and a nonblank reason and refuses stale or ineligible requests', () => {
  assert.deepEqual(deadlineRepairRequest(preview(), '  补充国庆调休安排  '), {week:'2026-09-28',token:'bound-preview-token',reason:'补充国庆调休安排'})
  assert.throws(() => deadlineRepairRequest(preview(), ' \n '), /请填写修复原因/)
  for (const change of [{eligible:false}, {unchanged:true}, {token:''}]) assert.throws(() => deadlineRepairRequest(preview(change), '修复原因'), /当前预览不可执行/)
})

test('settings explain next-full-week activation and shared-calendar behavior and require a preview before confirmation', () => {
  const html = renderToStaticMarkup(createElement(WeeklyDeadlineSettings, {view:view(),onUpdated:async () => {}}))
  for (const expected of ['下一个完整周生效', '2026-09-28', '含调休', '协作功能关闭时日历仍有效', '预览所选周期截止修复（只读）', '保存后续截止规则']) assert.ok(html.includes(expected), expected)
  assert.doesNotMatch(html, /确认修复该周期截止|name="reason"/)
})

test('National Day return week shows three real workdays and Saturday deadline alongside natural weeks', () => {
  const current = getWorkWeekCalendar('2026-10-05'), next = getWorkWeekCalendar('2026-10-12')
  const html = renderToStaticMarkup(createElement(WeeklyDeadlineBanner, { view:view({ week:current.week, nextWeek:next.week, deadlineAt:'2026-10-10T08:00:00Z', deadlinePolicy:{policyVersion:2,mode:'last_workday',workingDays:current.workingDays}, calendar:{current,next} }) }))
  for (const expected of ['自然周', '2026-10-05', '2026-10-11', '本周实际工作日', '10-08', '10-09', '10-10（调休上班）', '共 3 天', '下周实际工作日', '2026/10/10', '周六', '16:00']) assert.ok(html.includes(expected), expected)
  assert.doesNotMatch(html, /本周期保存的截止规则与最新工作日历不同|本周实际工作日：10-05/)
})

test('live workdays do not silently replace a previously saved Friday deadline or its explanation', () => {
  const current = getWorkWeekCalendar('2026-10-05'), next = getWorkWeekCalendar('2026-10-12')
  const html = renderToStaticMarkup(createElement(WeeklyDeadlineBanner, { view:view({ week:current.week,nextWeek:next.week,deadlineAt:'2026-10-09T08:00:00Z',deadlinePolicy:{policyVersion:1,mode:'friday',workingDays:['2026-10-05','2026-10-06','2026-10-07','2026-10-08','2026-10-09']},calendar:{current,next} }) }))
  for (const expected of ['截止：2026/10/09', '固定周五截止', '共 3 天', '10-10（调休上班）', '仍以上方截止时间为准', '预览当前周期截止修复']) assert.ok(html.includes(expected), expected)
  assert.doesNotMatch(html, /截止：2026\/10\/10/)
})

test('a frozen no-duty cycle stays exempt without mislabelling newly configured workdays as all rest', () => {
  const current = getWorkWeekCalendar('2026-10-05'), next = getWorkWeekCalendar('2026-10-12')
  const html = renderToStaticMarkup(createElement(WeeklyDeadlineBanner, {view:view({week:current.week,nextWeek:next.week,deadlineAt:null,deadlinePolicy:{policyVersion:1,mode:'last_workday',workingDays:[]},calendar:{current,next}})}))
  assert.match(html, /按已保存规则，本周期无提报义务/)
  assert.match(html, /共 3 天/)
  assert.doesNotMatch(html, /整周休息/)
  const guidance = renderToStaticMarkup(createElement(WeeklyRecordSubmissionGuidance, {noSubmissionDuty:true,wholeWeekRest:false}))
  assert.match(guidance, /按本提报周期已保存规则/)
  assert.match(guidance, /无须正式提报，也不计缺交/)
  assert.doesNotMatch(guidance, /整周休息/)
})

test('all-rest calendar shows zero capacity and no new task deadline on a guessed Friday', () => {
  const calendar = getWorkWeekCalendar('2026-10-05', {'2026-10-08':false,'2026-10-09':false,'2026-10-10':false})
  const summary = renderToStaticMarkup(createElement(WorkWeekCalendarSummary, {calendar}))
  assert.match(summary, /整周休息，共 0 天/)
  const field = renderToStaticMarkup(createElement(WeeklyTaskDeadlineField, {calendar}))
  assert.match(field, /value=""/)
  assert.match(field, /所选自然周整周休息/)
  assert.doesNotMatch(field, /value="2026-10-09"/)
  const capacity = renderToStaticMarkup(createElement(WeeklyCapacityNotice, {name:'管理员',capacityDays:0}))
  assert.match(capacity, /超过 0 人日/)
})

test('new task deadline and weekly capacity use holiday workdays but preserve an explicit goal deadline', () => {
  const calendar = getWorkWeekCalendar('2026-10-05')
  const field = renderToStaticMarkup(createElement(WeeklyTaskDeadlineField, {calendar}))
  assert.match(field, /value="2026-10-10"/)
  assert.match(field, /最后一个工作日（含调休）/)
  const explicit = renderToStaticMarkup(createElement(WeeklyTaskDeadlineField, {calendar,planDueDate:'2026-10-30'}))
  assert.match(explicit, /value="2026-10-30"/)
  const capacity = renderToStaticMarkup(createElement(WeeklyCapacityNotice, {name:'管理员',capacityDays:3}))
  assert.match(capacity, /超过 3 人日/)
  assert.doesNotMatch(capacity, /5 人日/)
})

test('official calendar coverage and company overrides are explained without claiming unknown years are loaded', () => {
  const field = renderToStaticMarkup(createElement(WorkCalendarField, {overrides:{'2026-10-10':false}}))
  for (const expected of ['已内置 2026 年', '企业手工例外优先', '尚未载入国家安排的年份暂按周一至周五', '2026-10-10 休息']) assert.ok(field.includes(expected), expected)
  const unknown = renderToStaticMarkup(createElement(WorkWeekCalendarSummary, {calendar:getWorkWeekCalendar('2027-01-04')}))
  assert.match(unknown, /尚未完整载入国家节假日安排/)
  const known = renderToStaticMarkup(createElement(WorkWeekCalendarSummary, {calendar:getWorkWeekCalendar('2026-10-05')}))
  assert.doesNotMatch(known, /尚未完整载入/)
})

test('new deadline settings choose last working day when no policy has been configured', () => {
  const current = view()
  const html = renderToStaticMarkup(createElement(WeeklyDeadlineSettings, {view:{...current,rule:{...current.rule,deadlinePolicies:undefined}},onUpdated:async () => {}}))
  assert.match(html, /value="last_workday" selected=""/)
  assert.doesNotMatch(html, /value="friday" selected=""/)
})
