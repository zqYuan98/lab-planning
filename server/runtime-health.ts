import type { RuntimeHeartbeat } from '../shared/notification-diagnostics.ts'
import type { Store } from './store.ts'

type Service = 'worker' | 'scheduler'
const values = new WeakMap<Store, Map<Service, RuntimeHeartbeat>>()
export function runtimeHeartbeat(store: Store, service: Service): RuntimeHeartbeat {
  return { ...(values.get(store)?.get(service) ?? { startedAt: null, completedAt: null, failedAt: null, running: false }) }
}
/** Runtime-only health never dirties business storage or survives a misleading restart. */
export function beginRuntimeRun(store: Store, service: Service, now = new Date()) {
  let map = values.get(store)
  if (!map) { map = new Map(); values.set(store, map) }
  map.set(service, { ...runtimeHeartbeat(store, service), startedAt: now.toISOString(), running: true })
  return (success = true, finished = new Date()) => {
    const previous = runtimeHeartbeat(store, service)
    map!.set(service, { ...previous, running: false, ...(success ? { completedAt: finished.toISOString() } : { failedAt: finished.toISOString() }) })
  }
}
