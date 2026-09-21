declare const __APP_VERSION__: string | undefined
export const appVersion = typeof __APP_VERSION__ === 'undefined' ? '本地开发版' : __APP_VERSION__ || '本地开发版'
export interface ClientErrorContext { requestId?: string; message: string; occurredAt: string }
let recentError: ClientErrorContext | undefined
export function rememberClientError(message: string, requestId?: string) {
  recentError = { message: message.slice(0, 500), ...(requestId ? { requestId } : {}), occurredAt: new Date().toISOString() }
}
export function latestClientError() { return recentError }
export function clearClientError() { recentError = undefined }
export function requestErrorFeedback() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event('workspace-feedback'))
}
/** Preserve only application navigation, never authentication codes, tokens or free-text searches. */
export function safeFeedbackPath(pathname: string, search: string) {
  if (!['/', '/work', '/entry'].includes(pathname)) return '/'
  const source = new URLSearchParams(search), safe = new URLSearchParams()
  for (const key of ['view', 'id', 'notificationId', 'weekStart', 'cycleWeek', 'month', 'kind', 'targetType']) {
    const value = source.get(key)
    if (value && /^[a-zA-Z0-9_-]{1,200}$/.test(value)) safe.set(key, value)
  }
  return `${pathname}${safe.size ? `?${safe}` : ''}`
}
