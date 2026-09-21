import test from 'node:test'
import assert from 'node:assert/strict'
import type { FeedbackAttachmentInput } from '../shared/feedback.ts'
import { validateFeedbackAttachments } from '../server/feedback-attachments.ts'

// JPEG exported from a real 2 × 2 bitmap by the platform encoder; WebP is a 1 × 1 image.
const jpeg = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAACAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD8rZ55LmaSaaRpZZGLvI7EszE5JJPUmiiis6fwL0OvF/7xU/xP8z//2Q=='
const webp = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA'
const attachment = (mimeType: FeedbackAttachmentInput['mimeType'], bytes: Buffer) => ({ name: `screenshot.${mimeType.split('/')[1]}`, mimeType, dataBase64: bytes.toString('base64') })

test('real JPEG and WebP containers are accepted with their actual formats and reject truncation or mismatched MIME', () => {
  for (const [mime, encoded] of [['image/jpeg', jpeg], ['image/webp', webp]] as const) {
    const bytes = Buffer.from(encoded, 'base64')
    assert.equal(validateFeedbackAttachments([attachment(mime, bytes)])[0].size, bytes.length)
    assert.throws(() => validateFeedbackAttachments([attachment(mime, bytes.subarray(0, -2))]), { status: 400 })
    assert.throws(() => validateFeedbackAttachments([attachment('image/png', bytes)]), { status: 400 })
  }
})

test('JPEG with intact real tables and headers but no entropy-coded pixels is rejected', () => {
  const bytes = Buffer.from(jpeg, 'base64'), scan = bytes.indexOf(Buffer.from([255, 218]))
  assert.ok(scan > 0)
  const endOfHeader = scan + 2 + bytes.readUInt16BE(scan + 2)
  const emptyScan = Buffer.concat([bytes.subarray(0, endOfHeader), Buffer.from([255, 217])])
  assert.throws(() => validateFeedbackAttachments([attachment('image/jpeg', emptyScan)]), { status: 400 })
  const frame = bytes.indexOf(Buffer.from([255, 192])), frameEnd = frame + 2 + bytes.readUInt16BE(frame + 2)
  const wrapperOnly = Buffer.concat([bytes.subarray(0, 2), bytes.subarray(frame, frameEnd), bytes.subarray(scan, endOfHeader), Buffer.from([255, 217])])
  assert.throws(() => validateFeedbackAttachments([attachment('image/jpeg', wrapperOnly)]), { status: 400 })
})

test('lossy and lossless WebP headers without image data are rejected even when RIFF sizes are internally consistent', () => {
  const riff = (kind: string, data: Buffer) => {
    const result = Buffer.alloc(20 + data.length + data.length % 2)
    result.write('RIFF'); result.writeUInt32LE(result.length - 8, 4); result.write('WEBP', 8); result.write(kind, 12); result.writeUInt32LE(data.length, 16); data.copy(result, 20)
    return result
  }
  const lossyHeader = Buffer.from([0x30, 0x01, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0])
  const losslessHeader = Buffer.from([0x2f, 0, 0, 0, 0])
  for (const bytes of [riff('VP8 ', lossyHeader), riff('VP8L', losslessHeader)]) assert.throws(() => validateFeedbackAttachments([attachment('image/webp', bytes)]), { status: 400 })
  const invalidPartition = Buffer.from(webp, 'base64'); invalidPartition.writeUIntLE(0xfffff0, 20, 3)
  assert.throws(() => validateFeedbackAttachments([attachment('image/webp', invalidPartition)]), { status: 400 })
})
