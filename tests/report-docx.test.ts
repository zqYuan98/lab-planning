import test from 'node:test'
import assert from 'node:assert/strict'
import JSZip from 'jszip'
import { assertSafeDocx, inspectDocx, inspectDocxSync, renderDocx, DocxError } from '../server/report-docx.ts'
import { document, fixture, fixtureParts, p, rawZip, row, table, W, REL } from './report-docx-fixtures.ts'

test('inspection exposes stable paragraph/table/cell regions, fonts, and multiline cell text', async () => {
  const result = await inspectDocx(await fixture(p('标题') + table))
  assert.equal(result.regions.find(r => r.id === 'p:0')?.text, '标题')
  const found = result.regions.find(r => r.id === 't:0')
  assert.equal(found?.kind, 'table')
  if (found?.kind === 'table') { assert.deepEqual(found.rows, [['列甲', '列乙'], ['旧甲', '旧乙'], ['旧末行', '旧示例']]); assert.equal(found.headerRows, 1) }
  assert.equal(result.regions.find(r => r.id === 't:0:r:1:c:0')?.text, '旧甲')
  assert.ok(result.fonts.includes('宋体')); assert.ok(result.fonts.includes('Times New Roman'))
  assert.match(result.sha256, /^[a-f0-9]{64}$/)
})

test('renders confirmed text/row scopes while preserving other parts, properties, header and footer fields', async () => {
  const bytes = await fixture(), original = await JSZip.loadAsync(bytes)
  const output = await renderDocx(bytes, [
    { kind: 'text', regionId: 'p:0', text: '本期 <内容> & 新行\n第二段' },
    { kind: 'rows', regionId: 't:0', headerRows: 1, templateRow: 1, startRow: 1, endRow: 3, rows: [['新甲', '新乙'], ['新丙', '新丁']] },
  ], { expectedSha256: (await inspectDocx(bytes)).sha256 })
  const generated = await JSZip.loadAsync(output), xml = await generated.file('word/document.xml')!.async('string')
  for (const name of Object.keys(original.files)) if (name !== 'word/document.xml') assert.deepEqual(await generated.file(name)!.async('nodebuffer'), await original.file(name)!.async('nodebuffer'), name)
  assert.ok(xml.includes('w:tblW')); assert.ok(xml.includes('w:shd')); assert.ok(xml.includes('w:spacing')); assert.ok(xml.includes('w:rFonts')); assert.ok(xml.includes('w:tblHeader'))
  assert.ok(xml.includes('列甲')); assert.ok(!/旧甲|旧乙|旧末行|旧示例|旧标题/.test(xml))
  assert.ok(xml.includes('&lt;内容&gt; &amp;'))
  const ids = [...xml.matchAll(/w14:paraId="([^"]+)"/g)].map(m => m[1])
  assert.equal(ids.length, new Set(ids).size, 'cloned paragraphs must not duplicate IDs')
  const parsed = await inspectDocx(output)
  assert.equal(parsed.regions.find(r => r.id === 'p:0')?.text, '本期 <内容> & 新行\n第二段')
})

test('keep returns exact input, clear removes all old text, empty table replacement is explicit', async () => {
  const bytes = await fixture()
  assert.deepEqual(await renderDocx(bytes, [{ kind: 'keep', regionId: 'p:0' }]), bytes)
  const rendered = await renderDocx(bytes, [{ kind: 'clear', regionId: 't:0:r:1:c:0' }, { kind: 'rows', regionId: 't:0', headerRows: 1, templateRow: 1, startRow: 2, endRow: 3, rows: [] }])
  const result = await inspectDocx(rendered)
  assert.equal(result.regions.find(r => r.id === 't:0:r:1:c:0')?.text, '')
  assert.ok(!result.regions.some(r => r.text.includes('旧示例')))
})

test('ZIP rejects true inflated size beyond limit, declared size lies, CRC, duplicate names and traversal', async () => {
  const parts = Object.entries(fixtureParts()).map(([name, value]) => ({ name, value: Buffer.from(value) }))
  const bomb = rawZip([...parts, { name: 'word/large.xml', value: Buffer.alloc(100000, 32), declaredSize: 1 }])
  await assert.rejects(inspectDocx(bomb, { maxExpandedBytes: 15000 }), /解压|大小/)
  await assert.rejects(inspectDocx(rawZip([...parts, { name: 'word/lie.xml', value: Buffer.from('12345'), declaredSize: 1 }])), /大小/)
  await assert.rejects(inspectDocx(rawZip([...parts, { name: 'word/crc.xml', value: Buffer.from('12345'), crc: 0 }])), /CRC|校验/)
  await assert.rejects(inspectDocx(rawZip([...parts, parts[0]])), /重复/)
  for (const name of ['../escape.xml', '/word/escape.xml', 'word\\escape.xml', 'word/%2e%2e/escape.xml']) await assert.rejects(inspectDocx(rawZip([...parts, { name, value: Buffer.from('x') }])), /路径|文件名/)
})

