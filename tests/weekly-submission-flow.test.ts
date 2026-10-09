import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createSubmissionRequestId, submissionProgress, recordTarget, planReviewTarget, weeklyTaskIntentId, weeklyNavigationWeeks, submissionOpenMode, advanceWeek } from '../src/weekly-submission-flow.ts'
import type { WeeklyDutyView } from '../shared/weekly-submissions.ts'
import { weeklyPageQuery } from '../src/period-query.ts'

test('submission request IDs work on LAN HTTP without crypto.randomUUID', () => {
  const httpCrypto = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }
  const ids = new Set(Array.from({length:1000},()=>createSubmissionRequestId(httpCrypto)))
  assert.equal(ids.size,1000)
  for (const id of ids) assert.match(id,/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
})

test('saved work is visible separately from the whole-sheet receipt', () => {
  const duty = {status:'due',kind:'results',records:[
    {submitted:true,actualOutcome:'已更新',status:'doing',updatedAt:'2026-09-14T01:00:00.000Z'},
    {submitted:true,actualOutcome:'',status:'planned',updatedAt:'2026-09-14T06:38:00.000Z'},
    {submitted:false,actualOutcome:'受阻',status:'blocked',blocker:'',updatedAt:'2026-09-14T05:00:00.000Z'},
  ]} as WeeklyDutyView
  assert.deepEqual(submissionProgress(duty), {total:3,filled:1,drafts:1,lastUpdatedAt:'2026-09-14T06:38:00.000Z',label:'已填写，待整份提交'})
  assert.equal(submissionProgress({...duty,records:[]}).label,'尚未填写')
  assert.equal(submissionProgress({...duty,status:'on_time'}).label,'按时提交')
  assert.equal(submissionProgress({...duty,status:'missing'}).label,'逾期未整份提交')
})

test('record links preserve the cutoff cycle and target the correct owner and content week', () => {
  assert.deepEqual(recordTarget({weekStart:'2026-09-21',ownerId:'member'},'2026-09-14'), {cycleWeek:'2026-09-14',contentWeek:'2026-09-21',ownerId:'member',kind:'plan'})
  assert.equal(recordTarget({weekStart:'2026-09-14',ownerId:'member'},'2026-09-14').kind,'results')
  assert.equal(recordTarget({weekStart:'2026-09-07',ownerId:'member'},'2026-09-14').cycleWeek,'2026-09-07')
  assert.equal(advanceWeek('2026-12-28',7),'2027-01-04')
})

test('direct future-week deletion and recreation returns to the preceding plan cycle while current and historical weeks keep results', () => {
  assert.deepEqual(recordTarget({weekStart:'2026-09-21',ownerId:'member'},'2026-09-21','2026-09-14'), {cycleWeek:'2026-09-14',contentWeek:'2026-09-21',ownerId:'member',kind:'plan'})
  assert.deepEqual(recordTarget({weekStart:'2026-10-05',ownerId:'member'},'2026-10-05','2026-09-14'), {cycleWeek:'2026-09-28',contentWeek:'2026-10-05',ownerId:'member',kind:'plan'})
  assert.equal(recordTarget({weekStart:'2026-09-14',ownerId:'member'},'2026-09-14','2026-09-14').kind,'results')
  assert.equal(recordTarget({weekStart:'2026-09-07',ownerId:'member'},'2026-09-14','2026-09-14').kind,'results')
})

test('current and historical plan-review links preserve the preceding plan cycle independently of result reporting', () => {
  const row = { weekStart: '2026-10-05', ownerId: 'member' }
  assert.deepEqual(planReviewTarget(row), { cycleWeek: '2026-09-28', contentWeek: '2026-10-05', ownerId: 'member', kind: 'plan' })
  for (const today of ['2026-10-05', '2026-10-12']) {
    assert.equal(recordTarget(row, row.weekStart, today).kind, 'results')
    assert.equal(recordTarget(row, row.weekStart, today).cycleWeek, '2026-10-05')
  }
  assert.equal(planReviewTarget({ ...row, weekStart: '2027-01-04' }).cycleWeek, '2026-12-28')
})

test('submission receipt IDs never enter task-record queries from a weekly review action', () => {
  const id = weeklyTaskIntentId({ id: 'receipt-123', kind: 'plan' })
  const query = weeklyPageQuery({ weekStart: '2026-09-28', ownerId: 'member', status: 'all', q: '', source: 'all', includeInactive: false, id })
  assert.equal(new URLSearchParams(query).has('id'), false)
  assert.equal(weeklyTaskIntentId({ id: 'receipt-results', kind: 'results' }), undefined)
  assert.equal(weeklyTaskIntentId({ id: 'task-123' }), 'task-123')
  assert.equal(weeklyTaskIntentId({ id: 'record-123' }), 'record-123')
})

test('workbench and notification review links resolve to the same plan content week while retaining the submission cycle', () => {
  const expected = { cycleWeek: '2026-09-28', recordWeek: '2026-10-05' }
  assert.deepEqual(weeklyNavigationWeeks({ kind: 'plan', cycleWeek: '2026-09-28', weekStart: '2026-09-28' }, '2026-10-05'), expected)
  assert.deepEqual(weeklyNavigationWeeks({ kind: 'plan', cycleWeek: '2026-09-28', weekStart: '2026-10-05' }, '2026-10-05'), expected)
  assert.deepEqual(weeklyNavigationWeeks({ kind: 'plan', weekStart: '2026-10-05' }, '2026-10-12'), expected)
  assert.deepEqual(weeklyNavigationWeeks({ kind: 'results', cycleWeek: '2026-10-05' }, '2026-10-12'), { cycleWeek: '2026-10-05', recordWeek: '2026-10-05' })
  assert.deepEqual(weeklyNavigationWeeks({ weekStart: '2026-09-28' }, '2026-10-05'), { cycleWeek: '2026-09-28', recordWeek: '2026-09-28' })
})

test('review entry opens only a live pending receipt for a manager and exposes details for every non-auditable state', () => {
  const pending = { kind: 'plan', status: 'late', planReviewStatus: 'pending', latestSubmission: { id: 'receipt-123' } } as WeeklyDutyView
  assert.equal(submissionOpenMode(pending, true, 'review'), 'review')
  assert.equal(submissionOpenMode(pending, false, 'review'), 'detail')
  assert.equal(submissionOpenMode({ ...pending, latestSubmission: null }, true, 'review'), 'detail')
  assert.equal(submissionOpenMode({ ...pending, status: 'exempt' }, true, 'review'), 'detail')
  assert.equal(submissionOpenMode({ ...pending, status: 'exempt' }, true, 'submit'), 'detail')
  assert.equal(submissionOpenMode({ ...pending, status: 'exempt' }, false, undefined), 'detail')
  for (const planReviewStatus of ['unsubmitted', 'returned', 'changed', 'approved', 'not_required'] as const) {
    assert.equal(submissionOpenMode({ ...pending, planReviewStatus }, true, 'review'), 'detail', planReviewStatus)
  }
  assert.equal(submissionOpenMode({ ...pending, kind: 'results' }, true, 'review'), 'detail')
  assert.equal(submissionOpenMode(pending, true, 'submit'), 'submit')
  assert.equal(submissionOpenMode(pending, false, undefined), 'submit')
})
