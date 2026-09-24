import { createHash } from 'node:crypto'
import type { AuditEvent, Entity, MonthlyPlan, Publication, Task } from '../shared/types.ts'
import type { DeliveryDecision, TaskDelivery } from '../shared/deliveries.ts'
import type { WeeklyAdjustment, WeeklyCycle, WeeklyDuty, WeeklyMissing, WeeklySubmission } from '../shared/weekly-submissions.ts'
import { periodReviewSourceCollections, type CommitmentValue, type HistoricalEvidence, type PeriodReviewContent, type PeriodReviewEntry, type PeriodWeeklyCompliance, type ReviewCoverage, type ReviewSourceRef, type ReviewSubmission, type TaskCommitmentEvent } from '../shared/period-reviews.ts'
import type { Store } from './store.ts'
import { commitmentScope } from './task-commitments.ts'

export function canonicalReview(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalReview)
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonicalReview(item)]))
  return value
}
export const reviewHash = (value: unknown): string => createHash('sha256').update(JSON.stringify(canonicalReview(value)) ?? 'null').digest('hex')
export function sortReviewCommitments(events: TaskCommitmentEvent[], audits: AuditEvent[]): TaskCommitmentEvent[] {
  const sources = new Map(audits.map((row, index) => [row.id, { index, version: row.entityType === 'task' ? (row.after as Task | null)?.version ?? 0 : 0 }]))
  return events.sort((a, b) => a.effectiveAt.localeCompare(b.effectiveAt) || a.recordedAt.localeCompare(b.recordedAt) || (sources.get(a.sourceId)?.version ?? 0) - (sources.get(b.sourceId)?.version ?? 0) || (sources.get(a.sourceId)?.index ?? 0) - (sources.get(b.sourceId)?.index ?? 0))
}
const min = (a: string, b: string) => a < b ? a : b
const max = (a: string, b: string) => a > b ? a : b
const deadlineEnd = (day: string) => new Date(new Date(`${day}T00:00:00+08:00`).getTime() + 86400000).toISOString()
const knownAt = (row: Entity, through: string, effective: string) => row.createdAt <= through && effective <= through
export function coverage(entries: PeriodReviewEntry[]): ReviewCoverage {
  const known = entries.filter(row => !row.unknowns.length).length, acceptedKnown = entries.filter(row => !row.unknowns.length && row.onTimeAccepted !== null).length
  const onTimeAccepted = entries.filter(row => !row.unknowns.length && row.onTimeAccepted === true).length
  return { known, unknown: entries.length - known, unfinished: entries.filter(row => row.statusAtCutoff !== 'accepted').length, total: entries.length, onTimeAccepted, acceptedKnown, rate: acceptedKnown ? onTimeAccepted / acceptedKnown : null }
}
/** Every eligible collection and every row is bound, so additions/deletions also invalidate previews. */
export function readReviewSources(store: Pick<Store, 'list'>) {
  const rows = Object.fromEntries(periodReviewSourceCollections.map(collection => [collection, store.list<Entity>(collection)])) as Record<typeof periodReviewSourceCollections[number], Entity[]>
  rows.events = (rows.events as AuditEvent[]).filter(row => ['task', 'plan', 'weeklyCycle'].includes(row.entityType))
  const manifest: ReviewSourceRef[] = periodReviewSourceCollections.flatMap(collection => rows[collection].map(row => ({ collection, id: row.id, version: row.version, hash: reviewHash(row) }))).sort((a, b) => `${a.collection}:${a.id}`.localeCompare(`${b.collection}:${b.id}`))
  return { rows, manifest }
}
export function buildPeriodReview(store: Pick<Store, 'list'>, options: { period: string; cutoffAt: string; generatedAt: string; laterEvidenceThrough: string | null }): PeriodReviewContent {
  const { rows, manifest } = readReviewSources(store), { cutoffAt, laterEvidenceThrough } = options
  const through = laterEvidenceThrough || cutoffAt, periodStart = new Date(`${options.period}-01T00:00:00+08:00`).toISOString()
  const audits = rows.events as AuditEvent[], publications = rows.publications as Publication[]
  const tasks = rows.tasks as Task[], formalCommitments = rows.taskCommitmentEvents as TaskCommitmentEvent[]
  const deliveries = rows.taskDeliveries as TaskDelivery[], decisions = rows.deliveryDecisions as DeliveryDecision[]
  const evidence = rows.historicalEvidence as HistoricalEvidence[], unknownItems: PeriodReviewContent['unknownItems'] = []
  const refs = (collection: ReviewSourceRef['collection'], ids: string[]) => manifest.filter(row => row.collection === collection && ids.includes(row.id))
  const taskIds = [...new Set([...tasks.filter(row => row.createdAt <= cutoffAt).map(row => row.id), ...formalCommitments.filter(row => row.recordedAt <= cutoffAt && row.effectiveAt <= cutoffAt).map(row => row.taskId), ...audits.filter(row => row.entityType === 'task' && row.createdAt <= cutoffAt).map(row => row.entityId), ...deliveries.filter(row => knownAt(row, cutoffAt, row.submittedAt)).map(row => row.taskId)])].sort()
  const entries: PeriodReviewEntry[] = []
  function historicalProject(planId: string | null, at: string): { projectId: string | null; known: boolean } {
    if (!planId) return { projectId: null, known: true }
    const candidates = audits.filter(row => row.entityType === 'plan' && row.entityId === planId && row.createdAt <= at && row.after).map(row => ({ at: row.createdAt, plan: row.after as MonthlyPlan }))
    for (const publication of publications.filter(row => row.createdAt <= at)) for (const plan of publication.plans.filter(row => row.id === planId)) candidates.push({ at: publication.createdAt, plan })
    const latest = candidates.sort((a, b) => b.at.localeCompare(a.at) || b.plan.version - a.plan.version)[0]
    return { projectId: latest?.plan.projectId ?? null, known: !!latest }
  }
  function decisionAt(deliveryId: string, at: string): DeliveryDecision | null {
    const candidates = decisions.filter(row => row.deliveryId === deliveryId && knownAt(row, at, row.decidedAt))
    const superseded = new Set(candidates.map(row => row.supersedesDecisionId))
    return candidates.filter(row => !superseded.has(row.id)).sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))[0] ?? null
  }
  for (const taskId of taskIds) {
    const importedTask = tasks.find(row => row.id === taskId)?.importSource
    const ownAudits = audits.filter(row => row.entityType === 'task' && row.entityId === taskId && row.createdAt <= cutoffAt && row.after).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || (a.after as Task).version - (b.after as Task).version)
    const ownEvents = formalCommitments.filter(row => row.taskId === taskId && row.recordedAt <= cutoffAt && row.effectiveAt <= cutoffAt)
    const broken = ownEvents.filter(row => !audits.some(event => event.id === row.sourceId && event.version === row.sourceVersion))
    const timeline: TaskCommitmentEvent[] = ownEvents.filter(row => !broken.includes(row))
    // Legacy audits establish facts at their recording instant only; the current task is never a historical anchor.
    for (const event of ownAudits) {
      if (ownEvents.some(row => row.sourceId === event.id)) continue
      const after = event.after as Task, before = event.before as Task | null
      // Import recording time establishes provenance, never the original business commitment.
      if (event.action === 'import_existing' || !before && (importedTask || after.importSource)) continue
      const value = (task: Task): CommitmentValue => ({ title: task.title, ownerId: task.ownerId, monthlyPlanId: task.monthlyPlanId, projectId: historicalProject(task.monthlyPlanId, event.createdAt).projectId, dueDate: task.dueDate, scope: commitmentScope(task), cancelled: !!task.cancellation })
      if (before && reviewHash(value(before)) === reviewHash(value(after))) continue
      timeline.push({ id: event.id, version: event.version, createdAt: event.createdAt, updatedAt: event.updatedAt, actorId: event.actorId, reason: event.reason || '历史字段审计', taskId, kind: before ? before.dueDate !== after.dueDate ? 'deadline' : before.ownerId !== after.ownerId ? 'owner' : before.monthlyPlanId !== after.monthlyPlanId ? 'association' : 'scope' : 'initial', oldValue: before ? value(before) : null, newValue: value(after), effectiveAt: event.createdAt, recordedAt: event.createdAt, sourceType: 'audit', sourceId: event.id, sourceVersion: event.version })
    }
    sortReviewCommitments(timeline, audits)
    const last = timeline.at(-1), attribution = last?.newValue
    const initial = timeline.find(row => row.kind === 'initial'), unknowns: string[] = []
    if (!attribution) unknowns.push('缺少期末责任与承诺的历史依据')
    if (!initial) unknowns.push('首次有效承诺未知，未用当前截止日期回填')
    if (attribution && !attribution.dueDate) unknowns.push('期末尚无有效承诺期限')
    if (broken.length) unknowns.push('承诺来源断链，相关事实未采用')
    if (attribution?.monthlyPlanId && !historicalProject(attribution.monthlyPlanId, cutoffAt).known && !ownEvents.some(row => row.id === last?.id)) unknowns.push('期末项目关系待核实')
    const ownDeliveries = deliveries.filter(row => row.taskId === taskId && knownAt(row, cutoffAt, row.submittedAt))
    const seriesIds = [...new Set(ownDeliveries.map(row => row.seriesId))]
    if (!seriesIds.length) seriesIds.push(`task:${taskId}`)
    for (const seriesId of seriesIds) {
      const localUnknown = [...unknowns]
      const versions = ownDeliveries.filter(row => row.seriesId === seriesId).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.revision - b.revision)
      const laterVersions = laterEvidenceThrough ? deliveries.filter(row => row.taskId === taskId && (seriesId === `task:${taskId}` || row.seriesId === seriesId) && knownAt(row, through, row.submittedAt)).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt) || a.revision - b.revision) : []
      const latest = versions.at(-1), currentDecision = latest ? decisionAt(latest.id, cutoffAt) : null
      const periodStatus = !attribution ? 'unknown' : !latest ? 'unsubmitted' : currentDecision?.conclusion ?? 'pending_review'
      const submissionFacts = (at: string, selectedVersions = versions): ReviewSubmission[] => selectedVersions.map(delivery => {
        const commitment = timeline.filter(row => row.effectiveAt <= delivery.submittedAt && row.recordedAt <= delivery.submittedAt).at(-1)
        const due = (delivery.submittedAt > cutoffAt ? delivery.dueDateSnapshot : commitment?.newValue.dueDate || delivery.dueDateSnapshot) || null
        const decision = decisionAt(delivery.id, at)
        return { id: delivery.id, revision: delivery.revision, submittedAt: delivery.submittedAt, applicableDueDate: due, timely: due ? delivery.submittedAt < deadlineEnd(due) : null,
          decision: decision?.conclusion ?? 'pending_review', decidedAt: decision?.decidedAt ?? null, acceptanceWaitMs: decision ? Math.max(0, Date.parse(decision.decidedAt) - Date.parse(delivery.submittedAt)) : null }
      })
      const submissions = submissionFacts(cutoffAt), accepted = periodStatus === 'accepted' ? submissions.find(row => row.id === latest?.id) : undefined
      if (submissions.some(row => row.timely === null)) localUnknown.push('部分提交缺少当时有效期限，及时性待确认')
      for (const delivery of versions) if (delivery.supersedesId && !deliveries.some(row => row.id === delivery.supersedesId && row.taskId === taskId && row.seriesId === seriesId)) localUnknown.push('提交版本链不完整')
      const overdueIntervals: PeriodReviewEntry['overdueIntervals'] = []
      type Boundary = { at: string; kind: 'deadline_change' | 'submission' | 'cancellation' | 'decision' | 'cutoff'; commitment?: TaskCommitmentEvent; fulfilled?: boolean }
      const boundaries: Boundary[] = timeline.map(commitment => ({ at: commitment.effectiveAt, kind: commitment.kind === 'cancellation' ? 'cancellation' : 'deadline_change', commitment }))
      for (const delivery of versions) {
        boundaries.push({ at: delivery.submittedAt, kind: 'submission', fulfilled: true })
        for (const decision of decisions.filter(row => row.deliveryId === delivery.id && knownAt(row, cutoffAt, row.decidedAt))) {
          if (versions.filter(row => row.submittedAt <= decision.decidedAt).at(-1)?.id === delivery.id) boundaries.push({ at: decision.decidedAt, kind: 'decision', fulfilled: decision.conclusion === 'accepted' })
        }
      }
      boundaries.push({ at: cutoffAt, kind: 'cutoff' })
      boundaries.sort((a, b) => a.at.localeCompare(b.at))
      let cursor = periodStart, due: string | null = null, fulfilled = false, cancelled = false
      for (const boundary of boundaries) {
        if (due && !fulfilled && !cancelled) {
          const from = max(max(cursor, periodStart), deadlineEnd(due)), end = min(boundary.at, cutoffAt)
          if (from < end) {
            const previous = overdueIntervals.at(-1)
            const endedBy = boundary.kind === 'decision' ? 'deadline_change' : boundary.kind
            if (previous && previous.through === from && previous.dueDate === due) { previous.through = end; previous.endedBy = endedBy }
            else overdueIntervals.push({ from, through: end, dueDate: due, endedBy })
          }
        }
        if (boundary.commitment) { due = boundary.commitment.newValue.dueDate || null; cancelled = boundary.commitment.newValue.cancelled }
        if (boundary.fulfilled !== undefined) fulfilled = boundary.fulfilled
        cursor = boundary.at
      }
      const supplemental = evidence.filter(row => row.taskId === taskId && row.recordedAt <= through && row.claimedAt <= cutoffAt)
      const planIds = new Set(timeline.flatMap(row => [row.oldValue?.monthlyPlanId, row.newValue.monthlyPlanId]).filter(Boolean))
      const sourceVersions = [...versions, ...laterVersions]
      const sourceRefs = [...refs('taskCommitmentEvents', ownEvents.map(row => row.id)), ...refs('events', [...ownAudits.map(row => row.id), ...timeline.map(row => row.sourceId), ...audits.filter(row => row.entityType === 'plan' && planIds.has(row.entityId) && row.createdAt <= cutoffAt).map(row => row.id)]), ...refs('publications', publications.filter(row => row.createdAt <= cutoffAt && row.plans.some(plan => planIds.has(plan.id))).map(row => row.id)), ...refs('taskDeliveries', sourceVersions.map(row => row.id)), ...refs('deliveryDecisions', decisions.filter(row => sourceVersions.some(delivery => delivery.id === row.deliveryId) && knownAt(row, through, row.decidedAt)).map(row => row.id)), ...refs('historicalEvidence', supplemental.map(row => row.id))]
      const laterFacts = submissionFacts(through, laterVersions)
      const laterHeads = [...new Set(laterVersions.map(row => row.seriesId))].map(id => laterVersions.filter(row => row.seriesId === id).at(-1)!).map(row => laterFacts.find(item => item.id === row.id)!.decision)
      const laterStatus = laterHeads.includes('pending_review') ? 'pending_review' : laterHeads.includes('returned') ? 'returned' : laterHeads.includes('withdrawn') ? 'withdrawn' : laterHeads.length ? 'accepted' : null
      entries.push({ taskId, deliverableKey: seriesId, title: attribution?.title ?? '历史归属待核实', ownerId: attribution?.ownerId ?? null, monthlyPlanId: attribution?.monthlyPlanId ?? null, projectId: attribution?.projectId ?? null, attributionKnown: !!attribution,
        originalDueDate: initial ? timeline.find(row => !!row.newValue.dueDate)?.newValue.dueDate ?? null : null, effectiveDueDate: attribution?.dueDate || null, commitments: timeline, submissions, firstSubmittedAt: submissions.find(row => row.decision !== 'withdrawn')?.submittedAt ?? null,
        acceptedSubmittedAt: accepted?.submittedAt ?? null, acceptedAt: accepted?.decidedAt ?? null, statusAtCutoff: periodStatus,
        laterStatus,
        laterSubmissions: laterFacts,
        onTimeAccepted: accepted?.timely ?? null, overdueIntervals, evidence: supplemental, sourceRefs, unknowns: [...new Set(localUnknown)] })
      for (const message of new Set(localUnknown)) unknownItems.push({ taskId, ownerId: attribution?.ownerId ?? null, code: 'HISTORICAL_GAP', message, from: initial ? null : periodStart, through: initial?.effectiveAt ?? cutoffAt })
    }
  }
  const weeklyCompliance: PeriodWeeklyCompliance[] = []
  const cycles = rows.weeklyCycles as WeeklyCycle[], duties = rows.weeklyDuties as WeeklyDuty[], weeklySubmissions = rows.weeklySubmissions as WeeklySubmission[], adjustments = rows.weeklyAdjustments as WeeklyAdjustment[], missing = rows.weeklyMissing as WeeklyMissing[]
  for (const duty of duties.filter(row => row.createdAt <= cutoffAt && row.deadlineAt >= periodStart && row.deadlineAt <= cutoffAt)) {
    const cycleAudits = audits.filter(row => row.entityType === 'weeklyCycle' && row.entityId === duty.cycleWeek && row.createdAt <= cutoffAt && row.after)
    const cycle = [...cycles.filter(row => row.week === duty.cycleWeek && row.updatedAt <= cutoffAt), ...cycleAudits.map(row => row.after as WeeklyCycle)]
      .filter(row => knownAt(row, cutoffAt, row.frozenAt)).sort((a, b) => b.version - a.version)[0]
    const actions = adjustments.filter(row => row.dutyId === duty.id && knownAt(row, cutoffAt, row.occurredAt)).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    const lastExemption = actions.filter(row => ['exempt', 'revoke_exemption'].includes(row.action)).at(-1)
    const validSubmission = (row: WeeklySubmission) => actions.filter(action => action.submissionId === row.id && ['invalidate', 'restore'].includes(action.action)).at(-1)?.action !== 'invalidate'
    const submitted = weeklySubmissions.filter(row => row.dutyId === duty.id && knownAt(row, cutoffAt, row.submittedAt) && validSubmission(row)).sort((a, b) => a.submittedAt.localeCompare(b.submittedAt))
    const missingRows = missing.filter(row => row.dutyId === duty.id && knownAt(row, cutoffAt, row.detectedAt))
    const first = submitted[0], known = !!cycle && !cycle.needsReview && cycle.rosterIds.includes(duty.ownerId)
    const status = !known ? 'unknown' : lastExemption?.action === 'exempt' ? 'exempt' : first ? first.submittedAt < duty.deadlineAt ? 'on_time' : 'late' : missingRows.length ? 'missing' : duty.deadlineAt > cutoffAt ? 'due' : 'unknown'
    if (status === 'unknown') unknownItems.push({ taskId: null, ownerId: duty.ownerId, code: 'WEEKLY_GAP', message: `${duty.cycleWeek} ${duty.kind} 周提报正式事实不完整`, from: duty.deadlineAt, through: cutoffAt })
    const laterActions = laterEvidenceThrough ? adjustments.filter(row => row.dutyId === duty.id && knownAt(row, through, row.occurredAt)).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)) : []
    const laterReceipts = laterEvidenceThrough ? weeklySubmissions.filter(row => row.dutyId === duty.id && knownAt(row, through, row.submittedAt) && (row.submittedAt > cutoffAt || row.createdAt > cutoffAt) && laterActions.filter(action => action.submissionId === row.id && ['invalidate', 'restore'].includes(action.action)).at(-1)?.action !== 'invalidate').sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)) : []
    weeklyCompliance.push({ dutyId: duty.id, ownerId: duty.ownerId, cycleWeek: duty.cycleWeek, kind: duty.kind, deadlineAt: duty.deadlineAt, statusAtCutoff: status,
      firstSubmittedAt: first?.submittedAt ?? null, missingAtDeadline: !!missingRows.length,
      laterSubmittedAt: laterReceipts[0]?.submittedAt ?? null,
      sourceRefs: [...refs('weeklyCycles', cycle ? [cycle.id] : []), ...refs('events', cycleAudits.map(row => row.id)), ...refs('weeklyDuties', [duty.id]), ...refs('weeklySubmissions', [...submitted, ...laterReceipts].map(row => row.id)), ...refs('weeklyMissing', missingRows.map(row => row.id)), ...refs('weeklyAdjustments', [...actions, ...laterActions].map(row => row.id))] })
  }
  return { ...options, ruleVersion: 'historical-v1', entries, weeklyCompliance, sourceManifest: manifest, unknownItems, evidenceCoverage: coverage(entries) }
}
