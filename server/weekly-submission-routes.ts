import { Router } from 'express'
import { Store } from './store.ts'
import { WeeklySubmissionService } from './weekly-submissions.ts'
import { shanghaiWeek } from './weekly-submission-clock.ts'
import { WeeklyCalendarService } from './weekly-calendar-service.ts'
import { WeeklyReviewDelegationService } from './weekly-review-delegation.ts'

export function createWeeklySubmissionRouter(store: Store) {
  const router = Router(), service = new WeeklySubmissionService(store)
  const calendar = new WeeklyCalendarService(store)
  const delegation = new WeeklyReviewDelegationService(store)
  router.get('/weekly-review-delegation', (req, res) => res.json(delegation.settings(req.user)))
  router.put('/weekly-review-delegation', (req, res) => res.json(delegation.updateSettings(req.user, req.body)))
  router.get('/weekly-review-queue', (req, res) => res.json(delegation.queue(req.user, req.query.week ?? shanghaiWeek(new Date()), req.query.cursor)))
  router.get('/weekly-submissions', (req, res) => res.json(service.view(req.user, req.query.week ?? shanghaiWeek(new Date()))))
  router.put('/weekly-submissions/rule', (req, res) => res.json(service.updateRule(req.user, req.body)))
  router.put('/weekly-submissions/deadline-policy', (req, res) => res.json(calendar.updatePolicy(req.user, req.body)))
  router.post('/weekly-submissions/deadline-repair/preview', (req, res) => res.json(calendar.previewRepair(req.user, req.body)))
  router.post('/weekly-submissions/deadline-repair', (req, res) => res.json(calendar.repair(req.user, req.body)))
  router.post('/weekly-submissions/submit', (req, res) => res.json(service.submit(req.user, req.body)))
  router.post('/weekly-submissions/review', (req, res) => res.json(service.review(req.user, req.body)))
  router.post('/weekly-submissions/adjust', (req, res) => res.json(service.adjust(req.user, req.body)))
  router.post('/weekly-submissions/roster', (req, res) => res.json(service.confirmRoster(req.user, req.body)))
  return router
}
