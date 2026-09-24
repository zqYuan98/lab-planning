import { z } from 'zod'
import type { DeliveryDecision, DeliverySeries, TaskDelivery } from '../shared/deliveries.ts'
import type { DecisionRequest } from '../shared/support.ts'
import type { Entity, Task } from '../shared/types.ts'
import type { BusinessCollections, DataReference, TransferCollection } from './data-transfer-schema.ts'

export const deliveryCollectionNames = ['deliverySeries', 'taskDeliveries', 'deliveryDecisions', 'decisionRequests'] as const
export interface DeliveryCollections { deliverySeries: DeliverySeries[]; taskDeliveries: TaskDelivery[]; deliveryDecisions: DeliveryDecision[]; decisionRequests: DecisionRequest[] }
const id = z.string().min(1).max(200), line = z.string().max(12000), integer = z.number().int().positive()
const requiredLine = line.refine(value => !!value.trim(), '业务说明不可为空白')
const evidence = z.string().max(4000).refine(value => !!value.trim(), '证据不可为空白')
  .refine(value => !/^[a-z][a-z\d+.-]*:/i.test(value.trim()) || /^https?:\/\//i.test(value.trim()), '证据链接只支持 http 或 https')
const time = z.string().max(40).refine(value => Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value)
const day = z.union([z.literal(''), z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value)])
const entity = { id, version: integer, createdAt: time, updatedAt: time }
export const deliverySchemas = {
  deliverySeries: z.object({ ...entity, taskId: id, title: z.string().trim().min(1).max(300), reviewerId: id.nullable(), headSubmissionId: id, status: z.enum(['pending_review', 'accepted', 'returned', 'withdrawn']) }).strict(),
  taskDeliveries: z.object({ ...entity, seriesId: id, taskId: id, revision: integer, supersedesId: id.nullable(), taskVersion: integer, ownerId: id, submittedBy: id, proxyReason: line, submittedAt: time, actualOutcome: requiredLine, evidenceRefs: z.array(evidence).max(30), acceptanceCriteriaSnapshot: requiredLine, reviewerIdSnapshot: id.nullable(), dueDateSnapshot: day, deadlineBasisRefs: z.array(id).max(1000) }).strict(),
  deliveryDecisions: z.object({ ...entity, seriesId: id, deliveryId: id, conclusion: z.enum(['accepted', 'returned', 'withdrawn']), action: z.enum(['review', 'withdraw', 'correct']), note: requiredLine, decidedBy: id, decidedAt: time, supersedesDecisionId: id.nullable() }).strict(),
  decisionRequests: z.object({ ...entity, taskId: id, blockerEpisodeId: id.nullable(), question: requiredLine, options: z.array(z.string().max(3000).refine(value => !!value.trim(), '决策选项不可为空白')).max(20), decisionOwnerId: id, responseDueAt: time, status: z.enum(['open', 'decided', 'cancelled']), result: line, decidedAt: time.nullable(), decidedBy: id.nullable(), generation: integer, requestedBy: id, reason: line }).strict(),
}
export const deliveryCollectionsShape = Object.fromEntries(deliveryCollectionNames.map(name => [name, z.array(deliverySchemas[name]).max(50000)])) as { [K in keyof typeof deliverySchemas]: z.ZodArray<typeof deliverySchemas[K]> }
export const emptyDeliveryCollectionsShape = Object.fromEntries(deliveryCollectionNames.map(name => [name, z.array(z.never()).max(0).optional()]))
export function emptyDeliveryCollections(): DeliveryCollections { return { deliverySeries: [], taskDeliveries: [], deliveryDecisions: [], decisionRequests: [] } }
const userFields = ['reviewerId', 'ownerId', 'submittedBy', 'reviewerIdSnapshot', 'decidedBy', 'decisionOwnerId', 'requestedBy']
export function deliveryReferences(name: string, row: Record<string, unknown>): DataReference[] {
  if (!(deliveryCollectionNames as readonly string[]).includes(name)) return []
  const refs: DataReference[] = []
  const add = (collection: TransferCollection, value: unknown) => { if (typeof value === 'string' && value) refs.push({ collection, id: value }) }
  for (const field of userFields) add('users', row[field])
  add('tasks', row.taskId); add('deliverySeries', row.seriesId); add('taskDeliveries', row.headSubmissionId); add('taskDeliveries', row.deliveryId)
  if (name === 'taskDeliveries') { add('taskDeliveries', row.supersedesId); for (const ref of row.deadlineBasisRefs as string[] || []) add('deadlineChangeRequests', ref) }
  if (name === 'deliveryDecisions') add('deliveryDecisions', row.supersedesDecisionId)
  if (name === 'decisionRequests') add('blockerEpisodes', row.blockerEpisodeId)
  return refs
}
export function remapDeliveryUsers(row: Record<string, unknown>, mapping: Record<string, string>) {
  for (const field of userFields) if (typeof row[field] === 'string' && mapping[row[field] as string]) row[field] = mapping[row[field] as string]
}
export function deliveryTransferIssues(rows: BusinessCollections, available: Record<TransferCollection, Map<string, Entity>>, issue: (message: string) => void) {
  const seriesMap = available.deliverySeries as Map<string, DeliverySeries>, deliveries = available.taskDeliveries as Map<string, TaskDelivery>, decisions = available.deliveryDecisions as Map<string, DeliveryDecision>
  for (const series of seriesMap.values()) {
    const head = deliveries.get(series.headSubmissionId), task = available.tasks.get(series.taskId) as Task | undefined
    const revisions = [...deliveries.values()].filter(row => row.seriesId === series.id)
    if (!head || head.seriesId !== series.id || head.taskId !== series.taskId || revisions.some(row => row.revision > head.revision)) issue(`deliverySeries/${series.id}：当前提交与成果项不一致`)
    if (head && series.reviewerId === head.ownerId) issue(`deliverySeries/${series.id}：验收人不能是成果责任人`)
    if (task?.cancellation && series.status === 'pending_review') issue(`deliverySeries/${series.id}：已作废任务不能有待验收成果`)
    if (head) {
      const list = [...decisions.values()].filter(row => row.deliveryId === head.id)
      const replaced = new Set(list.map(row => row.supersedesDecisionId).filter(Boolean)), effective = list.filter(row => !replaced.has(row.id))
      if (effective.length > 1 || series.status !== (effective[0]?.conclusion || 'pending_review')) issue(`deliverySeries/${series.id}：当前状态与有效决定不一致`)
    }
  }
  const revisionKeys = new Set<string>()
  for (const delivery of deliveries.values()) {
    const series = seriesMap.get(delivery.seriesId), previous = delivery.supersedesId ? deliveries.get(delivery.supersedesId) : null
    const task = available.tasks.get(delivery.taskId) as Task | undefined
    if (task && delivery.taskVersion > task.version) issue(`taskDeliveries/${delivery.id}：冻结任务版本不能晚于当前任务版本`)
    const key = `${delivery.seriesId}/${delivery.revision}`
    if (revisionKeys.has(key)) issue(`taskDeliveries/${delivery.id}：成果版本重复`)
    revisionKeys.add(key)
    if (series && series.taskId !== delivery.taskId || delivery.revision === 1 && delivery.supersedesId || delivery.revision > 1 && (!previous || previous.seriesId !== delivery.seriesId || previous.revision !== delivery.revision - 1)) issue(`taskDeliveries/${delivery.id}：提交修订链断裂`)
    if (!delivery.actualOutcome.trim() || !delivery.acceptanceCriteriaSnapshot.trim() || delivery.ownerId !== delivery.submittedBy && !delivery.proxyReason.trim()) issue(`taskDeliveries/${delivery.id}：成果或代交证据缺失`)
    if (delivery.reviewerIdSnapshot === delivery.ownerId) issue(`taskDeliveries/${delivery.id}：不能指定本人验收`)
    for (const basis of delivery.deadlineBasisRefs) { const request = available.deadlineChangeRequests.get(basis) as { taskId?: string; status?: string } | undefined; if (request && (request.taskId !== delivery.taskId || request.status !== 'approved')) issue(`taskDeliveries/${delivery.id}：期限依据必须是本任务批准的变更`) }
    const terminal = [...decisions.values()].filter(row => row.deliveryId === delivery.id), referenced = new Set(terminal.map(row => row.supersedesDecisionId).filter(Boolean))
    if (series && series.headSubmissionId !== delivery.id && !terminal.length) issue(`taskDeliveries/${delivery.id}：历史版本必须已有有效终态决定才能提交下一版`)
    if (terminal.length && terminal.filter(row => !referenced.has(row.id)).length !== 1) issue(`taskDeliveries/${delivery.id}：有效决定必须唯一`)
  }
  for (const decision of decisions.values()) {
    const delivery = deliveries.get(decision.deliveryId), prior = decision.supersedesDecisionId ? decisions.get(decision.supersedesDecisionId) : null
    if (delivery && decision.seriesId !== delivery.seriesId || !decision.note.trim()) issue(`deliveryDecisions/${decision.id}：成果引用或决定说明无效`)
    if (decision.action === 'withdraw' ? decision.conclusion !== 'withdrawn' : decision.conclusion === 'withdrawn') issue(`deliveryDecisions/${decision.id}：决定动作与结论不一致`)
    if (decision.action === 'correct' ? !prior || prior.deliveryId !== decision.deliveryId : !!prior) issue(`deliveryDecisions/${decision.id}：更正链不一致`)
    if (delivery && decision.action !== 'withdraw' && decision.decidedBy === delivery.ownerId) issue(`deliveryDecisions/${decision.id}：不能验收本人交付`)
    const seen = new Set([decision.id]); let node = prior
    while (node) { if (seen.has(node.id)) { issue(`deliveryDecisions/${decision.id}：决定更正链循环`); break }; seen.add(node.id); node = node.supersedesDecisionId ? decisions.get(node.supersedesDecisionId) || null : null }
  }
  for (const request of rows.decisionRequests) {
    const episode = request.blockerEpisodeId ? available.blockerEpisodes.get(request.blockerEpisodeId) as { parentTaskId?: string } | undefined : undefined
    if (episode && episode.parentTaskId !== request.taskId) issue(`decisionRequests/${request.id}：阻塞关联不属于当前任务`)
    if (request.status === 'decided' && (!request.result.trim() || !request.decidedAt || !request.decidedBy) || request.status === 'open' && (request.decidedAt || request.decidedBy || request.result)) issue(`decisionRequests/${request.id}：决策状态和结果不一致`)
  }
}
