import ExcelJS from 'exceljs'
import { basename, extname } from 'node:path'
import { inflateRawSync } from 'node:zlib'

export interface ParsedImportRow { rowNumber: number; cells: string[] }
export interface ParsedImportSheet { name: string; rows: ParsedImportRow[]; merges?: string[] }
export interface ParsedImportFile {
  kind: 'table' | 'image' | 'text'
  fileName: string
  mimeType: string
  sheets?: ParsedImportSheet[]
  text?: string
  imageDataUrl?: string
  warnings: string[]
}
export interface ImportFileLimits {
  maxBytes: number
  maxImageBytes: number
  maxExpandedBytes: number
  maxSheets: number
  maxRows: number
  maxColumns: number
  maxCells: number
  maxTextChars: number
}
export const DEFAULT_IMPORT_FILE_LIMITS: Readonly<ImportFileLimits> = {
  maxBytes: 12 * 1024 * 1024, maxImageBytes: 10 * 1024 * 1024,
  maxExpandedBytes: 40 * 1024 * 1024, maxSheets: 30,
  maxRows: 10000, maxColumns: 256, maxCells: 100000, maxTextChars: 1200000,
}
export class ImportFileError extends Error {
  readonly status = 400
  constructor(message: string) { super(message); this.name = 'ImportFileError' }
}
function reject(message: string): never { throw new ImportFileError(message) }
function limitsFor(options: Partial<ImportFileLimits>): ImportFileLimits {
  const limits = { ...DEFAULT_IMPORT_FILE_LIMITS, ...options }
  for (const value of Object.values(limits)) if (!Number.isSafeInteger(value) || value < 1) reject('文件解析限额必须为正整数')
  return limits
}
function coordinate(address: string): { row: number; column: number } {
  const match = /^\$?([A-Z]{1,3})\$?([1-9]\d{0,6})$/.exec(address)
  if (!match) reject('工作簿包含无效的单元格地址')
  let column = 0
  for (const letter of match[1]) column = column * 26 + letter.charCodeAt(0) - 64
  const row = Number(match[2])
  if (column > 16384 || row > 1048576) reject('工作簿单元格超出 Excel 范围')
  return { row, column }
}

