import { AsyncLocalStorage } from 'node:async_hooks'
import type { Store } from './store.ts'

const context = new AsyncLocalStorage<ReadonlySet<Store>>()
/** Import authority is server-created and cannot be supplied by a business HTTP payload. */
export function withSilentImport<T>(store: Store, operation: () => T): T {
  const stores = new Set(context.getStore()); stores.add(store)
  return context.run(stores, operation)
}
export const isSilentImport = (store: Store) => context.getStore()?.has(store) === true
