export interface ReadMeasurement { sql: number; parsedRows: number; parsedBytes: number; responseBytes: number }
export type PerformanceEndpoint = 'bootstrap' | 'shell' | 'tasks' | 'weekly' | 'monthly' | 'overview-personal' | 'overview-department' | 'projects' | 'team' | 'goals' | 'import-candidates' | 'task-view' | 'collaboration'
export type PerformanceBudget = ReadMeasurement
const MiB = 1024 * 1024
/** Stable ceilings; machine-dependent wall time is recorded separately, never auto-rebased. */
export const performanceBudgets: Record<PerformanceEndpoint, PerformanceBudget> = {
  bootstrap: { sql: 25, parsedRows: 40_000, parsedBytes: 25 * MiB, responseBytes: 12 * MiB },
  shell: { sql: 10, parsedRows: 200, parsedBytes: 200 * 1024, responseBytes: 100 * 1024 },
  tasks: { sql: 10, parsedRows: 200, parsedBytes: MiB, responseBytes: 100 * 1024 },
  weekly: { sql: 250, parsedRows: 1500, parsedBytes: 2 * MiB, responseBytes: 150 * 1024 },
  monthly: { sql: 100, parsedRows: 500, parsedBytes: MiB, responseBytes: 100 * 1024 },
  'overview-personal': { sql: 25, parsedRows: 1500, parsedBytes: MiB, responseBytes: 20 * 1024 },
  'overview-department': { sql: 25, parsedRows: 6000, parsedBytes: 3 * MiB, responseBytes: 100 * 1024 },
  projects: { sql: 15, parsedRows: 200, parsedBytes: 200 * 1024, responseBytes: 100 * 1024 },
  team: { sql: 15, parsedRows: 200, parsedBytes: 200 * 1024, responseBytes: 100 * 1024 },
  goals: { sql: 15, parsedRows: 200, parsedBytes: 200 * 1024, responseBytes: 100 * 1024 },
  'import-candidates': { sql: 75, parsedRows: 200, parsedBytes: MiB, responseBytes: 150 * 1024 },
  'task-view': { sql: 75, parsedRows: 200, parsedBytes: MiB, responseBytes: 100 * 1024 },
  collaboration: { sql: 350, parsedRows: 500, parsedBytes: MiB, responseBytes: 150 * 1024 },
}
export function budgetViolations(endpoint: PerformanceEndpoint, actual: ReadMeasurement, budget = performanceBudgets[endpoint]): string[] {
  return (Object.keys(budget) as (keyof PerformanceBudget)[]).flatMap(key =>
    !Number.isFinite(actual[key]) || actual[key] < 0 || actual[key] > budget[key]
      ? [`${endpoint}.${key}: ${actual[key]} exceeds ${budget[key]} or is invalid`] : [])
}
export function assertPerformanceBudget(endpoint: PerformanceEndpoint, actual: ReadMeasurement, budget = performanceBudgets[endpoint]): void {
  const failures = budgetViolations(endpoint, actual, budget)
  if (failures.length) throw new Error(`Performance budget failed: ${failures.join('; ')}`)
}
