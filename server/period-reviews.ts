import type { Entity, MonthlyPlan, Project, User } from '../shared/types.ts'
import type { HistoricalEvidence, PeriodReviewContent, PeriodReviewDisplayReferences, PeriodReviewPreview, PeriodReviewSnapshot } from '../shared/period-reviews.ts'
import { periodReviewLabel, reviewStatusLabels } from '../shared/period-reviews.ts'
import { buildPeriodReview, coverage, reviewHash } from './period-review-facts.ts'
import { businessActor, cas, type Input } from './delivery-common.ts'
import { requiredText, utcTime } from './collaboration-store.ts'
import { assertOperationEpoch, getOperationEpoch } from './operation-context.ts'
import { HttpError, type Store } from './store.ts'

type Receipt = Entity & { actorId: string; command: string; requestId: string; payloadHash: string; resultId: string }
export function periodReviewContentHash(review: PeriodReviewContent & { revision: number; previousSnapshotId: string | null; differences: PeriodReviewSnapshot['differences'] }): string {
  const { period, cutoffAt, generatedAt, ruleVersion, laterEvidenceThrough, sourceManifest, entries, weeklyCompliance, unknownItems, evidenceCoverage, revision, previousSnapshotId, differences } = review
  return reviewHash({ period, cutoffAt, generatedAt, ruleVersion, laterEvidenceThrough, sourceManifest, entries, weeklyCompliance, unknownItems, evidenceCoverage, revision, previousSnapshotId, differences })
}
export function periodReviewDifferences(previous: PeriodReviewSnapshot | undefined, current: PeriodReviewContent): PeriodReviewSnapshot['differences'] {
  if (!previous) return []
  const before = new Map(previous.entries.map(row => [`${row.taskId}:${row.deliverableKey}`, row])), after = new Map(current.entries.map(row => [`${row.taskId}:${row.deliverableKey}`, row]))
  const changes: PeriodReviewSnapshot['differences'] = []
  for (const key of new Set([...before.keys(), ...after.keys()])) {
    const old = before.get(key), next = after.get(key)
    if (reviewHash(old ?? null) !== reviewHash(next ?? null)) changes.push({ key, before: JSON.stringify(old ?? null), after: JSON.stringify(next ?? null) })
  }
  if (reviewHash(previous.weeklyCompliance) !== reviewHash(current.weeklyCompliance)) changes.push({ key: 'weeklyCompliance', before: JSON.stringify(previous.weeklyCompliance), after: JSON.stringify(current.weeklyCompliance) })
  return changes
}
export class PeriodReviewService {
  constructor(private store: Store, private clock: () => Date = () => new Date()) {}
  private need(id: string): PeriodReviewSnapshot { const row = this.store.get<PeriodReviewSnapshot>('periodReviewSnapshots', id); if (!row) throw new HttpError(404, '复盘快照不存在'); return row }
  private options(input: Input) {
    const period = requiredText(input.period, '复盘月份', true, 7)
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(period)) throw new HttpError(400, '复盘月份格式应为 YYYY-MM')
    const [year, month] = period.split('-').map(Number), end = new Date(Date.UTC(year, month, 1) - 8 * 3600000 - 1).toISOString()
    const cutoffAt = input.cutoffAt ? utcTime(input.cutoffAt, '期末时点') : end, start = new Date(`${period}-01T00:00:00+08:00`).toISOString(), now = this.clock().toISOString()
    if (cutoffAt < start || cutoffAt > end || cutoffAt > now) throw new HttpError(400, '期末时点必须属于所选月份，且不能晚于当前时间')
    const laterEvidenceThrough = input.laterEvidenceThrough ? utcTime(input.laterEvidenceThrough, '事后证据时点') : null
    if (laterEvidenceThrough && (laterEvidenceThrough <= cutoffAt || laterEvidenceThrough > now)) throw new HttpError(400, '事后证据时点必须晚于期末且不晚于当前时间')
    return { period, cutoffAt, laterEvidenceThrough, generatedAt: now }
  }
  private previewInTransaction(actor: User, input: Input): PeriodReviewPreview {
    businessActor(this.store, actor, true)
    const options = this.options(input), previous = input.previousSnapshotId ? this.need(requiredText(input.previousSnapshotId, '前版快照')) : undefined
    if (previous && (previous.status !== 'finalized' || previous.period !== options.period || previous.cutoffAt !== options.cutoffAt)) throw new HttpError(409, '修订必须关联同周期、同期末的已定稿快照')
    if (options.laterEvidenceThrough && !previous) throw new HttpError(400, '事后核实须作为已定稿快照的修订')
    const content = buildPeriodReview(this.store, options), revision = previous ? previous.revision + 1 : 1, previousSnapshotId = previous?.id ?? null
    const changes = periodReviewDifferences(previous, content)
    const fingerprint = reviewHash({ ...content, generatedAt: undefined, revision, previousSnapshotId, differences: changes })
    return { ...content, revision, previousSnapshotId, differences: changes, fingerprint, operationEpoch: getOperationEpoch(this.store) }
  }
  preview(actor: User, input: Input): PeriodReviewPreview { return this.store.transaction(() => this.previewInTransaction(actor, input)) }
  private command(actor: User, name: string, input: Input, operation: () => PeriodReviewSnapshot | HistoricalEvidence) {
    return this.store.transaction(() => {
      actor = businessActor(this.store, actor, true)
      assertOperationEpoch(this.store, input.operationEpoch)
      const requestId = requiredText(input.requestId, '提交标识', true, 100)
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(requestId)) throw new HttpError(400, '提交标识格式无效')
      const id = reviewHash([actor.id, name, requestId]), payloadHash = reviewHash(input), previous = this.store.get<Receipt>('periodReviewReceipts', id)
      if (previous) {
        if (previous.payloadHash !== payloadHash) throw new HttpError(409, '提交标识已用于不同内容', 'IDEMPOTENCY_MISMATCH')
        const result = this.store.get<PeriodReviewSnapshot | HistoricalEvidence>(name === 'evidence' ? 'historicalEvidence' : 'periodReviewSnapshots', previous.resultId)
        if (!result) throw new HttpError(409, '操作回执目标已失效，请重新核对')
        return result
      }
      const result = operation()
      this.store.insert<Receipt>('periodReviewReceipts', { id, actorId: actor.id, command: name, requestId, payloadHash, resultId: result.id })
      return result
    })
  }
  create(actor: User, input: Input): PeriodReviewSnapshot {
    return this.command(actor, 'create', input, () => {
      const preview = this.previewInTransaction(actor, input)
      if (preview.fingerprint !== input.fingerprint || reviewHash(preview.sourceManifest) !== reviewHash(input.sourceManifest)) throw new HttpError(409, '事实来源已变化，请重新预览', 'SOURCE_CONFLICT')
      const { fingerprint: _fingerprint, operationEpoch: _epoch, ...content } = preview
      if (content.previousSnapshotId && this.store.list<PeriodReviewSnapshot>('periodReviewSnapshots').some(row => row.previousSnapshotId === content.previousSnapshotId)) throw new HttpError(409, '此版本已有修订，请从最新修订继续')
      return this.store.insert<PeriodReviewSnapshot>('periodReviewSnapshots', { ...content, status: 'draft', authorId: actor.id, finalizedAt: null, finalizedBy: null, contentHash: periodReviewContentHash(content) })
    }) as PeriodReviewSnapshot
  }
  finalize(actor: User, id: string, input: Input): PeriodReviewSnapshot {
    return this.command(actor, `finalize:${id}`, input, () => {
      const review = this.need(id); cas(review.version, input.version)
      if (review.status !== 'draft') throw new HttpError(409, '此快照已定稿')
      if (input.contentHash !== review.contentHash || periodReviewContentHash(review) !== review.contentHash) throw new HttpError(409, '快照内容不一致，请重新核对', 'CONTENT_CONFLICT')
      return this.store.update<PeriodReviewSnapshot>('periodReviewSnapshots', id, review.version, { status: 'finalized', finalizedAt: this.clock().toISOString(), finalizedBy: actor.id })
    }) as PeriodReviewSnapshot
  }
  addEvidence(actor: User, input: Input): HistoricalEvidence {
    return this.command(actor, 'evidence', input, () => {
      const taskId = requiredText(input.taskId, '任务'), claimedAt = utcTime(input.claimedAt, '声称发生时间'), recordedAt = this.clock().toISOString()
      if (claimedAt > recordedAt) throw new HttpError(400, '补证发生时间不能在未来')
      if (!this.store.get('tasks', taskId) && !this.store.list<{ taskId: string }>('taskCommitmentEvents').some(row => row.taskId === taskId)) throw new HttpError(404, '任务不存在')
      if (!Array.isArray(input.evidence) || !input.evidence.length || input.evidence.length > 20) throw new HttpError(400, '请提供 1 至 20 项佐证')
      const ownerId = input.ownerId ? requiredText(input.ownerId, '声称责任人') : null
      if (ownerId && !this.store.get('users', ownerId)) throw new HttpError(400, '声称责任人不存在')
      return this.store.insert<HistoricalEvidence>('historicalEvidence', { taskId, ownerId, claimedAt, recordedAt, actorId: actor.id,
        statement: requiredText(input.statement, '佐证说明'), evidence: input.evidence.map(item => requiredText(item, '证据')), reason: requiredText(input.reason, '补证原因') })
    }) as HistoricalEvidence
  }
  read(actor: User, id: string): PeriodReviewSnapshot {
    return this.store.transaction(() => {
      actor = businessActor(this.store, actor)
      const review = this.need(id)
      if (actor.role === 'manager') return review
      if (review.status !== 'finalized') throw new HttpError(404, '复盘不存在')
      const entries = review.entries.filter(row => row.attributionKnown && row.ownerId === actor.id), weeklyCompliance = review.weeklyCompliance.filter(row => row.ownerId === actor.id)
      if (!entries.length && !weeklyCompliance.length) throw new HttpError(404, '复盘不存在')
      // No department manifest, comparison payload, draft or unknown-owner fact reaches members.
      const allowedRefs = new Set([...entries.flatMap(row => row.sourceRefs), ...weeklyCompliance.flatMap(row => row.sourceRefs)].map(row => `${row.collection}:${row.id}`))
      return { ...review, entries, weeklyCompliance, sourceManifest: review.sourceManifest.filter(row => allowedRefs.has(`${row.collection}:${row.id}`)),
        unknownItems: review.unknownItems.filter(row => row.ownerId === actor.id), differences: [], evidenceCoverage: coverage(entries) }
    })
  }
  list(actor: User) {
    actor = businessActor(this.store, actor)
    return this.store.list<PeriodReviewSnapshot>('periodReviewSnapshots').filter(row => actor.role === 'manager' || row.status === 'finalized' && (row.entries.some(entry => entry.attributionKnown && entry.ownerId === actor.id) || row.weeklyCompliance.some(entry => entry.ownerId === actor.id)))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)).map(({ id, version, period, cutoffAt, generatedAt, revision, status, laterEvidenceThrough, ruleVersion, previousSnapshotId }) => ({ id, version, period, cutoffAt, generatedAt, revision, status, laterEvidenceThrough, ruleVersion, previousSnapshotId }))
  }
  displayReferences(actor: User, review: PeriodReviewContent): PeriodReviewDisplayReferences {
    actor = businessActor(this.store, actor)
    const entries = review.entries.filter(row => actor.role === 'manager' || row.ownerId === actor.id)
    const ownerIds = new Set([...entries.map(row => row.ownerId), ...review.weeklyCompliance.filter(row => actor.role === 'manager' || row.ownerId === actor.id).map(row => row.ownerId)])
    const planIds = new Set(entries.map(row => row.monthlyPlanId)), projectIds = new Set(entries.map(row => row.projectId))
    return { users: [...ownerIds].flatMap(id => { const row = id ? this.store.get<User>('users', id) : null; return row ? [{ id: row.id, name: row.name }] : [] }),
      // Department managers can resolve live dictionary names. Member historical scope does not grant today's private goal details.
      plans: actor.role === 'manager' ? [...planIds].flatMap(id => { const row = id ? this.store.get<MonthlyPlan>('plans', id) : null; return row ? [{ id: row.id, title: row.title }] : [] }) : [],
      projects: actor.role === 'manager' ? [...projectIds].flatMap(id => { const row = id ? this.store.get<Project>('projects', id) : null; return row ? [{ id: row.id, name: row.name }] : [] }) : [] }
  }
  export(actor: User, id: string): string {
    const review = this.read(actor, id), summary = review.evidenceCoverage
    return [periodReviewLabel(review), `版本 ${review.revision} · ${review.status === 'finalized' ? '已定稿' : '冻结草稿'} · 已知 ${summary.known} / 未知 ${summary.unknown} / 未完成 ${summary.unfinished}`, `按时达标交付：${summary.rate === null ? '暂无可判定数据' : `${Math.round(summary.rate * 100)}%（${summary.onTimeAccepted}/${summary.acceptedKnown}）`}`,
      ...review.entries.flatMap(row => [`\n${row.title} · ${reviewStatusLabels[row.statusAtCutoff]}`, `期末责任人 ${row.ownerId ?? '待核实'} / 原承诺 ${row.originalDueDate ?? '未知'} / 期末期限 ${row.effectiveDueDate ?? '未知'}`, `首次提交 ${row.firstSubmittedAt ?? '无正式回执'} / 通过版本提交 ${row.acceptedSubmittedAt ?? '待确认'} / 验收 ${row.acceptedAt ?? '待确认'}`,
        ...row.commitments.map(item => `承诺变更 ${item.kind} / 生效 ${item.effectiveAt} / 录入 ${item.recordedAt} / ${item.reason}\n变更前：${JSON.stringify(item.oldValue)}\n变更后：${JSON.stringify(item.newValue)}`),
        ...row.submissions.map(item => `提交版本 ${item.revision} / 提交 ${item.submittedAt} / 当时期限 ${item.applicableDueDate ?? '未知'} / ${item.timely === null ? '及时性待核实' : item.timely ? '按时提交' : '晚于当时期限'} / 验收等待 ${item.acceptanceWaitMs === null ? '待确认' : `${(item.acceptanceWaitMs / 3600000).toFixed(1)} 小时`}`),
        ...(row.laterStatus ? [`事后核实 ${reviewStatusLabels[row.laterStatus]}；期末仍为 ${reviewStatusLabels[row.statusAtCutoff]}`, ...row.laterSubmissions.map(item => `事后核实版本 ${item.revision} / 原提交 ${item.submittedAt} / 验收 ${item.decidedAt ?? '待确认'} / ${reviewStatusLabels[item.decision]}`)] : []),
        ...row.overdueIntervals.map(item => `历史逾期 ${item.from} — ${item.through}`), ...row.evidence.map(item => `人工补证（非正式提交）声称 ${item.claimedAt} / 录入 ${item.recordedAt} / ${item.statement} / ${item.evidence.join('；')}`), ...row.unknowns.map(item => `待核实：${item}`)]),
      '\n周提报合规（整份正式回执）', ...review.weeklyCompliance.map(row => `${row.cycleWeek} ${row.ownerId} ${row.kind} ${reviewStatusLabels[row.statusAtCutoff]} / 首交 ${row.firstSubmittedAt ?? '无'} / 事后补交 ${row.laterSubmittedAt ?? '无'}`),
      ...review.differences.map(row => `\n修订差异 ${row.key}\n旧：${row.before}\n新：${row.after}`)].join('\n')
  }
}
