import type { Bootstrap, Entity, MonthlyPlan, Task, WeeklyRecord } from '../shared/types'
import { reconcileVersionedList } from './latest-read'

const lists = ['users', 'projects', 'annualGoals', 'plans', 'tasks', 'weeklyRecords', 'publications', 'reports'] as const
type Collection = typeof lists[number]
type MutationCollection = Collection | 'followupRequests' | 'taskTrackings'
export type ConfirmedMutations = Partial<Record<MutationCollection, Entity[]>>
function entity(value: unknown): value is Entity & Record<string, unknown> {
  return !!value && typeof value === 'object' && typeof (value as Entity).id === 'string' && Number.isInteger((value as Entity).version)
}
/** Inspect only documented response containers, never snapshots or arbitrary nested evidence. */
export function mutationEntities(value: unknown): ConfirmedMutations {
  const result: ConfirmedMutations = {}
  const inspect = (row: unknown) => {
    if (!entity(row)) return
    const collection: MutationCollection | undefined = 'weekStart' in row && 'taskId' in row ? 'weeklyRecords'
      : 'requirement' in row && 'taskId' in row && 'status' in row ? 'followupRequests'
      : 'dueDateVersion' in row && 'taskId' in row && 'state' in row ? 'taskTrackings'
      : 'monthlyPlanId' in row && 'isTemporary' in row && 'title' in row ? 'tasks'
      : 'acceptanceStatus' in row && 'month' in row ? 'plans'
      : 'plans' in row && 'revision' in row && 'month' in row ? 'publications'
      : 'snapshot' in row && 'narrative' in row && 'period' in row ? 'reports'
      : 'role' in row && 'email' in row && 'active' in row ? 'users'
      : 'code' in row && 'name' in row && 'ownerId' in row ? 'projects'
      : 'year' in row && 'target' in row && 'ownerId' in row ? 'annualGoals' : undefined
    if (collection) (result[collection] ??= []).push(row)
  }
  inspect(value)
  if (Array.isArray(value)) value.forEach(inspect)
  else if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>
    for (const key of ['task', 'tasks', 'record', 'weeklyRecord', 'weeklyRecords', 'plan', 'plans', 'project', 'user', 'annualGoal', 'report', 'publication', 'request', 'followup', 'tracking']) {
      if (Array.isArray(row[key])) (row[key] as unknown[]).forEach(inspect)
      else inspect(row[key])
    }
  }
  return result
}
export function confirmMutation(known: ConfirmedMutations, value: unknown): ConfirmedMutations {
  const next = { ...known }, updates = mutationEntities(value)
  for (const name of Object.keys(updates) as MutationCollection[]) {
    if (!updates[name]) continue
    const rows = new Map((known[name] ?? []).map(row => [row.id, row]))
    for (const row of updates[name]) if (!rows.has(row.id) || rows.get(row.id)!.version <= row.version) rows.set(row.id, row)
    next[name] = [...rows.values()]
  }
  return next
}
export function applyBootstrapMutation(current: Bootstrap, value: unknown): Bootstrap {
  const changes = mutationEntities(value), next = { ...current }
  for (const name of lists) {
    const updates = changes[name]
    if (!updates) continue
    const known = new Map((current[name] as Entity[]).map(row => [row.id, row]))
    for (const row of updates) {
      const before = known.get(row.id)
      if (before && before.version > row.version) continue
      if (name === 'tasks' && ((row as Task).cancellation || current.user.role !== 'manager' && (row as Task).ownerId !== current.user.id)
        || name === 'weeklyRecords' && ((row as WeeklyRecord).deletion || current.user.role !== 'manager' && (row as WeeklyRecord).ownerId !== current.user.id)) known.delete(row.id)
      else known.set(row.id, row)
    }
    Object.assign(next, { [name]: [...known.values()] })
  }
  const self = changes.users?.find(row => row.id === current.user.id)
  if (self && self.version >= current.user.version) next.user = self as Bootstrap['user']
  return next
}
export function reconcileBootstrap(current: Bootstrap | null, incoming: Bootstrap, confirmed: ConfirmedMutations = {}): { value: Bootstrap; stale: boolean } {
  if (!current || current.user.id !== incoming.user.id || current.user.role !== incoming.user.role) return { value: incoming, stale: false }
  const value = { ...incoming }
  let stale = false
  for (const name of lists) {
    // A historical/reference plan is a narrower authorized projection, not a stale current record.
    const projections = new Map(incoming.plans.map(plan => [plan.id, plan.visibility]))
    const sameProjection = (row: Entity) => name !== 'plans' || projections.has(row.id) && projections.get(row.id) === (row as MonthlyPlan).visibility
    const candidates = new Map((current[name] as Entity[]).filter(sameProjection).map(row => [row.id, row]))
    for (const row of confirmed[name] ?? []) if (sameProjection(row) && (!candidates.has(row.id) || candidates.get(row.id)!.version < row.version)) candidates.set(row.id, row)
    const result = reconcileVersionedList([...candidates.values()], incoming[name] as Entity[])
    const items = name === 'tasks' ? result.items.filter(row => !(row as Task).cancellation)
      : name === 'weeklyRecords' ? result.items.filter(row => !(row as WeeklyRecord).deletion) : result.items
    Object.assign(value, { [name]: items }); stale ||= result.stale
  }
  return { value, stale }
}
