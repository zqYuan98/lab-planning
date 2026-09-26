import { Router } from 'express'
import { Store, HttpError } from './store.ts'
import { requireManager } from './authorization.ts'
import { exportBusinessData, exportCsv, exportXlsx, previewRestore, restoreBusinessData, type TransferType } from './data-transfer.ts'

export function createDataRouter(store: Store, readOnly = false) {
  const router = Router()
  router.get('/data/export', async (req, res) => {
    const type = String(req.query.type ?? 'all') as TransferType
    const format = String(req.query.format ?? 'xlsx')
    if (!['json', 'csv', 'xlsx'].includes(format)) throw new HttpError(400, '请选择 JSON、CSV 或 Excel 格式')
    const packet = exportBusinessData(store, req.user, { type, month: req.query.month === undefined ? undefined : String(req.query.month), ownerId: req.query.ownerId === undefined ? undefined : String(req.query.ownerId), projectId: req.query.projectId === undefined ? undefined : String(req.query.projectId) })
    const name = `lab-planning-${type}-${new Date().toISOString().slice(0, 10)}.${format}`
    res.set('Content-Disposition', `attachment; filename="${name}"`)
    if (format === 'json') return res.type('application/json').send(JSON.stringify(packet, null, 2))
    if (format === 'csv') return res.type('text/csv; charset=utf-8').send(exportCsv(packet, type))
    res.type('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet').send(await exportXlsx(packet))
  })
  if (!readOnly) {
    router.post('/data/restore/preview', requireManager, (req, res) => res.json(previewRestore(store, req.user, req.body.packet, req.body.mapping)))
    router.post('/data/restore/commit', requireManager, (req, res) => res.json(restoreBusinessData(store, req.user, req.body.packet, req.body.mapping, req.body.fingerprint)))
  }
  return router
}
