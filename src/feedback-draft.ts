import type { FeedbackAttachmentInput } from '../shared/feedback'
import { feedbackAttachmentLimits } from '../shared/feedback'
import { createSubmissionRequestId } from './weekly-submission-flow'

export interface FeedbackAttempt { requestId: string; fingerprint: string }
/** Persist the exact attempt with the draft, including after an ambiguous network failure. */
export function feedbackAttempt(previous: FeedbackAttempt | null, payload: unknown, createId = createSubmissionRequestId): FeedbackAttempt {
  const fingerprint = JSON.stringify(payload)
  return previous?.fingerprint === fingerprint ? previous : { requestId: createId(), fingerprint }
}

export function feedbackDraftKey(userId: string, target: string) {
  return JSON.stringify(['feedback-draft', 1, userId, target])
}

const databaseName = 'lab-feedback-drafts-v1'
const collection = 'drafts'
const maximumAge = 14 * 24 * 60 * 60 * 1000
interface SavedDraft<T> { key: string; value: T; updatedAt: number }
function openDraftDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(new Error('此浏览器未提供草稿存储')); return }
    const request = indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(collection)) request.result.createObjectStore(collection, { keyPath: 'key' }) }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('无法打开草稿存储'))
    request.onblocked = () => reject(new Error('草稿存储被另一个窗口占用'))
  })
}

async function draftOperation<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openDraftDatabase()
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(collection, mode)
      const request = operation(transaction.objectStore(collection))
      let value: T
      request.onsuccess = () => { value = request.result }
      transaction.oncomplete = () => resolve(value)
      transaction.onerror = () => reject(transaction.error || request.error || new Error('草稿保存失败'))
      transaction.onabort = () => reject(transaction.error || new Error('草稿保存已中断'))
    })
  } finally { database.close() }
}

export async function readFeedbackDraft<T>(key: string): Promise<T | null> {
  const record = await draftOperation('readonly', store => store.get(key)) as SavedDraft<T> | undefined
  if (!record) return null
  if (!Number.isFinite(record.updatedAt) || Date.now() - record.updatedAt > maximumAge) {
    await removeFeedbackDraft(key)
    return null
  }
  return record.value
}

export async function writeFeedbackDraft<T>(key: string, value: T): Promise<void> {
  await draftOperation('readwrite', store => store.put({ key, value, updatedAt: Date.now() } satisfies SavedDraft<T>))
}
export async function removeFeedbackDraft(key: string): Promise<void> {
  await draftOperation('readwrite', store => store.delete(key))
}

export function feedbackImageError(file: Pick<File, 'name' | 'type' | 'size'>): string {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type.toLowerCase())) return `“${file.name || '图片'}”只支持 PNG、JPEG 或 WebP 格式。`
  if (!file.size) return `“${file.name || '图片'}”为空，请重新选择。`
  if (file.size > feedbackAttachmentLimits.bytes) return `“${file.name || '图片'}”超过 2 MiB，请压缩后上传。`
  return ''
}

/** Verify actual browser decoding before keeping a screenshot in a persistent draft. */
function feedbackDataUrl(file: Blob): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取截图，请重新选择。'))
    reader.onerror = () => reject(new Error('无法读取截图，请重新选择。'))
    reader.onabort = () => reject(new Error('截图读取已中断。'))
    reader.readAsDataURL(file)
  })
}

export async function validateFeedbackImageDisplay(file: Blob): Promise<void> {
  const dimensions = (width: number, height: number) => {
    if (!width || !height || width * height > 40_000_000) throw new Error('截图像素尺寸无效或超过 4000 万，请缩小后上传。')
  }
  if (typeof globalThis.createImageBitmap === 'function') {
    let bitmap: ImageBitmap
    try { bitmap = await createImageBitmap(file) }
    catch { throw new Error('截图无法显示或文件已损坏，请重新导出 PNG、JPEG 或 WebP。') }
    try { dimensions(bitmap.width, bitmap.height) } finally { bitmap.close() }
    return
  }
  if (typeof globalThis.Image !== 'function' || typeof globalThis.FileReader !== 'function') throw new Error('当前浏览器无法验证截图，请换用支持图片预览的浏览器后上传。')
  // The production CSP permits data: images, but deliberately does not permit blob: image URLs.
  const url = await feedbackDataUrl(file)
  await new Promise<void>((resolve, reject) => {
      const preview = new Image()
      const timer = setTimeout(() => { preview.onload = null; preview.onerror = null; preview.src = ''; reject(new Error('截图读取超时，请重新选择或压缩图片后重试。')) }, 15_000)
      preview.onload = () => {
        clearTimeout(timer)
        try { dimensions(preview.naturalWidth, preview.naturalHeight); resolve() } catch (error) { reject(error) }
      }
      preview.onerror = () => { clearTimeout(timer); reject(new Error('截图无法显示或文件已损坏，请重新导出 PNG、JPEG 或 WebP。')) }
      preview.src = url
    })
}

export async function feedbackImage(file: File): Promise<FeedbackAttachmentInput> {
  const issue = feedbackImageError(file)
  if (issue) throw new Error(issue)
  await validateFeedbackImageDisplay(file)
  const dataUrl = await feedbackDataUrl(file)
  const mimeType = file.type.toLowerCase() as FeedbackAttachmentInput['mimeType']
  const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType === 'image/webp' ? 'webp' : 'png'
  return { name: (file.name || `粘贴截图.${extension}`).slice(0, 200), mimeType, dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1) }
}

export const feedbackImageUrl = (file: FeedbackAttachmentInput) => `data:${file.mimeType};base64,${file.dataBase64}`

export function feedbackError(error: unknown, fallback = '操作失败，请稍后重试。') {
  const message = error instanceof Error ? error.message : fallback
  const id = error && typeof error === 'object' && 'requestId' in error && typeof error.requestId === 'string' ? error.requestId : ''
  return id && !message.includes(id) ? `${message}（错误编号：${id}）` : message
}
