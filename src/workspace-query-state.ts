import { ApiError } from './api'
import { LatestRead, StaleReadError } from './latest-read'
import { captureMutationContext, MutationContextChangedError, subscribeMutationResponses } from './mutation-response'
import { confirmMutation, mutationEntities, type ConfirmedMutations } from './workspace-response'

const containers = new Set(['items', 'references', 'detail', 'focus', 'selected', 'result', 'rows', 'tasks', 'weeklyRecords', 'plans', 'projects', 'users', 'annualGoals', 'reports', 'publications', 'task', 'plan', 'record', 'user', 'project', 'annualGoal', 'report', 'publication'])
/** Keep response membership and projection; receipts only update objects already present. */
export function mergeWorkspaceReceipt<T>(value: T, confirmed: ConfirmedMutations): { value: T; stale: boolean } {
  let stale = false
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit)
    if (!value || typeof value !== 'object') return value
    const row = value as Record<string, unknown>
    const collection = Object.keys(mutationEntities(row))[0] as keyof ConfirmedMutations | undefined
    const receipt = collection && confirmed[collection]?.find(item => item.id === row.id)
    // A historical/reference plan is a distinct authorized projection, regardless of version.
    if (receipt && receipt.version > Number(row.version) && (collection !== 'plans' || (receipt as unknown as Record<string, unknown>).visibility === row.visibility)) {
      stale = true
      const update = receipt as unknown as Record<string, unknown>
      // Summary DTOs retain their shape and server-computed aggregates until their next read.
      return { ...row, ...Object.fromEntries(Object.keys(row).filter(key => key in update).map(key => [key, update[key]])), ...('cancellation' in update ? { cancellation: update.cancellation } : {}), ...('deletion' in update ? { deletion: update.deletion } : {}) }
    }
    return Object.fromEntries(Object.entries(row).map(([key, item]) => [key, containers.has(key) ? visit(item) : item]))
  }
  const next = visit(value) as T
  return { value: stale ? next : value, stale }
}

/** Shared state machine for page reads: authorization loss clears, transport failure preserves receipts. */
export function workspaceQueryReader<T>(options: {
  load: (signal: AbortSignal) => Promise<T>; accept: (value: T) => void; clear: () => void
  error: (error: unknown) => void; loading: (value: boolean) => void; merge?: (value: T, receipt: unknown) => T
  affected?: (path: string) => boolean
  recoverQuery?: () => boolean
}) {
  let value: T | null = null, confirmed: ConfirmedMutations = {}
  let inFlight = false, background = false, disposed = false, contextChanged = false
  const accept = (next: T) => { value = next; options.accept(next) }
  const clear = () => { value = null; confirmed = {}; options.clear() }
  const reader = new LatestRead<T>({
    load: async signal => {
      const context = captureMutationContext()
      let next: T
      try { next = await options.load(signal) }
      catch (error) {
        if (signal.aborted || context !== captureMutationContext()) throw new MutationContextChangedError()
        // A changed collection invalidates pagination, not the mounted editor or identity.
        // Retry at most once and let authorization/network failures keep their usual semantics.
        if (!(error instanceof ApiError) || error.code !== 'WORKSPACE_CURSOR_STALE' || !options.recoverQuery?.()) throw error
        confirmed = {}
        next = await options.load(signal)
      }
      if (context !== captureMutationContext()) throw new MutationContextChangedError()
      return next
    },
    accept: next => { const result = mergeWorkspaceReceipt(next, confirmed); accept(result.value); if (result.stale) throw new StaleReadError() },
    loading: loading => { inFlight = loading; if (!background || !loading) options.loading(loading) },
    error: error => {
      if (error instanceof ApiError && ([401,403,404].includes(error.status) || ['WORKSPACE_CURSOR_STALE','ACCESS_SCOPE_CHANGED','OPERATION_CONTEXT_CHANGED'].includes(error.code || ''))) clear()
      options.error(error)
    },
  })
  const read = () => { background = false; return reader.read() }
  const unsubscribe = subscribeMutationResponses(event => {
    if (event.context !== captureMutationContext() || options.affected && !options.affected(event.path)) return
    reader.invalidate()
    confirmed = confirmMutation(confirmed, event.value)
    if (value) accept(options.merge ? options.merge(value, event.value) : mergeWorkspaceReceipt(value, confirmed).value)
    void read().catch(()=>{})
  }, () => { contextChanged = true; inFlight = false; reader.reset(); clear(); options.loading(false) })
  return {
    read,
    // External-session changes have no local mutation receipt. Keep the current page and
    // edit snapshots mounted while refreshing; never cancel an already effective read.
    revalidate: () => {
      if (disposed || contextChanged || inFlight) return Promise.resolve()
      background = value !== null
      return reader.read()
    },
    // Retargeting preserves callers awaiting the latest read, but never its former query's cache.
    resetQuery: () => { reader.invalidate(); inFlight = false; value = null; confirmed = {} },
    dispose: () => { disposed = true; unsubscribe(); reader.dispose() },
  }
}
