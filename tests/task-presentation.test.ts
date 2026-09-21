import test from 'node:test'
import assert from 'node:assert/strict'
import { taskPriority, workKind } from '../src/task-presentation'

test('explicit low priority is not replaced by a high priority parent goal', () => {
  assert.equal(taskPriority({ priority: 'low' }, { priority: 'high' }), 'low')
})
test('legacy task inherits goal priority while unclassified work stays unclassified', () => {
  assert.equal(taskPriority({}, { priority: 'high' }), 'high')
  assert.equal(taskPriority({}), undefined)
  assert.equal(taskPriority(undefined, { priority: 'medium' }), 'medium')
})
test('temporary origin stays visible when work is included in a monthly plan', () => {
  assert.equal(workKind({ isTemporary: true, monthlyPlanId: 'goal-1' }), 'temporary')
  assert.equal(workKind({ isTemporary: true, isMonthly: true }), 'temporary')
})
test('unlinked routine work is never presented as temporary work', () => {
  assert.equal(workKind({ monthlyPlanId: null }), 'routine')
  assert.equal(workKind({ monthlyPlanId: 'goal-1' }), 'monthly')
  assert.equal(workKind({ isMonthly: true }), 'monthly')
})