// Validate actual inflated sizes before ExcelJS allocates its workbook model.
// No archive paths are written to disk and no external workbook links are fetched.
function validateXlsxArchive(bytes: Buffer, limits: ImportFileLimits) {
  if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) reject('文件内容不是有效的 XLSX 工作簿')
  let end = -1
  for (let position = bytes.length - 22; position >= Math.max(0, bytes.length - 65557); position--) {
    if (bytes.readUInt32LE(position) === 0x06054b50 && position + 22 + bytes.readUInt16LE(position + 20) === bytes.length) { end = position; break }
  }
  if (end < 0) reject('XLSX 文件已损坏或不完整')
  const entries = bytes.readUInt16LE(end + 10)
  let position = bytes.readUInt32LE(end + 16), expanded = 0, mergeArea = 0
  if (bytes.readUInt16LE(end + 4) !== 0 || bytes.readUInt16LE(end + 6) !== 0 || entries === 0xffff || entries > 3000) reject('工作簿压缩结构过大或不受支持')
  const names = new Set<string>()
  for (let i = 0; i < entries; i++) {
    if (position + 46 > end || bytes.readUInt32LE(position) !== 0x02014b50) reject('XLSX 压缩目录已损坏')
    const flags = bytes.readUInt16LE(position + 8), method = bytes.readUInt16LE(position + 10)
    const compressedSize = bytes.readUInt32LE(position + 20), expandedSize = bytes.readUInt32LE(position + 24)
    const nameLength = bytes.readUInt16LE(position + 28), extraLength = bytes.readUInt16LE(position + 30), commentLength = bytes.readUInt16LE(position + 32)
    const offset = bytes.readUInt32LE(position + 42)
    if (position + 46 + nameLength + extraLength + commentLength > end || offset + 30 > bytes.length) reject('XLSX 压缩目录已损坏')
    const name = bytes.subarray(position + 46, position + 46 + nameLength).toString('utf8')
    if (names.has(name)) reject('XLSX 包含重复的压缩文件项')
    names.add(name)
    if ((flags & 1) !== 0) reject('暂不支持加密工作簿，请先取消密码保护并另存为 XLSX')
    if (![0, 8].includes(method) || expandedSize > limits.maxExpandedBytes - expanded || bytes.readUInt32LE(offset) !== 0x04034b50) reject('工作簿解压后过大或压缩格式不受支持')
    const start = offset + 30 + bytes.readUInt16LE(offset + 26) + bytes.readUInt16LE(offset + 28)
    if (start + compressedSize > bytes.length) reject('XLSX 压缩内容不完整')
    const compressed = bytes.subarray(start, start + compressedSize)
    let value: Buffer
    try { value = method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1, limits.maxExpandedBytes - expanded) }) }
    catch { reject('工作簿解压失败或解压后超过允许大小') }
    expanded += value.length
    if (expanded > limits.maxExpandedBytes || value.length !== expandedSize) reject('工作簿解压大小异常或超过允许大小')
    if (/^xl\/worksheets\/[^/]+\.xml$/.test(name)) {
      const xml = value.toString('utf8')
      for (const match of xml.matchAll(/<(?:\w+:)?mergeCell\s+[^>]*\bref=["']([^"']+)["']/g)) {
        const [a, b = a] = match[1].split(':')
        const first = coordinate(a), last = coordinate(b)
        if (last.row < first.row || last.column < first.column) reject('工作簿包含无效合并区域')
        mergeArea += (last.row - first.row + 1) * (last.column - first.column + 1)
        if (mergeArea > limits.maxCells * 4) reject('工作簿合并区域过大，请移除数据范围之外的合并单元格')
      }
    }
    position += 46 + nameLength + extraLength + commentLength
  }
  if (!names.has('[Content_Types].xml') || !names.has('xl/workbook.xml')) reject('文件不是 XLSX 工作簿')
}

function cellText(value: ExcelJS.CellValue, warning: (message: string) => void, location: string, depth = 0): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().replace(/T00:00:00\.000Z$/, '')
  if ('formula' in value || 'sharedFormula' in value) {
    if (depth > 1 || value.result === undefined || value.result === null) {
      warning(`${location} 的公式没有缓存结果，请在 Excel 中重新计算并保存后导入`)
      return '[公式无缓存结果]'
    }
    return cellText(value.result, warning, location, depth + 1)
  }
  if ('richText' in value) return value.richText.map(part => part.text).join('').trim()
  if ('text' in value) return String(value.text).trim()
  if ('error' in value) { warning(`${location} 包含公式错误 ${value.error}`); return value.error }
  return ''
}

function checkTables(sheets: ParsedImportSheet[], limits: ImportFileLimits) {
  let rowCount = 0, cellCount = 0, chars = 0
  for (const sheet of sheets) {
    rowCount += sheet.rows.length
    for (const row of sheet.rows) {
      if (row.cells.length > limits.maxColumns) reject(`工作表“${sheet.name}”有效列数超过 ${limits.maxColumns} 列`)
      cellCount += row.cells.length
      for (const cell of row.cells) chars += cell.length
    }
  }
  if (sheets.length > limits.maxSheets) reject(`工作表数量超过 ${limits.maxSheets} 张，请分批导入`)
  if (rowCount > limits.maxRows) reject(`非空行数量超过 ${limits.maxRows} 行，请分批导入`)
  if (cellCount > limits.maxCells || chars > limits.maxTextChars) reject('表格有效内容超过解析限额，请按月份或工作表拆分后导入')
  if (!rowCount) reject('文件中没有可导入的数据')
}

