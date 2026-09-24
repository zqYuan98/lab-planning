import { Router } from 'express'
import type { Store } from './store.ts'
import { CarryWorkflowService } from './carry-workflows.ts'

export function carryWorkflowRouter(store: Store) {
  const router = Router(), service = new CarryWorkflowService(store)
  const command = (req: { body: Record<string, unknown>; get: (name: string) => string | undefined }) => ({ ...req.body, operationEpoch: req.get('X-Operation-Epoch') })
  router.get('/carry-workflows', (req, res) => res.json(service.list(req.user, req.query)))
  router.post('/carry-workflows/preview', (req, res) => res.json(service.preview(req.user, req.body)))
  router.post('/carry-workflows', (req, res) => res.status(201).json(service.create(req.user, command(req))))
  router.get('/carry-workflows/:id', (req, res) => res.json(service.detail(req.user, String(req.params.id))))
  router.patch('/carry-workflows/:id', (req, res) => res.json(service.saveSelection(req.user, String(req.params.id), command(req))))
  router.post('/carry-workflows/:id/preview-apply', (req, res) => res.json(service.previewApply(req.user, String(req.params.id), req.body)))
  router.post('/carry-workflows/:id/apply', (req, res) => res.json(service.apply(req.user, String(req.params.id), command(req))))
  router.post('/carry-workflows/:id/cancel', (req, res) => res.json(service.cancel(req.user, String(req.params.id), command(req))))
  return router
}
