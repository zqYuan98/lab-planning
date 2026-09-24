import { z } from 'zod'
import type { AuditEvent, Entity, MonthlyPlan, Publication, Task } from '../shared/types.ts'
import { periodReviewSourceCollections, type HistoricalEvidence, type PeriodReviewEntry, type PeriodReviewSnapshot, type TaskCommitmentEvent } from '../shared/period-reviews.ts'
import type { BusinessCollections, DataReference, TransferCollection } from './data-transfer-schema.ts'
import { buildPeriodReview, coverage, reviewHash, sortReviewCommitments } from './period-review-facts.ts'
import { periodReviewContentHash, periodReviewDifferences } from './period-reviews.ts'
import { commitmentScope } from './task-commitments.ts'

export const periodReviewCollectionNames = ['taskCommitmentEvents', 'historicalEvidence', 'periodReviewSnapshots'] as const
export interface PeriodReviewCollections { taskCommitmentEvents: TaskCommitmentEvent[]; historicalEvidence: HistoricalEvidence[]; periodReviewSnapshots: PeriodReviewSnapshot[] }
const id = z.string().min(1).max(200), line = z.string().max(20000), integer = z.number().int().positive(), hash = z.string().regex(/^[a-f0-9]{64}$/)
const time = z.string().max(40).refine(v => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v)
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(v => Number.isFinite(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v)
const entity = { id, version: integer, createdAt: time, updatedAt: time }
const valueSchema = z.object({ title: z.string().min(1).max(300), ownerId: id, monthlyPlanId: id.nullable(), projectId: id.nullable(), dueDate: z.union([day, z.literal('')]), scope: z.string().max(40000), cancelled: z.boolean() }).strict()
const commitmentSchema = z.object({ ...entity, taskId: id, kind: z.enum(['initial', 'deadline', 'owner', 'scope', 'association', 'cancellation']), oldValue: valueSchema.nullable(), newValue: valueSchema, effectiveAt: time, recordedAt: time, actorId: id, reason: line.min(1), sourceType: z.literal('audit'), sourceId: id, sourceVersion: integer }).strict()
const evidenceSchema = z.object({ ...entity, taskId: id, ownerId: id.nullable(), claimedAt: time, recordedAt: time, actorId: id, statement: line.min(1), evidence: z.array(line.min(1)).min(1).max(20), reason: line.min(1) }).strict()
const refSchema = z.object({ collection: z.enum(periodReviewSourceCollections), id, version: integer, hash }).strict()
const refs = z.array(refSchema).max(500000)
const submissionSchema = z.object({ id, revision: integer, submittedAt: time, applicableDueDate: day.nullable(), timely: z.boolean().nullable(), decision: z.enum(['pending_review', 'accepted', 'returned', 'withdrawn']), decidedAt: time.nullable(), acceptanceWaitMs: z.number().nonnegative().nullable() }).strict()
const entrySchema = z.object({ taskId: id, deliverableKey: id, title: z.string().min(1).max(300), ownerId: id.nullable(), projectId: id.nullable(), monthlyPlanId: id.nullable(), attributionKnown: z.boolean(), originalDueDate: day.nullable(), effectiveDueDate: day.nullable(), commitments: z.array(commitmentSchema).max(50000), submissions: z.array(submissionSchema).max(50000), firstSubmittedAt: time.nullable(), acceptedSubmittedAt: time.nullable(), acceptedAt: time.nullable(), statusAtCutoff: z.enum(['unknown', 'unsubmitted', 'pending_review', 'accepted', 'returned', 'withdrawn']), laterStatus: submissionSchema.shape.decision.nullable(), laterSubmissions: z.array(submissionSchema).max(50000), onTimeAccepted: z.boolean().nullable(), overdueIntervals: z.array(z.object({ from: time, through: time, dueDate: day, endedBy: z.enum(['deadline_change', 'submission', 'cutoff', 'cancellation']) }).strict()).max(50000), evidence: z.array(evidenceSchema).max(50000), sourceRefs: refs, unknowns: z.array(line).max(50000) }).strict()
const weeklySchema = z.object({ dutyId: id, ownerId: id, cycleWeek: day.refine(v => new Date(`${v}T00:00:00Z`).getUTCDay() === 1), kind: z.enum(['plan', 'results']), deadlineAt: time, statusAtCutoff: z.enum(['unknown', 'due', 'on_time', 'missing', 'late', 'exempt']), firstSubmittedAt: time.nullable(), missingAtDeadline: z.boolean(), laterSubmittedAt: time.nullable(), sourceRefs: refs }).strict()
const unknownSchema = z.object({ taskId: id.nullable(), ownerId: id.nullable(), code: id, message: line, from: time.nullable(), through: time }).strict()
const count = z.number().int().nonnegative()
const coverageSchema = z.object({ known: count, unknown: count, unfinished: count, total: count, onTimeAccepted: count, acceptedKnown: count, rate: z.number().min(0).max(1).nullable() }).strict()
const differenceSchema = z.object({ key: z.string().min(1).max(500), before: z.string().max(4000000), after: z.string().max(4000000) }).strict().superRefine((row, ctx) => {
  for (const field of ['before', 'after'] as const) { try { const parsed = JSON.parse(row[field]); (row.key === 'weeklyCompliance' ? z.array(weeklySchema) : entrySchema.nullable()).parse(parsed) } catch { ctx.addIssue({ code: 'custom', path: [field], message: '复盘差异必须是对应类型的冻结内容' }) } }
})
export const periodReviewSchemas = {
  taskCommitmentEvents: commitmentSchema,
  historicalEvidence: evidenceSchema,
  periodReviewSnapshots: z.object({ ...entity, period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/), cutoffAt: time, generatedAt: time, ruleVersion: z.literal('historical-v1'), laterEvidenceThrough: time.nullable(), sourceManifest: refs, entries: z.array(entrySchema).max(50000), weeklyCompliance: z.array(weeklySchema).max(50000), unknownItems: z.array(unknownSchema).max(50000), evidenceCoverage: coverageSchema, revision: integer, status: z.enum(['draft', 'finalized']), previousSnapshotId: id.nullable(), authorId: id, finalizedAt: time.nullable(), finalizedBy: id.nullable(), contentHash: hash, differences: z.array(differenceSchema).max(50000) }).strict(),
}
export const periodReviewCollectionsShape = Object.fromEntries(periodReviewCollectionNames.map(name => [name, z.array(periodReviewSchemas[name]).max(50000)])) as { [K in keyof typeof periodReviewSchemas]: z.ZodArray<typeof periodReviewSchemas[K]> }
export const emptyPeriodReviewCollectionsShape = Object.fromEntries(periodReviewCollectionNames.map(name => [name, z.array(z.never()).max(0).optional()]))
export const emptyPeriodReviewCollections = (): PeriodReviewCollections => ({ taskCommitmentEvents: [], historicalEvidence: [], periodReviewSnapshots: [] })