async function parseXlsx(bytes: Buffer, limits: ImportFileLimits, warnings: string[]): Promise<ParsedImportSheet[]> {
  validateXlsxArchive(bytes, limits)
  const workbook = new ExcelJS.Workbook()
  try {
    await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0], {
      ignoreNodes: ['dataValidations', 'conditionalFormatting', 'drawing', 'picture', 'extLst'],
    })
  } catch { reject('无法读取工作簿，文件可能已损坏或受到密码保护，请重新导出 XLSX') }
  if (workbook.worksheets.length > limits.maxSheets) reject(`工作表数量超过 ${limits.maxSheets} 张，请分批导入`)
  const warn = (message: string) => { if (warnings.length < 100) warnings.push(message) }
  const sheets: ParsedImportSheet[] = []
  let originalCells = 0, originalChars = 0, originalRows = 0
  for (const sheet of workbook.worksheets) {
    const rawRows = new Map<number, string[]>()
    let lastColumn = 0
    sheet.eachRow({ includeEmpty: false }, row => {
      const cells: string[] = []
      row.eachCell({ includeEmpty: false }, (cell, column) => {
        if (cell.isMerged && cell.master.address !== cell.address) return
        const rawValue = cell.value
        // ExcelJS's value getter omits a cached 0; its result getter retains it.
        const actualValue = rawValue && typeof rawValue === 'object' && ('formula' in rawValue || 'sharedFormula' in rawValue)
          ? { ...rawValue, result: cell.result } : rawValue
        const value = cellText(actualValue, warn, `${sheet.name}!${cell.address}`)
        if (!value) return
        if (column > limits.maxColumns) reject(`工作表“${sheet.name}”有效列数超过 ${limits.maxColumns} 列`)
        if (++originalCells > limits.maxCells || (originalChars += value.length) > limits.maxTextChars) reject('表格有效内容超过解析限额，请按月份或工作表拆分后导入')
        while (cells.length < column) cells.push('')
        cells[column - 1] = value
        lastColumn = Math.max(lastColumn, column)
      })
      if (cells.length) {
        if (++originalRows > limits.maxRows) reject(`非空行数量超过 ${limits.maxRows} 行，请分批导入`)
        rawRows.set(row.number, cells)
      }
    })
    const merges = (sheet.model.merges ?? []).map(String)
    // Fill only rows that actually had data; merged formatting must not create records.
    let fills = 0
    for (const merge of merges) {
      const [a, b = a] = merge.split(':')
      const first = coordinate(a), last = coordinate(b)
      const value = rawRows.get(first.row)?.[first.column - 1]
      if (!value) continue
      for (const [rowNumber, cells] of rawRows) {
        if (rowNumber < first.row || rowNumber > last.row) continue
        for (let column = first.column; column <= Math.min(last.column, lastColumn); column++) {
          while (cells.length < column) cells.push('')
          if (!cells[column - 1]) { cells[column - 1] = value; fills++ }
        }
      }
    }
    if (fills) warn(`工作表“${sheet.name}”已按合并区域补齐 ${fills} 个单元格，保留原始行号及合并范围`)
    if (sheet.state !== 'visible') warn(`工作表“${sheet.name}”原为隐藏状态，已保留供选择导入`)
    sheets.push({ name: sheet.name, rows: [...rawRows].map(([rowNumber, cells]) => ({ rowNumber, cells })), merges })
  }
  checkTables(sheets, limits)
  return sheets
}

function decodeText(bytes: Buffer, warnings: string[]): string {
  try {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes)
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes)
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    try { const text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); warnings.push('已按 GB18030 读取中文表格，请核对预览中的文字'); return text }
    catch { reject('无法识别文本编码，请使用 UTF-8 或 UTF-16 格式重新导出') }
  }
}

