import { createHash } from 'node:crypto'
import { posix } from 'node:path'
import JSZip from 'jszip'
import { DOMParser, XMLSerializer, type Document as XmlDocument, type Element as XmlElement, type Node as XmlNode } from '@xmldom/xmldom'
import type { DocxEdit, DocxInspection, DocxLimits, DocxRegion, DocxRenderOptions } from '../shared/report-docx.ts'
import { decodeDocxXml, docxLimits, fail, readDocxArchive } from './report-docx-archive.ts'
export { DocxError, DEFAULT_DOCX_LIMITS } from './report-docx-archive.ts'

export const DOCX_RENDERER_VERSION = 'docx-ooxml-v1'
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
const CT = 'http://schemas.openxmlformats.org/package/2006/content-types'
const XML = 'http://www.w3.org/XML/1998/namespace'
const OFFICE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/'
const BIB = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography'
const DS = 'http://schemas.openxmlformats.org/officeDocument/2006/customXml'
const XMLNS = 'http://www.w3.org/2000/xmlns/'
const invalidXmlChars = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffe\uffff]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')
const is = (node: XmlNode, name: string) => node.nodeType === 1 && node.namespaceURI === W && node.localName === name
function children(node: XmlNode, name?: string): XmlElement[] {
  const result: XmlElement[] = []
  for (let child = node.firstChild; child; child = child.nextSibling) if (child.nodeType === 1 && (!name || is(child, name))) result.push(child as XmlElement)
  return result
}
function descendants(node: XmlNode, name?: string): XmlElement[] {
  const result: XmlElement[] = [], pending: Array<[XmlNode, number]> = [[node, 0]]
  let visited = 0
  while (pending.length) {
    const [current, depth] = pending.pop()!
    if (depth > 256 || ++visited > 200000) fail('DOCX XML 结构层数或节点数超过限额')
    if (current.nodeType === 1 && (!name || is(current, name))) result.push(current as XmlElement)
    for (let child = current.lastChild; child; child = child.previousSibling) pending.push([child, depth + 1])
  }
  return result
}
function visibleText(node: XmlNode): string {
  // Paragraph boundaries and explicit line breaks survive extraction.
  if (is(node, 't')) return node.textContent ?? ''
  if (is(node, 'tab')) return '\t'
  if (is(node, 'br') || is(node, 'cr')) return '\n'
  const elements = children(node)
  return elements.map((child, index) => visibleText(child) + (is(child, 'p') && index < elements.length - 1 ? '\n' : '')).join('')
}
function parseXml(bytes: Buffer, part: string, limits: DocxLimits): XmlDocument {
  if (bytes.length > limits.maxXmlBytes) fail(`DOCX XML 部件 ${part} 超过解析大小限额`)
  const source = decodeDocxXml(bytes)
  if (invalidXmlChars.test(source)) fail('DOCX 源 XML 含非法控制字符，请修复后重新上传')
  for (const match of source.matchAll(/&#(x[0-9a-f]+|[0-9]+);/gi)) {
    const code = parseInt(match[1][0].toLowerCase() === 'x' ? match[1].slice(1) : match[1], match[1][0].toLowerCase() === 'x' ? 16 : 10)
    if (![9, 10, 13].includes(code) && !(code >= 0x20 && code <= 0xd7ff || code >= 0xe000 && code <= 0xfffd || code >= 0x10000 && code <= 0x10ffff)) fail('DOCX 源 XML 含非法字符引用，请修复后重新上传')
  }
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(source)) fail('DOCX 含 DTD 或实体声明，禁止进入学习和模板输出')
  try {
    const document = new DOMParser({ onError: (_level, message) => { throw new Error(message) } }).parseFromString(source, 'application/xml')
    if (!document.documentElement) fail('DOCX XML 缺少根节点')
    descendants(document)
    return document
  } catch { return fail(`DOCX XML 部件 ${part} 无效，请用 Word 修复并另存`) }
}
function enabled(element: XmlElement) { return !['0', 'false', 'off'].includes(element.getAttributeNS(W, 'val') ?? '') }
const revisionNames = new Set(['ins', 'del', 'moveFrom', 'moveTo', 'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd', 'pPrChange', 'rPrChange', 'tcPrChange', 'trPrChange', 'sectPrChange', 'tblPrChange', 'tblGridChange', 'numberingChange', 'cellIns', 'cellDel', 'cellMerge'])
const dangerousNames = new Set(['altChunk', 'object', 'control', 'dataBinding'])
const complexNames = new Set(['sdt', 'fldChar', 'fldSimple', 'instrText', 'txbxContent', 'drawing', 'pict', 'hyperlink', 'footnoteReference', 'endnoteReference'])

