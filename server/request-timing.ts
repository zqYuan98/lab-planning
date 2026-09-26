import type { RequestHandler } from 'express'
import type { Store } from './store.ts'

const DEFAULT_SLOW_REQUEST_MS = 500
function slowThreshold(value = process.env.SLOW_REQUEST_MS): number {
  if (value === undefined || value === '') return DEFAULT_SLOW_REQUEST_MS
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error('SLOW_REQUEST_MS 必须为正整数（毫秒）')
  return parsed
}
/** Identifiers only: query strings and free-text segments may contain business content. */
function routeLabel(path: string) {
  return path.split('/').map(segment => /^[0-9a-f-]{16,}$/i.test(segment) || /^[A-Za-z0-9_-]{20,}$/.test(segment) || /^\d{4}-\d{2}(-\d{2})?$/.test(segment) ? ':id' : segment).join('/').slice(0, 200)
}

/**
 * Report server time and SQLite read cost per API request. Handlers are synchronous,
 * so the store's read counters between start and response belong to this request.
 */
export function requestTiming(store: Store, threshold = slowThreshold()): RequestHandler {
  return (req, res, next) => {
    const started = process.hrtime.bigint(), before = store.getReadMetrics()
    let measured: { ms: number; sql: number; parsedRows: number } | undefined
    const measure = () => {
      if (measured) return measured
      const after = store.getReadMetrics()
      measured = { ms: Number(process.hrtime.bigint() - started) / 1e6, sql: after.sql - before.sql, parsedRows: after.parsedRows - before.parsedRows }
      return measured
    }
    const writeHead = res.writeHead
    res.writeHead = function (this: typeof res, ...args: Parameters<typeof writeHead>) {
      if (!res.headersSent) {
        const value = measure()
        res.setHeader('Server-Timing', `app;dur=${value.ms.toFixed(1)}, db;desc="sql=${value.sql} rows=${value.parsedRows}"`)
      }
      return writeHead.apply(this, args)
    } as typeof writeHead
    res.once('finish', () => {
      const value = measure()
      if (value.ms < threshold) return
      console.warn(JSON.stringify({ event: 'slow_request', requestId: res.locals.requestId, method: req.method, route: routeLabel(req.originalUrl.split('?')[0]), status: res.statusCode, ms: Math.round(value.ms), sql: value.sql, parsedRows: value.parsedRows }))
    })
    next()
  }
}
