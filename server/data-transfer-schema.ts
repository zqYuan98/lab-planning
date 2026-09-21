import { z } from 'zod'
import type { AnnualGoal, AuditEvent, MonthlyPlan, Project, Publication, Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { HistoricalRecord } from './import-service.ts'
import type { WeeklyRule, WeeklyCycle, WeeklyDuty, WeeklySubmission, WeeklyMissing, WeeklyAdjustment, WeeklyPlanReview } from '../shared/weekly-submissions.ts'
import { HttpError } from './store.ts'
import { collaborationCollectionNames, collaborationCollectionsShape, collaborationReferences, collaborationSchemas, emptyCollaborationCollections, emptyCollaborationCollectionsShape, remapCollaborationUsers, type CollaborationCollections } from './collaboration-transfer.ts'
import { reportAgentTransferCollections, reportAgentCollectionsShape, reportAgentReferences, reportAgentTransferSchemas, reportAgentPayloadSchema, emptyReportAgentCollections, emptyReportAgentCollectionsShape, remapReportAgentUsers, type ReportAgentCollections } from './report-agent-transfer.ts'

export const collectionNames = ['users', 'projects', 'annualGoals', 'plans', 'tasks', 'weeklyRecords', 'history', 'publications', 'reports', 'events', 'weeklyRules', 'weeklyCycles', 'weeklyDuties', 'weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments', 'weeklyPlanReviews', ...collaborationCollectionNames, ...reportAgentTransferCollections] as const
export type TransferCollection = typeof collectionNames[number]
export type TransferType = 'all' | 'plans' | 'weeklyRecords' | 'projects' | 'tasks' | 'annualGoals' | 'history'
export interface BusinessCollections extends CollaborationCollections, ReportAgentCollections {
  users: User[]; projects: Project[]; annualGoals: AnnualGoal[]; plans: MonthlyPlan[]; tasks: Task[]
  weeklyRecords: WeeklyRecord[]; history: HistoricalRecord[]; publications: Publication[]; reports: Report[]; events: AuditEvent[]
  weeklyRules: WeeklyRule[]; weeklyCycles: WeeklyCycle[]; weeklyDuties: WeeklyDuty[]; weeklySubmissions: WeeklySubmission[]; weeklyMissing: WeeklyMissing[]; weeklyAdjustments: WeeklyAdjustment[]; weeklyPlanReviews: WeeklyPlanReview[]
}
export interface BusinessDataPacket {
  application: 'lab-planning'; formatVersion: 1 | 2 | 3 | 4; exportedAt: string; collections: BusinessCollections
}
export const storedCollection = (name: TransferCollection) => name === 'history' ? 'historicalRecords' : name
export const businessEventCollections: Record<string, TransferCollection> = {
  project: 'projects', annualGoal: 'annualGoals', plan: 'plans', plans: 'plans', monthlyPlan: 'plans',
  task: 'tasks', weeklyRecord: 'weeklyRecords', historicalRecord: 'history', report: 'reports',
  weeklyRule: 'weeklyRules', weeklyCycle: 'weeklyCycles', weeklyPlanReview: 'weeklyPlanReviews',
  taskTracking: 'taskTrackings', followupRequest: 'followupRequests', deadlineChangeRequest: 'deadlineChangeRequests', blockerEpisode: 'blockerEpisodes',
  reportTemplate: 'reportTemplates',
}
const id = z.string().min(1).max(200)
const line = z.string().max(12000)
const timestamp = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/).refine(v => Number.isFinite(Date.parse(v)))
// The weekly submission service orders these values lexically. One canonical
// representation is mandatory; legacy business timestamps retain their schema.
const weeklyTimestamp = timestamp.refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v, '周提报时间必须使用 ISO UTC 毫秒格式')
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v)
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
const planFingerprintTuple = z.tuple([id, id, day, id.nullable(), line])
export function planFingerprintParts(value: string): [string, string, string, string | null, string] | undefined {
  try {
    const parsed = planFingerprintTuple.safeParse(JSON.parse(value))
    return parsed.success && JSON.stringify(parsed.data) === value ? parsed.data : undefined
  } catch { return undefined }
}
const planFingerprint = z.string().max(80000).refine(value => !!planFingerprintParts(value), '计划指纹格式无效')
const deletionSchema = z.object({ deletedAt: timestamp, deletedBy: id, reason: line.refine(value => !!value.trim()) }).strict()
const planApprovalSchema = z.object({ required: z.literal(true), approvedSubmissionId: id.nullable(), approvedFingerprint: planFingerprint.nullable(), suspended: z.literal(true).optional() }).strict()
  .refine(row => (row.approvedSubmissionId === null) === (row.approvedFingerprint === null), '批准回执和指纹必须同时存在')
