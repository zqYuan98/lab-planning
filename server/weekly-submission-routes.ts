import { Router } from 'express'
import { Store } from './store.ts'
import { WeeklySubmissionService } from './weekly-submissions.ts'
import { shanghaiWeek } from './weekly-submission-clock.ts'

export function createWeeklySubmissionRouter(store: Store) {
  const router = Router(), service = new WeeklySubmissionService(store)
  router.get('/weekly-submissions', (req, res) => res.json(service.view(req.user, req.query.week ?? shanghaiWeek(new Date()))))
  router.put('/weekly-submissions/rule', (req, res) => res.json(service.updateRule(req.user, req.body)))
  router.post('/weekly-submissions/submit', (req, res) => res.json(service.submit(req.user, req.body)))
  router.post('/weekly-submissions/adjust', (req, res) => res.json(service.adjust(req.user, req.body)))
  router.post('/weekly-submissions/roster', (req, res) => res.json(service.confirmRoster(req.user, req.body)))
  return router
}