function validateCustomXml(name: string, document: XmlDocument, parts: Map<string, Buffer>) {
  const root = document.documentElement!
  // Bibliography entries themselves can contain old business/person data. Only
  // the empty Word bookkeeping seen in the validated company template is retained.
  const item = /^customXml\/item([1-9]\d*)\.xml$/.exec(name)
  const props = /^customXml\/itemProps([1-9]\d*)\.xml$/.exec(name)
  const relation = /^customXml\/_rels\/item([1-9]\d*)\.xml\.rels$/.exec(name)
  const reject = () => fail('DOCX 含不受支持的自定义 XML 或隐藏书目数据；请清理后重新上传')
  if (!item && !props && !relation) reject()
  const allowedAttrs = (node: XmlElement, attrs: Record<string, (value: string) => boolean>, namespace: string) => {
    for (let i = 0; i < node.attributes.length; i++) {
      const attr = node.attributes.item(i)!
      if (attr.namespaceURI === XMLNS && attr.value === namespace) continue
      const key = attr.namespaceURI ? `{${attr.namespaceURI}}${attr.localName}` : attr.name
      if (!attrs[key]?.(attr.value)) reject()
    }
  }
  const pending: XmlNode[] = [document]
  while (pending.length) {
    const node = pending.pop()!
    if ((node.nodeType === 3 || node.nodeType === 4) && node.textContent?.trim() || node.nodeType === 8 || node.nodeType === 7 && node.nodeName.toLowerCase() !== 'xml') reject()
    for (let child = node.firstChild; child; child = child.nextSibling) pending.push(child)
  }
  if (item) {
    if (root.namespaceURI !== BIB || root.localName !== 'Sources' || children(root).length) reject()
    allowedAttrs(root, { StyleName: value => /^[A-Za-z0-9 ._-]{0,80}$/.test(value), SelectedStyle: value => /^\/?[A-Za-z0-9._-]+\.XSL$/i.test(value) }, BIB)
  } else if (props) {
    if (!parts.has(`customXml/item${props[1]}.xml`) || root.namespaceURI !== DS || root.localName !== 'datastoreItem') reject()
    allowedAttrs(root, { [`{${DS}}itemID`]: value => /^\{[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12}\}$/.test(value) }, DS)
    const refs = children(root)
    if (refs.length !== 1 || refs[0].namespaceURI !== DS || refs[0].localName !== 'schemaRefs') reject()
    allowedAttrs(refs[0], {}, DS)
    for (const ref of children(refs[0])) {
      if (ref.namespaceURI !== DS || ref.localName !== 'schemaRef' || children(ref).length) reject()
      allowedAttrs(ref, { [`{${DS}}uri`]: value => value === BIB }, DS)
      if (ref.getAttributeNS(DS, 'uri') !== BIB) reject()
    }
  } else if (relation) {
    if (!parts.has(`customXml/item${relation[1]}.xml`) || !parts.has(`customXml/itemProps${relation[1]}.xml`) || root.namespaceURI !== REL || root.localName !== 'Relationships') reject()
    allowedAttrs(root, {}, REL)
    const entries = children(root)
    if (entries.length !== 1 || entries[0].namespaceURI !== REL || entries[0].localName !== 'Relationship') reject()
    const entry = entries[0]
    allowedAttrs(entry, { Id: value => /^rId\d+$/.test(value), Type: value => value === OFFICE_REL + 'customXmlProps', Target: value => value === `itemProps${relation[1]}.xml`, TargetMode: value => value === 'Internal' }, REL)
    if (entry.getAttribute('Type') !== OFFICE_REL + 'customXmlProps' || entry.getAttribute('Target') !== `itemProps${relation[1]}.xml`) reject()
  }
}

