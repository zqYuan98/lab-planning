import type { MonthlyPlan, ReportSnapshot } from '../shared/types.ts'
import type { ReportAgentCell, ReportAgentNarrative, ReportFact } from '../shared/report-agent.ts'
import { isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'

/** Marks content the system has no record of; finalization stays blocked until a manager fills it. */
export const PENDING = '【待补充】'
interface Line { text: string; factIds: string[] }
const priorityRank: Record<MonthlyPlan['priority'], number> = { high: 0, medium: 1, low: 2 }
const verdicts: Record<string, string> = { accepted: '确认完成', not_completed: '确认未完成', submitted: '已提交成果，待验收', pending: '尚未提交成果' }
const oneLine = (text: string) => text.replace(/[ \t]*(?:\r\n?|[\n\u2028\u2029])+[ \t]*/g, ' ')

/**
 * Deterministic draft of one outline section. Every line names one subject and cites only that
 * subject's frozen facts (or a frozen count), so AI rewriting is validated line by line.
 */
export function narrativeCell(kind: ReportAgentNarrative, snapshot: ReportSnapshot, facts: ReportFact[], period: string): ReportAgentCell {
  const rawLines = period.length === 7 ? monthlyLines(kind, snapshot, facts, period) : weeklyLines(kind, snapshot, facts)
  const lines = rawLines.map(line => ({ ...line, text: oneLine(line.text) }))
  return { text: lines.map(line => line.text).join('\n'), factIds: [...new Set(lines.flatMap(line => line.factIds))], lineFactIds: lines.map(line => line.factIds), manual: false, confirmed: false, source: '' }
}
function reader(facts: ReportFact[], prefix: string) {
  const get = (id: string, field: string) => facts.find(fact => fact.id === `${prefix}:${id}:${field}`)
  return {
    value: (id: string, field: string) => get(id, field)?.value.trim() || '',
    ids: (id: string, fields: string[]) => fields.map(field => get(id, field)?.id).filter((value): value is string => !!value),
    metric: (field: string) => facts.find(fact => fact.id === `metric:${field}`),
  }
}
function countLine(text: string, ...metrics: (ReportFact | undefined)[]): Line {
  return { text, factIds: metrics.filter((fact): fact is ReportFact => !!fact).map(fact => fact.id) }
}

function monthlyLines(kind: ReportAgentNarrative, snapshot: ReportSnapshot, facts: ReportFact[], period: string): Line[] {
  const { value, ids, metric } = reader(facts, 'plan')
  const current = snapshot.plans.filter(plan => plan.month === period && plan.status === 'published')
  const next = snapshot.nextPlans.filter(plan => plan.status === 'published')
  // Root causes and remedies cover goals that missed their target; an accepted goal's resolved blocker is not a shortfall.
  const raised = (plan: MonthlyPlan) => plan.acceptanceStatus === 'not_completed' || plan.acceptanceStatus !== 'accepted' && !!value(plan.id, 'execution_blocker')
  const count = (field: string) => metric(field)?.value || '0'
  if (kind === 'review') {
    if (!current.length) return [countLine('本月没有已发布的月度目标。', metric('monthly_total'))]
    const parts = [`确认完成 ${count('monthly_accepted')} 项`, ...(count('monthly_not_completed') !== '0' ? [`确认未完成 ${count('monthly_not_completed')} 项`] : []), ...(count('monthly_waiting') !== '0' ? [`待验收 ${count('monthly_waiting')} 项`] : [])]
    return [countLine(`本月目标共 ${count('monthly_total')} 项：${parts.join('，')}。`, metric('monthly_total'), metric('monthly_accepted'), metric('monthly_not_completed'), metric('monthly_waiting')),
      ...current.map(plan => ({ text: `${plan.title}：${verdicts[plan.acceptanceStatus]}。${value(plan.id, 'outcome') ? `实际结果：${value(plan.id, 'outcome')}` : '实际结果未填写。'}`, factIds: ids(plan.id, ['title', 'acceptance', 'outcome']) }))]
  }
  if (kind === 'causes') {
    const targets = current.filter(raised)
    if (!targets.length) return [countLine('本月没有确认未完成的目标，执行中也未记录阻塞问题。', metric('monthly_not_completed'))]
    return targets.map(plan => {
      const direct = [value(plan.id, 'acceptance_note'), value(plan.id, 'execution_blocker')].filter(Boolean).join('；') || PENDING
      return { text: `${plan.title}：现象：${plan.acceptanceStatus === 'not_completed' ? '目标确认未完成' : '执行中受阻'}；直接原因：${direct}；根本原因：${value(plan.id, 'root_cause') || PENDING}。`, factIds: ids(plan.id, ['title', 'acceptance', 'acceptance_note', 'execution_blocker', 'root_cause']) }
    })
  }
  if (kind === 'remedies') {
    const targets = current.filter(raised)
    if (!targets.length) return [countLine('本月没有需要补救的事项。', metric('monthly_not_completed'))]
    return targets.map(plan => ({
      text: `${plan.title}：措施：${value(plan.id, 'remedy') || value(plan.id, 'next_actions') || PENDING}；责任人：${value(plan.id, 'owner')}；完成时间：${value(plan.id, 'carry_due') || PENDING}；完成标准：${value(plan.id, 'carry_criteria') || PENDING}。`,
      factIds: ids(plan.id, ['title', 'acceptance', 'remedy', 'next_actions', 'owner', 'carry_due', 'carry_criteria']),
    }))
  }
  if (kind === 'plan') {
    if (!next.length) return [countLine('下月尚无已发布的月度目标。', metric('next_total'))]
    // The template asks for 3–5 priorities: highest priority first, then the earliest due date.
    const chosen = [...next].sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || (a.dueDate || '9999').localeCompare(b.dueDate || '9999')).slice(0, 5)
    const lines: Line[] = chosen.map(plan => {
      const actions = value(plan.id, 'key_actions')
      return { text: `${plan.title}：目标：${value(plan.id, 'commitment') || PENDING}；${actions ? `关键动作：${actions}` : `验收标准：${value(plan.id, 'criteria') || PENDING}`}；责任人：${value(plan.id, 'owner')}；完成时间：${value(plan.id, 'due') || PENDING}。`, factIds: ids(plan.id, ['title', 'commitment', 'key_actions', 'criteria', 'owner', 'due']) }
    })
    if (next.length > chosen.length) lines.push(countLine(`下月已发布目标共 ${count('next_total')} 项，以上按优先级列出重点。`, metric('next_total')))
    return lines
  }
  const asking = [...current, ...next].filter(plan => value(plan.id, 'support'))
  if (!asking.length) return [countLine('无。本月各目标及其任务、周记录均未提出需要公司或跨部门支持的事项。', metric('support_total'))]
  return asking.map(plan => ({ text: `${plan.title}：${value(plan.id, 'support')}`, factIds: ids(plan.id, ['title', 'support']) }))
}

