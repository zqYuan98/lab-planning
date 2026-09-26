import { createHash } from 'node:crypto'
import { Router, type RequestHandler } from 'express'
import type { User } from '../shared/types.ts'
import type { UsageAction } from '../shared/usage-analytics.ts'
import { isMember, requireManager } from './authorization.ts'
import { getOperationEpoch } from './operation-context.ts'
import type { Store } from './store.ts'
import { exactUsageFields, usageDay, UsageAnalyticsStore } from './usage-analytics.ts'

/** Mount behind requireAuth, before the observer business-route guard. */
export function usageAnalyticsRouter(store: Store, analytics: UsageAnalyticsStore) {
  const router = Router()
  router.use('/usage-analytics', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.get('/usage-analytics/status', (req, res) => {
    exactUsageFields(req.query, [])
    res.json(analytics.policy(req.user, getOperationEpoch(store)))
  })
  router.post('/usage-analytics/page', (req, res) => {
    exactUsageFields(req.query, [])
    analytics.page(req.user, getOperationEpoch(store), req.body)
    res.status(204).end()
  })
  router.get('/usage-analytics/settings', requireManager, (_req, res) => res.json(analytics.view(getOperationEpoch(store))))
  router.put('/usage-analytics/settings', requireManager, (req, res) => res.json(analytics.update(req.body, store.list<User>('users'), getOperationEpoch(store))))
  router.get('/usage-analytics/summary', requireManager, (req, res) => res.json(analytics.summary(store.list<User>('users'), getOperationEpoch(store), req.query)))
  return router
}

interface Operation { action: UsageAction; id: string; day: string; occurredAt: string }
const hash = (...parts: unknown[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex')
/** Read only whitelisted receipt/identity fields; never serialize the request or response. */
export function usageOperationForResponse(method: string, path: string, _request: unknown, response: unknown): Operation | null {
  let action: UsageAction | undefined, command = false
  if (method === 'POST' && path === '/work-register/capture') { action = 'work_captured'; command = true }
  else if (method === 'POST' && /^\/tasks\/[^/?]+\/progress$/.test(path)) { action = 'progress_recorded'; command = true }
  else if (method === 'POST' && /^\/tasks\/[^/?]+\/deliveries$/.test(path)) { action = 'delivery_submitted'; command = true }
  else if (method === 'POST' && path === '/feedback') { action = 'feedback_submitted'; command = true }
  else if (method === 'POST' && path === '/weekly-submissions/submit') action = 'weekly_submitted'
  else if (method === 'POST' && /^\/plans\/[^/?]+\/submit$/.test(path)) action = 'plan_submitted'
  else for (const [resource, name] of [['tasks', 'task_saved'], ['plans', 'plan_saved'], ['weekly-records', 'weekly_record_saved']] as const) {
    if (method === 'POST' && path === `/${resource}` || method === 'PATCH' && new RegExp(`^/${resource}/[^/?]+$`).test(path)) action = name
  }
  if (!action || !response || typeof response !== 'object' || Array.isArray(response)) return null
  const result = response as Record<string, unknown>
  const entityId = (value: unknown) => {
    const id = value && typeof value === 'object' ? (value as Record<string, unknown>).id : undefined
    return typeof id === 'string' && id.length >= 1 && id.length <= 200 ? id : null
  }
  const createdAt = (value: unknown) => value && typeof value === 'object' ? (value as Record<string, unknown>).createdAt : undefined
  const occurredAt = action === 'work_captured' ? (Array.isArray(result.tasks) ? createdAt(result.tasks[0]) : undefined)
    : action === 'progress_recorded' ? createdAt(result.progressEvent)
    : action === 'delivery_submitted' ? createdAt(result.delivery)
    : action === 'feedback_submitted' ? createdAt(result.feedback) : result.updatedAt
  if (typeof occurredAt !== 'string' || !Number.isFinite(Date.parse(occurredAt))) return null
  const day = usageDay(new Date(occurredAt))
  if (command) {
    // Business receipts may return a newer projection on replay. Immutable event/created
    // entity IDs are stable across that replay, URL aliases, and command request-ID formats.
    const ids = action === 'work_captured' ? (Array.isArray(result.tasks) && result.tasks.length >= 1 && result.tasks.length <= 50 ? result.tasks.map(entityId).sort() : [])
      : [entityId(action === 'progress_recorded' ? result.progressEvent : action === 'delivery_submitted' ? result.delivery : result.feedback)]
    return ids.length && ids.every(id => id !== null) ? { action, id: hash(action, ids), day, occurredAt } : null
  }
  const { id, version } = response as Record<string, unknown>
  return entityId(response) && Number.isSafeInteger(version) && Number(version) > 0 ? { action, id: hash(action, id, version), day, occurredAt } : null
}

/** Install after session auth and before business routers. No listener is attached while disabled. */
export function usageAnalyticsSuccessMiddleware(store: Store, analytics: UsageAnalyticsStore): RequestHandler {
  return (req, res, next) => {
    if (!analytics.configuredEnabled || !isMember(req.user) || !['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || req.path.startsWith('/usage-analytics')) return next()
    let operation: Operation | null = null
    const path = req.path, method = req.method
    const original = res.json
    res.json = function (body: unknown) {
      if (this.statusCode >= 200 && this.statusCode < 300) operation = usageOperationForResponse(method, path, req.body, body)
      return original.call(this, body)
    }
    res.once('finish', () => {
      if (!operation || res.statusCode < 200 || res.statusCode >= 300) return
      try { analytics.action(req.user, getOperationEpoch(store), operation.action, operation.id, operation.occurredAt) }
      catch { console.error('Usage analytics write failed; business response was preserved') }
    })
    next()
  }
}
