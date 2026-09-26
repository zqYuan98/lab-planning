import type { Store } from './store.ts'
import { storeScope } from './operation-scope.ts'

const silent = storeScope<true>()
/** Import authority is server-created and cannot be supplied by a business HTTP payload. */
export function withSilentImport<T>(store: Store, operation: () => T): T {
  return silent.run(store, true, operation)
}
export const isSilentImport = (store: Store) => silent.has(store)