function parseDelimited(text: string, delimiter: string, limits: ImportFileLimits): ParsedImportRow[] {
  let start = 0, physicalLine = 1
  const sep = /^sep=([,;\t])\r?\n/i.exec(text)
  if (sep) { delimiter = sep[1]; start = sep[0].length; physicalLine = 2 }
  const rows: ParsedImportRow[] = []
  let cells: string[] = [], field = '', quoted = false, closedQuote = false, rowNumber = physicalLine, count = 0
  const endField = () => { cells.push(field.trim()); field = ''; closedQuote = false; if (cells.length > limits.maxColumns) reject(`表格列数超过 ${limits.maxColumns} 列`) }
  const endRow = () => {
    endField()
    while (cells.length && !cells[cells.length - 1]) cells.pop()
    if (cells.length) {
      rows.push({ rowNumber, cells })
      count += cells.length
      if (rows.length > limits.maxRows || count > limits.maxCells) reject('表格有效行或单元格数量超过解析限额，请分批导入')
    }
    cells = []; rowNumber = physicalLine + 1
  }
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else { quoted = false; closedQuote = true } }
      else if (ch === '\r' || ch === '\n') { if (ch === '\r' && text[i + 1] === '\n') i++; field += '\n'; physicalLine++ }
      else field += ch
    } else if (ch === delimiter) endField()
    else if (ch === '\r' || ch === '\n') { endRow(); if (ch === '\r' && text[i + 1] === '\n') i++; physicalLine++ }
    else if (ch === '"' && !field && !closedQuote) quoted = true
    else if (closedQuote && ch.trim()) reject(`第 ${physicalLine} 行的引号格式有误，请重新导出 CSV`)
    else if (!closedQuote) field += ch
  }
  if (quoted) reject(`第 ${rowNumber} 行存在未闭合引号，请重新导出 CSV`)
  if (field || cells.length || closedQuote) endRow()
  return rows
}

function imageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString('ascii', 12, 16) === 'IHDR') {
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20)
    if (!width || !height || width * height > 40000000) reject('图片像素尺寸过大或无效，请缩小后上传')
    return 'image/png'
  }
  if (bytes.length >= 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff && bytes[bytes.length - 2] === 0xff && bytes[bytes.length - 1] === 0xd9) return 'image/jpeg'
  if (bytes.length >= 20 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('ascii', 12, 16)) && bytes.readUInt32LE(4) + 8 === bytes.length) return 'image/webp'
  return undefined
}

export async function parseImportFile(fileName: string, mimeType: string, bytes: Buffer, options: Partial<ImportFileLimits> = {}): Promise<ParsedImportFile> {
  const limits = limitsFor(options)
  if (!Buffer.isBuffer(bytes) || !bytes.length) reject('请选择包含数据的文件')
  if (bytes.length > limits.maxBytes) reject(`文件超过 ${Math.floor(limits.maxBytes / 1024 / 1024)} MB 限额，请分批导入`)
  const safeName = basename(fileName.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 240)
  if (!safeName) reject('文件名不能为空')
  const extension = extname(safeName).toLowerCase(), warnings: string[] = []
  const base = { fileName: safeName, mimeType, warnings }
  if (extension === '.xls') reject('暂不支持旧版 .xls 文件，请在 Excel 或钉钉中另存为 .xlsx 后上传')
  if (extension === '.xlsx') return { ...base, kind: 'table', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', sheets: await parseXlsx(bytes, limits, warnings) }
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(extension)) {
    if (bytes.length > limits.maxImageBytes) reject(`图片超过 ${Math.floor(limits.maxImageBytes / 1024 / 1024)} MB 限额，请压缩后上传`)
    const detected = imageMime(bytes), expected = extension === '.png' ? 'image/png' : extension === '.webp' ? 'image/webp' : 'image/jpeg'
    if (detected !== expected) reject('图片内容与文件类型不一致或图片已损坏，请重新导出 PNG、JPEG 或 WebP')
    return { ...base, kind: 'image', mimeType: detected, imageDataUrl: `data:${detected};base64,${bytes.toString('base64')}` }
  }
  if (['.csv', '.tsv', '.txt', '.md'].includes(extension)) {
    const text = decodeText(bytes, warnings).replace(/^\uFEFF/, '')
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) reject('文件包含二进制内容，请上传有效文本或表格')
    if (text.length > limits.maxTextChars) reject('文本内容超过解析限额，请分批导入')
    if (!text.trim()) reject('文件中没有可导入的数据')
    if (extension === '.txt' || extension === '.md') return { ...base, kind: 'text', mimeType: 'text/plain', text }
    const sheets = [{ name: safeName, rows: parseDelimited(text, extension === '.tsv' ? '\t' : ',', limits) }]
    checkTables(sheets, limits)
    return { ...base, kind: 'table', mimeType: extension === '.tsv' ? 'text/tab-separated-values' : 'text/csv', sheets }
  }
  reject('支持 XLSX、CSV、TSV、TXT、Markdown 和 PNG/JPEG/WebP 图片；钉钉在线表请先导出文件')
}

