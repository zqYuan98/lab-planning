import type { MonthlyPlan, Project, WeeklyRecord } from './types'
import { isEffectiveWeeklyRecord } from './weekly-record-state'

export function isEffortDays(value: unknown): value is number | null {
  return value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && Number.isInteger(value * 2)
}
export function effortDays(value: unknown): number | null {
  if (!isEffortDays(value)) throw new RangeError('投入人日必须为有限、非负且以 0.5 为步长的数字，留空请传 null')
  return value
}
export function effortInput(value: FormDataEntryValue | null): number | null {
  return value === null || String(value).trim() === '' ? null : effortDays(Number(value))
}
export interface EffortTotals { recordCount: number; plannedEffortDays: number; actualEffortDays: number; missingPlannedCount: number; missingActualCount: number }
export interface EffortSummary extends EffortTotals {
  byProject: (EffortTotals & { projectId: string | null; projectName: string })[]
  byOwnerWeek: (EffortTotals & { ownerId: string; weekStart: string; overCapacity: boolean })[]
}
const empty = (): EffortTotals => ({ recordCount: 0, plannedEffortDays: 0, actualEffortDays: 0, missingPlannedCount: 0, missingActualCount: 0 })
const add = (total: EffortTotals, record: WeeklyRecord) => {
  total.recordCount++
  if (record.plannedEffortDays == null) total.missingPlannedCount++; else total.plannedEffortDays += record.plannedEffortDays
  if (record.actualEffortDays == null) total.missingActualCount++; else total.actualEffortDays += record.actualEffortDays
}
/** Uses the supplied facts only, so frozen report snapshots never consult live task estimates. */
export function summarizeEffort(records: readonly WeeklyRecord[], plans: readonly MonthlyPlan[] = [], projects: readonly Project[] = []): EffortSummary {
  const total = empty(), byProject = new Map<string | null, EffortSummary['byProject'][number]>(), byOwnerWeek = new Map<string, EffortSummary['byOwnerWeek'][number]>()
  const planMap = new Map(plans.map(plan => [plan.id, plan])), projectMap = new Map(projects.map(project => [project.id, project.name]))
  const unique = new Map<string, WeeklyRecord>()
  for (const record of records) if (!unique.has(record.id) || unique.get(record.id)!.version < record.version) unique.set(record.id, record)
  for (const record of unique.values()) {
    if (!isEffectiveWeeklyRecord(record)) continue
    add(total, record)
    const projectId = record.monthlyPlanId ? planMap.get(record.monthlyPlanId)?.projectId ?? null : null
    const project = byProject.get(projectId) ?? { ...empty(), projectId, projectName: projectId ? projectMap.get(projectId) ?? '未命名项目' : '未关联项目' }
    add(project, record); byProject.set(projectId, project)
    const key = JSON.stringify([record.ownerId, record.weekStart])
    const week = byOwnerWeek.get(key) ?? { ...empty(), ownerId: record.ownerId, weekStart: record.weekStart, overCapacity: false }
    add(week, record); week.overCapacity = week.plannedEffortDays > 5 || week.actualEffortDays > 5; byOwnerWeek.set(key, week)
  }
  return { ...total, byProject: [...byProject.values()], byOwnerWeek: [...byOwnerWeek.values()] }
}
