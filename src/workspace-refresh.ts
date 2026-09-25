export const WORKSPACE_REFRESH_INTERVAL_MS = 45_000

interface RefreshEnvironment {
  window: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  document: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>
  visible: () => boolean
  online: () => boolean
  now: () => number
  setInterval: (callback: () => void, milliseconds: number) => unknown
  clearInterval: (timer: unknown) => void
}

/** One browser listener/timer shared by mounted queries; hidden/offline tabs do no polling. */
export function createWorkspaceRefreshSource(environment: RefreshEnvironment) {
  const listeners = new Set<() => void>()
  let timer: unknown, lastDispatch = -Infinity
  const stopTimer = () => { if (timer !== undefined) environment.clearInterval(timer); timer = undefined }
  const refresh = () => {
    if (!listeners.size || !environment.visible() || !environment.online()) return
    // Browsers often dispatch focus and visibilitychange together.
    const now = environment.now()
    if (now - lastDispatch < 1_000) return
    lastDispatch = now
    for (const listener of listeners) listener()
  }
  const resume = () => {
    stopTimer()
    if (!environment.visible() || !environment.online()) return
    refresh()
    timer = environment.setInterval(refresh, WORKSPACE_REFRESH_INTERVAL_MS)
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      if (listeners.size === 1) {
        lastDispatch = -Infinity
        environment.window.addEventListener('focus', resume)
        environment.window.addEventListener('online', resume)
        environment.window.addEventListener('offline', stopTimer)
        environment.document.addEventListener('visibilitychange', resume)
        if (environment.visible() && environment.online()) timer = environment.setInterval(refresh, WORKSPACE_REFRESH_INTERVAL_MS)
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size) return
        stopTimer()
        environment.window.removeEventListener('focus', resume)
        environment.window.removeEventListener('online', resume)
        environment.window.removeEventListener('offline', stopTimer)
        environment.document.removeEventListener('visibilitychange', resume)
      }
    },
  }
}

let browserSource: ReturnType<typeof createWorkspaceRefreshSource> | undefined
export function subscribeWorkspaceRefresh(listener: () => void) {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {}
  browserSource ??= createWorkspaceRefreshSource({
    window, document, visible: () => document.visibilityState === 'visible', online: () => navigator.onLine !== false,
    now: () => Date.now(), setInterval: (callback, milliseconds) => window.setInterval(callback, milliseconds),
    clearInterval: timer => window.clearInterval(timer as number),
  })
  return browserSource.subscribe(listener)
}