export function periodReviewReferences(name: string, input: Record<string, unknown>): DataReference[] {
  if (!(periodReviewCollectionNames as readonly string[]).includes(name)) return []
  const result: DataReference[] = []
  const add = (collection: TransferCollection, value: unknown) => { if (typeof value === 'string' && value) result.push({ collection, id: value }) }
  const value = (row: Record<string, unknown>) => { add('users', row.ownerId); add('plans', row.monthlyPlanId); add('projects', row.projectId) }
  const commitment = (row: TaskCommitmentEvent) => { add('tasks', row.taskId); add('users', row.actorId); add('events', row.sourceId); if (row.oldValue) value(row.oldValue as unknown as Record<string, unknown>); value(row.newValue as unknown as Record<string, unknown>) }
  const evidence = (row: HistoricalEvidence) => { add('tasks', row.taskId); add('users', row.ownerId); add('users', row.actorId) }
  const entry = (row: PeriodReviewEntry) => { add('tasks', row.taskId); value(row as unknown as Record<string, unknown>); row.commitments.forEach(commitment); row.evidence.forEach(evidence); for (const ref of row.sourceRefs) add(ref.collection, ref.id); for (const item of [...row.submissions, ...row.laterSubmissions]) add('taskDeliveries', item.id) }
  if (name === 'taskCommitmentEvents') commitment(input as unknown as TaskCommitmentEvent)
  if (name === 'historicalEvidence') evidence(input as unknown as HistoricalEvidence)
  if (name === 'periodReviewSnapshots') {
    const row = input as unknown as PeriodReviewSnapshot
    add('users', row.authorId); add('users', row.finalizedBy); add('periodReviewSnapshots', row.previousSnapshotId)
    for (const ref of row.sourceManifest) add(ref.collection, ref.id)
    row.entries.forEach(entry)
    for (const item of row.weeklyCompliance) { add('weeklyDuties', item.dutyId); add('users', item.ownerId) }
    for (const item of row.unknownItems) { add('tasks', item.taskId); add('users', item.ownerId) }
    for (const difference of row.differences) for (const field of ['before', 'after'] as const) {
      const parsed = JSON.parse(difference[field])
      if (difference.key === 'weeklyCompliance') for (const item of parsed) { add('users', item.ownerId); add('weeklyDuties', item.dutyId) }
      else if (parsed) entry(parsed)
    }
  }
  return result
}

