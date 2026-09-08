import { Router, type Request } from 'express'
import type { Report, User } from '../shared/types.ts'
import type { Store } from './store.ts'
import { editReport, exportMarkdown, exportWord, finalizeReport, generateReport, polishReport, requireReportManager } from './reports.ts'
import { getReportSchedule, updateReportSchedule } from './scheduler.ts'

function actorId(req: Request) { return (req as Request & { user?: User }).user?.id || '' }
export function createReportRouter(store: Store) {
  const router = Router()
  router.use(['/reports', '/report-schedule'], (req, _res, next) => { try { requireReportManager(store, actorId(req)); next() } catch (error) { next(error) } })
  router.get('/reports', (_req, res) => res.json(store.list<Report>('reports').sort((a, b) => b.createdAt.localeCompare(a.createdAt))))
  router.post('/reports', (req, res) => res.status(201).json(generateReport(store, req.body.type, req.body.period, actorId(req))))
  router.patch('/reports/:id', (req, res) => res.json(editReport(store, String(req.params.id), req.body.version, actorId(req), req.body.narrative, req.body.title)))
  router.post('/reports/:id/finalize', (req, res) => res.json(finalizeReport(store, String(req.params.id), req.body.version, actorId(req))))
  router.post('/reports/:id/polish', async (req, res) => res.json(await polishReport(store, String(req.params.id), req.body.version, actorId(req))))
  router.get('/reports/:id/export', async (req, res) => {
    const report = store.get<Report>('reports', String(req.params.id))
    if (!report) return res.status(404).json({ error: '报告不存在。' })
    const format = req.query.format || 'docx'
    if (format !== 'md' && format !== 'docx') return res.status(400).json({ error: '仅支持 Markdown 或 Word 格式。' })
    const fileName = `${report.type === 'weekly' ? '人工智能实验室周报' : '人工智能实验室月报'}_${report.period}_v${report.revision}.${format}`
    res.setHeader('Content-Disposition', `attachment; filename="report-${report.period}.${format}"; filename*=UTF-8''${encodeURIComponent(fileName)}`)
    res.type(format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'text/markdown; charset=utf-8')
    res.send(format === 'docx' ? await exportWord(report) : exportMarkdown(report))
  })
  router.get('/report-schedule', (_req, res) => res.json(getReportSchedule(store)))
  router.put('/report-schedule', (req, res) => res.json(updateReportSchedule(store, req.body)))
  return router
}
