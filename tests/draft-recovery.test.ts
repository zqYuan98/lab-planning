import test from 'node:test'
import assert from 'node:assert/strict'
import { allowDraftLeave, collectDraftValues, draftStorageKey, FORM_DRAFT_MAX_CHARS, parseFormDraft, persistFormDraft, setActiveDraft } from '../src/draft-recovery.ts'
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


function memoryDraftStorage() {
  const entries = new Map<string, string>()
  return { entries, setItem: (key: string, value: string) => { entries.set(key, value) }, removeItem: (key: string) => { entries.delete(key) } }
}

test('large weekly editor drafts above 256 KiB are saved and completely restored', () => {
  const storage = memoryDraftStorage(), now = Date.now(), key = 'manager:report-agent-report:large'
  const text = '完整周报单元格和事实来源'.repeat(50000)
  const values = { title: '大周报', blocks: JSON.stringify([{ id: 'table', text, factIds: ['weekly:source:outcome'] }]), baseVersion: '8' }
  const result = persistFormDraft(storage, key, values, now)
  assert.equal(result.persisted, true)
  const raw = storage.entries.get(draftStorageKey(key))!
  assert.ok(raw.length > 256 * 1024)
  assert.deepEqual(parseFormDraft(raw, now)?.values, values)
})

test('draft size is checked against the complete envelope at the exact reader boundary', () => {
  const storage = memoryDraftStorage(), now = Date.now(), key = 'manager:report-agent-template:boundary'
  const overhead = JSON.stringify({ schema: 2, savedAt: now, values: { payload: '' } }).length
  const atLimit = { payload: 'a'.repeat(FORM_DRAFT_MAX_CHARS - overhead) }
  assert.equal(persistFormDraft(storage, key, atLimit, now).persisted, true)
  assert.equal(storage.entries.get(draftStorageKey(key))!.length, FORM_DRAFT_MAX_CHARS)
  assert.deepEqual(parseFormDraft(storage.entries.get(draftStorageKey(key))!, now)?.values, atLimit)
  const tooLarge = persistFormDraft(storage, key, { payload: `${atLimit.payload}a` }, now)
  assert.equal(tooLarge.persisted, false)
  assert.match(tooLarge.notice, /超过.*上限.*尚未备份/)
  assert.match(tooLarge.notice, /离开可能丢失/)
  assert.equal(storage.entries.has(draftStorageKey(key)), false, 'an older backup cannot masquerade as the new draft')
})

test('storage quota failures do not claim a draft is recoverable and discard stale backup', () => {
  const storage = memoryDraftStorage(), key = 'manager:report-agent-report:quota'
  persistFormDraft(storage, key, { blocks: 'older version' })
  const unavailable = { ...storage, setItem: () => { throw new Error('QuotaExceededError') } }
  const result = persistFormDraft(unavailable, key, { blocks: 'new unsaved text' })
  assert.equal(result.persisted, false)
  assert.match(result.notice, /未备份.*离开可能丢失/)
  assert.equal(storage.entries.has(draftStorageKey(key)), false)
})

test('leaving an oversized unbacked draft warns about losing input rather than promising recovery', t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window')
  let prompt = ''
  Object.defineProperty(globalThis, 'window', { configurable: true, value: { confirm: (value: string) => { prompt = value; return false } } })
  const token = Symbol('oversized-draft')
  t.after(() => {
    setActiveDraft(token, null)
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor)
    else Reflect.deleteProperty(globalThis, 'window')
  })
  const result = persistFormDraft(memoryDraftStorage(), 'manager:too-large', { blocks: 'a'.repeat(FORM_DRAFT_MAX_CHARS) })
  setActiveDraft(token, { form: {} as HTMLFormElement, dirty: true, busy: false, persisted: result.persisted })
  assert.equal(allowDraftLeave(), false)
  assert.match(prompt, /离开可能丢失输入/)
  assert.doesNotMatch(prompt, /返回同一表单可恢复/)
})
