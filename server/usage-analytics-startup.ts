import { UsageAnalyticsStore } from './usage-analytics.ts'

/** Optional measurements must never stop the business service from starting. */
export function openUsageAnalytics(path: string, version: string, warn: (message: string) => void = console.error): UsageAnalyticsStore {
  try { return new UsageAnalyticsStore(path, { version }) }
  catch {
    // Preserve the original sidecar for recovery; never replace it with an empty file.
    warn('使用率统计存储不可用，已暂停统计；业务服务继续运行。请检查统计存储并重启服务。')
    return new UsageAnalyticsStore(':memory:', { version, unavailable: true })
  }
}
