import { advanceMutationContext, captureMutationContext } from './mutation-response'

let actorId: string | undefined
let blocked = false
const listeners = new Set<() => void>()

/** Bind business requests to the identity confirmed by the shell, not a shared cookie. */
export function bindSessionActor(id: string | null) { actorId = id ?? undefined; blocked = id === null }
export function sessionActor() { return { actorId, blocked } }
export function rejectSessionIdentity(startedIn: number) {
  if (startedIn !== captureMutationContext() || blocked) return
  blocked = true
  advanceMutationContext()
  for (const listener of listeners) listener()
}
export function subscribeSessionIdentityChanges(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
