import test from 'node:test'
import assert from 'node:assert/strict'
import {deliveryTiming} from '../src/delivery-presentation.ts'
test('delivery timeliness uses submission in Shanghai, independent of later review time',()=>{
 assert.match(deliveryTiming('2026-09-22T15:59:00Z','2026-09-22',true),/按时达标交付/)
 assert.match(deliveryTiming('2026-09-22T16:01:00Z','2026-09-22',true),/逾期达标交付/)
 assert.match(deliveryTiming('2026-09-22T15:59:00Z','2026-09-22',false),/质量待确认/)
 assert.doesNotMatch(deliveryTiming('2026-09-22T15:59:00Z','2026-09-22',false),/按时达标/)
 assert.match(deliveryTiming('2026-09-22T15:59:00Z','',true),/无法判断是否按时/)
})
