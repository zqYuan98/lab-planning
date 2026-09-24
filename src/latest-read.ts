import { MutationContextChangedError } from './mutation-response'

/** All callers await the latest effective read, even when fetch ignores abort. */
export class LatestRead<T> {
  private sequence = 0
  private controller: AbortController | undefined
  private disposed = false
  private waiting: { resolve: () => void; reject: (error: unknown) => void }[] = []
  constructor(private options: { load: (signal: AbortSignal) => Promise<T>; accept: (value: T) => void; error?: (error: unknown | null) => void; loading?: (loading: boolean) => void }) {}
  read(): Promise<void> {
    if (this.disposed) return Promise.reject(new MutationContextChangedError())
    this.invalidate()
    const sequence = this.sequence, controller = new AbortController()
    this.controller = controller
    const completion = new Promise<void>((resolve, reject) => { this.waiting.push({ resolve, reject }) })
    this.options.loading?.(true); this.options.error?.(null)
    const current = () => !this.disposed && sequence === this.sequence
    void (async () => {
      try {
        const value = await this.options.load(controller.signal)
        if (!current()) return
        this.options.accept(value)
        if (!current()) return
        this.options.loading?.(false)
        for (const waiter of this.waiting.splice(0)) waiter.resolve()
      } catch (error) {
        if (!current()) return
        this.options.error?.(error); this.options.loading?.(false)
        for (const waiter of this.waiting.splice(0)) waiter.reject(error)
      }
    })()
    return completion
  }
  /** Follow with read() after accepting a successful mutation response. */
  invalidate() { this.sequence++; this.controller?.abort(); this.controller = undefined }
  reset() {
    this.invalidate()
    for (const waiter of this.waiting.splice(0)) waiter.reject(new MutationContextChangedError())
  }
  dispose() { this.disposed = true; this.reset() }
}

export class StaleReadError extends Error {
  constructor() { super('读取结果早于已确认的保存版本，已保留最新内容，请重新刷新。'); this.name = 'StaleReadError' }
}
/** Incoming membership is authoritative: never union objects missing from a complete response. */
export function reconcileVersionedList<T extends { id: string; version: number }>(known: T[], incoming: T[]) {
  const byId = new Map(known.map(item => [item.id, item]))
  let stale = false
  const items = incoming.map(item => {
    const prior = byId.get(item.id)
    if (prior && prior.version > item.version) { stale = true; return prior }
    return item
  })
  return { items, stale }
}
