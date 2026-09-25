import type { Bootstrap, MonthlyPlan, Publication, Task, WeeklyRecord } from './types'
import type { WorkspacePage } from './workspace-query'

export type PeriodReferences = Pick<Bootstrap, 'users' | 'projects' | 'plans' | 'tasks' | 'weeklyRecords'>
export interface WeeklyWorkspace extends WorkspacePage<WeeklyRecord> {
  references: PeriodReferences
  effortSummary: import('./effort').EffortSummary
  summary: { total: number; official: number; pending: number; done: number; blocked: number }
  detail?: { task?: Task; record?: WeeklyRecord }
}
export type PublicationSummary = Omit<Publication, 'plans'> & { planCount: number }
export type MonthlyScope = 'current' | 'historical'
export interface MonthlyWorkspace extends WorkspacePage<MonthlyPlan> {
  references: PeriodReferences
  summary: { statuses: Record<string, number>; historical: number; publishable: number; publications: number }
  detail?: MonthlyPlan
}
export interface PeriodCandidates extends WorkspacePage<MonthlyPlan | Task> { references: PeriodReferences }
