import type { ReportAgentBinding, ReportAgentNarrative } from '../shared/report-agent.ts'
import { REPORT_AGENT_NARRATIVES } from '../shared/report-agent.ts'
import type { DocxRegion } from '../shared/report-docx.ts'

/**
 * Outline templates carry headings with writing requirements instead of tables. Each paragraph gets a
 * role; a section's requirement paragraphs become one generated narrative region and are removed.
 */
export type OutlineRole = 'fixed' | 'meta' | 'heading' | 'instruction' | 'appendix'
export interface OutlineParagraph { id: string; part: OutlineRole; narrative?: ReportAgentNarrative | 'other' }
export const OUTLINE_ROLES: OutlineRole[] = ['fixed', 'meta', 'heading', 'instruction', 'appendix']

const headingPattern = /^\s*(?:[一二三四五六七八九十]+\s*[、.．]|第[一二三四五六七八九十]+(?:部分|章|节)|[（(][一二三四五六七八九十]+[）)])/
const appendixPattern = /^\s*附(?:[一二三四五六七八九十\d]+|件|录)?\s*[：:、.．]/
const instructionPattern = /^\s*(?:总体要求|填写要求|填报要求|编写要求|撰写要求|要求|建议|说明|注意事项?|提示|示例|备注|口径)\s*[：:]/
const blankPattern = /_{2,}|＿{2,}/

export function narrativeFor(heading: string): ReportAgentNarrative | 'other' {
  if (/根因|原因|未达标|问题|偏差|差距/.test(heading)) return 'causes'
  if (/措施|补救|整改|改进|纠偏/.test(heading)) return 'remedies'
  if (/计划|安排|下月|下周|下阶段|打算|重点工作/.test(heading)) return 'plan'
  if (/支持|支撑|协调|资源|帮助/.test(heading)) return 'support'
  if (/完成|成果|回顾|总结|情况|进展/.test(heading)) return 'review'
  return 'other'
}
/** Blanks such as "报告人：______" become tokens filled at generation; null when the line has none. */
export function metaTemplate(text: string): string | null {
  if (!blankPattern.test(text)) return null
  return text
    .replace(/(?:_{2,}|＿{2,})\s*部门/g, '{{department}}')
    .replace(/((?:部门|单位)\s*[：:]\s*)(?:_{2,}|＿{2,})/g, '$1{{department}}')
    .replace(/((?:报告|汇报|填报|编制|撰写)人\s*[：:]\s*)(?:_{2,}|＿{2,})/g, '$1{{author}}')
    .replace(/((?:填报|汇报|报告|编制|撰写)?日期\s*[：:]\s*)(?:_{2,}|＿{2,})/g, '$1{{date}}')
    .replace(/(?:_{2,}|＿{2,})\s*月/g, '{{month}}')
}
type Region = Extract<DocxRegion, { kind: 'paragraph' | 'table' }>
const topLevel = (regions: DocxRegion[]) => regions.filter((region): region is Region => region.kind === 'paragraph' || region.kind === 'table')

/** Rule-based roles; null when the document does not look like an outline template. */
export function heuristicOutline(regions: DocxRegion[]): OutlineParagraph[] | null {
  const paragraphs = topLevel(regions).filter(region => region.kind === 'paragraph')
  const headings = paragraphs.filter(region => headingPattern.test(region.text) || appendixPattern.test(region.text))
  if (headings.length < 2 || !paragraphs.some(region => instructionPattern.test(region.text))) return null
  let inSection = false
  return paragraphs.map(region => {
    if (appendixPattern.test(region.text)) { inSection = true; return { id: region.id, part: 'appendix' } }
    if (headingPattern.test(region.text)) { inSection = true; return { id: region.id, part: 'heading', narrative: narrativeFor(region.text) } }
    if (!region.text.trim()) return { id: region.id, part: 'fixed' }
    // Inside a section of a blank template every paragraph is guidance for the writer.
    if (inSection || instructionPattern.test(region.text)) return { id: region.id, part: 'instruction' }
    return { id: region.id, part: metaTemplate(region.text) ? 'meta' : 'fixed' }
  })
}

/** Paragraph bindings plus template-wide requirements (preamble instructions) that become writing rules. */
export function outlineBindings(regions: DocxRegion[], outline: OutlineParagraph[]): { bindings: ReportAgentBinding[]; rules: string[] } {
  const roles = new Map(outline.map(item => [item.id, item]))
  const bindings: ReportAgentBinding[] = [], rules: string[] = []
  const label = (text: string) => text.trim().slice(0, 80) || '空白段落'
  let section: { heading: Region; narrative: ReportAgentNarrative | 'other'; body: Region[]; table: boolean } | null = null, appendix = false
  const close = () => {
    if (!section) return
    const [slot, ...rest] = section.body
    if (slot && !section.table) {
      const instruction = section.body.map(region => region.text.trim()).join('\n').slice(0, 8000)
      bindings.push(section.narrative === 'other'
        ? { regionId: slot.id, label: label(section.heading.text), kind: 'manual', required: true, instruction }
        : { regionId: slot.id, label: label(section.heading.text), kind: 'narrative', required: true, narrative: section.narrative, instruction })
      for (const region of rest) bindings.push({ regionId: region.id, label: label(region.text), kind: 'remove', required: false })
    } else for (const region of section.body) bindings.push({ regionId: region.id, label: label(region.text), kind: 'remove', required: false })
    section = null
  }
  for (const region of topLevel(regions)) {
    if (region.kind === 'table') { if (section) section.table = true; continue }
    const item = roles.get(region.id) || { id: region.id, part: 'fixed' as const }
    if (item.part === 'appendix') { close(); appendix = true }
    if (appendix) { bindings.push({ regionId: region.id, label: label(region.text), kind: 'remove', required: false }); continue }
    if (item.part === 'heading') {
      close(); bindings.push({ regionId: region.id, label: label(region.text), kind: 'keep', required: false })
      section = { heading: region, narrative: item.narrative && item.narrative !== 'other' && REPORT_AGENT_NARRATIVES.includes(item.narrative) ? item.narrative : narrativeFor(region.text), body: [], table: false }
      continue
    }
    if (!region.text.trim()) { bindings.push({ regionId: region.id, label: '空白段落', kind: 'keep', required: false }); continue }
    if (section) { section.body.push(region); continue }
    if (item.part === 'instruction') { rules.push(region.text.trim().slice(0, 2000)); bindings.push({ regionId: region.id, label: label(region.text), kind: 'remove', required: false }); continue }
    const value = item.part === 'meta' || item.part === 'fixed' ? metaTemplate(region.text) : null
    bindings.push(value ? { regionId: region.id, label: label(region.text), kind: 'meta', meta: 'template', value, required: false } : { regionId: region.id, label: label(region.text), kind: 'keep', required: false })
  }
  close()
  return { bindings, rules }
}
