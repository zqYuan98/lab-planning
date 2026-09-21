export const SHUTDOWN_TIMEOUT_MS = 35_000
/** Stop claiming immediately; close storage only after both HTTP and in-flight workers settle. */
export async function drainServices(options: { stopScheduling: () => void; stopWorkers: () => Promise<void>; closeHttp: () => Promise<void>; closeStore: () => void }): Promise<void> {
  options.stopScheduling()
  const worker = options.stopWorkers()
  const http = options.closeHttp()
  const results = await Promise.allSettled([worker, http])
  if (results.some(result => result.status === 'rejected')) throw new Error('服务退出时仍有未完成工作')
  options.closeStore()
}
