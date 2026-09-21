import { crc32, inflateRawSync } from 'node:zlib'
import type { DocxLimits } from '../shared/report-docx.ts'

export class DocxError extends Error {
  readonly status = 400
  constructor(message: string) { super(message); this.name = 'DocxError' }
}
export function fail(message: string): never { throw new DocxError(message) }
export const DEFAULT_DOCX_LIMITS: Readonly<DocxLimits> = {
  maxBytes: 12 * 1024 * 1024, maxExpandedBytes: 40 * 1024 * 1024,
  maxEntries: 3000, maxXmlBytes: 8 * 1024 * 1024, maxTextChars: 1200000, maxRows: 10000, maxCells: 100000,
}
export function docxLimits(options: Partial<DocxLimits>): DocxLimits {
  const result = { ...DEFAULT_DOCX_LIMITS }
  for (const key of Object.keys(result) as (keyof DocxLimits)[]) {
    const value = options[key]
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_DOCX_LIMITS[key]) fail('DOCX 解析限额必须为正整数且不超过服务端上限')
      result[key] = value
    }
  }
  return result
}
function utf8(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) }
  catch { return fail('DOCX 文件名或 XML 不是有效 UTF-8，请用 Word 重新另存为 DOCX') }
}
export function safePartName(name: string): void {
  const path = name.endsWith('/') ? name.slice(0, -1) : name
  if (!path || name.startsWith('/') || /[\\:\u0000-\u001f\u007f%?#]/.test(name) || path.split('/').some(segment => !segment || segment === '.' || segment === '..')) fail('DOCX 压缩文件项路径或文件名不安全')
}
/** Inspect and inflate with hard limits before any convenience ZIP library allocates data. */
export function readDocxArchive(bytes: Buffer, limits: DocxLimits): Map<string, Buffer> {
  if (!Buffer.isBuffer(bytes) || bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) fail('文件不是有效 DOCX；旧 DOC、加密文件请先用 Word 另存为 DOCX')
  if (bytes.length > limits.maxBytes) fail('DOCX 文件超过上传大小限额')
  let end = -1
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break }
  }
  if (end < 0) fail('DOCX 压缩目录已损坏')
  const count = bytes.readUInt16LE(end + 10), directorySize = bytes.readUInt32LE(end + 12), directoryStart = bytes.readUInt32LE(end + 16)
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || count === 0xffff || count > limits.maxEntries || !count || directoryStart + directorySize !== end) fail('DOCX ZIP64、多卷或压缩目录结构不受支持')
  const parts = new Map<string, Buffer>(), folded = new Set<string>(), spans: Array<[number, number]> = []
  let position = directoryStart, expanded = 0
  for (let i = 0; i < count; i++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) fail('DOCX 压缩目录不完整')
    const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10), checksum = bytes.readUInt32LE(position + 16)
    const compressedSize = bytes.readUInt32LE(position + 20), declaredSize = bytes.readUInt32LE(position + 24)
    const nameLength = bytes.readUInt16LE(position + 28), extraLength = bytes.readUInt16LE(position + 30), commentLength = bytes.readUInt16LE(position + 32)
    const offset = bytes.readUInt32LE(position + 42), recordEnd = position + 46 + nameLength + extraLength + commentLength
    if (recordEnd > end || offset + 30 > directoryStart || bytes.readUInt16LE(position + 34) || [compressedSize, declaredSize, offset].includes(0xffffffff)) fail('DOCX 压缩目录大小或位置异常')
    if (flags & (1 | 64 | 8192)) fail('不支持加密 DOCX，请取消密码保护并另存')
    if (![0, 8].includes(method)) fail('DOCX 压缩方法不受支持')
    const nameBytes = bytes.subarray(position + 46, position + 46 + nameLength), name = utf8(nameBytes)
    safePartName(name)
    if (folded.has(name.toLowerCase())) fail('DOCX 包含重复的压缩文件项')
    folded.add(name.toLowerCase())
    for (let p = position + 46 + nameLength; p < position + 46 + nameLength + extraLength;) {
      if (p + 4 > position + 46 + nameLength + extraLength) fail('DOCX ZIP 扩展字段损坏')
      const id = bytes.readUInt16LE(p), size = bytes.readUInt16LE(p + 2)
      if (id === 1 || p + 4 + size > position + 46 + nameLength + extraLength) fail('DOCX ZIP64 或扩展字段不受支持')
      p += 4 + size
    }
    if (bytes.readUInt32LE(offset) !== 0x04034b50 || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method) fail('DOCX 压缩目录与文件头不一致')
    const localNameLength = bytes.readUInt16LE(offset + 26), localExtraLength = bytes.readUInt16LE(offset + 28)
    const start = offset + 30 + localNameLength + localExtraLength, dataEnd = start + compressedSize
    if (dataEnd > directoryStart || !bytes.subarray(offset + 30, offset + 30 + localNameLength).equals(nameBytes)) fail('DOCX 压缩文件名或数据范围不一致')
    const localCrc = bytes.readUInt32LE(offset + 14), localCompressed = bytes.readUInt32LE(offset + 18), localExpanded = bytes.readUInt32LE(offset + 22)
    if ((!(flags & 8) || localCrc || localCompressed || localExpanded) && (localCrc !== checksum || localCompressed !== compressedSize || localExpanded !== declaredSize)) fail('DOCX 压缩文件头的大小或 CRC 校验不一致')
    let spanEnd = dataEnd
    if (flags & 8) {
      let descriptor = dataEnd
      if (descriptor + 4 <= directoryStart && bytes.readUInt32LE(descriptor) === 0x08074b50) descriptor += 4
      if (descriptor + 12 > directoryStart || bytes.readUInt32LE(descriptor) !== checksum || bytes.readUInt32LE(descriptor + 4) !== compressedSize || bytes.readUInt32LE(descriptor + 8) !== declaredSize) fail('DOCX 压缩数据描述符不一致')
      spanEnd = descriptor + 12
    }
    spans.push([offset, spanEnd])
    if (declaredSize > limits.maxExpandedBytes - expanded) fail('DOCX 解压后超过大小限额')
    let value: Buffer
    try { value = method === 0 ? bytes.subarray(start, dataEnd) : inflateRawSync(bytes.subarray(start, dataEnd), { maxOutputLength: Math.max(1, limits.maxExpandedBytes - expanded) }) }
    catch { return fail('DOCX 解压失败或实际解压大小超过限额') }
    expanded += value.length
    if (expanded > limits.maxExpandedBytes || value.length !== declaredSize) fail('DOCX 实际解压大小与声明不一致或超过限额')
    if (crc32(value) !== checksum) fail('DOCX 压缩文件 CRC 校验失败')
    if (name.endsWith('/') && value.length) fail('DOCX 压缩目录项包含异常数据')
    parts.set(name, value)
    position = recordEnd
  }
  if (position !== end) fail('DOCX 压缩目录长度不一致')
  spans.sort((a, b) => a[0] - b[0])
  for (let i = 1; i < spans.length; i++) if (spans[i][0] < spans[i - 1][1]) fail('DOCX 压缩文件数据区域重叠')
  if (!parts.has('[Content_Types].xml') || !parts.has('_rels/.rels') || !parts.has('word/document.xml')) fail('ZIP 不是完整的 DOCX 文档')
  return parts
}
export const decodeDocxXml = utf8
