import { Router } from 'express'
import type { Store } from './store.ts'
import { TaskDeliveryService } from './task-deliveries.ts'
import { TaskSupportService } from './task-support.ts'

export function deliveryRouter(store: Store) {
  const router = Router(), deliveries = new TaskDeliveryService(store), support = new TaskSupportService(store)
  router.get('/tasks/:id/deliveries', (req, res) => res.json(deliveries.list(req.user, String(req.params.id))))
  router.get('/delivery-series/:id/history', (req, res) => res.json(deliveries.history(req.user, String(req.params.id), { cursor: req.query.cursor ? String(req.query.cursor) : undefined, limit: req.query.limit ? Number(req.query.limit) : undefined })))
  router.post('/tasks/:id/deliveries', (req, res) => res.status(201).json(deliveries.submit(req.user, String(req.params.id), req.body)))
  router.post('/deliveries/:id/decisions', (req, res) => res.json(deliveries.decide(req.user, String(req.params.id), req.body)))
  router.post('/delivery-series/:id/reassign', (req, res) => res.json(deliveries.reassign(req.user, String(req.params.id), req.body)))
  router.get('/tasks/:id/support', (req, res) => res.json(support.taskView(req.user, String(req.params.id))))
  router.get('/blockers/:id', (req, res) => res.json(support.blockerView(req.user, String(req.params.id))))
  router.post('/tasks/:id/blockers', (req, res) => res.status(201).json(support.enrollBlocker(req.user, String(req.params.id), req.body)))
  router.post('/blockers/:id/assign', (req, res) => res.json(support.assignBlocker(req.user, String(req.params.id), req.body)))
  // /blockers/:id/handle remains in collaborationRouter as a compatibility adapter.
  router.get('/decision-requests/:id', (req, res) => res.json(support.decisionView(req.user, String(req.params.id))))
  router.post('/decision-requests', (req, res) => res.status(201).json(support.createDecision(req.user, req.body)))
  router.post('/decision-requests/:id/decide', (req, res) => res.json(support.decideDecision(req.user, String(req.params.id), req.body)))
  router.post('/decision-requests/:id/reassign', (req, res) => res.json(support.reassignDecision(req.user, String(req.params.id), req.body)))
  router.post('/decision-requests/:id/cancel', (req, res) => res.json(support.cancelDecision(req.user, String(req.params.id), req.body)))
  router.post('/decision-requests/:id/reopen', (req, res) => res.json(support.reopenDecision(req.user, String(req.params.id), req.body)))
  return router
}
