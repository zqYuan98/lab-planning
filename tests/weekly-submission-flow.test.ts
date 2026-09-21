import test from 'node:test'
import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { createSubmissionRequestId, submissionProgress, recordTarget, advanceWeek } from '../src/weekly-submission-flow.ts'
import type { WeeklyDutyView } from '../shared/weekly-submissions.ts'

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