test('rejects macros, external relationships, DTD and malformed XML before returning learning text', async () => {
  for (const extra of [
    { 'word/vbaProject.bin': Buffer.from('macro') },
    { 'word/_rels/document.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="hyperlink" Target="https://example.invalid" TargetMode="External"/></Relationships>` },
    { 'word/document.xml': '<!DOCTYPE x [<!ENTITY y "hidden">]>' + document(p('&y;')) },
    { 'word/document.xml': document(p('text')).replace('</w:body>', '</w:wrong>') },
  ] as Array<Record<string, string | Buffer>>) await assert.rejects(inspectDocx(await fixture(undefined, extra)), DocxError)
})

test('comments parts, revisions, hidden runs/styles and data bindings are hard refusals', async () => {
  for (const extra of [
    { 'word/comments.xml': `<w:comments xmlns:w="${W}"/>` },
    { 'word/document.xml': document(`<w:ins>${p('旧修订')}</w:ins>`) },
    { 'word/document.xml': document(p('隐藏').replace('<w:b/>', '<w:vanish/>')) },
    { 'word/styles.xml': `<w:styles xmlns:w="${W}"><w:style><w:rPr><w:vanish/></w:rPr></w:style></w:styles>` },
    { 'word/document.xml': document(`<w:sdt><w:sdtPr><w:dataBinding w:xpath="/x"/></w:sdtPr><w:sdtContent>${p('旧值')}</w:sdtContent></w:sdt>`) },
  ] as Array<Record<string, string | Buffer>>) await assert.rejects(inspectDocx(await fixture(undefined, extra)), DocxError)
})

test('complex dynamic scopes are visible but cannot be rewritten or repeated', async () => {
  const nested = await fixture(`<w:tbl><w:tr><w:tc>${p('cell')}${table}</w:tc></w:tr></w:tbl>`)
  assert.equal((await inspectDocx(nested)).regions.find(r => r.id === 't:0')?.supported, false)
  await assert.rejects(renderDocx(nested, [{ kind: 'rows', regionId: 't:0', headerRows: 0, templateRow: 0, startRow: 0, endRow: 1, rows: [['x']] }]), /不支持|复杂/)
  const field = await fixture(p('旧域').replace('<w:t>', '<w:fldChar w:fldCharType="begin"/><w:t>'))
  await assert.rejects(renderDocx(field, [{ kind: 'text', regionId: 'p:0', text: 'x' }]), /不支持|复杂/)
})

test('rejects stale hash, absent/duplicate/overlapping regions, unsafe text and mismatched row shapes', async () => {
  const bytes = await fixture()
  await assert.rejects(renderDocx(bytes, [], { expectedSha256: '0'.repeat(64) }), /版本|哈希/)
  await assert.rejects(renderDocx(bytes, [{ kind: 'text', regionId: 'p:99', text: 'x' }]), /区域/)
  await assert.rejects(renderDocx(bytes, [{ kind: 'text', regionId: 'p:0', text: 'x' }, { kind: 'clear', regionId: 'p:0' }]), /重复|重叠/)
  const replace = { kind: 'rows' as const, regionId: 't:0', headerRows: 1, templateRow: 1, startRow: 1, endRow: 3, rows: [['x', 'y']] }
  await assert.rejects(renderDocx(bytes, [replace, { kind: 'text', regionId: 't:0:r:1:c:0', text: 'x' }]), /重叠/)
  await assert.rejects(renderDocx(bytes, [{ ...replace, rows: [['x']] }]), /列数/)
  await assert.rejects(renderDocx(bytes, [{ ...replace, startRow: 0 }]), /表头|范围/)
  await assert.rejects(renderDocx(bytes, [{ kind: 'text', regionId: 'p:0', text: '\u0000' }]), /字符/)
})

test('synchronous restore validation rejects unsafe XML and catches split or simple external fields', async () => {
  for (const body of [
    '<w:p><w:r><w:instrText>INCL</w:instrText></w:r><w:r><w:instrText>UDETEXT "remote"</w:instrText></w:r></w:p>',
    '<w:p><w:fldSimple w:instr="DDEAUTO remote">' + p('缓存') + '</w:fldSimple></w:p>',
    '<w:p><w:fldSimple w:instr="HYPERLINK https://example.invalid">' + p('链接') + '</w:fldSimple></w:p>',
  ]) assert.throws(() => assertSafeDocx(syncFieldBytes(body)), /外部/)
  function syncFieldBytes(body: string) { return rawZip(Object.entries(fixtureParts(body)).map(([name, value]) => ({ name, value: Buffer.from(value) }))) }
  const safe = await fixture()
  assert.doesNotThrow(() => assertSafeDocx(safe))
})

test('render handles escaped text, tabs, trailing breaks, multiline cells and paired cursor bookmarks', async () => {
  const cursor = '<w:bookmarkStart w:id="4" w:name="_GoBack"/><w:bookmarkEnd w:id="4"/>'
  const bytes = await fixture(p('旧标题').replace('</w:p>', cursor + '</w:p>') + table)
  const output = await renderDocx(bytes, [
    { kind: 'text', regionId: 'p:0', text: '保留\t制表\n' },
    { kind: 'text', regionId: 't:0:r:1:c:0', text: '第一段\n第二段\n第三段' },
  ])
  const found = await inspectDocx(output)
  assert.equal(found.regions.find(r => r.id === 'p:0')?.text, '保留\t制表\n')
  assert.equal(found.regions.find(r => r.id === 't:0:r:1:c:0')?.text, '第一段\n第二段\n第三段')
  assert.ok(!(await (await JSZip.loadAsync(output)).file('word/document.xml')!.async('string')).includes('bookmarkStart'))
})

test('custom or cross-scope bookmarks remain unsupported and preserved by keep', async () => {
  const bytes = await fixture(p('text').replace('</w:p>', '<w:bookmarkStart w:id="4" w:name="custom"/><w:bookmarkEnd w:id="4"/></w:p>'))
  assert.equal((await inspectDocx(bytes)).regions[0].supported, false)
  await assert.rejects(renderDocx(bytes, [{ kind: 'clear', regionId: 'p:0' }]), /书签/)
  assert.deepEqual(await renderDocx(bytes, [{ kind: 'keep', regionId: 'p:0' }]), bytes)
})

test('limits apply to source and output and do not truncate or silently shrink content', async () => {
  const bytes = await fixture()
  await assert.rejects(inspectDocx(bytes, { maxBytes: 30 }), /上传大小/)
  await assert.rejects(inspectDocx(bytes, { maxEntries: 2 }), /目录/)
  await assert.rejects(inspectDocx(bytes, { maxXmlBytes: 40 }), /XML/)
  await assert.rejects(renderDocx(bytes, [{ kind: 'text', regionId: 'p:0', text: '长'.repeat(300) }], { maxTextChars: 100 }), /字符|文字/)
  const fixed = await fixture(table.replaceAll('w:hRule="atLeast"', 'w:hRule="exact"'))
  assert.equal((await inspectDocx(fixed)).regions.find(r => r.id === 't:0')?.supported, false)
  await assert.rejects(renderDocx(fixed, [{ kind: 'rows', regionId: 't:0', headerRows: 1, templateRow: 1, startRow: 1, endRow: 3, rows: [['long text', 'x']] }]), /固定行高/)
})

test('relationship paths cannot escape or target missing parts and root needs exactly one main relationship', async () => {
  for (const target of ['../../../escape.xml', '%68ttps%3A%2F%2Fexample.invalid', 'missing.xml']) {
    const bytes = await fixture(undefined, { 'word/_rels/document.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId2" Type="x" Target="${target}"/></Relationships>` })
    await assert.rejects(inspectDocx(bytes), /路径|关系/)
  }
  await assert.rejects(inspectDocx(await fixture(undefined, { '_rels/.rels': `<Relationships xmlns="${REL}"/>` })), /唯一/)
})

test('declared XML parts with unusual names and uppercase XML cannot hide unsafe styles', async () => {
  for (const name of ['word/OTHER-STYLES.XML', 'word/styles-data']) {
    const original = fixtureParts()['[Content_Types].xml'] as string
    const types = original.replace('</Types>', `<Override PartName="/${name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`)
    const bytes = await fixture(undefined, { '[Content_Types].xml': types, [name]: `<w:styles xmlns:w="${W}"><w:style><w:rPr><w:vanish/></w:rPr></w:style></w:styles>` })
    await assert.rejects(inspectDocx(bytes), /隐藏/)
  }
})

test('fixed merged header is retained while only ordinary data rows repeat', async () => {
  const header = '<w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>' + p('合并表头') + '</w:tc></w:tr>'
  const bytes = await fixture('<w:tbl><w:tblPr/><w:tblGrid><w:gridCol w:w="2000"/><w:gridCol w:w="2000"/></w:tblGrid>' + header + row(['old a', 'old b']) + '</w:tbl>')
  const output = await renderDocx(bytes, [{ kind: 'rows', regionId: 't:0', headerRows: 1, templateRow: 1, startRow: 1, endRow: 2, rows: [['new a', 'new b'], ['c', 'd']] }])
  const xml = await (await JSZip.loadAsync(output)).file('word/document.xml')!.async('string')
  assert.ok(xml.includes('合并表头')); assert.equal([...xml.matchAll(/gridSpan/g)].length, 1)
  const table = (await inspectDocx(output)).regions.find(region => region.id === 't:0')
  assert.equal(table?.kind, 'table')
  if (table?.kind === 'table') assert.deepEqual(table.rows, [['合并表头'], ['new a', 'new b'], ['c', 'd']])
})

test('custom XML may retain only empty bibliography bookkeeping, never hidden historical business data', async () => {
  const BIB = 'http://schemas.openxmlformats.org/officeDocument/2006/bibliography'
  const DS = 'http://schemas.openxmlformats.org/officeDocument/2006/customXml'
  for (const extra of [
    { 'customXml/item1.xml': '<private><oldClient>HISTORICAL_SECRET</oldClient></private>' },
    { 'customXml/item1.xml': `<b:Sources xmlns:b="${BIB}"><b:Source>HISTORICAL_SECRET</b:Source></b:Sources>` },
    { 'customXml/item1.xml': `<b:Sources xmlns:b="${BIB}" oldClient="HISTORICAL_SECRET"/>` },
    { 'customXml/item1.xml': `<b:Sources xmlns:b="${BIB}"><!--HISTORICAL_SECRET--></b:Sources>` },
    { 'customXml/itemProps1.xml': `<ds:datastoreItem xmlns:ds="${DS}" ds:itemID="{00000000-0000-0000-0000-000000000000}"><ds:schemaRefs><private>HISTORICAL_SECRET</private></ds:schemaRefs></ds:datastoreItem>` },
    { 'customXml/hidden.bin': Buffer.from('HISTORICAL_SECRET') },
  ] as Array<Record<string, string | Buffer>>) {
    const bytes = await fixture(undefined, extra)
    await assert.rejects(inspectDocx(bytes), /自定义|书目/)
    await assert.rejects(renderDocx(bytes, [{ kind: 'text', regionId: 'p:0', text: '新周报' }]), /自定义|书目/)
  }
  const bytes = await fixture(undefined, {
    'customXml/item1.xml': `<b:Sources xmlns:b="${BIB}" StyleName="APA" SelectedStyle="/APA.XSL"/>`,
    'customXml/itemProps1.xml': `<ds:datastoreItem xmlns:ds="${DS}" ds:itemID="{00000000-0000-0000-0000-000000000000}"><ds:schemaRefs/></ds:datastoreItem>`,
    'customXml/_rels/item1.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/customXmlProps" Target="itemProps1.xml"/></Relationships>`,
  })
  assert.doesNotThrow(() => assertSafeDocx(bytes))
  const result = await renderDocx(bytes, [{ kind: 'text', regionId: 'p:0', text: '新周报' }])
  const before = await JSZip.loadAsync(bytes), after = await JSZip.loadAsync(result)
  for (const name of Object.keys(before.files).filter(name => name.startsWith('customXml/'))) assert.ok((await before.file(name)!.async('nodebuffer')).equals(await after.file(name)!.async('nodebuffer')))
})

test('external VML, href and file resource references are rejected even without package relationships', async () => {
  for (const attribute of ['src="https://example.invalid/remote.png"', 'src="file:///C:/private.png"', 'src="C:\\private.png"', 'src="../private.png"', 'href="https://example.invalid"']) {
    const bytes = await fixture(`<w:p xmlns:v="urn:schemas-microsoft-com:vml"><w:r><w:pict><v:shape id="x"><v:imagedata ${attribute}/></v:shape></w:pict></w:r></w:p>`)
    await assert.rejects(inspectDocx(bytes), /外部资源/)
    await assert.rejects(renderDocx(bytes, [{ kind: 'keep', regionId: 'p:0' }]), /外部资源/)
  }
  const bytes = await fixture()
  assert.deepEqual(inspectDocxSync(bytes), await inspectDocx(bytes))
})

test('source XML rejects illegal literal controls and numeric character references before learning', async () => {
  for (const text of ['old\u0000text', 'old\u000btext', 'old\ufffetext', 'old&#0;text', 'old&#xD800;text', 'old&#x110000;text']) {
    const bytes = await fixture(p(text))
    await assert.rejects(inspectDocx(bytes), /字符/)
    assert.throws(() => inspectDocxSync(bytes), /字符/)
  }
  assert.equal((await inspectDocx(await fixture(p('中文 😀 &#x1F600;')))).regions[0].text, '中文 😀 😀')
})
