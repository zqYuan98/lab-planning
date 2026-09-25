import type { AnnualGoal, MonthlyPlan } from './types'

export interface AnnualGoalProgress {
  chainCount: number
  acceptedChainCount: number
  linkedPlanCount: number
  autoProgress: number | null
  effectiveProgress: number | null
  manualOverride: boolean
}

/** Pass only currently authorized plans; neither aggregation nor ancestry widens that scope. */
export function annualGoalProgress(goal: AnnualGoal, plans: readonly MonthlyPlan[]): AnnualGoalProgress {
  const candidates = plans.filter(plan => !plan.visibility && plan.annualGoalId === goal.id && Number(plan.month.slice(0, 4)) === goal.year)
  const byId = new Map(candidates.map(plan => [plan.id, plan]))
  const parents = new Map(candidates.map(plan => [plan.id, plan.id]))
  const root = (id: string): string => {
    let current = id
    while (parents.get(current) !== current) current = parents.get(current)!
    let child = id
    while (parents.get(child) !== child) { const next = parents.get(child)!; parents.set(child, current); child = next }
    return current
  }
  // Merged rows do not count, but their authorized ancestry connects an earlier
  // carry root to the surviving merged result. Union also safely handles cycles.
  for (const plan of candidates) for (const id of [plan.sourcePlanId, plan.mergedIntoId, ...(plan.mergedFromIds ?? [])]) {
    if (!id || !byId.has(id)) continue
    const left = root(plan.id), right = root(id)
    if (left !== right) parents.set(left, right)
  }
  const chains = new Map<string, boolean>()
  const linked = candidates.filter(plan => plan.status !== 'merged')
  for (const plan of linked) {
    const key = root(plan.id)
    chains.set(key, chains.get(key) === true || plan.acceptanceStatus === 'accepted')
  }
  const chainCount = chains.size, acceptedChainCount = [...chains.values()].filter(Boolean).length
  const autoProgress = chainCount ? Math.round(100 * acceptedChainCount / chainCount) : null
  const manualOverride = goal.progressMode !== 'linked'
  return { chainCount, acceptedChainCount, linkedPlanCount: linked.length, autoProgress, effectiveProgress: manualOverride ? goal.progress : autoProgress, manualOverride }
}
