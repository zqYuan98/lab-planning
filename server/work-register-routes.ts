import { Router } from 'express'
import { WorkService } from './domain-work.ts'
import type { Store } from './store.ts'

/** Mount behind the application's existing authentication middleware. */
export function workRegisterRouter(store: Store) {
  const router = Router(), service = new WorkService(store)
  router.post('/work-register/capture', (req, res) => res.status(201).json(service.captureTasks(req.user, req.body)))
  return router
}
