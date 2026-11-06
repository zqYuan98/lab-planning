import { Router } from 'express'
import { requireManager } from './authorization.ts'
import type { DingTalkMonthlyImportService } from './dingtalk-monthly-import.ts'

export function createDingTalkMonthlyRouter(service: DingTalkMonthlyImportService) {
  const router = Router()
  router.use('/dingtalk-documents', requireManager)
  router.get('/dingtalk-documents/status', (req, res) => res.json(service.status(req.user)))
  router.post('/dingtalk-documents/discover', async (req, res) => res.json(await service.discover(req.user, req.body)))
  router.post('/dingtalk-documents/fetch', async (req, res) => res.status(201).json(await service.fetch(req.user, req.body)))
  router.get('/dingtalk-documents/batches/:id', (req, res) => res.json(service.review(req.user, String(req.params.id))))
  router.post('/dingtalk-documents/batches/:id/resolve', (req, res) => res.json(service.resolve(req.user, String(req.params.id), req.body)))
  router.post('/dingtalk-documents/batches/:id/commit', async (req, res) => res.json(await service.commit(req.user, String(req.params.id), req.body)))
  return router
}
