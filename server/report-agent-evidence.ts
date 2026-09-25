import { createHash } from 'node:crypto'
import type { ReportSnapshot } from '../shared/types.ts'
import type { ReportAgentBinding, ReportAgentBlock, ReportAgentCell, ReportAgentDataset, ReportAgentField, ReportAgentIssue, ReportFact } from '../shared/report-agent.ts'
import { isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { acceptanceLabels, reportMetrics, weeklyStatusLabel } from './report-metrics.ts'
import { addDays } from './reports.ts'
import { frozenSummaryFacts, monthEnd, monthlyDatasetIds, monthlyField, monthlyReportFacts, summaryDatasetIds } from './report-agent-monthly.ts'
import { HttpError } from './store.ts'

export function reportAgentHash(value: unknown): string {
  const canonical = (v: unknown): unknown => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, entry]) => [k, canonical(entry)])) : v
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex')
}
export function buildReportFacts(snapshot: ReportSnapshot, period: string): ReportFact[] {
  if (/^\d{4}-\d{2}$/.test(period)) return [...monthlyReportFacts(snapshot, period), ...frozenSummaryFacts(snapshot, period)]
  const facts: ReportFact[] = []
  const task = (id: string) => snapshot.tasks.find(t => t.id === id)
  const owner = (id: string) => snapshot.users.find(u => u.id === id)?.name || '负责人待核实'
  for (const record of [...snapshot.weeklyRecords, ...snapshot.nextWeeklyRecords]) {
    const work = task(record.taskId), formal = isEffectiveWeeklyRecord(record)
    const values: Record<string, string> = { title: work?.title || '任务标题待核实', owner: owner(record.ownerId), commitment: record.commitment,
      outcome: record.actualOutcome, status: `${formal ? '' : '未生效计划：'}${weeklyStatusLabel(record)}`, evidence: record.evidenceUrl,
      blocker: record.blocker, next_action: record.nextAction,
      monthly_goal: [...snapshot.plans, ...(snapshot.contextPlans || [])].find(p => p.id === record.monthlyPlanId)?.title || '本周记录未关联月目标' }
    for (const [field, value] of Object.entries(values)) facts.push({ id: `weekly:${record.id}:${field}`, sourceType: 'weeklyRecord', sourceId: record.id,
      sourceVersion: record.version, subjectId: record.taskId, subject: work?.title || '任务标题待核实', field, value, unit: '', period: record.weekStart, status: formal ? record.status : 'ineffective' })
  }
  for (const plan of snapshot.plans.filter(p => p.status === 'published')) {
    for (const [field, value] of Object.entries({ title: plan.title, outcome: plan.actualOutcome, expected: plan.expectedOutcome, acceptance: acceptanceLabels[plan.acceptanceStatus], due: plan.dueDate })) {
      facts.push({ id: `plan:${plan.id}:${field}`, sourceType: 'monthlyPlan', sourceId: plan.id, sourceVersion: plan.version, subjectId: plan.id, subject: plan.title, field, value, unit: '', period: plan.month, status: plan.acceptanceStatus })
    }
  }
  for (const work of snapshot.tasks) facts.push({ id: `task:${work.id}:status`, sourceType: 'task', sourceId: work.id, sourceVersion: work.version, subjectId: work.id, subject: work.title, field: 'status', value: work.status === 'done' ? '任务整体完成' : '任务尚未整体完成', unit: '', period, status: work.status })
  const metrics = reportMetrics(snapshot)
  for (const [field, value] of Object.entries({ weekly_total: metrics.weekly.total, weekly_done: metrics.weekly.done, weekly_rate: metrics.weekly.rate, monthly_total: metrics.monthly.total, monthly_accepted: metrics.monthly.accepted })) {
    facts.push({ id: `metric:${field}`, sourceType: 'metric', sourceId: 'snapshot', sourceVersion: 1, subjectId: 'snapshot', subject: '全量冻结统计', field, value: value === null ? '不可计算' : String(value), unit: field.includes('rate') ? '%' : '项', period, status: 'computed' })
  }
  return [...facts, ...frozenSummaryFacts(snapshot, period)]
}
function issue(code: string, location: string, message: string, severity: 'error' | 'warning' = 'error'): ReportAgentIssue {
  return { id: reportAgentHash(`${code}:${location}:${message}`).slice(0, 20), severity, code, location, message }
}
const numbers = (text: string) => text.match(/\d+(?:[.,]\d+)*(?:%|％)?/g) || []
// Preserve quantity AND unit. A date component, identifier or headcount is not a
// license to reuse the same digits as an amount of money or a completion rate.
const quantities = (text: string) => (text.match(/\d+(?:[.,]\d+)*(?:\s*(?:亿(?:元|人次|人|次|项|条|个)?|万(?:元|人次|人|次|项|条|个)?|千(?:元|人次|人|次|项|条|个)?|百(?:元|人次|人|次|项|条|个)?|人次|小时|分钟|百分点|百分比|万元|亿元|美元|人民币|元|人|条|项|个|次|份|台|套|家|页|件|天|周|月|年|秒|%|％))?/g) || []).map(value => value.replace(/\s+/g, '').replace(/％/g, '%'))
/** Each factual unit must be attributed to its own subject, field and frozen version. */
export function validateFactText(text: string, factIds: string[], facts: ReportFact[], location = '正文'): ReportAgentIssue[] {
  const issues: ReportAgentIssue[] = [], cited = facts.filter(f => factIds.includes(f.id))
  if (factIds.some(id => !facts.some(f => f.id === id))) issues.push(issue('unknown_reference', location, '引用不存在于本次冻结事实。'))
  if (text.trim() && !factIds.length) issues.push(issue('missing_reference', location, '此内容没有事实引用；请选择依据，或作为有来源的人工补充确认。'))
  const allowed = new Set(cited.flatMap(f => quantities(`${f.value}${f.unit} ${f.subject}`)))
  if (quantities(text).some(n => !allowed.has(n))) issues.push(issue('unsupported_number', location, '数字、单位或日期无法由本单元引用的事实证明。'))
  const subjects = new Set(cited.filter(f => f.sourceType !== 'metric').map(f => f.subjectId))
  const named = facts.filter(f => f.sourceType !== 'metric' && f.subject.length >= 2 && text.includes(f.subject))
  if (named.some(f => !subjects.has(f.subjectId))) issues.push(issue('subject_mismatch', location, '正文中的事项与引用事实的主体不一致。'))
  if (subjects.size > 1 && numbers(text).length) issues.push(issue('ambiguous_attribution', location, '同一句含多个事项及数字，请分开表述，使每个数字只引用对应事项。'))
  const records = new Set(cited.filter(f => f.sourceType !== 'metric').map(f => `${f.sourceType}:${f.sourceId}:${f.sourceVersion}:${f.period}`))
  if (records.size > 1 && numbers(text).length) issues.push(issue('ambiguous_record', location, '同一数字不能同时引用不同记录或周期，请拆分内容。'))
  if (/(?:已|整体|全部|全面)完成|完成了|已交付|已解决/.test(text) && cited.every(f => !['outcome', 'acceptance'].includes(f.field) && !(f.field === 'status' && f.status === 'done'))) issues.push(issue('plan_as_outcome', location, '计划或承诺不能改写为已经完成的成果。'))
  if (/(?:已(?:经)?(?:通过)?|通过(?:了)?|完成)验收|验收(?:已)?(?:通过|完成)/.test(text) && !cited.some(f => f.sourceType === 'monthlyPlan' && f.field === 'acceptance' && f.status === 'accepted')) issues.push(issue('acceptance_overstatement', location, '没有对应月目标已验收的冻结依据。'))
  const namedCompletion = cited.some(f => f.subject.length >= 2 && text.includes(`${f.subject}已完成`) && new RegExp(`${f.subject.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}已完成(?:[。；，！]|$)`).test(text))
  if ((/(?:任务|项目)(?:已)?整体完成|全部完成|(?:任务|项目)已完成(?:[。；，！]|$)/.test(text) || namedCompletion) && !cited.some(f => f.sourceType === 'task' && f.field === 'status' && f.status === 'done')) issues.push(issue('completion_overstatement', location, '周阶段自报完成不能写成任务或项目整体完成。'))
  if (/成员自报完成/.test(text) && !cited.some(f => f.sourceType === 'weeklyRecord' && f.field === 'status' && f.status === 'done')) issues.push(issue('weekly_status_overstatement', location, '缺少对应周记录自报完成的依据。'))
  return issues
}
export function validateReportBlocks(blocks: ReportAgentBlock[], facts: ReportFact[]): ReportAgentIssue[] {
  const issues: ReportAgentIssue[] = []
  const check = (cell: ReportAgentCell, required: boolean, location: string) => {
    if (!cell.text.trim() || cell.text.trim() === '待补充') { if (required) issues.push(issue('required_missing', location, '必填内容尚未补充。')); return }
    if (cell.manual) {
      if (!cell.confirmed || !cell.source.trim()) issues.push(issue('manual_unconfirmed', location, '人工补充须填写来源并确认。'))
    } else if (cell.factIds.length) {
      for (const line of cell.text.split('\n').filter(line => line.trim())) {
        const named = facts.filter(f => cell.factIds.includes(f.id) && f.subject.length >= 2 && line.includes(f.subject))
        const ids = named.length ? cell.factIds.filter(id => facts.some(f => f.id === id && named.some(n => n.subjectId === f.subjectId))) : cell.factIds
        issues.push(...validateFactText(line, ids, facts, location))
      }
    }
    else if (!['暂无', '待补充', '本期无已生效记录', '下周尚无已生效安排', '本周记录未关联月目标'].includes(cell.text.trim())) issues.push(issue('missing_reference', location, '请为此内容选择依据或确认人工来源。'))
  }
  for (const block of blocks) {
    if (block.kind === 'text') check(block.content, block.required, block.id)
    else {
      if (block.required && !block.rows.length) issues.push(issue('required_missing', block.id, '必填表格尚无内容。'))
      block.rows.forEach((row, r) => row.forEach((cell, c) => check(cell, block.columns[c]?.required || false, `${block.id}[${r + 1},${c + 1}]`)))
    }
  }
  return issues
}
export function factCell(text = '', factIds: string[] = [], manual = false): ReportAgentCell { return { text, factIds, manual, confirmed: false, source: '' } }
function recordsFor(snapshot: ReportSnapshot, dataset: ReportAgentDataset) {
  if (dataset === 'next_week') return snapshot.nextWeeklyRecords.filter(isEffectiveWeeklyRecord)
  return snapshot.weeklyRecords.filter(isEffectiveWeeklyRecord).filter(r => dataset !== 'risks' || r.blocker.trim() || r.status === 'blocked' || r.status === 'not_done')
}
export function buildRuleBlocks(bindings: ReportAgentBinding[], snapshot: ReportSnapshot, facts: ReportFact[], period: string, capturedAt: string, title: string): ReportAgentBlock[] {
  return bindings.filter(b => !['keep', 'clear'].includes(b.kind)).map(binding => {
    const block: ReportAgentBlock = { id: binding.regionId, regionId: binding.regionId, label: binding.label, kind: binding.kind === 'dataset' ? 'table' : 'text', required: binding.required, content: factCell(), columns: binding.columns || [], rows: [] }
    if (binding.kind === 'meta') block.content = { ...factCell(({ period, week_end: period.length === 7 ? monthEnd(period) : addDays(period, 6), week_range: period.length === 7 ? `${period}-01—${monthEnd(period)}` : `${period}—${addDays(period, 4)}`, captured_at: new Date(capturedAt).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' }), title, author: '汇报人待确认', department: '人工智能实验室' })[binding.meta || 'period']), manual: true, confirmed: true, source: '系统冻结的报告元信息' }
    else if (binding.kind === 'manual') block.content = factCell('', [], true)
    else {
      const dataset = binding.dataset || binding.section || 'outcomes'
      const summary = dataset === 'effort' || dataset === 'annual_goals'
      const monthly = period.length === 7
      const records = (summary ? summaryDatasetIds(facts, dataset) : monthly ? monthlyDatasetIds(snapshot, dataset, period) : recordsFor(snapshot, dataset).map(r => `weekly:${r.id}`)).map(id => ({ id }))
      const get = (id: string, field: ReportAgentField) => {
        if (field === 'manual') return factCell('', [], true)
        const fact = facts.find(f => f.id === `${id}:${monthly && !summary ? monthlyField(field) : field}`)
        return factCell(fact?.value || '待补充', fact ? [fact.id] : [])
      }
      if (binding.kind === 'dataset') {
        block.rows = records.map((r, index) => block.columns.map(c => /序号/.test(c.label) ? { ...factCell(String(index + 1), [], true), confirmed: true, source: '系统按本表行顺序编号' } : get(r.id, c.field)))
        if (!block.rows.length) block.rows = [block.columns.map((column, i) => ({ ...factCell(i === 0 ? '本期无已生效记录' : '暂无', [], column.field === 'manual'), ...(column.field === 'manual' ? { confirmed: true, source: '冻结快照没有本类已生效记录，系统占位' } : {}) }))]
      } else {
        const fields: ReportAgentField[] = ['next_week', 'next_month'].includes(binding.section || '') ? ['title', 'owner', 'commitment', 'status'] : binding.section === 'risks' ? ['title', 'blocker', 'next_action', 'status'] : summary ? ['title', 'commitment', 'outcome', 'status'] : ['title', 'outcome', 'status']
        const cells = records.map(r => fields.map(field => get(r.id, field)))
        block.content = factCell(cells.map(row => row.map(c => c.text).join('；')).join('\n') || '本期无已生效记录', [...new Set(cells.flat(2).flatMap(c => c.factIds))])
      }
    }
    return block
  })
}
export function reportBlocksNarrative(blocks: ReportAgentBlock[]): string {
  const text = blocks.map(block => `## ${block.label}\n${block.kind === 'text' ? block.content.text : block.rows.map(row => row.map(cell => cell.text).join('｜')).join('\n')}`).join('\n\n')
  if (text.length > 120000) throw new HttpError(400, '报告正文超过 120000 字，请精简内容后保存。原报告未改变。')
  return text
}
