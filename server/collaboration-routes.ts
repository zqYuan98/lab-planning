import { Router } from 'express'
import type { DeadlineChangeRequest, FollowupRequest, TaskTracking } from '../shared/collaboration.ts'
import type { CollaborationPreference, DigestItem, NotificationDigest } from '../shared/collaboration-notifications.ts'
import type { Entity, Task, User, WeeklyRecord } from '../shared/types.ts'
import { summarizeCollaborationTask } from '../shared/collaboration-task-summary.ts'
import { HttpError, type Store } from './store.ts'
import { requireManager } from './auth.ts'
import { CollaborationService, readCollaborationSettings } from './collaboration-service.ts'
import { collaborationCommand } from './collaboration-store.ts'
import { defaultFollowupDueAt, effectiveManagerIds } from './collaboration-policy.ts'
import { risksForActor, automaticRiskCandidates } from './collaboration-rules.ts'
import { visibleDigestItems } from './collaboration-content.ts'
import { notificationId } from './notifications.ts'
import { withCollaborationPublicationDeferred } from './collaboration-notifications.ts'
import { shanghaiDate } from './collaboration-calendar.ts'

export function collaborationRouter(store: Store) {
  const router = Router(), service = new CollaborationService(store)
  router.get('/collaboration', (req, res) => {
    const settings = readCollaborationSettings(store)
    const tasks = store.list<Task>('tasks').filter(task => req.user.role === 'manager' || task.ownerId === req.user.id)
    const followups = store.list<FollowupRequest>('followupRequests')
    const now = new Date(), weeklyByTask = new Map<string, WeeklyRecord[]>()
    for (const record of store.list<WeeklyRecord>('weeklyRecords')) {
      const records = weeklyByTask.get(record.taskId) ?? []
      records.push(record); weeklyByTask.set(record.taskId, records)
    }
    res.json({ settings, preference: store.get<CollaborationPreference>('collaborationPreferences', req.user.id) ?? { version: 0, memberActionsEnabled: true }, tasks: tasks.map(task => ({ task, tracking: store.get<TaskTracking>('taskTrackings', task.id) ?? null,
      openFollowup: followups.find(row => row.taskId === task.id && row.status === 'open') ?? null,
      ...summarizeCollaborationTask(task, weeklyByTask.get(task.id) ?? [], req.user, now) })), risks: risksForActor(store, req.user),
      digests: store.list<NotificationDigest>('notificationDigests').filter(row => row.recipientId === req.user.id).slice(-50).reverse() })
  })
  router.put('/collaboration/preferences', (req, res) => res.json(collaborationCommand(store, req.user, 'preferences', req.body, new Date(), () => {
    const old = store.get<CollaborationPreference>('collaborationPreferences', req.user.id)
    if (req.body.version !== (old?.version ?? 0)) throw new HttpError(409, '偏好已更新，请刷新')
    if (typeof req.body.memberActionsEnabled !== 'boolean') throw new HttpError(400, '请选择是否接收可选行动摘要')
    const patch = { userId: req.user.id, memberActionsEnabled: req.body.memberActionsEnabled }
    return old ? store.update<CollaborationPreference>('collaborationPreferences', old.id, old.version, patch) : store.insert<CollaborationPreference>('collaborationPreferences', { id: req.user.id, ...patch })
  })))
  router.get('/collaboration/tasks/:id', (req, res) => res.json(service.taskView(req.user, String(req.params.id))))
  router.get('/collaboration/resolve/:type/:id', (req, res) => {
    const { type, id } = req.params
    const taskId = type === 'task' ? String(id) : type === 'followup' ? store.get<FollowupRequest>('followupRequests', String(id))?.taskId
      : type === 'deadlineRequest' ? store.get<DeadlineChangeRequest>('deadlineChangeRequests', String(id))?.taskId : undefined
    if (!taskId) throw new HttpError(404, '工作事项不存在')
    service.taskView(req.user, taskId)
    res.json({ taskId })
  })
  router.get('/tasks/:id/tracking-preview', requireManager, (req, res) => res.json(service.previewTracking(req.user, String(req.params.id))))
  router.get('/work-risks', (req, res) => res.json({ items: risksForActor(store, req.user) }))
  router.get('/digests/:id', (req, res) => {
    const digest = store.get<NotificationDigest>('notificationDigests', String(req.params.id))
    if (!digest || digest.recipientId !== req.user.id) throw new HttpError(404, '摘要不存在')
    res.json({ ...digest, items: visibleDigestItems(store, req.user, digest) })
  })
  router.get('/collaboration/settings', requireManager, (_req, res) => res.json(readCollaborationSettings(store)))
  router.put('/collaboration/settings', requireManager, (req, res) => res.json(service.updateSettings(req.user, req.body)))
  router.get('/collaboration/rules-preview', requireManager, (req, res) => {
    const now = req.query.at ? new Date(String(req.query.at)) : new Date()
    if (!Number.isFinite(now.getTime())) throw new HttpError(400, '预览时间无效')
    const risks = risksForActor(store, req.user, now), candidates = automaticRiskCandidates(store, now)
    res.json({ generatedAt: now.toISOString(), risks, slot: candidates?.slot ?? null, automaticCandidates: candidates?.risks ?? [],
      recipientCount: new Set(risks.flatMap(risk => risk.managerOnly ? risk.managerIds : [risk.ownerId])).size, readonly: true })
  })
  router.post('/tasks/:id/progress', (req, res) => res.json(service.recordProgress(req.user, String(req.params.id), req.body)))
  router.post('/tasks/:id/followups', requireManager, (req, res) => res.status(201).json(service.createFollowup(req.user, String(req.params.id), req.body)))
  router.put('/followups/:id', requireManager, (req, res) => res.json(service.updateFollowup(req.user, String(req.params.id), req.body)))
  router.post('/followups/:id/respond', (req, res) => res.json(service.respondFollowup(req.user, String(req.params.id), req.body)))
  router.post('/followups/:id/close', requireManager, (req, res) => res.json(service.closeFollowup(req.user, String(req.params.id), req.body)))
  router.put('/tasks/:id/tracking', requireManager, (req, res) => res.json(service.updateTracking(req.user, String(req.params.id), req.body)))
  router.post('/tasks/:id/deadline-requests', (req, res) => res.status(201).json(service.requestDeadline(req.user, String(req.params.id), req.body)))
  router.post('/deadline-requests/:id/decide', requireManager, (req, res) => res.json(service.decideDeadline(req.user, String(req.params.id), req.body)))
  router.post('/blockers/:id/handle', requireManager, (req, res) => res.json(service.handleBlocker(req.user, String(req.params.id), req.body)))

  const preview = (actor: User, body: Record<string, unknown>) => {
    if (!Array.isArray(body.taskIds) || !body.taskIds.length || body.taskIds.length > 100 || body.taskIds.some(id => typeof id !== 'string') || new Set(body.taskIds).size !== body.taskIds.length) throw new HttpError(400, '请选择 1 至 100 项不同任务')
    if (typeof body.requirement !== 'string' || !body.requirement.trim() || body.requirement.length > 12000) throw new HttpError(400, '请填写有效的更新要求')
    const parsedDue = body.dueAt ? new Date(String(body.dueAt)) : null
    if (parsedDue && !Number.isFinite(parsedDue.getTime())) throw new HttpError(400, '回应期限无效')
    const dueAt = parsedDue ? parsedDue.toISOString() : defaultFollowupDueAt(store, new Date())
    if (dueAt <= new Date().toISOString()) throw new HttpError(400, '回应期限必须在未来')
    const rows = (body.taskIds as string[]).map(id => { const details = service.taskView(actor, id); return { ...details, preview: service.previewTracking(actor, id) } })
    if (rows.some(row => !row.preview.eligible)) throw new HttpError(409, '所选任务包含未启用、未生效或已完成事项，请重新核对')
    const normalized = { taskIds: [...body.taskIds].sort(), requirement: body.requirement.trim(), dueAt, enroll: body.enroll === true }
    const token = notificationId('followup-preview', actor.id, JSON.stringify(normalized), String(readCollaborationSettings(store).version), JSON.stringify(rows.map(row => [row.task.id, row.task.version, row.tracking?.version ?? 0, row.followups.filter(item => item.status === 'open').map(item => [item.id, item.version])]).sort()))
    const quotas = store.list<Entity & { day: string; recipientId: string; taskIds: string[] }>('followupNotificationQuotas').filter(row => row.day === shanghaiDate(new Date()))
    const recipients = [...new Set(rows.map(row => row.task.ownerId))].map(id => {
      const tasks = rows.filter(row => row.task.ownerId === id)
      const used = quotas.filter(row => row.recipientId === id)
      return { recipientId: id, recipientName: store.get<User>('users', id)?.name ?? '成员', externalQuotaAvailable: used.length < 3 && tasks.every(row => !used.some(value => value.taskIds.includes(row.task.id))),
        items: tasks.map(row => ({ taskId: row.task.id, taskVersion: row.task.version, title: row.task.title, taskDueDate: row.task.dueDate,
          managerIds: row.effectiveManagerIds, enrollRequired: !row.tracking || row.tracking.state === 'closed', existingRequest: row.followups.find(item => item.status === 'open') ?? null })) }
    })
    return { ...normalized, previewToken: token, recipients, readonly: true }
  }
  router.post('/followups/preview', requireManager, (req, res) => res.json(preview(req.user, req.body)))
  router.post('/followups/batch', requireManager, (req, res) => res.json(withCollaborationPublicationDeferred(store, () =>
    collaborationCommand(store, req.user, 'followup-batch', req.body, new Date(), () => {
      const current = preview(req.user, req.body)
      if (req.body.previewToken !== current.previewToken) throw new HttpError(409, '事项已变化，请重新预览催办内容')
      const items = current.recipients.flatMap(recipient => recipient.items)
      if (items.some(item => item.enrollRequired) && !current.enroll) throw new HttpError(409, '请明确确认将所选未跟踪事项纳入督办')
      return { items: items.map(item => service.createFollowup(req.user, item.taskId, { requestId: notificationId(String(req.body.requestId), item.taskId), version: item.taskVersion,
        requirement: current.requirement, dueAt: current.dueAt, enroll: current.enroll })), recipientCount: current.recipients.length }
    }))))
  return router
}
