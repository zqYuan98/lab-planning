import JSZip from 'jszip'
import { crc32, deflateRawSync } from 'node:zlib'

export const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
export const REL = 'http://schemas.openxmlformats.org/package/2006/relationships'
let paragraphId = 1
export const p = (text: string) => `<w:p w14:paraId="${(paragraphId++).toString(16).padStart(8, '0')}"><w:pPr><w:spacing w:after="90"/></w:pPr><w:r><w:rPr><w:b/><w:rFonts w:eastAsia="宋体"/></w:rPr><w:t>${text}</w:t></w:r></w:p>`
export const row = (texts: string[]) => `<w:tr><w:trPr><w:trHeight w:val="600" w:hRule="atLeast"/></w:trPr>${texts.map(text => `<w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/><w:shd w:fill="EFEFEF"/></w:tcPr>${p(text)}</w:tc>`).join('')}</w:tr>`
export const table = `<w:tbl><w:tblPr><w:tblW w:w="4000" w:type="dxa"/></w:tblPr><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>${row(['列甲', '列乙']).replace('<w:trPr>', '<w:trPr><w:tblHeader/>')}${row(['旧甲', '旧乙'])}${row(['旧末行', '旧示例'])}</w:tbl>`
export function document(body: string) { return `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="${W}" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"><w:body>${body}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/></w:sectPr></w:body></w:document>` }
export const fixtureParts = (body = p('旧标题') + table): Record<string, string | Buffer> => ({
  '[Content_Types].xml': '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  '_rels/.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  'word/document.xml': document(body),
  'word/styles.xml': `<w:styles xmlns:w="${W}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:eastAsia="宋体" w:ascii="Times New Roman"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`,
  'word/footer1.xml': `<w:ftr xmlns:w="${W}"><w:p><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>PAGE</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText>NUMPAGES</w:instrText></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p></w:ftr>`,
  'customXml/item1.xml': '<b:Sources xmlns:b="http://schemas.openxmlformats.org/officeDocument/2006/bibliography"/>',
})
export async function fixture(body?: string, extra: Record<string, string | Buffer> = {}) {
  const zip = new JSZip()
  for (const [name, value] of Object.entries({ ...fixtureParts(body), ...extra })) zip.file(name, value, { createFolders: false })
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
/** Intentionally allows invalid archives for boundary tests. */
export function rawZip(parts: Array<{ name: string; value: Buffer; declaredSize?: number; crc?: number }>) {
  const local: Buffer[] = [], central: Buffer[] = []
  let offset = 0
  for (const part of parts) {
    const name = Buffer.from(part.name), data = deflateRawSync(part.value), checksum = part.crc ?? crc32(part.value)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8)
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(part.declaredSize ?? part.value.length, 22); header.writeUInt16LE(name.length, 26)
    local.push(header, name, data)
    const dir = Buffer.alloc(46)
    dir.writeUInt32LE(0x02014b50); dir.writeUInt16LE(20, 4); dir.writeUInt16LE(20, 6); dir.writeUInt16LE(0x800, 8); dir.writeUInt16LE(8, 10)
    dir.writeUInt32LE(checksum, 16); dir.writeUInt32LE(data.length, 20); dir.writeUInt32LE(part.declaredSize ?? part.value.length, 24); dir.writeUInt16LE(name.length, 28); dir.writeUInt32LE(offset, 42)
    central.push(dir, name); offset += header.length + name.length + data.length
  }
  const directory = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(parts.length, 8); end.writeUInt16LE(parts.length, 10); end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, directory, end])
}
