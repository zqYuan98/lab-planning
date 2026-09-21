import { inflateSync } from 'node:zlib'
import type { FeedbackAttachment, FeedbackAttachmentInput } from '../shared/feedback.ts'
import { feedbackAttachmentLimits } from '../shared/feedback.ts'
import { HttpError } from './store.ts'

export interface StoredFeedbackAttachment extends FeedbackAttachment { dataBase64: string }
const invalid = (): never => { throw new HttpError(400, '截图内容与类型不一致或已损坏，请重新导出 PNG、JPEG 或 WebP') }
const dimensions = (width: number, height: number) => { if (!width || !height || width * height > 40000000) throw new HttpError(400, '截图像素尺寸无效或超过 4000 万，请缩小后上传') }
function crc32(bytes: Buffer) {
  let crc = 0xffffffff
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0) }
  return (crc ^ 0xffffffff) >>> 0
}
function validPng(bytes: Buffer) {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) invalid()
  let offset = 8, header = false, ended = false, width = 0, height = 0, depth = 0, color = 0, interlace = 0
  const data: Buffer[] = []
  while (offset + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(offset), end = offset + 12 + size
    if (end > bytes.length) invalid()
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) invalid()
    if (!header) {
      if (type !== 'IHDR' || size !== 13) invalid()
      width = bytes.readUInt32BE(offset + 8); height = bytes.readUInt32BE(offset + 12); dimensions(width, height)
      depth = bytes[offset + 16]; color = bytes[offset + 17]; interlace = bytes[offset + 20]
      const allowed: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] }
      if (!allowed[color]?.includes(depth) || bytes[offset + 18] || bytes[offset + 19] || interlace > 1) invalid()
      header = true
    } else if (type === 'IHDR') invalid()
    if (type === 'IDAT') data.push(bytes.subarray(offset + 8, end - 4))
    if (type === 'IEND') { if (size !== 0 || end !== bytes.length || !data.length) invalid(); ended = true; break }
    offset = end
  }
  if (!ended) invalid()
  const channels: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }
  const passes = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]]
  const rows = passes.map(([x, y, dx, dy]) => ({ width: Math.max(0, Math.ceil((width - x) / dx)), height: Math.max(0, Math.ceil((height - y) / dy)) }))
  const expected = rows.reduce((sum, pass) => sum + (pass.width ? (Math.ceil(pass.width * channels[color] * depth / 8) + 1) * pass.height : 0), 0)
  if (expected > 64 * 1024 * 1024) throw new HttpError(400, '截图解压尺寸过大，请缩小后上传')
  let decoded: Buffer
  try { decoded = inflateSync(Buffer.concat(data), { maxOutputLength: expected + 1 }) } catch { invalid() }
  if (decoded!.length !== expected) invalid()
  let position = 0
  for (const pass of rows) if (pass.width) for (let row = 0; row < pass.height; row++) {
    if (decoded![position] > 4) invalid()
    position += Math.ceil(pass.width * channels[color] * depth / 8) + 1
  }
}
function validJpeg(bytes: Buffer) {
  if (bytes.length < 20 || bytes[0] !== 255 || bytes[1] !== 216 || bytes[bytes.length - 2] !== 255 || bytes[bytes.length - 1] !== 217) invalid()
  let offset = 2, frame = false, scan = false, quantization = false, huffman = false
  while (offset < bytes.length - 2) {
    if (bytes[offset++] !== 255) invalid()
    while (bytes[offset] === 255) offset++
    const marker = bytes[offset++]
    if (marker === 217) break
    if (marker === 0 || marker === 216 || offset + 2 > bytes.length) invalid()
    const size = bytes.readUInt16BE(offset), end = offset + size
    if (size < 2 || end > bytes.length - 2) invalid()
    // Standalone uploaded JPEGs must include real quantization and Huffman tables;
    // a SOF/SOS wrapper without tables or entropy-coded pixels is not an image.
    if (marker === 219) {
      let table = offset + 2
      while (table < end) {
        const info = bytes[table++], precision = info >> 4
        if (precision > 1 || (info & 15) > 3 || table + 64 * (precision + 1) > end) invalid()
        table += 64 * (precision + 1); quantization = true
      }
    }
    if (marker === 196) {
      let table = offset + 2
      while (table < end) {
        const info = bytes[table++]
        if (info >> 4 > 1 || (info & 15) > 3 || table + 16 > end) invalid()
        const symbols = bytes.subarray(table, table + 16).reduce((sum, count) => sum + count, 0)
        if (!symbols || symbols > 256 || table + 16 + symbols > end) invalid()
        table += 16 + symbols; huffman = true
      }
    }
    if ([192, 193, 194].includes(marker)) {
      if (size < 11 || bytes[offset + 2] !== 8 || bytes[offset + 7] < 1 || bytes[offset + 7] > 4 || size !== 8 + 3 * bytes[offset + 7]) invalid()
      dimensions(bytes.readUInt16BE(offset + 5), bytes.readUInt16BE(offset + 3)); frame = true
    }
    offset = end
    if (marker === 218) {
      if (!frame || !quantization || !huffman || size < 8 || bytes[end - size + 2] < 1 || bytes[end - size + 2] > 4 || size !== 6 + 2 * bytes[end - size + 2]) invalid()
      scan = true
      let entropyBytes = 0
      while (offset < bytes.length - 2) {
        if (bytes[offset] !== 255) { offset++; entropyBytes++; continue }
        const next = bytes[offset + 1]
        if (next === 0 || next >= 208 && next <= 215) { offset += 2; if (next === 0) entropyBytes++; continue }
        break
      }
      if (!entropyBytes) invalid()
    }
  }
  if (!frame || !scan || offset !== bytes.length - 2) invalid()
}
function validWebp(bytes: Buffer) {
  if (bytes.length < 26 || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WEBP' || bytes.readUInt32LE(4) + 8 !== bytes.length) invalid()
  let offset = 12, image = false
  while (offset + 8 <= bytes.length) {
    const type = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8
    if (start + size > bytes.length) invalid()
    if (type === 'VP8 ') {
      if (image || size <= 10 || !bytes.subarray(start + 3, start + 6).equals(Buffer.from([157, 1, 42])) || bytes[start] & 1) invalid()
      const partitionSize = bytes.readUIntLE(start, 3) >>> 5
      if (!partitionSize || partitionSize > size - 10) invalid()
      dimensions(bytes.readUInt16LE(start + 6) & 16383, bytes.readUInt16LE(start + 8) & 16383); image = true
    } else if (type === 'VP8L') {
      if (image || size <= 5 || bytes[start] !== 47 || bytes[start + 4] >> 5) invalid()
      const bits = bytes.readUInt32LE(start + 1); dimensions((bits & 16383) + 1, ((bits >>> 14) & 16383) + 1); image = true
    } else if (type === 'VP8X') {
      if (size !== 10 || bytes[start] & 2) throw new HttpError(400, '请将动画截图导出为静态 PNG、JPEG 或 WebP')
      dimensions(bytes.readUIntLE(start + 4, 3) + 1, bytes.readUIntLE(start + 7, 3) + 1)
    }
    offset = start + size + (size % 2)
  }
  if (!image || offset !== bytes.length) invalid()
}
export function validateFeedbackAttachments(value: unknown): Array<FeedbackAttachmentInput & { size: number }> {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > feedbackAttachmentLimits.count) throw new HttpError(400, '每次最多添加 3 张截图')
  return value.map(input => {
    if (!input || typeof input !== 'object' || !['image/png', 'image/jpeg', 'image/webp'].includes(input.mimeType)) invalid()
    if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 240) throw new HttpError(400, '截图名称不能为空且不得超过 240 字符')
    const encoded = input.dataBase64
    if (typeof encoded !== 'string' || !encoded || encoded.length > Math.ceil(feedbackAttachmentLimits.bytes / 3) * 4) throw new HttpError(400, '单张截图不得超过 2 MiB')
    if (encoded.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) invalid()
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded) invalid()
    if (!bytes.length || bytes.length > feedbackAttachmentLimits.bytes) throw new HttpError(400, '单张截图不得超过 2 MiB')
    if (input.mimeType === 'image/png') validPng(bytes)
    else if (input.mimeType === 'image/jpeg') validJpeg(bytes)
    else validWebp(bytes)
    const name = input.name.replace(/\\/g, '/').split('/').at(-1)!.replace(/[\x00-\x1f\x7f]/g, '').trim()
    if (!name) throw new HttpError(400, '截图名称无效')
    return { name, mimeType: input.mimeType, dataBase64: bytes.toString('base64'), size: bytes.length }
  })
}
export function feedbackAttachmentMetadata(row: StoredFeedbackAttachment): FeedbackAttachment {
  const { dataBase64: _binary, ...metadata } = row
  return metadata
}
