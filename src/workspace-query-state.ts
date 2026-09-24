import { ApiError } from './api'
import { LatestRead } from './latest-read'
import { captureMutationContext, MutationContextChangedError, subscribeMutationResponses } from './mutation-response'

/** Shared state machine for page reads: authorization loss clears, transport failure preserves receipts. */
export function workspaceQueryReader<T>(options: {
  load: (signal: AbortSignal) => Promise<T>; accept: (value: T) => void; clear: () => void
  error: (error: unknown) => void; loading: (value: boolean) => void; merge?: (value: T, receipt: unknown) => T
}) {
  let value: T | null = null
  const accept = (next: T) => { value = next; options.accept(next) }
  const clear = () => { value = null; options.clear() }
  const reader = new LatestRead<T>({
    load: async signal => { const context = captureMutationContext(), next = await options.load(signal); if (context !== captureMutationContext()) throw new MutationContextChangedError(); return next },
    accept, loading: options.loading,
    error: error => {
      if (error instanceof ApiError && ([401,403,404].includes(error.status) || ['WORKSPACE_CURSOR_STALE','ACCESS_SCOPE_CHANGED','OPERATION_CONTEXT_CHANGED'].includes(error.code || ''))) clear()
      options.error(error)
    },
  })
  const unsubscribe = subscribeMutationResponses(event => {
    if (event.context !== captureMutationContext()) return
    reader.invalidate()
    if (value && options.merge) accept(options.merge(value, event.value))
    void reader.read().catch(()=>{})
  }, () => { reader.reset(); clear(); options.loading(false) })
  return { read: () => reader.read(), dispose: () => { unsubscribe(); reader.dispose() } }
}
