import { z } from 'zod'
import type { AnnualGoal, AuditEvent, MonthlyPlan, Project, Publication, Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { HistoricalRecord } from './import-service.ts'
import { HttpError } from './store.ts'

export const collectionNames = ['users', 'projects', 'annualGoals', 'plans', 'tasks', 'weeklyRecords', 'history', 'publications', 'reports', 'events'] as const
export type TransferCollection = typeof collectionNames[number]
export type TransferType = 'all' | 'plans' | 'weeklyRecords' | 'projects' | 'tasks' | 'annualGoals' | 'history'
export interface BusinessCollections {
  users: User[]; projects: Project[]; annualGoals: AnnualGoal[]; plans: MonthlyPlan[]; tasks: Task[]
  weeklyRecords: WeeklyRecord[]; history: HistoricalRecord[]; publications: Publication[]; reports: Report[]; events: AuditEvent[]
}
export interface BusinessDataPacket {
  application: 'lab-planning'; formatVersion: 1; exportedAt: string; collections: BusinessCollections
}
export const storedCollection = (name: TransferCollection) => name === 'history' ? 'historicalRecords' : name
export const businessEventCollections: Record<string, TransferCollection> = {
  project: 'projects', annualGoal: 'annualGoals', plan: 'plans', plans: 'plans', monthlyPlan: 'plans',
  task: 'tasks', weeklyRecord: 'weeklyRecords', historicalRecord: 'history', report: 'reports',
}
const id = z.string().min(1).max(200)
const line = z.string().max(12000)
const timestamp = z.string().max(40).regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/).refine(v => Number.isFinite(Date.parse(v)))
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v)
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/)
const entity = { id, version: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), createdAt: timestamp, updatedAt: timestamp }
const importSourceSchema = z.object({ batchId: id, sourceId: id, rowId: id, sourceStatus: line }).strict()
export const userSchema = z.object({ ...entity, name: z.string().min(1).max(100), email: z.string().min(3).max(254), role: z.enum(['manager', 'member']), position: z.string().max(100), active: z.boolean() }).strict()
const projectSchema = z.object({ ...entity, name: z.string().min(1).max(200), code: z.string().min(1).max(50), description: line, ownerId: id, status: z.enum(['active', 'archived']) }).strict()
const goalSchema = z.object({ ...entity, title: z.string().min(1).max(300), year: z.number().int().min(1900).max(2200), target: line.min(1), progress: z.number().min(0).max(100), description: line, ownerId: id, status: z.enum(['active', 'completed']) }).strict()
const planSchema = z.object({ ...entity, month, title: z.string().min(1).max(300), projectId: id.nullable(), category: z.string().max(100), ownerId: id, collaboratorIds: z.array(id).max(100),
  expectedOutcome: line, acceptanceCriteria: line, dueDate: z.union([day, z.literal('')]), priority: z.enum(['high', 'medium', 'low']), status: z.enum(['draft', 'submitted', 'approved', 'returned', 'published', 'merged']),
  reviewComment: line, publishedVersion: z.number().int().positive().nullable(), sourcePlanId: id.nullable(), actualOutcome: line, acceptanceStatus: z.enum(['pending', 'submitted', 'accepted', 'not_completed']), acceptanceNote: line,
  mergedFromIds: z.array(id).max(50).optional(), mergedIntoId: id.optional(), importSource: importSourceSchema.optional(),
}).strict().superRefine((row, ctx) => {
  if (!row.importSource && (!row.expectedOutcome.trim() || !row.acceptanceCriteria.trim() || !row.dueDate)) ctx.addIssue({ code: 'custom', message: '普通月计划的预期成果、验收标准和截止日期不可为空' })
})
const taskSchema = z.object({ ...entity, title: z.string().min(1).max(300), monthlyPlanId: id.nullable(), ownerId: id, description: z.string().max(20000), dueDate: z.union([day, z.literal('')]),
  status: z.enum(['todo', 'doing', 'blocked', 'done']), isTemporary: z.boolean(), temporaryReason: line, importSource: importSourceSchema.optional(),
}).strict().superRefine((row, ctx) => {
  if (!row.importSource && (!row.dueDate || row.description.length > 12000)) ctx.addIssue({ code: 'custom', message: '普通任务的截止日期或说明格式无效' })
})
const weeklySchema = z.object({ ...entity, taskId: id, monthlyPlanId: id.nullable(), ownerId: id, weekStart: day, commitment: line, actualOutcome: line,
  evidenceUrl: z.string().max(2000).refine(v => { if (!v) return true; try { return ['http:', 'https:'].includes(new URL(v).protocol) } catch { return false } }),
  blocker: line, nextAction: line, status: z.enum(['planned', 'doing', 'blocked', 'done', 'not_done']), submitted: z.boolean(), importSource: importSourceSchema.optional(),
}).strict().superRefine((row, ctx) => {
  if (!row.importSource && !row.commitment.trim()) ctx.addIssue({ code: 'custom', message: '普通周记录的本周承诺不可为空' })
})
const importRowSchema = z.object({ id, kind: z.enum(['monthly', 'weekly']), selected: z.boolean(), sourceSheet: z.string().max(200), sourceRow: z.number().int().positive(), sourceText: z.string().max(20000),
  ownerName: line, ownerId: line, projectName: line, projectId: line, category: line, title: z.string().max(300), month: line, weekStart: line, dueDate: line,
  expectedOutcome: line, acceptanceCriteria: line, actualOutcome: line, blocker: line, nextAction: line, sourceStatus: line, monthlyPlanId: line, linkedRowId: line, taskId: line, issues: z.array(line).max(100),
  monthlyResult: z.enum(['pending', 'submitted', 'accepted', 'not_completed']).optional(), weeklyStatus: z.enum(['planned', 'doing', 'blocked', 'done', 'not_done']).optional(),
  result: z.object({ collection: z.enum(['plans', 'tasks', 'weeklyRecords', 'historicalRecords']), id }).strict().optional(),
}).strict()
const historySchema = z.object({ ...entity, importedBy: id, batchId: id, sourceId: id, row: importRowSchema }).strict()
const reportPatchSchema = z.object({ id: id.optional(), version: z.number().int().positive(), title: z.string().max(200).optional(), narrative: z.string().max(120000).optional(), status: z.enum(['draft', 'finalized']).optional(), finalizedAt: timestamp.nullable().optional() }).strict()
const auditSchema = z.object({ ...entity, entityType: z.enum(['project', 'annualGoal', 'plan', 'plans', 'monthlyPlan', 'task', 'weeklyRecord', 'historicalRecord', 'report']), entityId: id, actorId: id, action: z.string().min(1).max(100), reason: line, before: z.unknown(), after: z.unknown() }).strict().superRefine((event, ctx) => {
  const schema = event.entityType === 'report' ? reportPatchSchema : ({ project: projectSchema, annualGoal: goalSchema, plan: planSchema, plans: planSchema, monthlyPlan: planSchema, task: taskSchema, weeklyRecord: weeklySchema, historicalRecord: historySchema } as const)[event.entityType]
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
}).strict()
const reportSchema = z.object({ ...entity, type: z.enum(['weekly', 'monthly']), period: z.string().max(10), title: z.string().min(1).max(200), status: z.enum(['draft', 'finalized']), revision: z.number().int().positive(), narrative: z.string().max(120000), snapshot: snapshotSchema, authorId: id, finalizedAt: timestamp.nullable() }).strict()
export const schemas = { users: userSchema, projects: projectSchema, annualGoals: goalSchema, plans: planSchema, tasks: taskSchema, weeklyRecords: weeklySchema, history: historySchema, publications: publicationSchema, reports: reportSchema, events: auditSchema }
const collectionsSchema = z.object({ users: z.array(userSchema).max(50000), projects: z.array(projectSchema).max(50000), annualGoals: z.array(goalSchema).max(50000), plans: z.array(planSchema).max(50000),
  tasks: z.array(taskSchema).max(50000), weeklyRecords: z.array(weeklySchema).max(50000), history: z.array(historySchema).max(50000), publications: z.array(publicationSchema).max(50000), reports: z.array(reportSchema).max(50000), events: z.array(auditSchema).max(50000),
}).strict()
const packetSchema = z.object({ application: z.literal('lab-planning'), formatVersion: z.literal(1), exportedAt: timestamp, collections: collectionsSchema }).strict()

