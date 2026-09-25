import type { ReportSnapshot } from '../shared/types.ts'
import type { ReportAgentBinding, ReportAgentDataset, ReportAgentField, ReportFact, ReportTemplate } from '../shared/report-agent.ts'
import type { DocxEdit, DocxInspection } from '../shared/report-docx.ts'
import { acceptanceLabels } from './report-metrics.ts'

export function monthEnd(period: string) {
  const date = new Date(`${period}-01T00:00:00Z`)
  date.setUTCMonth(date.getUTCMonth() + 1); date.setUTCDate(0)
  return date.toISOString().slice(0, 10)
}

/** Monthly outcomes have the monthly acceptance authority, never a weekly done flag. */
export function monthlyReportFacts(snapshot: ReportSnapshot, period: string): ReportFact[] {
  const facts: ReportFact[] = []
  for (const plan of [...snapshot.plans.filter(p => p.month === period && p.status === 'published'), ...snapshot.nextPlans.filter(p => p.status !== 'merged')]) {
    const next = plan.month !== period
    const values = { title: plan.title, owner: snapshot.users.find(u => u.id === plan.ownerId)?.name || '负责人待核实',
      commitment: plan.expectedOutcome, expected: plan.expectedOutcome, outcome: next ? '下月安排，尚非本月成果' : plan.actualOutcome,
      acceptance: next ? (plan.status === 'published' ? '下月已发布承诺' : '下月未发布草案，待审核发布') : acceptanceLabels[plan.acceptanceStatus],
      evidence: '', blocker: plan.acceptanceStatus === 'not_completed' ? plan.acceptanceNote : '', next_action: next ? plan.acceptanceCriteria : '',
      monthly_goal: plan.title, due: plan.dueDate }
    for (const [field, value] of Object.entries(values)) facts.push({ id: `plan:${plan.id}:${field}`, sourceType: 'monthlyPlan', sourceId: plan.id, sourceVersion: plan.version,
      subjectId: plan.id, subject: plan.title, field, value, unit: '', period: plan.month, status: next ? 'next_plan' : plan.acceptanceStatus })
  }
  const plans = snapshot.plans.filter(p => p.month === period && p.status === 'published')
  for (const [field, value] of Object.entries({ monthly_total: plans.length, monthly_accepted: plans.filter(p => p.acceptanceStatus === 'accepted').length })) {
    facts.push({ id: `metric:${field}`, sourceType: 'metric', sourceId: 'snapshot', sourceVersion: 1, subjectId: 'snapshot', subject: '冻结月度验收统计', field, value: String(value), unit: '项', period, status: 'computed' })
  }
  return facts
}

export function frozenSummaryFacts(snapshot: ReportSnapshot, period: string): ReportFact[] {
  const facts: ReportFact[] = []
  const add = (id: string, subject: string, field: string, value: string) => facts.push({ id: `${id}:${field}`, sourceType: 'metric', sourceId: id, sourceVersion: 1, subjectId: id, subject, field, value, unit: '', period, status: 'frozen' })
  if (snapshot.effortSummary) {
    const summary = snapshot.effortSummary
    const rows = [{ id: 'effort:total', name: '部门投入', ...summary }, ...summary.byProject.map((p, i) => ({ ...p, id: `effort:project:${i}`, name: p.projectName }))]
    for (const row of rows) {
      add(row.id, row.name, 'title', row.name)
      add(row.id, row.name, 'commitment', `已填合计 ${row.plannedEffortDays} 人日；未填 ${row.missingPlannedCount} 条`)
      add(row.id, row.name, 'outcome', `已填合计 ${row.actualEffortDays} 人日；未填 ${row.missingActualCount} 条`)
      add(row.id, row.name, 'status', summary.basis)
    }
  }
  for (const summary of snapshot.annualGoalSummaries || []) {
    const goal = snapshot.annualGoals.find(g => g.id === summary.goalId)
    if (!goal) continue
    const id = `annual:${goal.id}`
    add(id, goal.title, 'title', goal.title)
    add(id, goal.title, 'commitment', goal.target)
    add(id, goal.title, 'outcome', summary.autoProgress === null ? '暂无关联' : `关联承接链验收计数 ${summary.acceptedChainCount}/${summary.chainCount}，自动进度 ${summary.autoProgress}%`)
    add(id, goal.title, 'status', summary.manualOverride ? `人工覆盖 ${summary.effectiveProgress ?? goal.progress}%` : `采用自动值；历史手工记录 ${goal.progress}%`)
  }
  return facts
}

export function monthlyDatasetIds(snapshot: ReportSnapshot, dataset: ReportAgentDataset, period: string): string[] {
  if (dataset === 'next_month' || dataset === 'next_week') return snapshot.nextPlans.filter(p => p.status !== 'merged').map(p => `plan:${p.id}`)
  return snapshot.plans.filter(p => p.month === period && p.status === 'published' && (dataset !== 'risks' || p.acceptanceStatus === 'not_completed')).map(p => `plan:${p.id}`)
}
export function summaryDatasetIds(facts: ReportFact[], dataset: ReportAgentDataset): string[] {
  return facts.filter(f => f.field === 'title' && f.id.startsWith(dataset === 'effort' ? 'effort:' : 'annual:')).map(f => f.id.slice(0, -6))
}
export function monthlyField(field: ReportAgentField) { return field === 'status' ? 'acceptance' : field }

export const monthlyWordText = (text: string) => text.replaceAll('周报', '月报').replaceAll('本周', '本月').replaceAll('下周', '下月').replaceAll('周阶段状态', '月度验收状态')
export function monthlyBindings(bindings: ReportAgentBinding[], inspection: DocxInspection): ReportAgentBinding[] {
  return bindings.map(binding => {
    const result = { ...binding, label: monthlyWordText(binding.label) }
    if (binding.columns) result.columns = binding.columns.map(column => ({ ...column, label: monthlyWordText(column.label) }))
    if (binding.dataset === 'next_week') result.dataset = 'next_month'
    if (binding.value !== undefined) result.value = monthlyWordText(binding.value)
    else if (binding.kind === 'keep') {
      const original = inspection.regions.find(region => region.id === binding.regionId)?.text || ''
      const converted = monthlyWordText(original)
      // Unchanged fixed regions must remain keep, including fixed complex Word content.
      if (converted !== original) result.value = converted
    }
    return result
  })
}

/** Header cells are outside the replaced data-row interval, so edits cannot overlap. Source bytes stay intact. */
export function monthlyHeaderEdits(template: ReportTemplate, inspection: DocxInspection): DocxEdit[] {
  if (template.type !== 'monthly') return []
  const edits: DocxEdit[] = []
  for (const binding of template.bindings.filter(binding => binding.kind === 'dataset')) {
    for (const region of inspection.regions) {
      if (region.kind !== 'cell' || `t:${region.tableIndex}` !== binding.regionId || region.rowIndex >= (binding.startRow ?? 1)) continue
      const text = monthlyWordText(region.text)
      if (text !== region.text && !template.bindings.some(other => other.regionId === region.id)) edits.push({ kind: 'text', regionId: region.id, text })
    }
  }
  return edits
}
