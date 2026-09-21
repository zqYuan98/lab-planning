import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Task } from '../shared/types'
import type { CollaborationTaskStatusSummary } from '../shared/collaboration'
import TaskProgressSummary from '../src/components/TaskProgressSummary'

function render(status: Task['status'], summary: CollaborationTaskStatusSummary) {
  return renderToStaticMarkup(createElement(TaskProgressSummary, { task: { status } as Task, ...summary }))
}
const completedWeek: CollaborationTaskStatusSummary = {
  weeklySummary: { recordId: 'weekly-1', weekStart: '2026-09-14', status: 'done', actualOutcome: '已交付第一阶段成果', submitted: true, isCurrentWeek: true, isImported: false },
  overallStatusNeedsConfirmation: true,
}

test('weekly completion and task status remain distinct and the recovery action is visible', () => {
  const html = render('todo', completedWeek)
  assert.match(html, /整个任务/)
  assert.match(html, /未开始/)
  assert.match(html, /本周执行/)
  assert.match(html, /2026-09-14/)
  assert.match(html, /成员自报完成/)
  assert.match(html, /已交付第一阶段成果/)
  assert.match(html, /同时完成整个任务/)
})

test('a past week is dated and never described as current; own drafts are marked', () => {
  const html = render('doing', { ...completedWeek, weeklySummary: { ...completedWeek.weeklySummary!, isCurrentWeek: false, submitted: false } })
  assert.match(html, /最近周记录/)
  assert.match(html, /草稿/)
  assert.doesNotMatch(html, /本周执行/)
})

test('overall completion has no correction prompt and no week does not invent a weekly status', () => {
  assert.doesNotMatch(render('done', { ...completedWeek, overallStatusNeedsConfirmation: false }), /同时完成整个任务/)
  const html = render('doing', { weeklySummary: null, overallStatusNeedsConfirmation: false })
  assert.match(html, /暂无可展示/)
  assert.doesNotMatch(html, /本周执行|未开始|成员自报完成/)
})

test('imported completion is not attributed to a member self-report', () => {
  const html = render('todo', { ...completedWeek, weeklySummary: { ...completedWeek.weeklySummary!, isImported: true } })
  assert.match(html, /原记录标记完成/)
  assert.doesNotMatch(html, /成员自报完成|该周已自报完成/)
})
