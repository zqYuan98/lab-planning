import { Router } from 'express'
import type { Store } from './store.ts'
import { PeriodReviewService } from './period-reviews.ts'

export function periodReviewRouter(store: Store) {
  const router = Router(), service = new PeriodReviewService(store)
  router.get('/period-reviews', (req, res) => res.json({ items: service.list(req.user) }))
  router.post('/period-reviews/preview', (req, res) => { const preview = service.preview(req.user, req.body); res.json({ ...preview, displayReferences: service.displayReferences(req.user, preview) }) })
  router.post('/period-reviews', (req, res) => res.status(201).json(service.create(req.user, req.body)))
  router.post('/period-reviews/evidence', (req, res) => res.status(201).json(service.addEvidence(req.user, req.body)))
  router.get('/period-reviews/:id/export', (req, res) => res.type('text/plain').attachment(`period-review-${String(req.params.id)}.txt`).send(service.export(req.user, String(req.params.id))))
  router.get('/period-reviews/:id/display-references', (req, res) => res.json(service.displayReferences(req.user, service.read(req.user, String(req.params.id)))))
  router.get('/period-reviews/:id', (req, res) => res.json(service.read(req.user, String(req.params.id))))
  router.post('/period-reviews/:id/finalize', (req, res) => res.json(service.finalize(req.user, String(req.params.id), req.body)))
  return router
}
