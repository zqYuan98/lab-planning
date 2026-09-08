import { AlignmentType, BorderStyle, Document, Footer, HeadingLevel, PageNumber, Packer, Paragraph, Table, TableCell, TableLayoutType, TableRow, TextRun, WidthType } from 'docx'

const green = '24483E', border = 'D6DED9'
const body = (text: string, bold = false) => new TextRun({ text, bold, font: 'Microsoft YaHei', size: 20, color: '24352E' })
const cells = (line: string) => line.replace(/^\|\s*/, '').replace(/\s*\|$/, '').split('|').map(cell => cell.trim())
function tableWidths(headers: string[], width: number): number[] {
  let weights = headers.map(() => 1)
  if (headers.length === 6 && headers.includes('证据')) weights = [21, 10, 18, 20, 13, 18]
  else if (headers.length === 6 && headers.includes('发布状态')) weights = [19, 10, 12, 25, 21, 13]
  else if (headers.length === 4 && headers.includes('当期月归属与后续关联')) weights = [21, 29, 23, 27]
  else if (headers.length === 4 && headers.includes('确认进展')) weights = [28, 40, 16, 16]
  else if (headers.length === 3) weights = [24, 38, 38]
  const total = weights.reduce((sum, weight) => sum + weight, 0)
  const values = weights.map(weight => Math.floor(width * weight / total))
  values[values.length - 1] += width - values.reduce((sum, value) => sum + value, 0)
  return values
}

/** Converts the deterministic report format into real Word tables, not pipe-delimited paragraphs. */
export async function markdownToWord(title: string, markdown: string): Promise<Buffer> {
  const source = markdown.split('\n'), children: (Paragraph | Table)[] = []
  for (let index = 0; index < source.length; index++) {
    const line = source[index]
    // Markdown blank lines separate blocks; Word spacing already supplies that separation.
    if (!line.trim()) continue
    if (line.startsWith('|') && /^\|(?:\s*-{3,}\s*\|)+\s*$/.test(source[index + 1] || '')) {
      const headers = cells(line), rows: string[][] = [headers]
      index += 2
      while (index < source.length && source[index].startsWith('|')) rows.push(cells(source[index++]))
      index--
      const width = 9638, columnWidths = tableWidths(headers, width)
      children.push(new Table({ width: { size: width, type: WidthType.DXA }, columnWidths, layout: TableLayoutType.FIXED,
        borders: { top: { style: BorderStyle.SINGLE, size: 4, color: border }, bottom: { style: BorderStyle.SINGLE, size: 4, color: border },
          left: { style: BorderStyle.SINGLE, size: 4, color: border }, right: { style: BorderStyle.SINGLE, size: 4, color: border },
          insideHorizontal: { style: BorderStyle.SINGLE, size: 4, color: border }, insideVertical: { style: BorderStyle.SINGLE, size: 4, color: border } },
        rows: rows.map((row, rowIndex) => new TableRow({ tableHeader: rowIndex === 0, cantSplit: true,
          children: headers.map((_, column) => new TableCell({ width: { size: columnWidths[column], type: WidthType.DXA },
            shading: { fill: rowIndex === 0 ? 'EAF0EC' : rowIndex % 2 === 0 ? 'F8FAF8' : 'FFFFFF' }, margins: { top: 100, bottom: 100, left: 100, right: 100 },
            children: [new Paragraph({ spacing: { after: 40, line: 280 }, children: [body(row[column] || '—', rowIndex === 0)] })] })) })) }))
      children.push(new Paragraph({ spacing: { before: 0, after: 40, line: 20 }, children: [new TextRun({ text: '', size: 2 })] }))
      continue
    }
    const level = line.startsWith('# ') ? HeadingLevel.TITLE : line.startsWith('## ') ? HeadingLevel.HEADING_1 : line.startsWith('### ') ? HeadingLevel.HEADING_2 : undefined
    children.push(new Paragraph({ heading: level, keepNext: Boolean(level), bullet: line.startsWith('- ') ? { level: 0 } : undefined,
      spacing: { before: level ? 240 : 0, after: level ? 150 : 100, line: 300 },
      children: [new TextRun({ text: line.replace(/^#{1,3} /, '').replace(/^- /, ''), font: 'Microsoft YaHei',
        size: level === HeadingLevel.TITLE ? 34 : level ? 25 : 20, color: level ? green : '24352E', bold: Boolean(level) })] }))
  }
  const footer = new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [body('人工智能实验室  ·  '), new TextRun({ children: [PageNumber.CURRENT], size: 18 }), body(' / '), new TextRun({ children: [PageNumber.TOTAL_PAGES], size: 18 })] })] })
  return Packer.toBuffer(new Document({ creator: '部门计划与执行', title, styles: { default: { document: { run: { font: 'Microsoft YaHei', size: 20 } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1134, bottom: 1134, left: 1134, right: 1134 } } }, footers: { default: footer }, children }] }))
}
