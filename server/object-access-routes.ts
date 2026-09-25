import { Router, type RequestHandler } from 'express'
import { HttpError, type Store } from './store.ts'
import { liveObjectActor, ObjectAccessService, projectObject } from './object-access.ts'
import { ObjectGrantService } from './object-grants.ts'

/** A deny-by-default fence around legacy routes, including exports and private attachments. */
export function observerRouteGuard(store: Store): RequestHandler {
  return (req, _res, next) => {
    try {
      req.user = liveObjectActor(store, req.user)
      if (req.user.role !== 'observer') return next()
      const path = req.path.toLowerCase().replace(/\/+$/, '')
      if (req.method === 'POST' && path === '/auth/logout') return next()
      if (['GET', 'HEAD'].includes(req.method) && (/^\/(?:auth\/me|workspace|my-actions|authorized-work(?:\/[^/]+)?|tasks\/[^/]+\/(?:view|history)|scoped-reports\/[^/]+(?:\/export)?)$/.test(path))) return next()
      return next(new HttpError(['GET', 'HEAD'].includes(req.method) ? 404 : 403, '观察者仅能读取明确授权的内容', 'READ_ONLY_OBSERVER'))
    } catch (error) { next(error) }
  }
}
export function objectAccessRouter(store: Store) {
  const router = Router(), access = new ObjectAccessService(store), grants = new ObjectGrantService(store)
  router.get('/object-grants', (req, res) => res.json(grants.list(req.user)))
  router.post('/object-grants', (req, res) => res.status(201).json(grants.grant(req.user, req.body)))
  router.post('/object-grants/:id/revoke', (req, res) => res.json(grants.revoke(req.user, String(req.params.id), req.body)))
  router.get('/authorized-work', (req, res) => res.json(access.list(req.user)))
  router.get('/authorized-work/:id', (req, res) => res.json(access.detail(req.user, String(req.params.id))))
  router.post('/scoped-reports', (req, res) => res.status(201).json(grants.createReport(req.user, req.body)))
  router.get('/scoped-reports', (req, res) => res.json(grants.listReports(req.user)))
  router.get('/scoped-reports/:id', (req, res) => res.json(projectObject(store, req.user, 'scoped_report', String(req.params.id))))
  router.get('/scoped-reports/:id/export', (req, res) => {
    const report = grants.exportReport(req.user, String(req.params.id))
    res.set('Content-Disposition', `attachment; filename="scoped-report-${String(req.params.id).replace(/[^a-zA-Z0-9_-]/g, '')}.txt"`).type('text/plain').send(`${report.title}\n\n${report.narrative}\n\nSHA-256: ${report.hash}`)
  })
  return router
}
