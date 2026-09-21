import test from 'node:test'
import assert from 'node:assert/strict'
import { collectDraftValues, draftStorageKey, parseFormDraft } from '../src/draft-recovery.ts'
import { safeFeedbackPath } from '../src/error-context.ts'

test('drafts preserve multiple collaborators and explicitly cleared checkbox groups', () => {
  const values = collectDraftValues([
    { name: 'collaborators', type: 'checkbox', value: 'alice', checked: true },
    { name: 'collaborators', type: 'checkbox', value: 'bob', checked: false },
    { name: 'collaborators', type: 'checkbox', value: 'chen', checked: true },
    { name: 'submitted', type: 'checkbox', value: 'on', checked: false },
    { name: 'teams', type: 'select-multiple', value: 'a', selectedValues: ['a', 'c'] },
    { name: 'description', type: 'textarea', value: '阶段成果尚未提交' },
  ])
  assert.deepEqual(values.collaborators, ['alice', 'chen'])
  assert.deepEqual(values.submitted, [])
  assert.deepEqual(values.teams, ['a', 'c'])
  assert.equal(values.description, '阶段成果尚未提交')
})

test('draft serializer excludes credential, hidden and file inputs', () => {
  const values = collectDraftValues([
    { name: 'password', type: 'password', value: 'sensitive' },
    { name: 'csrf', type: 'hidden', value: 'sensitive' },
    { name: 'screenshot', type: 'file', value: 'C:/private/file' },
  ])
  assert.equal(Object.keys(values).length, 0)
})

test('draft parsing rejects malformed, expired and prototype fields and isolates account/version keys', () => {
  const now = Date.now(), valid = { schema: 2, savedAt: now, values: { body: '尚未完成', members: ['a', 'b'] } }
  assert.deepEqual(parseFormDraft(JSON.stringify(valid), now), valid)
  assert.equal(parseFormDraft('{', now), null)
  assert.equal(parseFormDraft(JSON.stringify({ ...valid, savedAt: now - 8 * 86400000 }), now), null)
  assert.equal(parseFormDraft(JSON.stringify({ ...valid, values: { body: 13 } }), now), null)
  assert.equal(parseFormDraft(`{"schema":2,"savedAt":${now},"values":{"__proto__":"bad"}}`, now), null)
  assert.notEqual(draftStorageKey('monthly:a:plan:v1'), draftStorageKey('monthly:b:plan:v1'))
  assert.notEqual(draftStorageKey('monthly:a:plan:v1'), draftStorageKey('monthly:a:plan:v2'))
})

test('feedback context retains navigation but drops authentication codes, tokens and typed search', () => {
  assert.equal(safeFeedbackPath('/work', '?view=weekly&id=abc&code=secret&token=secret&query=private'), '/work?view=weekly&id=abc')
  assert.equal(safeFeedbackPath('/entry', '?notificationId=abc&authCode=secret'), '/entry?notificationId=abc')
  assert.equal(safeFeedbackPath('/private-path/secret', '?token=secret'), '/')
})
