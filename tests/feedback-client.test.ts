import assert from 'node:assert/strict'
import test from 'node:test'
import {
  feedbackAttempt, feedbackDraftKey, feedbackError, feedbackImageError, feedbackImageUrl,
  readFeedbackDraft, removeFeedbackDraft, validateFeedbackImageDisplay, writeFeedbackDraft,
} from '../src/feedback-draft.ts'

test('an unchanged ambiguous submission reuses its ID after draft serialization; edits create a new command', () => {
  let number = 0
  const id = () => `request-${++number}`
  const payload = { description: '保存时没有响应', kind: 'bug', context: { path: '/work?view=weekly' }, attachments: [{ name: '截图.png', mimeType: 'image/png', dataBase64: 'YWJj' }] }
  const first = feedbackAttempt(null, payload, id)
  const restored = JSON.parse(JSON.stringify({ payload, attempt: first }))
  assert.equal(feedbackAttempt(restored.attempt, restored.payload, id).requestId, 'request-1')
  assert.equal(number, 1)
  assert.equal(feedbackAttempt(first, { ...payload, description: '保存后报错' }, id).requestId, 'request-2')
  assert.equal(feedbackAttempt(first, { ...payload, attachments: [{ ...payload.attachments[0], dataBase64: 'ZGVm' }] }, id).requestId, 'request-3')
  assert.equal(feedbackAttempt(first, { ...payload, context: { path: '/work?view=monthly' } }, id).requestId, 'request-4')
})

test('feedback action retries retain the original version, while explicit conflict recovery creates a new attempt', () => {
  const payload = { version: 5, action: 'comment', text: '补充截图', attachments: [] }
  const attempt = feedbackAttempt(null, payload, () => 'original')
  assert.equal(feedbackAttempt(attempt, { ...payload }, () => 'unwanted').requestId, 'original')
  assert.equal(feedbackAttempt(attempt, { ...payload, version: 6 }, () => 'after-conflict').requestId, 'after-conflict')
})

test('draft keys isolate accounts, targets, and delimiter-like identifiers', () => {
  assert.notEqual(feedbackDraftKey('member-a', 'create'), feedbackDraftKey('member-b', 'create'))
  assert.notEqual(feedbackDraftKey('member-a', 'create'), feedbackDraftKey('member-a', 'action:one'))
  assert.notEqual(feedbackDraftKey('a:b', 'c'), feedbackDraftKey('a', 'b:c'))
})

test('client attachments reject unsafe formats, empty files and oversize data before upload', () => {
  assert.equal(feedbackImageError({ name: '截图.png', type: 'image/png', size: 2 * 1024 * 1024 }), '')
  assert.match(feedbackImageError({ name: '截图.png', type: 'image/png', size: 2 * 1024 * 1024 + 1 }), /超过 2 MiB/)
  assert.match(feedbackImageError({ name: '截图.svg', type: 'image/svg+xml', size: 30 }), /只支持/)
  assert.match(feedbackImageError({ name: '截图.jpg', type: 'image/jpeg', size: 0 }), /为空/)
  assert.equal(feedbackImageUrl({ name: '截图.webp', mimeType: 'image/webp', dataBase64: 'YWJj' }), 'data:image/webp;base64,YWJj')
})

test('feedback errors retain a server correlation ID without repeating it', () => {
  const error = Object.assign(new Error('暂时无法保存'), { requestId: 'req-one' })
  assert.equal(feedbackError(error), '暂时无法保存（错误编号：req-one）')
  error.message = '无法保存，错误编号 req-one'
  assert.equal(feedbackError(error), error.message)
})

test('browser decoding rejects unreadable images and closes decoded bitmap memory, including excessive dimensions', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap')
  let closed = 0
  try {
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => { throw new Error('Invalid image stream') } })
    await assert.rejects(validateFeedbackImageDisplay(new Blob(['invalid jpeg'], { type: 'image/jpeg' })), /无法显示或文件已损坏/)
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => ({ width: 400, height: 300, close: () => { closed++ } }) })
    await validateFeedbackImageDisplay(new Blob(['fixture']))
    assert.equal(closed, 1)
    Object.defineProperty(globalThis, 'createImageBitmap', { configurable: true, value: async () => ({ width: 10000, height: 5000, close: () => { closed++ } }) })
    await assert.rejects(validateFeedbackImageDisplay(new Blob(['fixture'])), /超过 4000 万/)
    assert.equal(closed, 2)
  } finally { if (before) Object.defineProperty(globalThis, 'createImageBitmap', before); else Reflect.deleteProperty(globalThis, 'createImageBitmap') }
})

/** A fault-injectable IndexedDB surface tests transaction completion, not just request success. */
function draftDatabase() {
  const records = new Map<string, unknown>()
  let failNextWrite = false
  const factory = {
    open() {
      const request: Record<string, any> = {}
      const database = {
        close() {},
        transaction() {
          const transaction: Record<string, any> = {}
          transaction.objectStore = () => Object.fromEntries(['get', 'put', 'delete'].map(operation => [operation, (input: any) => {
            const result: Record<string, any> = {}
            setTimeout(() => {
              if (operation === 'put' && failNextWrite) {
                failNextWrite = false; transaction.error = new DOMException('No space left', 'QuotaExceededError')
                transaction.onerror?.(); return
              }
              if (operation === 'put') records.set(input.key, structuredClone(input))
              if (operation === 'delete') records.delete(input)
              result.result = operation === 'get' ? structuredClone(records.get(input)) : undefined
              result.onsuccess?.()
              transaction.oncomplete?.()
            }, 0)
            return result
          }]))
          return transaction
        },
      }
      setTimeout(() => { request.result = database; request.onsuccess?.() }, 0)
      return request
    },
  }
  return { factory: factory as unknown as IDBFactory, fail: () => { failNextWrite = true } }
}

test('draft storage restores description, binary screenshots and retry ID by account; quota failure is surfaced', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'), database = draftDatabase()
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: database.factory })
  try {
    const key = feedbackDraftKey('member-a', 'create')
    const value = { description: '输入不能丢', attachments: [{ name: '原图.png', mimeType: 'image/png', dataBase64: 'YWJj' }], attempt: { requestId: 'persisted-attempt', fingerprint: 'full-payload' } }
    await writeFeedbackDraft(key, value)
    assert.deepEqual(await readFeedbackDraft(key), value)
    assert.equal(await readFeedbackDraft(feedbackDraftKey('member-b', 'create')), null)
    database.fail()
    await assert.rejects(writeFeedbackDraft(key, { ...value, description: '未能写入的修改' }), /No space left/)
    assert.deepEqual(await readFeedbackDraft(key), value)
    await removeFeedbackDraft(key)
    assert.equal(await readFeedbackDraft(key), null)
  } finally {
    if (before) Object.defineProperty(globalThis, 'indexedDB', before)
    else Reflect.deleteProperty(globalThis, 'indexedDB')
  }
})

test('unavailable browser storage rejects instead of claiming the draft was saved', async () => {
  const before = Object.getOwnPropertyDescriptor(globalThis, 'indexedDB')
  Object.defineProperty(globalThis, 'indexedDB', { configurable: true, value: undefined })
  try { await assert.rejects(writeFeedbackDraft('key', { description: '仍可在页面提交' }), /未提供草稿存储/) }
  finally { if (before) Object.defineProperty(globalThis, 'indexedDB', before); else Reflect.deleteProperty(globalThis, 'indexedDB') }
})
