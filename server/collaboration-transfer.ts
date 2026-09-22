import { z } from 'zod'
import type { BlockerAction, BlockerEpisode, DeadlineChangeRequest, FollowupRequest, FollowupResponse, ProgressEvent, TaskTracking } from '../shared/collaboration.ts'
import type { Entity, Task } from '../shared/types.ts'
import type { BusinessCollections, DataReference, TransferCollection } from './data-transfer-schema.ts'

export const collaborationCollectionNames = ['taskTrackings', 'progressEvents', 'followupRequests', 'followupResponses', 'blockerEpisodes', 'blockerActions', 'deadlineChangeRequests'] as const
export interface CollaborationCollections {
  taskTrackings: TaskTracking[]; progressEvents: ProgressEvent[]; followupRequests: FollowupRequest[];
  followupResponses: FollowupResponse[]; blockerEpisodes: BlockerEpisode[]; blockerActions: BlockerAction[]; deadlineChangeRequests: DeadlineChangeRequest[]
}
const id = z.string().min(1).max(200), line = z.string().max(12000), integer = z.number().int().positive()
const time = z.string().max(40).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value)
const entity = { id, version: integer, createdAt: time, updatedAt: time }
const managers = z.array(id).max(3), taskOwner = { taskId: id, ownerId: id }
export const collaborationSchemas = {
  taskTrackings: z.object({ ...entity, ...taskOwner, generation: integer, state: z.enum(['active', 'paused', 'closed']), enrolledAt: time, activeFrom: time, reminderBaselineAt: time,
    enrolledBy: id, source: z.enum(['assignment', 'manual', 'restore']), managerRecipientIds: managers, ruleVersion: integer, dueDateVersion: integer, currentDueDate: z.union([day, z.literal('')]),
    lastMeaningfulOwnerProgressAt: time.nullable(), lastRecordedProgressAt: time.nullable(), pauseReason: line, reviewAt: time.nullable(), closedAt: time.nullable(), closedReason: line }).strict(),
  progressEvents: z.object({ ...entity, ...taskOwner, mutationId: id, weeklyRecordId: id.nullable(), actorId: id, source: z.enum(['task', 'weeklyRecord', 'progress', 'followup']),
    noteType: z.enum(['progress', 'no_change']), note: line, noChangeReason: line, nextAction: line, proxyReason: line,
    changes: z.array(z.object({ field: z.enum(['task.status', 'task.currentProgress', 'task.completionNote', 'task.evidenceUrl', 'task.blockerReason', 'task.blockerImpact', 'task.supportNeeded', 'task.nextAction', 'weeklyRecord.status', 'weeklyRecord.actualOutcome', 'weeklyRecord.evidenceUrl', 'weeklyRecord.blocker', 'weeklyRecord.blockerImpact', 'weeklyRecord.supportNeeded', 'weeklyRecord.nextAction']), before: line, after: line }).strict()).max(30), meaningfulOwnerProgress: z.boolean(), occurredAt: time, auditEventIds: z.array(id).max(30) }).strict(),
  followupRequests: z.object({ ...entity, ...taskOwner, weeklyRecordId: id.nullable(), requestedBy: id, managerRecipientIds: managers, generation: integer, requirement: line.min(1), dueAt: time,
    status: z.enum(['open', 'responded', 'cancelled', 'superseded']), respondedAt: time.nullable(), closedAt: time.nullable(), closedBy: id.nullable(), closeReason: line, lastChangedBy: id, changeReason: line }).strict(),
  followupResponses: z.object({ ...entity, ...taskOwner, followupRequestId: id, requestVersion: integer, weeklyRecordId: id.nullable(), actorId: id, progressEventId: id, respondedAt: time, dueAt: time, late: z.boolean(), mutationId: id }).strict(),
  blockerEpisodes: z.object({ ...entity, sourceType: z.enum(['task', 'weeklyRecord']), sourceId: id, parentTaskId: id, ownerId: id, generation: z.number().int().nonnegative(), openedAt: time, openedBy: id,
    resolvedAt: time.nullable(), resolvedBy: id.nullable(), reason: line, impact: line, supportNeeded: line, reviewAt: time.nullable(), closureReason: line, managementClosedAt: time.nullable().optional(), managementNote: line.optional() }).strict(),
  blockerActions: z.object({ ...entity, ...taskOwner, episodeId: id, actorId: id, action: z.enum(['record', 'defer', 'close']), note: line.min(1), reviewAt: time.nullable(), occurredAt: time }).strict(),
  deadlineChangeRequests: z.object({ ...entity, ...taskOwner, requestedBy: id, generation: integer, dueDateVersion: integer, originalDueDate: z.union([day, z.literal('')]), requestedDueDate: day,
    reason: line.min(1), status: z.enum(['open', 'approved', 'returned', 'cancelled', 'superseded']), decidedBy: id.nullable(), decidedAt: time.nullable(), decisionNote: line }).strict(),
}
export const collaborationCollectionsShape = Object.fromEntries(collaborationCollectionNames.map(name => [name, z.array(collaborationSchemas[name]).max(50000)])) as { [K in keyof typeof collaborationSchemas]: z.ZodArray<typeof collaborationSchemas[K]> }
export const emptyCollaborationCollectionsShape = Object.fromEntries(collaborationCollectionNames.map(name => [name, z.array(z.never()).max(0).optional()]))
export function emptyCollaborationCollections(): CollaborationCollections { return { taskTrackings: [], progressEvents: [], followupRequests: [], followupResponses: [], blockerEpisodes: [], blockerActions: [], deadlineChangeRequests: [] } }