function weeklyLines(kind: ReportAgentNarrative, snapshot: ReportSnapshot, facts: ReportFact[]): Line[] {
  const { value, ids, metric } = reader(facts, 'weekly')
  const records = snapshot.weeklyRecords.filter(isEffectiveWeeklyRecord), next = snapshot.nextWeeklyRecords.filter(isEffectiveWeeklyRecord)
  const raised = records.filter(record => record.status === 'blocked' || record.status === 'not_done' || !!record.blocker.trim())
  if (kind === 'review') {
    if (!records.length) return [countLine('本周没有已提交的工作记录。', metric('weekly_total'))]
    return [countLine(`本周工作共 ${metric('weekly_total')?.value || '0'} 项，自报完成 ${metric('weekly_done')?.value || '0'} 项。`, metric('weekly_total'), metric('weekly_done')),
      ...records.map(record => ({ text: `${value(record.id, 'title')}：${value(record.id, 'status')}。${value(record.id, 'outcome') ? `实际结果：${value(record.id, 'outcome')}` : '实际结果未填写。'}`, factIds: ids(record.id, ['title', 'status', 'outcome']) }))]
  }
  if (kind === 'causes') {
    if (!raised.length) return [countLine('本周没有记录阻塞或未完成的工作。', metric('weekly_total'))]
    return raised.map(record => ({ text: `${value(record.id, 'title')}：现象：${value(record.id, 'status')}；原因：${value(record.id, 'blocker') || PENDING}。`, factIds: ids(record.id, ['title', 'status', 'blocker']) }))
  }
  if (kind === 'remedies') {
    if (!raised.length) return [countLine('本周没有需要补救的事项。', metric('weekly_total'))]
    return raised.map(record => ({ text: `${value(record.id, 'title')}：措施：${value(record.id, 'next_action') || PENDING}；责任人：${value(record.id, 'owner')}。`, factIds: ids(record.id, ['title', 'next_action', 'owner']) }))
  }
  if (kind === 'plan') {
    if (!next.length) return [countLine('下周尚无已生效的工作计划。', metric('weekly_total'))]
    return next.map(record => ({ text: `${value(record.id, 'title')}：${value(record.id, 'commitment') || PENDING}；责任人：${value(record.id, 'owner')}。`, factIds: ids(record.id, ['title', 'commitment', 'owner']) }))
  }
  const asking = records.filter(record => value(record.id, 'support'))
  if (!asking.length) return [countLine('无。本周各项工作均未提出需要支持的事项。', metric('support_total'))]
  return asking.map(record => ({ text: `${value(record.id, 'title')}：${value(record.id, 'support')}`, factIds: ids(record.id, ['title', 'support']) }))
}