const entity = { id, version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), createdAt: timestamp, updatedAt: timestamp }
const workOriginSchema = z.object({ kind: z.enum(['self', 'assigned', 'proxy']), actorId: id, reason: line }).strict().refine(row => row.kind !== 'proxy' || !!row.reason.trim(), '代录需要原因')
const importSourceSchema = z.object({ batchId: id, sourceId: id, rowId: id, sourceStatus: line, mode: z.enum(['draft', 'existing']).optional(), notificationMode: z.literal('silent').optional() }).strict()
export const userSchema = z.object({ ...entity, name: z.string().min(1).max(100), email: z.string().min(3).max(254), role: z.enum(['manager', 'member']), position: z.string().max(100), active: z.boolean() }).strict()
const projectSchema = z.object({ ...entity, name: z.string().min(1).max(200), code: z.string().min(1).max(50), description: line, ownerId: id, status: z.enum(['active', 'archived']) }).strict()
const goalSchema = z.object({ ...entity, title: z.string().min(1).max(300), year: z.number().int().min(1900).max(2200), target: line.min(1), progress: z.number().min(0).max(100), description: line, ownerId: id, status: z.enum(['active', 'completed']) }).strict()
const planSchema = z.object({ ...entity, month, title: z.string().min(1).max(300), projectId: id.nullable(), category: z.string().max(100), ownerId: id, collaboratorIds: z.array(id).max(100),
  expectedOutcome: line, acceptanceCriteria: line, dueDate: z.union([day, z.literal('')]), priority: z.enum(['high', 'medium', 'low']), status: z.enum(['draft', 'submitted', 'approved', 'returned', 'published', 'merged']),
  reviewComment: line, publishedVersion: z.number().int().positive().nullable(), sourcePlanId: id.nullable(), actualOutcome: line, acceptanceStatus: z.enum(['pending', 'submitted', 'accepted', 'not_completed']), acceptanceNote: line,
  mergedFromIds: z.array(id).max(50).optional(), mergedIntoId: id.optional(), importSource: importSourceSchema.optional(), visibility: z.enum(['reference', 'historical']).optional(),
  isTemporary: z.boolean().optional(), temporaryReason: line.optional(),
  workSource: z.enum(['leader', 'self', 'coordination']).optional(), assignedBy: z.string().max(100).optional(), assignedOn: z.union([day, z.literal('')]).optional(),
}).strict().superRefine((row, ctx) => {
  if (!row.importSource && !row.visibility && (!row.expectedOutcome.trim() || !row.acceptanceCriteria.trim() || !row.dueDate)) ctx.addIssue({ code: 'custom', message: '普通月计划的预期成果、验收标准和截止日期不可为空' })
  if (row.isTemporary && !row.temporaryReason?.trim()) ctx.addIssue({ code: 'custom', message: '临时月度目标需要填写原因' })
})
const taskSchema = z.object({ ...entity, title: z.string().min(1).max(300), monthlyPlanId: id.nullable(), ownerId: id, description: z.string().max(20000), dueDate: z.union([day, z.literal('')]),
  status: z.enum(['todo', 'doing', 'blocked', 'done']), isTemporary: z.boolean(), temporaryReason: line, workOrigin: workOriginSchema.optional(), importSource: importSourceSchema.optional(),
  completionNote: line.optional(), evidenceUrl: z.string().max(2000).refine(value => { if (!value) return true; try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false } }).optional(), blockerReason: line.optional(), blockerImpact: line.optional(), supportNeeded: line.optional(), nextAction: line.optional(),
  workSource: z.enum(['leader', 'self', 'coordination']).optional(), assignedBy: z.string().max(100).optional(), assignedOn: z.union([day, z.literal('')]).optional(),
  requestedOutcome: line.optional(), priority: z.enum(['high', 'medium', 'low']).optional(), estimatedEffort: line.optional(), currentProgress: line.optional(), decisionNeeded: line.optional(), waitingForFeedback: z.boolean().optional(),
}).strict().superRefine((row, ctx) => {
  if (!row.importSource && row.description.length > 12000) ctx.addIssue({ code: 'custom', message: '普通任务的说明格式无效' })
})
const weeklySchema = z.object({ ...entity, taskId: id, monthlyPlanId: id.nullable(), ownerId: id, weekStart: day, commitment: line, actualOutcome: line,
  blockerImpact: line.optional(), supportNeeded: line.optional(),
  evidenceUrl: z.string().max(2000).refine(v => { if (!v) return true; try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false } }),
  blocker: line, nextAction: line, status: z.enum(['planned', 'doing', 'blocked', 'done', 'not_done']), submitted: z.boolean(), workOrigin: workOriginSchema.optional(), importSource: importSourceSchema.optional(),
  deletion: deletionSchema.optional(), planApproval: planApprovalSchema.optional(),
}).strict().superRefine((row, ctx) => {
  if (!row.importSource && !row.commitment.trim()) ctx.addIssue({ code: 'custom', message: '普通周记录的本周承诺不可为空' })
})
const importRowSchema = z.object({ id, kind: z.enum(['monthly', 'weekly']), selected: z.boolean(), sourceSheet: z.string().max(200), sourceRow: z.number().int().positive(), sourceText: z.string().max(20000),
  exclusionReason: z.string().max(1000).optional(), exclusionKind: z.enum(['task', 'duplicate', 'not_task']).optional(), manuallyAdded: z.boolean().optional(), collaboratorNames: z.array(z.string().max(200)).max(100).optional(), collaboratorIds: z.array(id).max(100).optional(),
  workSource: z.enum(['leader', 'self', 'coordination']).optional(), assignedBy: z.string().max(100).optional(), assignedOn: z.union([day, z.literal('')]).optional(), taskCompleted: z.boolean().optional(), completionNote: line.optional(), resultDisposition: z.enum(['created', 'existing']).optional(),
  ownerName: line, ownerId: line, projectName: line, projectId: line, category: line, title: z.string().max(300), month: line, weekStart: line, dueDate: line,
  expectedOutcome: line, acceptanceCriteria: line, actualOutcome: line, blocker: line, nextAction: line, sourceStatus: line, monthlyPlanId: line, linkedRowId: line, taskId: line, issues: z.array(line).max(100),
  monthlyResult: z.enum(['pending', 'submitted', 'accepted', 'not_completed']).optional(), weeklyStatus: z.enum(['planned', 'doing', 'blocked', 'done', 'not_done']).optional(),
  isTemporary: z.boolean().optional(), temporaryReason: line.optional(),
  result: z.object({ collection: z.enum(['plans', 'tasks', 'weeklyRecords', 'historicalRecords']), id }).strict().optional(),
}).strict()
const historySchema = z.object({ ...entity, importedBy: id, batchId: id, sourceId: id, row: importRowSchema }).strict()
const reportPatchSchema = z.object({ id: id.optional(), version: z.number().int().positive(), title: z.string().max(200).optional(), narrative: z.string().max(120000).optional(), status: z.enum(['draft', 'finalized']).optional(), finalizedAt: timestamp.nullable().optional(), finalHash: z.string().regex(/^[a-f0-9]{64}$/).optional(), model: z.string().max(300).optional(), validatorVersion: z.literal('legacy-fact-sentences-v1').optional(), sentences: z.array(z.object({ section: z.enum(['outcomes', 'risks', 'next']), text: z.string().max(20000), factIds: z.array(id).max(1000) }).strict()).max(1000).optional() }).strict()
const templatePatchSchema = z.object({ version: z.number().int().positive(), sourceHash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict()
const week = day.refine(v => new Date(`${v}T00:00:00Z`).getUTCDay() === 1)
const kind = z.enum(['results', 'plan'])
const dutyIdentity = { ownerId: id, cycleWeek: week, kind }
const weeklyEntity = { ...entity, createdAt: weeklyTimestamp, updatedAt: weeklyTimestamp }
const ruleSchema = z.object({ ...weeklyEntity, id: z.literal('weekly-submission-rule'), enabled: z.boolean(), effectiveWeek: week, planReviewEffectiveWeek: week.optional(), timezone: z.literal('Asia/Shanghai'), windows: z.array(z.object({ fromWeek: week, toWeek: week.nullable() }).strict()).max(50000) }).strict()
const cycleSchema = z.object({ ...weeklyEntity, week, deadlineAt: weeklyTimestamp, rosterIds: z.array(id).max(50000), needsReview: z.boolean(), confirmedBy: id.nullable(), confirmationReason: line, frozenAt: weeklyTimestamp }).strict()
const dutySchema = z.object({ ...weeklyEntity, ...dutyIdentity, contentWeek: week, deadlineAt: weeklyTimestamp }).strict()
const planManifestItemSchema = z.object({ id, fingerprint: planFingerprint, submitted: z.boolean() }).strict()
const planTaskSnapshotSchema = z.object({ id, title: z.string().min(1).max(300), dueDate: z.union([day, z.literal('')]), description: z.string().max(20000) }).strict()
const planGoalSnapshotSchema = z.object({ id, month, title: z.string().min(1).max(300) }).strict()
const submissionSchema = z.object({ ...weeklyEntity, ...dutyIdentity, dutyId: id, submittedAt: weeklyTimestamp, actorId: id, reason: line, note: line, requestId: id, records: z.array(weeklySchema).max(50000), retainedDraftIds: z.array(id).max(50000), retainedDraftManifest: z.array(z.object({ id, version: z.number().int().positive() }).strict()).max(50000), progressEventIds: z.array(id).max(50000).optional(), planManifest: z.array(planManifestItemSchema).max(50000).optional(), planTaskSnapshots: z.array(planTaskSnapshotSchema).max(50000).optional(), planGoalSnapshots: z.array(planGoalSnapshotSchema).max(50000).optional() }).strict()
const planReviewSchema = z.object({ ...weeklyEntity, dutyId: id, ownerId: id, cycleWeek: week, submissionId: id, decision: z.enum(['approved', 'returned']), reviewedBy: id, reviewedAt: weeklyTimestamp, reason: line, requestId: id }).strict()
  .refine(row => row.decision !== 'returned' || !!row.reason.trim(), '退回计划必须提供原因')
const missingSchema = z.object({ ...weeklyEntity, ...dutyIdentity, dutyId: id, deadlineAt: weeklyTimestamp, detectedAt: weeklyTimestamp }).strict()
const adjustmentSchema = z.object({ ...weeklyEntity, ...dutyIdentity, dutyId: id, action: z.enum(['exempt', 'revoke_exemption', 'invalidate', 'restore']), submissionId: id.nullable(), actorId: id, reason: line.min(1), occurredAt: weeklyTimestamp }).strict()
const reportSubmissionSchema = z.object({ ...dutyIdentity, status: z.enum(['due', 'on_time', 'missing', 'late', 'exempt']), deadlineAt: weeklyTimestamp, firstSubmittedAt: weeklyTimestamp.nullable(), missingAtDeadline: z.boolean(), exemptionReason: line }).strict()
const weeklySchemas = { weeklyRules: ruleSchema, weeklyCycles: cycleSchema, weeklyDuties: dutySchema, weeklySubmissions: submissionSchema, weeklyMissing: missingSchema, weeklyAdjustments: adjustmentSchema, weeklyPlanReviews: planReviewSchema }
const auditSchema = z.object({ ...entity, entityType: z.enum(['project', 'annualGoal', 'plan', 'plans', 'monthlyPlan', 'task', 'weeklyRecord', 'historicalRecord', 'report', 'reportTemplate', 'weeklyRule', 'weeklyCycle', 'weeklyPlanReview', 'taskTracking', 'followupRequest', 'deadlineChangeRequest', 'blockerEpisode']), entityId: id, actorId: id, action: z.string().min(1).max(100), reason: line, before: z.unknown(), after: z.unknown() }).strict().superRefine((event, ctx) => {
  if (['weeklyRule', 'weeklyCycle', 'weeklyPlanReview'].includes(event.entityType)) for (const field of ['createdAt', 'updatedAt'] as const) {
    if (!weeklyTimestamp.safeParse(event[field]).success) ctx.addIssue({ code: 'custom', path: [field], message: '周提报审计时间必须使用 ISO UTC 毫秒格式' })
  }
  const schema = event.entityType === 'report' ? reportPatchSchema : event.entityType === 'reportTemplate' ? templatePatchSchema : ({ project: projectSchema, annualGoal: goalSchema, plan: planSchema, plans: planSchema, monthlyPlan: planSchema, task: taskSchema, weeklyRecord: weeklySchema, historicalRecord: historySchema, weeklyRule: ruleSchema, weeklyCycle: cycleSchema, weeklyPlanReview: planReviewSchema, taskTracking: collaborationSchemas.taskTrackings, followupRequest: collaborationSchemas.followupRequests, deadlineChangeRequest: collaborationSchemas.deadlineChangeRequests, blockerEpisode: collaborationSchemas.blockerEpisodes } as const)[event.entityType]
  for (const field of ['before', 'after'] as const) {
    const value = event[field]
    if (value === null) continue
    const values = Array.isArray(value) && ['plan', 'plans', 'monthlyPlan'].includes(event.entityType) ? value : [value]
    if (values.length > 50 || values.some(item => !schema.safeParse(item).success)) ctx.addIssue({ code: 'custom', path: [field], message: '审计快照字段无效或包含未允许字段' })
  }
})
const publicationSchema = z.object({ ...entity, month, revision: z.number().int().positive(), actorId: id, reason: line, plans: z.array(planSchema).max(50000) }).strict()
const snapshotSchema = z.object({ plans: z.array(planSchema).max(50000), contextPlans: z.array(planSchema).max(50000).optional(), weeklyRecords: z.array(weeklySchema).max(50000), tasks: z.array(taskSchema).max(50000),
  projects: z.array(projectSchema).max(50000), users: z.array(userSchema).max(50000), annualGoals: z.array(goalSchema).max(50000), nextPlans: z.array(planSchema).max(50000), nextWeeklyRecords: z.array(weeklySchema).max(50000),
  publications: z.array(publicationSchema).max(50000), changes: z.array(auditSchema).max(50000),
  weeklySubmissions: z.array(reportSubmissionSchema).max(50000).optional(),
}).strict()
const reportSchema = z.object({ ...entity, type: z.enum(['weekly', 'monthly']), period: z.string().max(10), title: z.string().min(1).max(200), status: z.enum(['draft', 'finalized']), revision: z.number().int().positive(), narrative: z.string().max(120000), snapshot: snapshotSchema, authorId: id, finalizedAt: timestamp.nullable(), agent: reportAgentPayloadSchema.optional() }).strict()
export const schemas = { users: userSchema, projects: projectSchema, annualGoals: goalSchema, plans: planSchema, tasks: taskSchema, weeklyRecords: weeklySchema, history: historySchema, publications: publicationSchema, reports: reportSchema, events: auditSchema, ...weeklySchemas, ...collaborationSchemas, ...reportAgentTransferSchemas }
const collectionsSchema = z.object({ users: z.array(userSchema).max(50000), projects: z.array(projectSchema).max(50000), annualGoals: z.array(goalSchema).max(50000), plans: z.array(planSchema).max(50000),
  tasks: z.array(taskSchema).max(50000), weeklyRecords: z.array(weeklySchema).max(50000), history: z.array(historySchema).max(50000), publications: z.array(publicationSchema).max(50000), reports: z.array(reportSchema).max(50000), events: z.array(auditSchema).max(50000),
}).strict()
const weeklyCollectionsSchema = z.object({ weeklyRules: z.array(ruleSchema).max(1), weeklyCycles: z.array(cycleSchema).max(50000), weeklyDuties: z.array(dutySchema).max(50000), weeklySubmissions: z.array(submissionSchema).max(50000), weeklyMissing: z.array(missingSchema).max(50000), weeklyAdjustments: z.array(adjustmentSchema).max(50000), weeklyPlanReviews: z.array(planReviewSchema).max(50000).default([]) }).strict()
const packetSchema = z.discriminatedUnion('formatVersion', [
  z.object({ application: z.literal('lab-planning'), formatVersion: z.literal(1), exportedAt: timestamp, collections: collectionsSchema.extend(emptyCollaborationCollectionsShape).extend(emptyReportAgentCollectionsShape).extend({ weeklyPlanReviews: z.array(z.never()).max(0).optional() }) }).strict(),
  z.object({ application: z.literal('lab-planning'), formatVersion: z.literal(2), exportedAt: timestamp, collections: collectionsSchema.extend(weeklyCollectionsSchema.shape).extend(emptyCollaborationCollectionsShape).extend(emptyReportAgentCollectionsShape) }).strict(),
  z.object({ application: z.literal('lab-planning'), formatVersion: z.literal(3), exportedAt: timestamp, collections: collectionsSchema.extend(weeklyCollectionsSchema.shape).extend(collaborationCollectionsShape).extend(emptyReportAgentCollectionsShape) }).strict(),
  z.object({ application: z.literal('lab-planning'), formatVersion: z.literal(4), exportedAt: timestamp, collections: collectionsSchema.extend(weeklyCollectionsSchema.shape).extend(collaborationCollectionsShape).extend(reportAgentCollectionsShape) }).strict(),
])

export function parsePacket(input: unknown): BusinessDataPacket {
  let encoded: string
  try { encoded = JSON.stringify(input) } catch { throw new HttpError(400, '迁移包必须是有效 JSON') }
  if (!encoded || Buffer.byteLength(encoded) > 32 * 1024 * 1024) throw new HttpError(400, '迁移包不得超过 32 MB')
  const parsed = packetSchema.safeParse(input)
  if (!parsed.success) {
    const location = parsed.error.issues[0]?.path.map(String).join('.') || '根对象'
    throw new HttpError(400, `迁移包格式无效或含未允许字段：${location}`)
  }
  // Normalize legacy inputs to the current in-memory packet shape without inventing facts.
  if (parsed.data.formatVersion !== 4 && parsed.data.collections.reports?.some(report => report.agent)) throw new HttpError(400, '包含周报智能体内容的迁移包必须使用格式版本 4')
  return { ...parsed.data, formatVersion: parsed.data.formatVersion >= 3 ? parsed.data.formatVersion : 2, collections: { ...emptyCollections(), ...parsed.data.collections } } as BusinessDataPacket
}

function pick(value: unknown, fields: string[]): Record<string, unknown> {
  const row = value as Record<string, unknown>
  return Object.fromEntries(fields.filter(field => row[field] !== undefined).map(field => [field, structuredClone(row[field])]))
}
const auditFields = [...Object.keys(entity), 'entityType', 'entityId', 'actorId', 'action', 'reason', 'before', 'after']
/** Explicit projection also protects exports from accidental secret-bearing extensions to stored entities. */
export function projectRow(collection: TransferCollection, value: unknown): Record<string, unknown> {
  const schema = schemas[collection]
  const row = pick(value, collection === 'events' ? auditFields : Object.keys((schema as typeof projectSchema).shape))
  if (row.workOrigin) row.workOrigin = pick(row.workOrigin, ['kind', 'actorId', 'reason'])
  if (row.importSource) row.importSource = pick(row.importSource, Object.keys(importSourceSchema.shape))
  if (collection === 'weeklyRecords') {
    if (row.deletion) row.deletion = pick(row.deletion, ['deletedAt', 'deletedBy', 'reason'])
    if (row.planApproval) row.planApproval = pick(row.planApproval, ['required', 'approvedSubmissionId', 'approvedFingerprint', 'suspended'])
  }
  if (collection === 'history') row.row = pick(row.row, Object.keys(importRowSchema.shape))
  if (collection === 'weeklyRules') row.windows = (row.windows as unknown[]).map(item => pick(item, ['fromWeek', 'toWeek']))
  if (collection === 'weeklySubmissions') {
    row.records = (row.records as unknown[]).map(item => projectRow('weeklyRecords', item))
    row.retainedDraftManifest = (row.retainedDraftManifest as unknown[]).map(item => pick(item, ['id', 'version']))
    if (row.planManifest) row.planManifest = (row.planManifest as unknown[]).map(item => pick(item, Object.keys(planManifestItemSchema.shape)))
    if (row.planTaskSnapshots) row.planTaskSnapshots = (row.planTaskSnapshots as unknown[]).map(item => pick(item, Object.keys(planTaskSnapshotSchema.shape)))
    if (row.planGoalSnapshots) row.planGoalSnapshots = (row.planGoalSnapshots as unknown[]).map(item => pick(item, Object.keys(planGoalSnapshotSchema.shape)))
  }
  if (collection === 'publications') row.plans = (row.plans as unknown[]).map(plan => projectRow('plans', plan))
  if (collection === 'reports') {
    const snapshot = row.snapshot as Record<string, unknown[]>
    row.snapshot = Object.fromEntries(Object.keys(snapshotSchema.shape).filter(key => snapshot[key] !== undefined).map(key => {
      if (key === 'weeklySubmissions') return [key, snapshot[key].map(item => pick(item, Object.keys(reportSubmissionSchema.shape)))]
      const target = ({ contextPlans: 'plans', nextPlans: 'plans', nextWeeklyRecords: 'weeklyRecords', changes: 'events' } as Record<string, TransferCollection>)[key] ?? key as TransferCollection
      return [key, snapshot[key].map(item => projectRow(target, item))]
    }))
  }
  if (collection === 'events') {
    const target = businessEventCollections[String(row.entityType)]
    for (const field of ['before', 'after']) {
      const item = row[field]
      if (item === null) continue
      const project = (entry: unknown) => target === 'reports' ? pick(entry, Object.keys(reportPatchSchema.shape)) : target === 'reportTemplates' ? pick(entry, Object.keys(templatePatchSchema.shape)) : projectRow(target, entry)
      row[field] = Array.isArray(item) ? item.map(project) : project(item)
    }
  }
  return row
}

export function emptyCollections(): BusinessCollections {
  return { users: [], projects: [], annualGoals: [], plans: [], tasks: [], weeklyRecords: [], history: [], publications: [], reports: [], events: [], weeklyRules: [], weeklyCycles: [], weeklyDuties: [], weeklySubmissions: [], weeklyMissing: [], weeklyAdjustments: [], weeklyPlanReviews: [], ...emptyCollaborationCollections(), ...emptyReportAgentCollections() }
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  return JSON.stringify(value)
}

export interface DataReference { collection: TransferCollection; id: string }
/** References are enumerated by domain field, never inferred from arbitrary text or raw source IDs. */
export function rowReferences(collection: TransferCollection, value: unknown): DataReference[] {
  const refs: DataReference[] = []
  const add = (target: TransferCollection, id: unknown) => { if (typeof id === 'string' && id) refs.push({ collection: target, id }) }
  const fingerprintReferences = (value: unknown) => {
    const parts = typeof value === 'string' ? planFingerprintParts(value) : undefined
    if (parts) { add('tasks', parts[0]); add('users', parts[1]); add('plans', parts[3]) }
  }
  const visit = (target: TransferCollection, input: unknown, nested = false) => {
    const row = input as Record<string, unknown>
    refs.push(...collaborationReferences(target, row))
    refs.push(...reportAgentReferences(target, row))
    // An archive may be deleted while its correction audit remains as a fact.
    // Its snapshot still validates all business references below.
    if (nested && target !== 'history') add(target, row.id)
    if (['projects', 'annualGoals', 'plans', 'tasks', 'weeklyRecords'].includes(target)) add('users', row.ownerId)
    if (target === 'plans') {
      add('projects', row.projectId); add('plans', row.sourcePlanId); add('plans', row.mergedIntoId)
      for (const id of row.collaboratorIds as string[]) add('users', id)
      for (const id of (row.mergedFromIds ?? []) as string[]) add('plans', id)
    }
    if (target === 'tasks' || target === 'weeklyRecords') add('plans', row.monthlyPlanId)
    if (target === 'weeklyRecords') {
      add('tasks', row.taskId)
      if (row.deletion) add('users', (row.deletion as WeeklyRecord['deletion'])!.deletedBy)
      if (row.planApproval) {
        const approval = row.planApproval as NonNullable<WeeklyRecord['planApproval']>
        add('weeklyRules', 'weekly-submission-rule')
        add('weeklySubmissions', approval.approvedSubmissionId); fingerprintReferences(approval.approvedFingerprint)
      }
    }
    if ((target === 'tasks' || target === 'weeklyRecords') && row.workOrigin) add('users', (row.workOrigin as { actorId: string }).actorId)
    if (target === 'weeklyCycles') { add('weeklyRules', 'weekly-submission-rule'); add('users', row.confirmedBy); for (const id of row.rosterIds as string[]) add('users', id) }
    if (['weeklyDuties', 'weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments', 'weeklyPlanReviews'].includes(target)) { add('users', row.ownerId); add('weeklyCycles', row.cycleWeek) }
    if (['weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments', 'weeklyPlanReviews'].includes(target)) add('weeklyDuties', row.dutyId)
    if (target === 'weeklySubmissions' || target === 'weeklyAdjustments') add('users', row.actorId)
    if (target === 'weeklyAdjustments') add('weeklySubmissions', row.submissionId)
    if (target === 'weeklyPlanReviews') { add('weeklySubmissions', row.submissionId); add('users', row.reviewedBy) }
    if (target === 'weeklySubmissions') {
      for (const id of row.progressEventIds as string[] ?? []) add('progressEvents', id)
      for (const item of row.records as unknown[]) visit('weeklyRecords', item, true)
      for (const id of row.retainedDraftIds as string[]) add('weeklyRecords', id)
      for (const item of row.retainedDraftManifest as { id: string }[]) add('weeklyRecords', item.id)
      for (const item of (row.planManifest ?? []) as { id: string; fingerprint: string }[]) { add('weeklyRecords', item.id); fingerprintReferences(item.fingerprint) }
      for (const item of (row.planTaskSnapshots ?? []) as { id: string }[]) add('tasks', item.id)
      for (const item of (row.planGoalSnapshots ?? []) as { id: string }[]) add('plans', item.id)
    }
    if (target === 'history') {
      add('users', row.importedBy)
      const item = row.row as Record<string, unknown>
      add('users', item.ownerId); add('projects', item.projectId); add('plans', item.monthlyPlanId); add('tasks', item.taskId)
      for (const userId of (item.collaboratorIds as string[] | undefined) ?? []) add('users', userId)
      const result = item.result as { collection: string; id: string } | undefined
      if (result) add(result.collection === 'historicalRecords' ? 'history' : result.collection as TransferCollection, result.id)
    }
    if (target === 'publications') {
      add('users', row.actorId)
      for (const plan of row.plans as unknown[]) visit('plans', plan, true)
    }
    if (target === 'reports') {
      add('users', row.authorId)
      const snapshot = row.snapshot as Record<string, unknown[]>
      for (const [key, items] of Object.entries(snapshot)) {
        if (key === 'weeklySubmissions') { for (const item of items as { ownerId: string }[]) add('users', item.ownerId); continue }
        const child = ({ contextPlans: 'plans', nextPlans: 'plans', nextWeeklyRecords: 'weeklyRecords', changes: 'events' } as Record<string, TransferCollection>)[key] ?? key as TransferCollection
        for (const item of items) visit(child, item, true)
      }
    }
    if (target === 'events') {
      add('users', row.actorId)
      const child = businessEventCollections[String(row.entityType)]
      if (child !== 'history') add(child, row.entityId)
      if (child !== 'reports' && child !== 'reportTemplates') for (const field of ['before', 'after']) {
        const snapshots = row[field] === null ? [] : Array.isArray(row[field]) ? row[field] as unknown[] : [row[field]]
        for (const snapshot of snapshots) visit(child, snapshot, true)
      }
    }
  }
  visit(collection, value)
  return refs
}

export function remapUsers(collection: TransferCollection, value: unknown, mapping: Record<string, string>): unknown {
  const row = structuredClone(value) as Record<string, unknown>
  if ((collaborationCollectionNames as readonly string[]).includes(collection)) remapCollaborationUsers(row, mapping)
  const replace = (field: string) => { if (typeof row[field] === 'string' && mapping[row[field] as string]) row[field] = mapping[row[field] as string] }
  const remapFingerprint = (value: string) => {
    const parts = planFingerprintParts(value)
    if (!parts) return value
    parts[1] = mapping[parts[1]] ?? parts[1]
    return JSON.stringify(parts)
  }
  if (collection === 'users') replace('id')
  if ((collection === 'tasks' || collection === 'weeklyRecords') && row.workOrigin) { const origin = row.workOrigin as { actorId: string }; origin.actorId = mapping[origin.actorId] ?? origin.actorId }
  if (['projects', 'annualGoals', 'plans', 'tasks', 'weeklyRecords'].includes(collection)) replace('ownerId')
  if (['weeklyDuties', 'weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments', 'weeklyPlanReviews'].includes(collection)) replace('ownerId')
  if (collection === 'weeklyRecords') {
    const deletion = row.deletion as WeeklyRecord['deletion']
    if (deletion) deletion.deletedBy = mapping[deletion.deletedBy] ?? deletion.deletedBy
    const approval = row.planApproval as WeeklyRecord['planApproval']
    if (approval?.approvedFingerprint) approval.approvedFingerprint = remapFingerprint(approval.approvedFingerprint)
  }
  if (collection === 'weeklyCycles') { replace('confirmedBy'); row.rosterIds = (row.rosterIds as string[]).map(id => mapping[id] ?? id) }
  if (collection === 'weeklySubmissions' || collection === 'weeklyAdjustments') replace('actorId')
  if (collection === 'weeklyPlanReviews') replace('reviewedBy')
  if (collection === 'weeklySubmissions') {
    row.records = (row.records as unknown[]).map(item => remapUsers('weeklyRecords', item, mapping))
    if (row.planManifest) row.planManifest = (row.planManifest as { id: string; fingerprint: string; submitted: boolean }[]).map(item => ({ ...item, fingerprint: remapFingerprint(item.fingerprint) }))
  }
  if (collection === 'plans') row.collaboratorIds = (row.collaboratorIds as string[]).map(id => mapping[id] ?? id)
  if (collection === 'history') {
    replace('importedBy')
    const item = row.row as Record<string, unknown>
    if (typeof item.ownerId === 'string' && mapping[item.ownerId]) item.ownerId = mapping[item.ownerId]
    if (Array.isArray(item.collaboratorIds)) item.collaboratorIds = item.collaboratorIds.map(id => mapping[String(id)] ?? id)
  }
  if (collection === 'publications') { replace('actorId'); row.plans = (row.plans as unknown[]).map(plan => remapUsers('plans', plan, mapping)) }
  if (collection === 'reports') {
    replace('authorId')
    row.snapshot = Object.fromEntries(Object.entries(row.snapshot as Record<string, unknown[]>).map(([key, items]) => {
      if (key === 'weeklySubmissions') return [key, items.map(item => { const summary = item as { ownerId: string }; return { ...summary, ownerId: mapping[summary.ownerId] ?? summary.ownerId } })]
      const child = ({ contextPlans: 'plans', nextPlans: 'plans', nextWeeklyRecords: 'weeklyRecords', changes: 'events' } as Record<string, TransferCollection>)[key] ?? key as TransferCollection
      return [key, items.map(item => remapUsers(child, item, mapping))]
    }))
  }
  if (collection === 'events') {
    replace('actorId')
    const child = businessEventCollections[String(row.entityType)]
    if (child !== 'reports' && child !== 'reportTemplates') for (const field of ['before', 'after']) {
      const item = row[field]
      row[field] = item === null ? null : Array.isArray(item) ? item.map(value => remapUsers(child, value, mapping)) : remapUsers(child, item, mapping)
    }
  }
  remapReportAgentUsers(collection, row, mapping)
  return row
}
