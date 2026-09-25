import { Router, type Request, type Response } from 'express'
import type { User } from '../shared/types.ts'
import type { ReportAgentDownload } from '../shared/report-agent.ts'
import { HttpError, type Store } from './store.ts'
import { reportTypeManaged } from './report-agent-policy.ts'
import { requireReportManager } from './reports.ts'
import {
  activateReportTemplate, archiveReportTemplate, createReportTemplate, downloadAgentReport, downloadReportAsset,
  editAgentReport, enqueueReportAgent, enqueueReportRewrite, enqueueTemplateLearning, finalizeAgentReport,
  getAgentReport, getReportAgentBootstrap, previewReportTemplate, updateReportTemplate, uploadReportAsset,
} from './report-agent-service.ts'
import { cancelReportAgentJob, getReportAgentJob, retryReportAgentJob } from './report-agent-jobs.ts'
import { getReportAgentSchedule, updateReportAgentSchedule } from './report-agent-schedule.ts'

const actor = (req: Request) => (req as Request & { user?: User }).user?.id ?? ''
function sendDocument(res: Response, result: ReportAgentDownload) {
  const name = result.filename.replace(/[\r\n]/g, '').slice(0, 240)
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'Content-Disposition': `attachment; filename="report.docx"; filename*=UTF-8''${encodeURIComponent(name)}`,
    'X-Content-SHA256': result.sha256,
    'Cache-Control': 'no-store',
  })
  res.send(result.bytes)
}

/** No integration-token route: templates, examples and all assets are manager-only. */
export function createReportAgentRouter(store: Store) {
  const router = Router()
  router.use('/report-agent', (req, _res, next) => {
    try { requireReportManager(store, actor(req)); next() } catch (error) { next(error) }
  })
  router.get('/report-agent', (req, res) => res.json(getReportAgentBootstrap(store, actor(req))))
  router.get('/report-agent/policy', (_req, res) => res.json({ managedTypes: ['weekly', 'monthly'].filter(type => reportTypeManaged(store, type as 'weekly' | 'monthly')) }))
  router.post('/report-agent/assets', async (req, res) => res.status(201).json(await uploadReportAsset(store, actor(req), req.body)))
  router.get('/report-agent/assets/:id/download', async (req, res) => sendDocument(res, await downloadReportAsset(store, actor(req), String(req.params.id))))
  router.post('/report-agent/templates', (req, res) => res.status(201).json(createReportTemplate(store, actor(req), req.body)))
  router.patch('/report-agent/templates/:id', (req, res) => res.json(updateReportTemplate(store, actor(req), String(req.params.id), req.body)))
  router.post('/report-agent/templates/:id/learn', (req, res) => res.status(202).json(enqueueTemplateLearning(store, actor(req), String(req.params.id), req.body)))
  router.post('/report-agent/templates/:id/preview', async (req, res) => res.json(await previewReportTemplate(store, actor(req), String(req.params.id), req.body.expectedVersion)))
  router.post('/report-agent/templates/:id/activate', (req, res) => res.json(activateReportTemplate(store, actor(req), String(req.params.id), req.body)))
  router.post('/report-agent/templates/:id/archive', (req, res) => res.json(archiveReportTemplate(store, actor(req), String(req.params.id), req.body.expectedVersion)))
  router.post('/report-agent/jobs', (req, res) => res.status(202).json(enqueueReportAgent(store, actor(req), req.body)))
  router.get('/report-agent/jobs/:id', (req, res) => res.json(getReportAgentJob(store, actor(req), String(req.params.id))))
  router.post('/report-agent/jobs/:id/cancel', (req, res) => res.json(cancelReportAgentJob(store, actor(req), String(req.params.id), req.body.expectedVersion)))
  router.post('/report-agent/jobs/:id/retry', (req, res) => res.json(retryReportAgentJob(store, actor(req), String(req.params.id), req.body.expectedVersion)))
  router.get('/report-agent/reports/:id', (req, res) => res.json(getAgentReport(store, actor(req), String(req.params.id))))
  router.patch('/report-agent/reports/:id', (req, res) => res.json(editAgentReport(store, actor(req), String(req.params.id), req.body)))
  router.post('/report-agent/reports/:id/rewrite', (req, res) => res.status(202).json(enqueueReportRewrite(store, actor(req), String(req.params.id), req.body)))
  router.post('/report-agent/reports/:id/finalize', async (req, res) => res.json(await finalizeAgentReport(store, actor(req), String(req.params.id), req.body)))
  router.get('/report-agent/reports/:id/docx', async (req, res) => {
    const rawVersion = req.query.expectedVersion
    if (rawVersion !== undefined && (typeof rawVersion !== 'string' || !/^[1-9]\d*$/.test(rawVersion) || !Number.isSafeInteger(Number(rawVersion)))) throw new HttpError(400, '报告版本号无效。')
    sendDocument(res, await downloadAgentReport(store, actor(req), String(req.params.id), rawVersion === undefined ? undefined : Number(rawVersion)))
  })
  router.get('/report-agent/schedule', (_req, res) => res.json(getReportAgentSchedule(store)))
  router.put('/report-agent/schedule', (req, res) => res.json(updateReportAgentSchedule(store, actor(req), req.body)))
  router.get('/report-agent/monthly-schedule', (_req, res) => res.json(getReportAgentSchedule(store, 'monthly')))
  router.put('/report-agent/monthly-schedule', (req, res) => res.json(updateReportAgentSchedule(store, actor(req), { ...req.body, type: 'monthly' })))
  return router
}