export function remapPeriodReviewUsers(name: string, input: Record<string, unknown>, mapping: Record<string, string>) {
  if (!(periodReviewCollectionNames as readonly string[]).includes(name)) return
  // Only typed identity fields are remapped. Evidence prose is never rewritten.
  const visit = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    if (Array.isArray(value)) { value.forEach(visit); return }
    const row = value as Record<string, unknown>
    for (const [key, child] of Object.entries(row)) {
      if (['ownerId', 'actorId', 'authorId', 'finalizedBy'].includes(key) && typeof child === 'string') row[key] = mapping[child] ?? child
      else if (key !== 'differences') visit(child)
    }
  }
  visit(input)
  if (name === 'periodReviewSnapshots') {
    const row = input as unknown as PeriodReviewSnapshot
    for (const difference of row.differences) for (const field of ['before', 'after'] as const) { const parsed = JSON.parse(difference[field]); visit(parsed); difference[field] = JSON.stringify(parsed) }
    row.contentHash = periodReviewContentHash(row)
  }
}

/** Validate source fingerprints before mapping changes identities and corresponding hashes. */
export function periodReviewHashIssues(rows: BusinessCollections, issue: (message: string) => void) {
  const sources = Object.fromEntries(periodReviewSourceCollections.map(name => [name, new Map((rows[name] as Entity[]).map(row => [row.id, row]))]))
  for (const row of rows.periodReviewSnapshots) {
    if (periodReviewContentHash(row) !== row.contentHash) issue(`periodReviewSnapshots/${row.id}：冻结内容哈希不一致`)
    for (const ref of row.sourceManifest) { const source = sources[ref.collection].get(ref.id); if (source?.version === ref.version && reviewHash(source) !== ref.hash) issue(`periodReviewSnapshots/${row.id}：来源哈希不一致 ${ref.collection}/${ref.id}`) }
  }
}
export function remapReviewSourceHashes(row: PeriodReviewSnapshot, mappedSources: Record<string, Map<string, Entity>>) {
  const remap = (refs: PeriodReviewSnapshot['sourceManifest']) => { for (const ref of refs) { const source = mappedSources[ref.collection]?.get(ref.id); if (source?.version === ref.version) ref.hash = reviewHash(source) } }
  remap(row.sourceManifest)
  for (const item of [...row.entries, ...row.weeklyCompliance]) remap(item.sourceRefs)
  for (const difference of row.differences) for (const field of ['before', 'after'] as const) {
    const parsed = JSON.parse(difference[field])
    if (difference.key === 'weeklyCompliance') for (const item of parsed) remap(item.sourceRefs)
    else if (parsed) remap(parsed.sourceRefs)
    difference[field] = JSON.stringify(parsed)
  }
  row.contentHash = periodReviewContentHash(row)
}
export function periodReviewTransferIssues(rows: BusinessCollections, available: Record<TransferCollection, Map<string, Entity>>, issue: (message: string) => void) {
  const audits = [...available.events.values()] as AuditEvent[]
  const projectAt = (planId: string | null, at: string) => {
    if (!planId) return null
    const candidates = audits.filter(event => event.entityType === 'plan' && event.entityId === planId && event.createdAt <= at && event.after).map(event => ({ at: event.createdAt, plan: event.after as MonthlyPlan }))
    for (const publication of available.publications.values() as Iterable<Publication>) if (publication.createdAt <= at) for (const plan of publication.plans) if (plan.id === planId) candidates.push({ at: publication.createdAt, plan })
    return candidates.sort((a, b) => b.at.localeCompare(a.at) || b.plan.version - a.plan.version)[0]?.plan.projectId ?? null
  }
  const auditValue = (task: Task, at: string) => ({ title: task.title, ownerId: task.ownerId, monthlyPlanId: task.monthlyPlanId, projectId: projectAt(task.monthlyPlanId, at), dueDate: task.dueDate, scope: commitmentScope(task), cancelled: !!task.cancellation })
  for (const row of rows.taskCommitmentEvents) {
    const source = available.events.get(row.sourceId) as AuditEvent | undefined
    if (!source || source.version !== row.sourceVersion || !['task', 'plan'].includes(source.entityType) || source.entityType === 'task' && source.entityId !== row.taskId) issue(`taskCommitmentEvents/${row.id}：承诺审计依据不一致`)
    if (row.kind === 'initial' ? row.oldValue !== null : row.oldValue === null) issue(`taskCommitmentEvents/${row.id}：首次承诺与变更前值不一致`)
    if (row.recordedAt < row.effectiveAt || row.createdAt < row.recordedAt || source && (source.createdAt !== row.effectiveAt || source.actorId !== row.actorId)) issue(`taskCommitmentEvents/${row.id}：承诺时间或操作人不一致`)
    if (source?.entityType === 'task') {
      const withoutProject = (value: unknown) => { if (!value) return null; const { projectId: _projectId, ...fields } = value as Record<string, unknown>; return fields }
      if (!source.after || reviewHash(withoutProject(row.newValue)) !== reviewHash(withoutProject(auditValue(source.after as Task, source.createdAt))) || reviewHash(withoutProject(row.oldValue)) !== reviewHash(withoutProject(source.before ? auditValue(source.before as Task, source.createdAt) : null))) issue(`taskCommitmentEvents/${row.id}：承诺字段与原始任务审计不一致`)
    }
    if (source?.entityType === 'plan') {
      const before = source.before as MonthlyPlan | null, after = source.after as MonthlyPlan | null
      if (row.kind !== 'association' || row.newValue.monthlyPlanId !== source.entityId || row.oldValue?.monthlyPlanId !== source.entityId || !before || !after || row.oldValue.projectId !== before.projectId || row.newValue.projectId !== after.projectId) issue(`taskCommitmentEvents/${row.id}：项目关系与月目标审计不一致`)
    }
  }
  for (const row of rows.historicalEvidence) if (row.claimedAt > row.recordedAt || row.recordedAt > row.createdAt) issue(`historicalEvidence/${row.id}：补证双时间不一致`)
  const children = new Map<string, string>()
  for (const row of available.periodReviewSnapshots.values() as Iterable<PeriodReviewSnapshot>) {
    const label = `periodReviewSnapshots/${row.id}`
    if (periodReviewContentHash(row) !== row.contentHash) issue(`${label}：冻结内容哈希不一致`)
    const previous = row.previousSnapshotId ? available.periodReviewSnapshots.get(row.previousSnapshotId) as PeriodReviewSnapshot | undefined : undefined
    if (row.revision === 1 ? !!row.previousSnapshotId : !previous || previous.revision !== row.revision - 1 || previous.period !== row.period || previous.cutoffAt !== row.cutoffAt || previous.status !== 'finalized') issue(`${label}：复盘修订链断裂`)
    if (row.previousSnapshotId) { if (children.has(row.previousSnapshotId)) issue(`${label}：复盘修订分叉`); children.set(row.previousSnapshotId, row.id) }
    const finalized = row.status === 'finalized'
    if (finalized ? !row.finalizedAt || !row.finalizedBy || row.finalizedAt < row.generatedAt : row.finalizedAt !== null || row.finalizedBy !== null) issue(`${label}：定稿状态与时间、责任人不一致`)
    if (row.cutoffAt > row.generatedAt || row.laterEvidenceThrough && (!previous || row.laterEvidenceThrough <= row.cutoffAt || row.laterEvidenceThrough > row.generatedAt)) issue(`${label}：期末与事后核实时间不一致`)
    const periodStart = new Date(`${row.period}-01T00:00:00+08:00`).toISOString(), [year, month] = row.period.split('-').map(Number), periodEnd = new Date(Date.UTC(year, month, 1) - 8 * 3600000).toISOString()
    if (row.cutoffAt < periodStart || row.cutoffAt >= periodEnd) issue(`${label}：期末不属于复盘月份`)
    if (reviewHash(periodReviewDifferences(previous, row)) !== reviewHash(row.differences)) issue(`${label}：修订差异与前版事实不一致`)
    if (reviewHash(coverage(row.entries)) !== reviewHash(row.evidenceCoverage)) issue(`${label}：覆盖率与冻结条目不一致`)
    const manifest = new Map(row.sourceManifest.map(ref => [`${ref.collection}:${ref.id}`, ref]))
    if (manifest.size !== row.sourceManifest.length) issue(`${label}：来源清单重复`)
    for (const ref of row.sourceManifest) { const source = available[ref.collection].get(ref.id); if (!source || source.version < ref.version) issue(`${label}：来源版本缺失 ${ref.collection}/${ref.id}`) }
    for (const entry of [...row.entries, ...row.weeklyCompliance]) for (const ref of entry.sourceRefs) if (reviewHash(manifest.get(`${ref.collection}:${ref.id}`) ?? null) !== reviewHash(ref)) issue(`${label}：条目来源不属于冻结清单`)
    for (const entry of row.entries) {
      if (entry.attributionKnown && !entry.ownerId || !entry.attributionKnown && entry.ownerId) issue(`${label}：历史责任归属与证据状态不一致`)
      if (entry.submissions.some(s => s.submittedAt > row.cutoffAt || s.decidedAt && s.decidedAt > row.cutoffAt) || entry.overdueIntervals.some(i => i.from > i.through || i.through > row.cutoffAt)) issue(`${label}：期末事实包含事后时间`)
      if (!row.laterEvidenceThrough && (entry.laterStatus || entry.laterSubmissions.length)) issue(`${label}：未声明事后核实边界`)
      const through = row.laterEvidenceThrough || row.cutoffAt
      if (entry.commitments.some(item => item.taskId !== entry.taskId || item.effectiveAt > row.cutoffAt || item.recordedAt > row.cutoffAt) || entry.evidence.some(item => item.taskId !== entry.taskId || item.claimedAt > row.cutoffAt || item.recordedAt > through) || entry.laterSubmissions.some(item => item.submittedAt > through || item.decidedAt && item.decidedAt > through)) issue(`${label}：冻结条目超出声明的历史边界`)
      for (const item of entry.commitments) {
        const formal = available.taskCommitmentEvents.get(item.id)
        if (formal) { if (reviewHash(formal) !== reviewHash(item)) issue(`${label}：嵌入承诺与来源事实不一致`); continue }
        const audit = available.events.get(item.sourceId) as AuditEvent | undefined
        if (!audit || audit.entityType !== 'task' || audit.entityId !== entry.taskId || item.id !== audit.id || item.sourceVersion !== audit.version || item.effectiveAt !== audit.createdAt || item.recordedAt !== audit.createdAt || item.actorId !== audit.actorId || !audit.after || reviewHash(item.newValue) !== reviewHash(auditValue(audit.after as Task, audit.createdAt)) || reviewHash(item.oldValue) !== reviewHash(audit.before ? auditValue(audit.before as Task, audit.createdAt) : null)) issue(`${label}：历史审计承诺无法验证`)
      }
      for (const item of entry.evidence) if (reviewHash(available.historicalEvidence.get(item.id) ?? null) !== reviewHash(item)) issue(`${label}：嵌入补证与来源事实不一致`)
      const ordered = [...entry.commitments]; sortReviewCommitments(ordered, audits)
      const attribution = ordered.at(-1)?.newValue
      if (entry.attributionKnown !== !!attribution || entry.ownerId !== (attribution?.ownerId ?? null) || entry.monthlyPlanId !== (attribution?.monthlyPlanId ?? null) || entry.projectId !== (attribution?.projectId ?? null)) issue(`${label}：期末归属与最后有效承诺不一致`)
      for (const submission of [...entry.submissions, ...entry.laterSubmissions]) {
        const source = available.taskDeliveries.get(submission.id) as { taskId?: string; revision?: number; submittedAt?: string } | undefined
        if (!source || source.taskId !== entry.taskId || source.revision !== submission.revision || source.submittedAt !== submission.submittedAt) issue(`${label}：冻结提交与正式回执不一致`)
      }
    }
    for (const entry of row.weeklyCompliance) {
      const duty = available.weeklyDuties.get(entry.dutyId) as { ownerId?: string; cycleWeek?: string; kind?: string; deadlineAt?: string } | undefined
      if (!duty || entry.ownerId !== duty.ownerId || entry.cycleWeek !== duty.cycleWeek || entry.kind !== duty.kind || entry.deadlineAt !== duty.deadlineAt) issue(`${label}：冻结周提报与正式义务不一致`)
      if (entry.firstSubmittedAt && entry.firstSubmittedAt > row.cutoffAt || entry.laterSubmittedAt && (!row.laterEvidenceThrough || entry.laterSubmittedAt > row.laterEvidenceThrough)) issue(`${label}：周提报时间越过历史边界`)
    }
    if (new Set(row.entries.map(entry => `${entry.taskId}:${entry.deliverableKey}`)).size !== row.entries.length || new Set(row.weeklyCompliance.map(entry => entry.dutyId)).size !== row.weeklyCompliance.length) issue(`${label}：冻结条目重复`)
    // Reuse the rule-version implementation for derived decisions, timeliness and weekly compliance.
    // Restrict reconstruction to the frozen manifest; later-added source objects must not rewrite history.
    const snapshotSources = new Map<string, Set<string>>()
    for (const ref of row.sourceManifest) { if (!snapshotSources.has(ref.collection)) snapshotSources.set(ref.collection, new Set()); snapshotSources.get(ref.collection)!.add(ref.id) }
    const reconstructed = buildPeriodReview({ list: <T>(name: string): T[] => [...(available[name as TransferCollection]?.values() || [])].filter(item => snapshotSources.get(name)?.has(item.id)) as T[] }, row)
    const factValue = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(factValue)
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'sourceRefs').map(([key, child]) => [key, factValue(child)]))
      return value
    }
    const comparable = (items: unknown[]) => items.map(factValue).map(reviewHash).sort()
    if (reviewHash(comparable(reconstructed.entries)) !== reviewHash(comparable(row.entries)) || reviewHash(comparable(reconstructed.weeklyCompliance)) !== reviewHash(comparable(row.weeklyCompliance)) || reviewHash(comparable(reconstructed.unknownItems)) !== reviewHash(comparable(row.unknownItems))) issue(`${label}：派生事实与原始提交、决定和义务不一致`)
  }
}
