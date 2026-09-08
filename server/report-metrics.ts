import type { MonthlyPlan, Report, ReportSnapshot, WeeklyRecord } from '../shared/types.ts'

/** Pure snapshot calculations, shared by the browser and all export formats. */
export function reportMetrics(snapshot: ReportSnapshot) {
  const plans = snapshot.plans.filter(plan => plan.status === 'published')
  const weekly = snapshot.weeklyRecords.filter(record => record.submitted)
  const accepted = plans.filter(plan => plan.acceptanceStatus === 'accepted').length
  const done = weekly.filter(record => record.status === 'done').length
  return {
    monthly: { total: plans.length, accepted, awaitingReview: plans.filter(p => p.acceptanceStatus === 'submitted').length,
      notCompleted: plans.filter(p => p.acceptanceStatus === 'not_completed').length,
      rate: plans.length ? Math.round(accepted * 1000 / plans.length) / 10 : null },
    weekly: { total: weekly.length, done, blocked: weekly.filter(r => r.status === 'blocked' || r.status === 'not_done').length,
      drafts: snapshot.weeklyRecords.length - weekly.length,
      rate: weekly.length ? Math.round(done * 1000 / weekly.length) / 10 : null }
  }
}

export function rateLabel(value: number | null) { return value === null ? '暂无统计口径' : `${value}%` }
/** Follow frozen source proposals, including carryovers that were subsequently merged. */
export function planOriginLabel(snapshot: ReportSnapshot, plan: MonthlyPlan): string {
  const plans = new Map([...snapshot.plans, ...snapshot.nextPlans, ...(snapshot.contextPlans || [])].map(p => [p.id, p]))
  const describe = (current: MonthlyPlan, path: Set<string>): string => {
    if (path.has(current.id)) return '来源链存在重复，待核对'
    const nextPath = new Set(path).add(current.id)
    const label = (id: string): string => {
      const source = plans.get(id)
      if (!source) return '原始计划未收录于该快照'
      const ancestry = describe(source, nextPath)
      return `${source.month} · ${source.title}${ancestry ? `（${ancestry}）` : ''}`
    }
    return [current.sourcePlanId ? `承接：${label(current.sourcePlanId)}` : '',
      current.mergedFromIds?.length ? `合并：${current.mergedFromIds.map(label).join('、')}` : ''].filter(Boolean).join('；')
  }
  return describe(plan, new Set())
}
/** Historical record attribution never changes when the stable task is later relinked. */
export function weeklyAssociationLabel(snapshot: ReportSnapshot, record: WeeklyRecord): string {
  const task = snapshot.tasks.find(t => t.id === record.taskId)
  const planName = (id: string) => {
    const plan = [...snapshot.plans, ...snapshot.nextPlans, ...(snapshot.contextPlans || [])].find(p => p.id === id)
    return plan ? `${plan.month} · ${plan.title}` : id
  }
  if (record.monthlyPlanId) return `当期月计划：${planName(record.monthlyPlanId)}`
  const reason = task?.temporaryReason ? `；临时原因：${task.temporaryReason}` : ''
  return task?.monthlyPlanId
    ? `当期为临时工作；生成报告时任务已补关联：${planName(task.monthlyPlanId)}${reason}`
    : `当期为临时工作；生成报告时仍待补关联${reason}`
}
export function snapshotWarnings(report: Pick<Report, 'snapshot' | 'type'>): string[] {
  const { snapshot } = report
  const warnings: string[] = []
  const taskTitle = (id: string) => snapshot.tasks.find(t => t.id === id)?.title || id
  for (const record of snapshot.weeklyRecords.filter(r => r.submitted)) {
    if (record.status === 'done' && !record.actualOutcome.trim()) warnings.push(`「${taskTitle(record.taskId)}」自报完成，缺少实际成果。`)
    if (record.status === 'done' && !record.evidenceUrl.trim()) warnings.push(`「${taskTitle(record.taskId)}」自报完成，缺少验收证据链接。`)
    if (['blocked', 'not_done'].includes(record.status) && !record.blocker.trim()) warnings.push(`「${taskTitle(record.taskId)}」缺少阻塞或未完成原因。`)
    if (['blocked', 'not_done'].includes(record.status) && !record.nextAction.trim()) warnings.push(`「${taskTitle(record.taskId)}」缺少下一步措施。`)
    if (!record.monthlyPlanId && !snapshot.tasks.find(t => t.id === record.taskId)?.monthlyPlanId) warnings.push(`「${taskTitle(record.taskId)}」当期为临时工作，生成报告时仍未补充月计划关联。`)
  }
  for (const plan of snapshot.plans.filter(p => p.status === 'published')) {
    if (plan.acceptanceStatus === 'submitted') warnings.push(`月计划「${plan.title}」已提交成果，待管理者验收。`)
    if (plan.acceptanceStatus === 'not_completed' && !plan.acceptanceNote.trim()) warnings.push(`月计划「${plan.title}」未完成，缺少原因与纠偏说明。`)
  }
  if (snapshot.nextPlans.length === 0) warnings.push('下一月尚无计划；下月安排待提报。')
  else if (snapshot.nextPlans.some(p => p.status !== 'published')) warnings.push('下月安排包含未发布草案，尚未成为正式承诺。')
  if (report.type === 'weekly' && !snapshot.nextWeeklyRecords.some(r => r.submitted)) warnings.push('下周尚无已提交周计划，安排待确认。')
  return warnings
}

export const weeklyStatusLabels: Record<string, string> = { planned: '未开始', doing: '进行中', blocked: '阻塞', done: '成员自报完成', not_done: '未完成' }
export const acceptanceLabels: Record<string, string> = { pending: '待提交成果', submitted: '待管理者验收', accepted: '管理者已验收', not_completed: '确认未完成' }
