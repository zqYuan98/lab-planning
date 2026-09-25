import { useEffect, useRef } from 'react'
import type { User } from '../shared/types'
import { usagePages, type UsagePage, type UsagePolicy, type UsageSettingsView, type UsageSummary } from '../shared/usage-analytics'
import { captureMutationContext, MutationContextChangedError, subscribeMutationResponses } from './mutation-response'
import { appVersion } from './error-context'
import { LatestRead } from './latest-read'

/** Dedicated transport: analytics writes never publish business mutation responses. */
export async function usageRequest<T>(path: string, options: RequestInit = {}): Promise<T> {
  if (!/^\/(?:status|page|settings|summary)(?:\?|$)/.test(path)) throw new Error('无效使用率接口')
  const context = captureMutationContext()
  const response = await fetch(`/api/usage-analytics${path}`, { ...options, credentials: 'same-origin', headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers } })
  const text = await response.text()
  if (context !== captureMutationContext()) throw new MutationContextChangedError()
  const value = text ? JSON.parse(text) : undefined
  if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : '使用率统计暂时不可用')
  return value as T
}

export function createUsageAnalyticsClient(user: Pick<User, 'id' | 'role'>, request = usageRequest, clientVersion = appVersion === '本地开发版' ? 'development' : appVersion) {
  const context = captureMutationContext(), abort = new AbortController(), visited = new Set<string>(), pending = new Set<string>()
  let live = true
  const current = () => live && context === captureMutationContext()
  return {
    dispose() { live = false; visited.clear(); pending.clear(); abort.abort() },
    async visit(page: string) {
      if (!current() || user.role !== 'member' || !usagePages.includes(page as UsagePage)) return
      const date = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10), attempt = `${date}:${page}`
      if (pending.has(attempt)) return
      pending.add(attempt)
      try {
        const policy = await request<UsagePolicy>('/status', { signal: abort.signal })
        if (!current() || policy.enabled !== true || policy.version !== clientVersion || !/^[A-Za-z0-9_.-]{1,80}$/.test(policy.version)) return
        const key = `${date}:${policy.version}:${page}`
        if (visited.has(key)) return
        await request('/page', { method: 'POST', signal: abort.signal, body: JSON.stringify({ page, version: policy.version, userId: user.id }) })
        if (current()) visited.add(key)
      } catch { /* Measurement never blocks navigation, login or business work. */ }
      finally { pending.delete(attempt) }
    },
  }
}

export function createUsageSettingsReader(days: number, accept: (value: { settings: UsageSettingsView; summary: UsageSummary }) => void, error: (error: unknown | null) => void, request = usageRequest) {
  return new LatestRead({
    load: async signal => {
      const to = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
      const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86_400_000).toISOString().slice(0, 10)
      const [settings, summary] = await Promise.all([request<UsageSettingsView>('/settings', { signal }), request<UsageSummary>(`/summary?from=${from}&to=${to}`, { signal })])
      return { settings, summary }
    }, accept, error,
  })
}

/** Call unconditionally in App with its current authenticated user and selected page. */
export function useUsageAnalytics(user: Pick<User, 'id' | 'role'> | null | undefined, page: string) {
  const client = useRef<ReturnType<typeof createUsageAnalyticsClient> | null>(null)
  const context = captureMutationContext()
  useEffect(() => {
    const instance = user ? createUsageAnalyticsClient(user) : null
    client.current = instance
    const unsubscribe = subscribeMutationResponses(() => {}, () => instance?.dispose())
    return () => { instance?.dispose(); if (client.current === instance) client.current = null; unsubscribe() }
  }, [user?.id, user?.role, context])
  useEffect(() => { void client.current?.visit(page) }, [user?.id, user?.role, page, context])
}
