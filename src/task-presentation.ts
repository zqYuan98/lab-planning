import type { MonthlyPlan, Task } from '../shared/types'

export type TaskPriority = NonNullable<Task['priority']>
export type WorkKind = 'monthly' | 'temporary' | 'routine'

/** Explicit task choices win. Legacy tasks may inherit their linked goal's priority. */
export function taskPriority(task?: Pick<Task, 'priority'>, plan?: Pick<MonthlyPlan, 'priority'>): TaskPriority | undefined {
  return task?.priority ?? plan?.priority
}

/** Temporary origin is retained even after a task is included in a monthly goal. */
export function workKind(value: { isTemporary?: boolean; monthlyPlanId?: string | null; isMonthly?: boolean }): WorkKind {
  return value.isTemporary ? 'temporary' : value.isMonthly || value.monthlyPlanId ? 'monthly' : 'routine'
}

export const priorityLabels = { high: '高优先级', medium: '中优先级', low: '低优先级', none: '未设优先级' }
export const workKindLabels = { monthly: '月度计划', temporary: '临时任务', routine: '日常任务' }
export const priorityRank = { high: 0, medium: 1, low: 2, none: 3 }
