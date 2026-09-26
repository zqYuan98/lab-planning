import { Router } from 'express'
import { Store, HttpError } from './store.ts'
import { readImportContext } from './import-context.ts'
import { ImportService } from './import-service.ts'
import { requireManager } from './authorization.ts'
import { readAiSettings, updateAiSettings, testAiConnection } from './ai-service.ts'
import { listIntegrationTokens, createIntegrationToken, revokeIntegrationToken, assertIntegrationTokenActive } from './integration-auth.ts'
import type { ImportBatch } from '../shared/import-types.ts'
const services = new WeakMap<Store, ImportService>()
export function closeImportServices(store: Store) { services.get(store)?.close() }

export function createImportRouter(store: Store) {
  const router = Router()
  let service = services.get(store)
  if (!service) { service = new ImportService(store); services.set(store, service) }
  const imports = service
  router.get('/imports', (req, res) => res.json(service.list(req.user)))
  router.get('/imports/history', (req, res) => res.json(service.history(req.user)))
  router.patch('/imports/history/:id', (req, res) => res.json(imports.editHistory(req.user, String(req.params.id), req.body)))
  router.delete('/imports/history/:id', (req, res) => res.json(imports.deleteHistory(req.user, String(req.params.id), req.body)))
  router.post('/imports/structured', (req, res) => res.status(201).json(service.structured(req.user, req.body)))
  router.post('/imports', async (req, res) => res.status(201).json(await service.upload(req.user, req.body)))
  router.get('/imports/:id', (req, res) => res.json(service.get(req.user, String(req.params.id))))
  router.get('/imports/:id/source-preview', (req, res) => res.json(imports.sourcePreview(req.user, String(req.params.id))))
  router.patch('/imports/:id', (req, res) => res.json(service.edit(req.user, String(req.params.id), req.body)))
  router.delete('/imports/:id', (req, res) => res.json(imports.deleteBatch(req.user, String(req.params.id), req.body)))
  router.post('/imports/:id/analyze', (req, res) => {
    const tokenId = req.integrationToken?.id
    res.status(202).json(imports.startAnalysis(req.user, String(req.params.id), req.body, tokenId ? () => assertIntegrationTokenActive(store, tokenId, 'imports:write') : undefined))
  })
  router.post('/imports/:id/commit', (req, res) => res.json(service.commit(req.user, String(req.params.id), req.body)))
  router.post('/imports/:id/request-confirmation', (req, res) => res.json(service.requestConfirmation(req.user, String(req.params.id), req.body)))
  router.post('/imports/:id/fork', (req, res) => {
    const before = service.get(req.user, String(req.params.id))
    const available = service.list(req.user).find(b => b.sourceId === before.sourceId && b.status === 'uploaded' && b.ownerId === req.user.id)
    if (available) return res.json(service.get(req.user, available.id))
    res.status(201).json(store.insert<ImportBatch>('importBatches', { ownerId: req.user.id, sourceId: before.sourceId, fileName: before.fileName, kind: before.kind, status: 'uploaded', sourceSheets: before.sourceSheets, warnings: [], rows: [], mode: before.mode, requiresCompletionReview: before.requiresCompletionReview, analysisOptions: before.analysisOptions }))
  })
  router.get('/imports/:id/source', (req, res) => {
    const source = service.source(req.user, String(req.params.id))
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(source.fileName)}` }).send(Buffer.from(source.base64, 'base64'))
  })
  router.get('/schema', (_req, res) => res.json({ formatVersion: 1, structuredEndpoint: '/api/v1/imports/structured', required: ['sourceKey', 'rows'], kinds: ['monthly', 'weekly'], modes: ['history', 'draft', 'existing'], rowFields: ['kind', 'sourceRow', 'sourceSheet', 'sourceText', 'title', 'ownerName', 'ownerId', 'projectName', 'projectId', 'category', 'month', 'weekStart', 'dueDate', 'expectedOutcome', 'acceptanceCriteria', 'actualOutcome', 'blocker', 'nextAction', 'sourceStatus', 'monthlyPlanId', 'taskId', 'linkedRowId', 'monthlyResult', 'weeklyStatus', 'isTemporary', 'temporaryReason', 'selected', 'exclusionReason', 'exclusionKind', 'collaboratorNames', 'collaboratorIds', 'workSource', 'assignedBy', 'assignedOn', 'taskCompleted', 'completionNote'], workflow: 'structured/upload -> analyze (files only) -> edit -> commit; 文件通过source-preview核对原文，edit可追加id以new:开头且带原文的补录行，并提交completionReview:{confirmed:true,sourceItemCount}。原文数量包括未选任务，不含有理由排除的duplicate/not_task；文件提交前须有效核对，结构化来源兼容原API。未选行需exclusionReason。kind为monthly/weekly，临时属性由isTemporary与temporaryReason独立表达；history仅归档，可保留原因缺项；临时事项纳入draft/existing计划时必须填写原因，临时周任务不能同时关联月目标。draft遵循新增计划规则，成员可创建本人临时月目标草稿；existing仍由管理者确认直接生效，其他原表缺项可空。成员可request-confirmation请求管理员接续核对；同来源草稿转生效复用原ID，提交可安全重试。协作人用于月目标；workSource独立于临时性质；周完成不代表整个任务结束，taskCompleted需人工确认和completionNote' }))
  router.get('/context', (req, res) => res.json(readImportContext(store, req.user)))
  return router
}
export function createAiSettingsRouter(store: Store) {
  const router = Router()
  router.get('/ai/status', (_req, res) => res.json({ configured: readAiSettings(store).configured }))
  router.get('/ai/settings', requireManager, (_req, res) => res.json(readAiSettings(store)))
  router.put('/ai/settings', requireManager, (req, res) => res.json(updateAiSettings(store, req.user, req.body)))
  router.post('/ai/test', requireManager, async (req, res) => res.json(await testAiConnection(store, req.user)))
  router.get('/integration-tokens', requireManager, (req, res) => res.json(listIntegrationTokens(store, req.user)))
  router.post('/integration-tokens', requireManager, (req, res) => res.status(201).json(createIntegrationToken(store, req.user, req.body)))
  router.post('/integration-tokens/:id/revoke', requireManager, (req, res) => res.json(revokeIntegrationToken(store, req.user, String(req.params.id))))
  return router
}
