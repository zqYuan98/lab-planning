import { AsyncLocalStorage } from 'node:async_hooks'
import type { Store } from './store.ts'

/**
 * A per-store value scoped to the current call stack and its awaited continuations. Unlike a
 * module-level map keyed by store, a value set while one operation runs is never visible to
 * another request that runs while the first is waiting, and it is cleared on every exit path.
 */
export function storeScope<T>() {
  const storage = new AsyncLocalStorage<ReadonlyMap<Store, T>>()
  return {
    get: (store: Store): T | undefined => storage.getStore()?.get(store),
    has: (store: Store): boolean => storage.getStore()?.has(store) === true,
    run<R>(store: Store, value: T, operation: () => R): R {
      const next = new Map(storage.getStore()); next.set(store, value)
      return storage.run(next, operation)
    },
  }
}
