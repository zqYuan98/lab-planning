import express, { type ErrorRequestHandler, type RequestHandler } from 'express'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isIP } from 'node:net'
import type { User } from '../shared/types.ts'
import { appOrigin, clearSession, createSession, createOriginGuard, requireAuth, setSessionCookie, type StoredUser } from './auth.ts'
import { Domain } from './domain.ts'
import { HttpError, Store } from './store.ts'
import { createReportRouter } from './report-routes.ts'
import { createAiSettingsRouter, createImportRouter } from './import-routes.ts'
import { requireIntegrationAuth } from './integration-auth.ts'
import { createDataRouter } from './data-routes.ts'
import { createWeeklySubmissionRouter } from './weekly-submission-routes.ts'
import { ensureWeeklyPlanReviewRule } from './weekly-plan-review.ts'
import { createDingTalkClient, type DingTalkClient } from './dingtalk.ts'
import { dingtalkRouter } from './dingtalk-routes.ts'
import { notificationRouter } from './notification-routes.ts'
import { collaborationRouter } from './collaboration-routes.ts'
import { notificationDiagnosticsRouter } from './notification-diagnostics.ts'
import { nativeRouter } from './native-routes.ts'
import { workRegisterRouter } from './work-register-routes.ts'
import { observerRouteGuard, objectAccessRouter } from './object-access-routes.ts'
import { deliveryRouter } from './delivery-routes.ts'
import { carryWorkflowRouter } from './carry-workflow-routes.ts'
import { periodReviewRouter } from './period-review-routes.ts'
import { workspaceQueryRouter } from './workspace-query.ts'
import { TaskViewService } from './task-view.ts'
import { MyActionsService } from './my-actions.ts'
import type { DingTalkNativeClient } from './dingtalk-native.ts'
import { feedbackRouter } from './feedback-routes.ts'
import { createReportAgentRouter } from './report-agent-routes.ts'
import { requireReportManager } from './reports.ts'