export interface ImportModelChunk { sheetName: string; contextRows: ParsedImportRow[]; rows: ParsedImportRow[]; text: string }
const periodPattern = /(?:20\d{2}\s*[-年/.]\s*\d{1,2}|\d{1,2}\s*月|第\s*\d+\s*周)/
const headerPattern = /^(?:序号|项目编号|项目名称|负责人(?:员)?|工作内容|工作事项|交付时间|开始时间|结束时间|本周.*|下周工作计划|完成情况)$/

/** Context rows carry source evidence; only rows are new candidates in each chunk. */
export function buildModelChunks(parsed: ParsedImportFile, sheetNames?: string[], maxChars = 18000, maxRows = 20): ImportModelChunk[] {
  if (!Number.isSafeInteger(maxChars) || maxChars < 1000) reject('模型分块大小必须至少为 1000 字符')
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 100) reject('模型每块源行上限必须为 1 至 100 行')
  if (parsed.kind !== 'table') return []
  const selected = sheetNames ? new Set(sheetNames) : undefined
  if (selected && [...selected].some(name => !parsed.sheets?.some(sheet => sheet.name === name))) reject('选择的工作表不存在，请重新选择')
  const chunks: ImportModelChunk[] = []
  for (const sheet of parsed.sheets ?? []) {
    if (selected && !selected.has(sheet.name)) continue
    let header: ParsedImportRow[] = [], periods: ParsedImportRow[] = [], rows: ParsedImportRow[] = [], contextRows: ParsedImportRow[] = [], previousRowNumber = 0
    const titles = sheet.rows.slice(0, 2).filter(row => {
      const values = [...new Set(row.cells.filter(Boolean))]
      return values.length <= 2 && values.every(value => value.length <= 100 && !periodPattern.test(value))
    })
    const contextBefore = (rowNumber: number) => [...new Map([...titles, ...header, ...periods].filter(item => item.rowNumber < rowNumber).map(item => [item.rowNumber, item])).values()].sort((a, b) => a.rowNumber - b.rowNumber)
    const encoded = (context: ParsedImportRow[], data: ParsedImportRow[]) => JSON.stringify({ sheetName: sheet.name, contextRows: context, rows: data })
    const flush = () => { if (rows.length) chunks.push({ sheetName: sheet.name, contextRows, rows, text: encoded(contextRows, rows) }); rows = [] }
    for (const row of sheet.rows) {
      const values = [...new Set(row.cells.filter(Boolean))]
      const isHeader = values.filter(value => headerPattern.test(value)).length >= 2
      const isPeriod = values.length <= 2 && values.length > 0 && values.every(value => periodPattern.test(value) && value.length <= 100)
      if (!rows.length) contextRows = contextBefore(row.rowNumber)
      if (rows.length >= maxRows || encoded(contextRows, [...rows, row]).length > maxChars) {
        flush()
        contextRows = contextBefore(row.rowNumber)
        if (encoded(contextRows, [row]).length > maxChars) reject(`工作表“${sheet.name}”第 ${row.rowNumber} 行及其上下文过长，请拆分该行内容后重试`)
      }
      rows.push(row)
      if (isHeader) {
        // A new table layout without an adjacent period title must not inherit
        // an unrelated earlier section's month as if it were source evidence.
        if (header.length && JSON.stringify(header[0].cells) !== JSON.stringify(row.cells) && periods[0]?.rowNumber !== previousRowNumber) periods = []
        header = [row]
      }
      if (isPeriod) periods = [row]
      previousRowNumber = row.rowNumber
    }
    flush()
  }
  if (!chunks.length) reject('所选工作表没有可解析的数据，请选择包含计划内容的工作表')
  return chunks
}