export function parsePacket(input: unknown): BusinessDataPacket {
  let encoded: string
  try { encoded = JSON.stringify(input) } catch { throw new HttpError(400, '迁移包必须是有效 JSON') }
  if (!encoded || Buffer.byteLength(encoded) > 32 * 1024 * 1024) throw new HttpError(400, '迁移包不得超过 32 MB')
  const parsed = packetSchema.safeParse(input)
  if (!parsed.success) {
    const location = parsed.error.issues[0]?.path.map(String).join('.') || '根对象'
    throw new HttpError(400, `迁移包格式无效或含未允许字段：${location}`)
  }
  return parsed.data as BusinessDataPacket
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
  if (row.importSource) row.importSource = pick(row.importSource, Object.keys(importSourceSchema.shape))
  if (collection === 'history') row.row = pick(row.row, Object.keys(importRowSchema.shape))
  if (collection === 'publications') row.plans = (row.plans as unknown[]).map(plan => projectRow('plans', plan))
  if (collection === 'reports') {
    const snapshot = row.snapshot as Record<string, unknown[]>
    row.snapshot = Object.fromEntries(Object.keys(snapshotSchema.shape).filter(key => snapshot[key] !== undefined).map(key => {
      const target = ({ contextPlans: 'plans', nextPlans: 'plans', nextWeeklyRecords: 'weeklyRecords', changes: 'events' } as Record<string, TransferCollection>)[key] ?? key as TransferCollection
      return [key, snapshot[key].map(item => projectRow(target, item))]
    }))
  }
  if (collection === 'events') {
    const target = businessEventCollections[String(row.entityType)]
    for (const field of ['before', 'after']) {
      const item = row[field]
      if (item === null) continue
      const project = (entry: unknown) => target === 'reports' ? pick(entry, Object.keys(reportPatchSchema.shape)) : projectRow(target, entry)
      row[field] = Array.isArray(item) ? item.map(project) : project(item)
    }
  }
  return row
}

