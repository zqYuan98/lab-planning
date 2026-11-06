import type { MonthlyPlan } from './types'

export interface MonthlyPlanDeletionPreview {
  plan: MonthlyPlan
  canDelete: boolean
  blockers: string[]
}
