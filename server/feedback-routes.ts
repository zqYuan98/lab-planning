import { Router } from 'express'
import type { FeedbackListQuery } from '../shared/feedback.ts'
import { HttpError, type Store } from './store.ts'
import { FeedbackService } from './feedback-service.ts'

export function feedbackRouter(store: Store) {
  const router = Router(), service = new FeedbackService(store)
  router.get('/feedback/meta', (req, res) => res.json(service.meta(req.user)))
  router.get('/feedback', (req, res) => {
    for (const value of Object.values(req.query)) if (typeof value !== 'string') throw new HttpError(400, '反馈查询参数无效')
    const query: FeedbackListQuery = { scope: req.query.scope as FeedbackListQuery['scope'], status: req.query.status as FeedbackListQuery['status'], assigneeId: req.query.assigneeId as string | undefined, cursor: req.query.cursor as string | undefined,
      ...(req.query.limit !== undefined ? { limit: Number(req.query.limit) } : {}) }
    res.json(service.list(req.user, query))
  })
  router.get('/feedback/:id', (req, res) => res.json(service.detail(req.user, String(req.params.id))))
  router.post('/feedback', (req, res) => res.status(201).json(service.create(req.user, req.body)))
  router.post('/feedback/:id/actions', (req, res) => res.json(service.action(req.user, String(req.params.id), req.body)))
  router.get('/feedback/:id/attachments/:attachmentId', (req, res) => {
    const attachment = service.attachment(req.user, String(req.params.id), String(req.params.attachmentId))
    res.set({ 'Content-Type': attachment.mimeType, 'Content-Disposition': `inline; filename="feedback-image"; filename*=UTF-8''${encodeURIComponent(attachment.name).replace(/'/g, '%27')}`,
      'Content-Length': String(attachment.size), 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, no-store', 'Content-Security-Policy': "default-src 'none'; sandbox" })
    res.send(Buffer.from(attachment.dataBase64, 'base64'))
  })
  return router
}