export function emptyCollections(): BusinessCollections {
  return { users: [], projects: [], annualGoals: [], plans: [], tasks: [], weeklyRecords: [], history: [], publications: [], reports: [], events: [] }
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
  const visit = (target: TransferCollection, input: unknown, nested = false) => {
    const row = input as Record<string, unknown>
    if (nested) add(target, row.id)
    if (['projects', 'annualGoals', 'plans', 'tasks', 'weeklyRecords'].includes(target)) add('users', row.ownerId)
    if (target === 'plans') {
      add('projects', row.projectId); add('plans', row.sourcePlanId); add('plans', row.mergedIntoId)
      for (const id of row.collaboratorIds as string[]) add('users', id)
      for (const id of (row.mergedFromIds ?? []) as string[]) add('plans', id)
    }
    if (target === 'tasks' || target === 'weeklyRecords') add('plans', row.monthlyPlanId)
    if (target === 'weeklyRecords') add('tasks', row.taskId)
    if (target === 'history') {
      add('users', row.importedBy)
      const item = row.row as Record<string, unknown>
      add('users', item.ownerId); add('projects', item.projectId); add('plans', item.monthlyPlanId); add('tasks', item.taskId)
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
        const child = ({ contextPlans: 'plans', nextPlans: 'plans', nextWeeklyRecords: 'weeklyRecords', changes: 'events' } as Record<string, TransferCollection>)[key] ?? key as TransferCollection
        for (const item of items) visit(child, item, true)
      }
    }
    if (target === 'events') {
      add('users', row.actorId)
      const child = businessEventCollections[String(row.entityType)]
      add(child, row.entityId)
      if (child !== 'reports') for (const field of ['before', 'after']) {
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
  const replace = (field: string) => { if (typeof row[field] === 'string' && mapping[row[field] as string]) row[field] = mapping[row[field] as string] }
  if (collection === 'users') replace('id')
  if (['projects', 'annualGoals', 'plans', 'tasks', 'weeklyRecords'].includes(collection)) replace('ownerId')
  if (collection === 'plans') row.collaboratorIds = (row.collaboratorIds as string[]).map(id => mapping[id] ?? id)
  if (collection === 'history') {
    replace('importedBy')
    const item = row.row as Record<string, unknown>
    if (typeof item.ownerId === 'string' && mapping[item.ownerId]) item.ownerId = mapping[item.ownerId]
  }
  if (collection === 'publications') { replace('actorId'); row.plans = (row.plans as unknown[]).map(plan => remapUsers('plans', plan, mapping)) }
  if (collection === 'reports') {
    replace('authorId')
    row.snapshot = Object.fromEntries(Object.entries(row.snapshot as Record<string, unknown[]>).map(([key, items]) => {
      const child = ({ contextPlans: 'plans', nextPlans: 'plans', nextWeeklyRecords: 'weeklyRecords', changes: 'events' } as Record<string, TransferCollection>)[key] ?? key as TransferCollection
      return [key, items.map(item => remapUsers(child, item, mapping))]
    }))
  }
  if (collection === 'events') {
    replace('actorId')
    const child = businessEventCollections[String(row.entityType)]
    if (child !== 'reports') for (const field of ['before', 'after']) {
      const item = row[field]
      row[field] = item === null ? null : Array.isArray(item) ? item.map(value => remapUsers(child, value, mapping)) : remapUsers(child, item, mapping)
    }
  }
  return row
}