interface AppOptions { store?: Store; dbPath?: string; enableScheduler?: boolean; dingtalkClient?: DingTalkClient; nativeClient?: DingTalkNativeClient }
/** Trust named loopback or explicit proxy addresses, never a caller-supplied hop count. */
function trustedProxies(value = process.env.TRUST_PROXY): false | string[] {
  if (!value || value === 'false') return false
  const entries = value.split(',').map(entry => entry.trim())
  const valid = entries.every(entry => {
    if (entry === 'loopback') return true
    const [address, prefix, extra] = entry.split('/')
    const family = isIP(address)
    return family !== 0 && extra === undefined && (prefix === undefined || /^\d+$/.test(prefix) && Number(prefix) > 0 && Number(prefix) <= (family === 4 ? 32 : 128))
  })
  if (!valid) throw new Error('TRUST_PROXY 仅接受 loopback 或逗号分隔的代理 IP/CIDR 白名单，禁止全网信任或跳数')
  return entries
}
export function createApp(options: AppOptions = {}) {
  const canonical = appOrigin()
  const proxies = trustedProxies()
  const store = options.store ?? new Store(options.dbPath ?? process.env.DATABASE_PATH ?? resolve('data/lab-planning.sqlite'))
  ensureWeeklyPlanReviewRule(store)
  const domain = new Domain(store)
  const app = express()
  const dingtalk = options.dingtalkClient ?? createDingTalkClient()
  app.locals.store = store
  app.disable('x-powered-by')
  app.set('trust proxy', proxies)
  app.use((_req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' })
    if (process.env.NODE_ENV === 'production') res.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'")
    next()
  })
  app.use('/api', (_req, res, next) => {
    res.locals.requestId = randomUUID()
    res.set('X-Request-Id', res.locals.requestId)
    next()
  })
  const regularJson = express.json({ limit: '256kb' }), importJson = express.json({ limit: '16mb' }), restoreJson = express.json({ limit: '35mb' }), feedbackJson = express.json({ limit: '9mb' }), reportAssetJson = express.json({ limit: '18mb' }), reportEditJson = express.json({ limit: '4mb' })
  app.use('/api', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() }, createOriginGuard(canonical), (req, res, next) => {
    const large = /^\/(?:v1\/)?imports(?:\/|$)/i.test(req.path)
    const feedbackUpload = req.method === 'POST' && /^\/feedback(?:\/[^/]+\/actions)?\/?$/i.test(req.path)
    const reportUpload = req.method === 'POST' && /^\/report-agent\/assets\/?$/i.test(req.path)
    const reportEdit = req.method === 'PATCH' && /^\/report-agent\/(?:reports|templates)\/[^/]+\/?$/i.test(req.path)
    const frozenCommand = req.method === 'POST' && (/^\/period-reviews\/?$/i.test(req.path) || /^\/carry-workflows\/[^/]+\/apply\/?$/i.test(req.path))
    if (frozenCommand) return requireAuth(store)(req, res, error => {
      if (error) return next(error)
      try { requireReportManager(store, req.user.id) } catch (failure) { return next(failure) }
      return restoreJson(req, res, next)
    })
    if (reportUpload || reportEdit) return requireAuth(store)(req, res, error => {
      if (error) return next(error)
      try { requireReportManager(store, req.user.id) } catch (failure) { return next(failure) }
      return (reportUpload ? reportAssetJson : reportEditJson)(req, res, next)
    })
    if (feedbackUpload) return requireAuth(store)(req, res, error => error ? next(error) : feedbackJson(req, res, next))
    return (req.path.toLowerCase().startsWith('/data/restore/') ? restoreJson : large ? importJson : regularJson)(req, res, next)
  })
  app.use('/api', (req, _res, next) => {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && (!req.body || typeof req.body !== 'object' || Array.isArray(req.body))) return next(new HttpError(400, '请求内容必须是 JSON 对象'))
    next()
  })

  // Only failed credentials consume the budget; a valid login cannot erase prior failures.
  const attempts = new Map<string, { count: number; resetAt: number }>()
  const loginLimit: RequestHandler = (req, res, next) => {
    const key = req.ip ?? 'local'
    const now = Date.now()
    for (const [id, state] of attempts) if (state.resetAt <= now) attempts.delete(id)
    const state = attempts.get(key)
    if (state && state.count >= 20) {
      res.set('Retry-After', String(Math.ceil((state.resetAt - now) / 1000)))
      return next(new HttpError(429, '尝试次数过多，请稍后再试'))
    }
    next()
  }
  app.get('/api/auth/status', (_req, res) => res.json({ initialized: store.list('users').length > 0 }))
  const authenticate = (action: 'setup' | 'login'): RequestHandler => (req, res) => {
    let authenticated: { user: User; token: string }
    try {
      authenticated = store.transaction(() => {
        const user = domain[action](req.body)
        clearSession(store, req.headers.cookie, res, false)
        const token = createSession(store, store.get<StoredUser>('users', user.id)!)
        return { user, token }
      })
    } catch (error) {
      if (error instanceof HttpError && [400, 401, 409].includes(error.status)) {
        const key = req.ip ?? 'local'
        const state = attempts.get(key) ?? { count: 0, resetAt: Date.now() + 15 * 60 * 1000 }
        state.count++
        attempts.set(key, state)
      }
      throw error
    }
    const { user, token } = authenticated
    setSessionCookie(res, token)
    res.status(action === 'setup' ? 201 : 200).json(user)
  }
  app.post('/api/auth/setup', loginLimit, authenticate('setup'))
  app.post('/api/auth/login', loginLimit, authenticate('login'))
  const registrationAttempts = new Map<string, { count: number; resetAt: number }>()
  app.post('/api/auth/register', (req, res) => {
    const now = Date.now()
    for (const [key, state] of registrationAttempts) if (state.resetAt <= now) registrationAttempts.delete(key)
    const key = req.ip ?? 'local'
    const state = registrationAttempts.get(key) ?? { count: 0, resetAt: now + 15 * 60 * 1000 }
    if (state.count >= 20) {
      res.set('Retry-After', String(Math.ceil((state.resetAt - now) / 1000)))
      throw new HttpError(429, '注册申请次数过多，请稍后再试')
    }
    state.count++
    registrationAttempts.set(key, state)
    res.status(202).json(domain.register(req.body))
  })
  app.use('/api/v1', requireIntegrationAuth(store), createImportRouter(store), createDataRouter(store, true), (_req, _res, next) => next(new HttpError(404, '集成接口不存在')))
  app.use('/api', dingtalkRouter(store, dingtalk))
  app.use('/api', requireAuth(store))
  app.use('/api', observerRouteGuard(store))
  app.use('/api', objectAccessRouter(store))
  app.use('/api', deliveryRouter(store))
  app.use('/api', carryWorkflowRouter(store))
  app.use('/api', periodReviewRouter(store))
  app.use('/api', workspaceQueryRouter(store))
  const taskViews = new TaskViewService(store), myActions = new MyActionsService(store)
  app.get('/api/tasks/:id/view', (req, res) => res.json(taskViews.view(req.user, String(req.params.id), { section: req.query.section, weeklyRecordId: req.query.weeklyRecordId })))
  app.get('/api/tasks/:id/history', (req, res) => res.json(taskViews.history(req.user, String(req.params.id), { cursor: req.query.cursor, limit: req.query.limit })))
  app.get('/api/tasks/:id/editable', (req, res) => res.json(taskViews.editableTask(req.user, String(req.params.id))))
  app.get('/api/weekly-records/:id/editable', (req, res) => res.json(taskViews.editableWeekly(req.user, String(req.params.id))))
  app.get('/api/my-actions', (req, res) => res.json(myActions.list(req.user, { kind: req.query.kind, cursor: req.query.cursor, limit: req.query.limit })))
  app.get('/api/auth/me', (req, res) => res.json(req.user))
  app.post('/api/auth/logout', (req, res) => { clearSession(store, req.headers.cookie, res); res.json({ ok: true }) })
  app.get('/api/bootstrap', (req, res) => res.json(domain.bootstrap(req.user)))
  app.use('/api', createWeeklySubmissionRouter(store))
  app.use('/api', notificationRouter(store, dingtalk))
  app.use('/api', collaborationRouter(store))
  app.use('/api', notificationDiagnosticsRouter(store, dingtalk))
  app.use('/api', nativeRouter(store, options.nativeClient))
  app.use('/api', workRegisterRouter(store))
  app.use('/api', feedbackRouter(store))

  const create = (handler: (actor: User, input: Record<string, unknown>) => unknown): RequestHandler => (req, res) => { res.status(201).json(handler(req.user, req.body)) }
  const mutate = (handler: (actor: User, id: string, input: Record<string, unknown>) => unknown): RequestHandler => (req, res) => { res.json(handler(req.user, String(req.params.id), req.body)) }
  app.post('/api/users', create(domain.createUser))
  app.patch('/api/users/:id', mutate(domain.updateUser))
  app.get('/api/users/:id/deletion-preview', (req, res) => res.json(domain.userDeletionPreview(req.user, String(req.params.id))))
  app.delete('/api/users/:id', mutate(domain.deleteUser))
  app.post('/api/users/:id/registration-review', mutate(domain.reviewRegistration))
  app.post('/api/projects', create(domain.createProject))
  app.patch('/api/projects/:id', mutate(domain.updateProject))
  app.post('/api/annual-goals', create(domain.createAnnualGoal))
  app.patch('/api/annual-goals/:id', mutate(domain.updateAnnualGoal))
  app.post('/api/plans', create(domain.createPlan))
  app.post('/api/plans/merge', create(domain.mergePlans))
  app.patch('/api/plans/:id', mutate(domain.updatePlan))
  app.post('/api/plans/:id/submit', mutate(domain.submitPlan))
  app.post('/api/plans/:id/review', mutate(domain.reviewPlan))
  app.post('/api/months/:month/publish', (req, res) => res.json(domain.publishMonth(req.user, String(req.params.month), req.body)))
  app.post('/api/plans/:id/result', mutate(domain.planResult))
  app.get('/api/plans/:id/history', (req, res) => res.json(domain.planHistory(req.user, String(req.params.id))))
  app.post('/api/plans/:id/carry', (req, res) => res.json(domain.carryPlan(req.user, String(req.params.id), {
    ...req.body, operationEpoch: req.get('X-Operation-Epoch'),
  })))
  app.post('/api/tasks', create(domain.createTask))
  app.patch('/api/tasks/:id', mutate(domain.updateTask))
  app.post('/api/tasks/:id/cancel', mutate(domain.cancelTask))
  app.post('/api/tasks/:id/relink', mutate(domain.relinkTask))
  app.post('/api/weekly-records', create(domain.createWeeklyRecord))
  app.post('/api/weekly-assignments', create(domain.createWeeklyAssignment))
  app.patch('/api/weekly-records/:id', mutate(domain.updateWeeklyRecord))
  app.delete('/api/weekly-records/:id', mutate(domain.deleteWeeklyRecord))
  app.post('/api/weekly-records/:id/carry', mutate(domain.carryWeeklyRecord))
  app.use('/api', createReportRouter(store))
  app.use('/api', createReportAgentRouter(store))
  app.use('/api', createImportRouter(store), createAiSettingsRouter(store), createDataRouter(store))
  app.use('/api', (_req, _res, next) => next(new HttpError(404, '接口不存在')))

  const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../dist')
  if (existsSync(resolve(dist, 'index.html'))) {
    app.use(express.static(dist, { index: false, maxAge: 0 }))
    app.use((req, res, next) => req.method === 'GET' && req.accepts('html') ? res.sendFile(resolve(dist, 'index.html')) : next())
  }
  const errors: ErrorRequestHandler = (error, req, res, next) => {
    if (res.headersSent) return next(error)
    const status = Number.isInteger(error?.status) && error.status >= 400 && error.status < 600 ? error.status : 500
    const requestId = res.locals.requestId || randomUUID()
    res.set('X-Request-Id', requestId)
    if (status >= 500) console.error(JSON.stringify({ event: 'api_error', requestId, status, method: req.method,
      route: typeof req.route?.path === 'string' ? req.route.path : '/api',
      errorType: error instanceof Error ? error.name : 'Error',
      frames: error instanceof Error ? error.stack?.split('\n').slice(error.message.split('\n').length).filter(frame => /^\s+at\s/.test(frame)).slice(0, 6) : undefined }))
    if (status === 503) res.set('Retry-After', '1')
    const message = error?.type === 'entity.parse.failed' ? 'JSON 格式无效，请检查请求内容' : error?.type === 'entity.too.large' ? '请求内容超过大小限制' : status === 500 ? '服务暂时无法处理请求，请稍后重试' : error.message ?? '请求失败'
    res.status(status).json({ error: message, requestId,
      ...(error instanceof HttpError && error.code ? { code: error.code } : {}),
      ...(error instanceof HttpError && error.fieldErrors ? { fieldErrors: error.fieldErrors } : {}),
    })
  }
  app.use(errors)
  return app
}