const userFields = ['ownerId', 'enrolledBy', 'actorId', 'requestedBy', 'closedBy', 'lastChangedBy', 'openedBy', 'resolvedBy', 'decidedBy']
export function collaborationReferences(name: string, row: Record<string, unknown>): DataReference[] {
  if (!(collaborationCollectionNames as readonly string[]).includes(name)) return []
  const refs: DataReference[] = []
  const add = (collection: TransferCollection, value: unknown) => { if (typeof value === 'string' && value) refs.push({ collection, id: value }) }
  for (const field of userFields) add('users', row[field])
  for (const userId of row.managerRecipientIds as string[] ?? []) add('users', userId)
  add('tasks', row.taskId ?? row.parentTaskId); add('weeklyRecords', row.weeklyRecordId)
  if (name === 'blockerEpisodes') add(row.sourceType === 'task' ? 'tasks' : 'weeklyRecords', row.sourceId)
  if (name === 'blockerActions') add('blockerEpisodes', row.episodeId)
  if (name === 'followupResponses') { add('followupRequests', row.followupRequestId); add('progressEvents', row.progressEventId) }
  // Raw audit identifiers are provenance only: member exports intentionally omit manager-only audits.
  return refs
}
export function remapCollaborationUsers(row: Record<string, unknown>, mapping: Record<string, string>) {
  for (const field of userFields) if (typeof row[field] === 'string' && mapping[row[field] as string]) row[field] = mapping[row[field] as string]
  if (Array.isArray(row.managerRecipientIds)) row.managerRecipientIds = row.managerRecipientIds.map(id => mapping[String(id)] ?? id)
}
export function collaborationTransferIssues(rows: BusinessCollections, available: Record<TransferCollection, Map<string, Entity>>, issue: (message: string) => void) {
  const tasks = available.tasks as Map<string, Task>
  for (const tracking of available.taskTrackings.values() as Iterable<TaskTracking>) {
    if (tasks.get(tracking.taskId)?.cancellation && tracking.state !== 'closed') issue(`taskTrackings/${tracking.id}：已作废任务的督办必须关闭`)
  }
  for (const episode of available.blockerEpisodes.values() as Iterable<BlockerEpisode>) {
    if (tasks.get(episode.parentTaskId)?.cancellation && !episode.resolvedAt) issue(`blockerEpisodes/${episode.id}：已作废任务的阻塞必须关闭`)
  }
  for (const tracking of rows.taskTrackings) {
    if (tracking.id !== tracking.taskId) issue(`taskTrackings/${tracking.id}：跟踪主键必须为任务标识`)
    if (tasks.get(tracking.taskId)?.ownerId !== tracking.ownerId) issue(`taskTrackings/${tracking.id}：跟踪与任务负责人不一致`)
    if (tracking.state === 'paused' && !tracking.pauseReason.trim()) issue(`taskTrackings/${tracking.id}：暂停缺少原因`)
  }
  for (const event of rows.progressEvents) {
    if (event.meaningfulOwnerProgress && (event.actorId !== event.ownerId || event.noteType === 'no_change')) issue(`progressEvents/${event.id}：本人有效进展标记不一致`)
    if (event.noteType === 'no_change' && (!event.noChangeReason.trim() || !event.nextAction.trim())) issue(`progressEvents/${event.id}：暂无变化缺少原因或下一步`)
    if (event.actorId !== event.ownerId && !event.proxyReason.trim()) issue(`progressEvents/${event.id}：代录缺少原因`)
  }
  for (const response of rows.followupResponses) {
    const request = available.followupRequests.get(response.followupRequestId) as FollowupRequest | undefined
    const progress = available.progressEvents.get(response.progressEventId) as ProgressEvent | undefined
    if (response.actorId !== response.ownerId || response.late !== (response.respondedAt > response.dueAt) || request && (request.taskId !== response.taskId || request.ownerId !== response.ownerId) || progress && (progress.taskId !== response.taskId || progress.actorId !== response.actorId)) issue(`followupResponses/${response.id}：回应与催办、本人进展或迟回应事实不一致`)
  }
  for (const name of ['followupRequests', 'deadlineChangeRequests'] as const) {
    const open = new Set<string>()
    for (const row of available[name].values() as Iterable<FollowupRequest | DeadlineChangeRequest>) if (row.status === 'open') {
      if (tasks.get(row.taskId)?.cancellation) issue(`${name}/${row.id}：已作废任务不能有待处理请求`)
      if (open.has(row.taskId)) issue(`${name}：同一任务存在多个待处理请求`)
      open.add(row.taskId)
    }
  }
}