function inspectParts(parts: Map<string, Buffer>, limits: DocxLimits) {
  const documents = new Map<string, XmlDocument>(), fonts = new Set<string>(), warnings: string[] = []
  const contentTypes = parseXml(parts.get('[Content_Types].xml')!, '[Content_Types].xml', limits)
  const xmlNames = new Set([...parts.keys()].filter(name => /\.(xml|rels)$/i.test(name)))
  for (const declaration of children(contentTypes.documentElement!)) {
    const contentType = declaration.getAttribute('ContentType') ?? ''
    if (/svg/i.test(contentType)) fail('DOCX 含 SVG 图像，尚未验证其中的脚本或外部资源，请改用内嵌 PNG 图像')
    if (!/(?:\+xml|\/xml)$/i.test(contentType)) continue
    const partName = declaration.getAttribute('PartName'), extension = declaration.getAttribute('Extension')
    if (partName) {
      let decoded: string
      try { decoded = decodeURIComponent(partName) } catch { return fail('DOCX 内容类型路径无效') }
      xmlNames.add(decoded.replace(/^\//, ''))
    }
    if (extension) for (const name of parts.keys()) if (name.toLowerCase().endsWith('.' + extension.toLowerCase())) xmlNames.add(name)
  }
  let textChars = 0
  for (const [name, bytes] of parts) {
    if (/vba|macros|activex|^word\/embeddings\//i.test(name)) fail('DOCX 含宏、嵌入对象或活动控件，禁止进入学习和模板输出')
    if (/(?:^|\/)comments[^/]*\.xml$/i.test(name)) fail('DOCX 含批注部件，请先清理批注后重新上传')
    const customXml = /^customxml\//i.test(name) && !name.endsWith('/')
    if (customXml && !xmlNames.has(name)) fail('DOCX 含无法审查的自定义 XML 数据部件')
    if (!xmlNames.has(name)) continue
    const document = name === '[Content_Types].xml' ? contentTypes : parseXml(bytes, name, limits), root = document.documentElement!
    if (customXml) validateCustomXml(name, document, parts)
    documents.set(name, document)
    const forbiddenField = /\b(?:DDE(?:AUTO)?|INCLUDETEXT|INCLUDEPICTURE|LINK|IMPORT|DATABASE|HYPERLINK)\b/i
    const fieldInstructions = descendants(root, 'instrText').map(el => el.textContent ?? '').join('')
    if (forbiddenField.test(fieldInstructions) || descendants(root, 'fldSimple').some(el => forbiddenField.test(el.getAttributeNS(W, 'instr') ?? ''))) fail('DOCX 含可能访问外部资源的域，禁止自动处理')
    for (const element of descendants(root)) {
      for (let index = 0; index < element.attributes.length; index++) {
        const attr = element.attributes.item(index)!, local = (attr.localName ?? attr.name).toLowerCase()
        // VML/foreign image and link attributes bypass OPC .rels. Only local
        // fragment references are safe here; file paths and relative URLs are not.
        if (['src', 'href', 'srcset', 'codebase'].includes(local) || local === 'base' && attr.namespaceURI === XML) {
          if (attr.value && !/^#[A-Za-z_][\w.-]*$/.test(attr.value)) fail('DOCX 含 VML、图像或 XML 的外部资源路径，请改为文档内嵌资源')
        }
      }
      if (element.namespaceURI === W) {
        const local = element.localName ?? ''
        if (revisionNames.has(local)) fail('DOCX 含修订，请先在 Word 中确认接受或拒绝修订后重新上传')
        if (['vanish', 'webHidden', 'specVanish'].includes(local) && enabled(element)) fail('DOCX 含隐藏文字或隐藏样式，请清理后重新上传')
        if (/^comment/.test(local)) fail('DOCX 含批注标记，请清理后重新上传')
        if (dangerousNames.has(local)) fail('DOCX 含嵌入对象、动态数据绑定或外部内容，不支持安全填充')
        if (local === 'sourceFileName') fail('DOCX 含外部框架文件，禁止自动处理')
        if (local === 't') { textChars += (element.textContent ?? '').length; if (textChars > limits.maxTextChars) fail('DOCX 正文字符数超过解析限额') }
        if (local === 'rFonts') for (const attr of ['ascii', 'hAnsi', 'eastAsia', 'cs']) { const font = element.getAttributeNS(W, attr); if (font) fonts.add(font) }
      }
      if (element.namespaceURI === CT && /macroEnabled|vbaProject|oleObject|activeX|comments/i.test(element.getAttribute('ContentType') ?? '')) fail('DOCX 内容类型包含宏、嵌入对象或批注，不支持处理')
    }
    if (/\.rels$/i.test(name)) {
      if (root.namespaceURI !== REL || root.localName !== 'Relationships') fail('DOCX 关系部件格式无效')
      const relIds = new Set<string>()
      for (const relation of children(root)) {
        if (relation.namespaceURI !== REL || relation.localName !== 'Relationship') fail('DOCX 关系部件节点无效')
        const target = relation.getAttribute('Target') ?? '', mode = relation.getAttribute('TargetMode'), type = relation.getAttribute('Type') ?? '', id = relation.getAttribute('Id') ?? ''
        if (!id || relIds.has(id)) fail('DOCX 关系 ID 为空或重复')
        relIds.add(id)
        if (mode === 'External' || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('//')) fail('DOCX 含外部链接，请移除外部链接后重新上传；系统不会访问它们')
        if (mode && mode !== 'Internal') fail('DOCX 外部关系模式不受支持')
        if (/comments|vbaProject|oleObject|activeX/i.test(type)) fail('DOCX 关系包含批注、宏或嵌入对象')
        let decoded: string
        try { decoded = decodeURIComponent(target) } catch { return fail('DOCX 内部关系路径无效') }
        if (!decoded || /[\\\u0000-\u001f?#]/.test(decoded) || /^[a-z][a-z0-9+.-]*:/i.test(decoded) || decoded.startsWith('//')) fail('DOCX 内部关系路径不安全')
        const base = name === '_rels/.rels' ? '' : posix.dirname(posix.dirname(name))
        const resolved = posix.normalize(decoded.startsWith('/') ? decoded.slice(1) : posix.join(base, decoded))
        if (resolved.startsWith('../') || !parts.has(resolved)) fail('DOCX 内部关系越过文档包或指向缺失文件')
        if (name === '_rels/.rels' && type === OFFICE_REL + 'officeDocument' && resolved !== 'word/document.xml') fail('仅支持标准 word/document.xml 主文档路径')
        if (type === OFFICE_REL + 'customXml' && !/^customXml\/item[1-9]\d*\.xml$/.test(resolved) || type === OFFICE_REL + 'customXmlProps' && !/^customXml\/itemProps[1-9]\d*\.xml$/.test(resolved)) fail('DOCX 自定义 XML 关系不属于已支持的空书目结构')
      }
    }
  }
  const types = documents.get('[Content_Types].xml')?.documentElement
  if (!types || types.namespaceURI !== CT || types.localName !== 'Types' || !children(types).some(el => el.getAttribute('PartName') === '/word/document.xml' && el.getAttribute('ContentType') === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml')) fail('DOCX 主文档内容类型无效或不是普通 DOCX')
  const mainRelationships = children(documents.get('_rels/.rels')!.documentElement!).filter(el => el.getAttribute('Type') === OFFICE_REL + 'officeDocument')
  if (mainRelationships.length !== 1) fail('DOCX 必须包含唯一的主文档关系')
  const document = documents.get('word/document.xml')!
  if (!is(document.documentElement!, 'document')) fail('DOCX 主文档命名空间不受支持，请另存为普通 DOCX')
  const bodies = children(document.documentElement!, 'body')
  if (bodies.length !== 1) fail('DOCX 主文档正文结构异常')
  const body = bodies[0]
  if (children(body).some(el => !['p', 'tbl', 'sectPr'].some(name => is(el, name)))) fail('DOCX 含无法逐区域确认的正文控件或结构，请先转换为普通段落和表格')
  return { document, body, fonts: [...fonts].sort(), warnings }
}

function unsupported(node: XmlNode, table = false): string[] {
  const reasons = new Set<string>()
  const fixedHeader = new Set<XmlNode>()
  if (table && is(node, 'tbl')) for (const row of children(node, 'tr')) {
    const properties = children(row, 'trPr')[0]
    if (!properties || !descendants(properties, 'tblHeader').some(enabled)) break
    descendants(row).forEach(element => fixedHeader.add(element))
  }
  const starts = descendants(node, 'bookmarkStart'), ends = descendants(node, 'bookmarkEnd')
  // Word's paired _GoBack bookmark is a cursor location, not report content.
  // Other bookmarks (or split pairs) may have cross-references and remain unsupported.
  const cursorIds = new Set(starts.filter(el => el.getAttributeNS(W, 'name') === '_GoBack').map(el => el.getAttributeNS(W, 'id')))
  if (starts.length !== ends.length || starts.some(el => el.getAttributeNS(W, 'name') !== '_GoBack') || ends.some(el => !cursorIds.has(el.getAttributeNS(W, 'id')))) reasons.add('含自定义书签或跨区域书签，暂不支持替换')
  if (starts.length && node.ownerDocument && descendants(node.ownerDocument).some(el => (is(el, 'instrText') && /\b_GoBack\b/.test(el.textContent ?? '')) || (is(el, 'hyperlink') && el.getAttributeNS(W, 'anchor') === '_GoBack'))) reasons.add('光标书签被正文引用，不能自动移除')
  for (const element of descendants(node)) if (element.namespaceURI === W) {
    if (complexNames.has(element.localName ?? '')) reasons.add('含内容控件、域、书签、链接、图形或引用，需人工处理该区域')
    if (table && !fixedHeader.has(element) && (is(element, 'vMerge') || is(element, 'hMerge') || is(element, 'gridSpan'))) reasons.add('重复区域含合并单元格，暂不支持自动克隆')
    if (table && !fixedHeader.has(element) && is(element, 'trHeight') && element.getAttributeNS(W, 'hRule') === 'exact') reasons.add('表格含固定行高，可能截断新内容，请先调整为最小行高')
    if (is(element, 'sectPr')) reasons.add('该段含节设置，暂不支持替换')
  }
  if (table && descendants(node, 'tbl').length > 1) reasons.add('嵌套表格暂不支持自动填充')
  return [...reasons]
}
interface Prepared { inspection: DocxInspection; document: XmlDocument; nodes: Map<string, XmlElement>; limits: DocxLimits }
function prepare(bytes: Buffer, options: Partial<DocxLimits>): Prepared {
  const limits = docxLimits(options), parts = readDocxArchive(bytes, limits)
  const { document, body, fonts, warnings } = inspectParts(parts, limits)
  const regions: DocxRegion[] = [], nodes = new Map<string, XmlElement>()
  let paragraphIndex = 0, tableIndex = 0, rowCount = 0, cellCount = 0
  for (const block of children(body)) {
    if (is(block, 'p')) {
      const id = `p:${paragraphIndex}`, reasons = unsupported(block)
      regions.push({ id, kind: 'paragraph', paragraphIndex: paragraphIndex++, text: visibleText(block), supported: !reasons.length, reasons }); nodes.set(id, block)
    } else if (is(block, 'tbl')) {
      const id = `t:${tableIndex}`, rows = children(block, 'tr'), reasons = unsupported(block, true)
      rowCount += rows.length
      if (rowCount > limits.maxRows) fail('DOCX 表格行数超过解析限额')
      let headerRows = 0
      for (const row of rows) { if (descendants(children(row, 'trPr')[0] ?? document.createElement('unused'), 'tblHeader').some(enabled)) headerRows++; else break }
      const tableRows = rows.map(row => children(row, 'tc').map(visibleText))
      regions.push({ id, kind: 'table', tableIndex, text: tableRows.map(row => row.join('\t')).join('\n'), supported: !reasons.length, reasons, rows: tableRows, columnCounts: tableRows.map(row => row.length), headerRows }); nodes.set(id, block)
      rows.forEach((row, rowIndex) => children(row, 'tc').forEach((cell, cellIndex) => {
        if (++cellCount > limits.maxCells) fail('DOCX 表格单元格数超过解析限额')
        const cellId = `${id}:r:${rowIndex}:c:${cellIndex}`, cellReasons = unsupported(cell)
        if (descendants(cell, 'tbl').length) cellReasons.push('单元格含嵌套表格')
        const properties = children(row, 'trPr')[0]
        if (properties && descendants(properties, 'trHeight').some(el => el.getAttributeNS(W, 'hRule') === 'exact')) cellReasons.push('单元格所在行含固定行高，可能截断新内容')
        regions.push({ id: cellId, kind: 'cell', tableIndex, rowIndex, cellIndex, text: visibleText(cell), supported: !cellReasons.length, reasons: cellReasons }); nodes.set(cellId, cell)
      }))
      tableIndex++
    }
  }
  for (const region of regions) if (!region.supported) warnings.push(`${region.id}：${region.reasons.join('；')}`)
  return { inspection: { sha256: sha256(bytes), rendererVersion: DOCX_RENDERER_VERSION, regions, warnings, fonts, partNames: [...parts.keys()] }, document, nodes, limits }
}
export function inspectDocxSync(bytes: Buffer, options: Partial<DocxLimits> = {}): DocxInspection { return prepare(bytes, options).inspection }
export async function inspectDocx(bytes: Buffer, options: Partial<DocxLimits> = {}): Promise<DocxInspection> { return inspectDocxSync(bytes, options) }
/** Synchronous import/restore boundary. Includes bounded inflation, CRC and all XML safety checks. */
export function assertSafeDocx(bytes: Buffer, options: Partial<DocxLimits> = {}): void { prepare(bytes, options) }

function checkText(value: unknown, limits: DocxLimits): asserts value is string {
  if (typeof value !== 'string' || value.length > limits.maxTextChars || invalidXmlChars.test(value)) fail('填充文本含无效 XML 字符或超过字符限额')
}
function removeChildrenExcept(node: XmlNode, names: string[]) {
  for (let child = node.firstChild; child;) { const next = child.nextSibling; if (!names.some(name => is(child!, name))) node.removeChild(child); child = next }
}
function stripCopiedIds(node: XmlElement) {
  for (const element of descendants(node)) {
    if (is(element, 'bookmarkStart') || is(element, 'bookmarkEnd')) { element.parentNode?.removeChild(element); continue }
    for (let i = element.attributes.length - 1; i >= 0; i--) {
    const attr = element.attributes.item(i)!
    if (['paraId', 'textId', 'rsidR', 'rsidRPr', 'rsidP', 'rsidDel', 'rsidRDefault', 'rsidTr'].includes(attr.localName ?? '')) element.removeAttributeNode(attr)
    }
  }
}
/** Fill a scope using its own paragraph and first visible run as the formatting prototype. */
function fillParagraph(paragraph: XmlElement, text: string, document: XmlDocument) {
  const firstRun = descendants(paragraph, 'r').find(run => descendants(run, 't').length) ?? descendants(paragraph, 'r')[0]
  const properties = firstRun && children(firstRun, 'rPr')[0]?.cloneNode(true)
  removeChildrenExcept(paragraph, ['pPr'])
  const run = document.createElementNS(W, 'w:r')
  if (properties) run.appendChild(properties)
  for (const [index, line] of text.replace(/\r\n?/g, '\n').split('\n').entries()) {
    if (index) run.appendChild(document.createElementNS(W, 'w:br'))
    const tokens = line.split('\t')
    tokens.forEach((token, tokenIndex) => {
      if (tokenIndex) run.appendChild(document.createElementNS(W, 'w:tab'))
      const value = document.createElementNS(W, 'w:t'); value.setAttributeNS(XML, 'xml:space', 'preserve'); value.appendChild(document.createTextNode(token)); run.appendChild(value)
    })
  }
  paragraph.appendChild(run)
}
function fillCell(cell: XmlElement, text: string, document: XmlDocument) {
  const prototypes = children(cell, 'p'), prototype = prototypes[0] ?? document.createElementNS(W, 'w:p')
  // Preserve each corresponding paragraph/run style when the new cell is multiline.
  // Beyond the source paragraph count the last paragraph remains the style prototype.
  const paragraphs = text.replace(/\r\n?/g, '\n').split('\n').map((line, index) => {
    const paragraph = (prototypes[Math.min(index, prototypes.length - 1)] ?? prototype).cloneNode(true) as XmlElement
    stripCopiedIds(paragraph)
    fillParagraph(paragraph, line, document)
    return paragraph
  })
  removeChildrenExcept(cell, ['tcPr'])
  paragraphs.forEach(paragraph => cell.appendChild(paragraph))
}

export async function renderDocx(bytes: Buffer, edits: DocxEdit[], options: DocxRenderOptions = {}): Promise<Buffer> {
  const { inspection, document, nodes, limits } = prepare(bytes, options)
  if (options.expectedSha256 !== undefined && options.expectedSha256 !== inspection.sha256) fail('DOCX 模板哈希已变化，请重新确认当前版本')
  if (!Array.isArray(edits) || edits.length > limits.maxCells + limits.maxRows) fail('DOCX 编辑列表无效或过大')
  const regionMap = new Map(inspection.regions.map(region => [region.id, region])), touched = new Set<string>()
  const rowEdits: Array<Extract<DocxEdit, { kind: 'rows' }>> = []
  let chars = 0, addedRows = 0, addedCells = 0
  for (const edit of edits) {
    if (!edit || typeof edit.regionId !== 'string' || !['text', 'clear', 'keep', 'rows'].includes(edit.kind)) fail('DOCX 编辑操作无效')
    const region = regionMap.get(edit.regionId)
    if (!region) fail(`DOCX 区域 ${edit.regionId} 不存在`)
    if (touched.has(edit.regionId)) fail('DOCX 区域编辑重复或重叠')
    touched.add(edit.regionId)
    if (edit.kind === 'keep') continue
    if (!region.supported) fail(`DOCX 区域 ${edit.regionId} 含不支持的复杂结构：${region.reasons.join('；')}`)
    if (edit.kind === 'rows') {
      if (region.kind !== 'table') fail('重复行操作只能用于表格区域')
      const { headerRows, templateRow, startRow, endRow, rows } = edit
      if (![headerRows, templateRow, startRow, endRow].every(Number.isSafeInteger) || headerRows < region.headerRows || headerRows < 0 || startRow < headerRows || endRow <= startRow || endRow > region.rows.length || templateRow < headerRows || templateRow >= region.rows.length) fail('DOCX 重复行范围或表头范围无效')
      if (!Array.isArray(rows)) fail('DOCX 重复行内容无效')
      const count = region.columnCounts[templateRow]
      if (!count || region.columnCounts.slice(startRow, endRow).some(value => value !== count)) fail('DOCX 重复区域列数不一致')
      addedRows += rows.length; addedCells += rows.length * count
      if (addedRows > limits.maxRows || addedCells > limits.maxCells) fail('DOCX 输出表格行数或单元格超过限额')
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== count) fail('DOCX 新数据行列数与模板不一致')
        for (const value of row) { checkText(value, limits); chars += value.length }
      }
      rowEdits.push(edit)
    } else {
      if (region.kind === 'table') fail('表格内容必须通过单元格或重复行操作修改')
      if (edit.kind === 'text') { checkText(edit.text, limits); chars += edit.text.length }
    }
    if (chars > limits.maxTextChars) fail('DOCX 输出文字超过总字符限额')
  }
  for (const rowEdit of rowEdits) for (const edit of edits) {
    if (edit === rowEdit) continue
    const region = regionMap.get(edit.regionId)!
    if (region.kind === 'cell' && `t:${region.tableIndex}` === rowEdit.regionId && region.rowIndex >= rowEdit.startRow && region.rowIndex < rowEdit.endRow) fail('DOCX 表格行和单元格编辑范围重叠')
  }
  if (edits.every(edit => edit.kind === 'keep')) return Buffer.from(bytes)
  for (const edit of edits) {
    if (edit.kind === 'keep') continue
    const node = nodes.get(edit.regionId)!
    if (edit.kind === 'rows') {
      const sourceRows = children(node, 'tr'), prototype = sourceRows[edit.templateRow]
      for (const values of edit.rows) {
        const cloned = prototype.cloneNode(true) as XmlElement
        stripCopiedIds(cloned)
        for (const marker of descendants(cloned, 'tblHeader')) marker.parentNode!.removeChild(marker)
        children(cloned, 'tc').forEach((cell, index) => fillCell(cell, values[index], document))
        node.insertBefore(cloned, sourceRows[edit.startRow])
      }
      for (let index = edit.startRow; index < edit.endRow; index++) node.removeChild(sourceRows[index])
    } else {
      const value = edit.kind === 'text' ? edit.text : ''
      if (is(node, 'p')) fillParagraph(node, value, document)
      else fillCell(node, value, document)
    }
  }
  // xmldom represents the XML declaration as a PI; strict serialization correctly
  // disallows a PI named xml. Re-emit the declaration separately in UTF-8.
  for (let node = document.firstChild; node;) { const next = node.nextSibling; if (node.nodeType === 7 && node.nodeName.toLowerCase() === 'xml') document.removeChild(node); node = next }
  const xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' + new XMLSerializer().serializeToString(document, { requireWellFormed: true })
  const updated = Buffer.from(xml)
  if (updated.length > limits.maxXmlBytes) fail('DOCX 生成正文超过 XML 大小限额')
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false })
  zip.file('word/document.xml', updated, { createFolders: false })
  const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
  // Reapply archive/security/structure bounds to the complete product before it can be archived.
  prepare(output, options)
  return output
}
