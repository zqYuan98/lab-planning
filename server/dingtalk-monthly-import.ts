import { createHash } from 'node:crypto'
import type { Entity, MonthlyPlan, User } from '../shared/types.ts'
import type { ImportBatch, ImportRow } from '../shared/import-types.ts'
import type { DingTalkDocumentDiscovery, DingTalkDocumentCandidate, DingTalkBatchReview, DingTalkRowResolution, DingTalkResolveResult } from '../shared/dingtalk-monthly-api.ts'
import type { DingTalkSheetSnapshot, DingTalkMonthlyMapping, DingTalkImportedItem } from '../shared/dingtalk-documents.ts'
import type { DingTalkDocumentsClient } from './dingtalk-documents-client.ts'
import { managerActor } from './authorization.ts'
import { HttpError, Store } from './store.ts'
import { ImportService } from './import-service.ts'
import { mapMonthlySheet, monthlySourceRule, compareMonthlyRows } from './dingtalk-monthly-mapping.ts'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const normalizedTitle = (value: string) => value.normalize('NFKC').replace(/\s+/g, '').toLowerCase()
interface Discovery extends Entity { value: DingTalkDocumentDiscovery; expiresAt: number }
interface Snapshot extends Entity { sourceIdentity: string; snapshot: DingTalkSheetSnapshot; mapping: DingTalkMonthlyMapping; candidate: DingTalkDocumentCandidate }
interface Ledger extends Entity, DingTalkImportedItem { sourceIdentity: string; targetMonth: string; sourceText: string; actorId: string }
interface Resolution extends Entity, DingTalkRowResolution { batchId: string; rowId: string; fingerprint: string }
interface MonthlyBinding extends Entity { targetMonth: string; candidate: DingTalkDocumentCandidate }

/** One service per store. Remote I/O always finishes before a synchronous SQLite transaction. */
export class DingTalkMonthlyImportService {
  private pending = new Set<string>()
  constructor(private store: Store, private imports: ImportService, private client: DingTalkDocumentsClient) {}
  status(actor: User) { managerActor(this.store, actor); return this.client.status() }
  async discover(actor: User, input: Record<string, unknown>): Promise<DingTalkDocumentDiscovery> {
    actor = managerActor(this.store, actor)
    const month = String(input.month ?? '')
    monthlySourceRule(month)
    if (input.documentUrl !== undefined && typeof input.documentUrl !== 'string') throw new HttpError(400, '文档链接无效')
    const found = await this.client.discover(month, input.documentUrl as string | undefined)
    managerActor(this.store, actor)
    const bound = this.store.list<MonthlyBinding>('dingtalkMonthlyBindings').find(binding => binding.targetMonth === month && found.candidates.length === 1 && binding.candidate.id === found.candidates[0].id)
    if (found.complete && bound) {
      found.candidates[0] = { ...found.candidates[0], recommended: true }
      found.recommendedCandidateId = found.candidates[0].id
    }
    // Never turn a partial search into a claim that the sole returned candidate is unique.
    const id = digest({ targetMonth: month, candidates: found.candidates, complete: found.complete })
    const value = { ...found, id, targetMonth: month }
    const before = this.store.get<Discovery>('dingtalkDiscoveries', id)
    const fields = { value, expiresAt: Date.now() + 15 * 60_000 }
    if (before) this.store.update<Discovery>('dingtalkDiscoveries', id, before.version, fields)
    else this.store.insert<Discovery>('dingtalkDiscoveries', { id, ...fields })
    return value
  }
  async fetch(actor: User, input: Record<string, unknown>): Promise<ImportBatch> {
    actor = managerActor(this.store, actor)
    const discovery = this.store.get<Discovery>('dingtalkDiscoveries', String(input.discoveryId))
    if (!discovery || discovery.expiresAt < Date.now()) throw new HttpError(409, '查找结果已过期，请重新查找')
    if (!discovery.value.complete) throw new HttpError(409, '目录查找尚未完成，请缩小范围后重新查找')
    const candidate = discovery.value.candidates.find(item => item.id === input.candidateId)
    if (!candidate) throw new HttpError(400, '请选择本次查找范围内的有效文件和工作表')
    const snapshot = await this.client.read(candidate, discovery.value.targetMonth)
    managerActor(this.store, actor)
    if (snapshot.documentId !== candidate.documentId || snapshot.sheetId !== candidate.sheetId || snapshot.targetMonth !== discovery.value.targetMonth) throw new HttpError(409, '读取结果与所选来源不一致')
    const mapping = mapMonthlySheet(snapshot)
    if (!mapping.rows.length) throw new HttpError(400, '目标工作表没有可导入的事项')
    const sourceIdentity = digest([snapshot.connectionId, snapshot.folderId, snapshot.documentId, snapshot.sheetId, snapshot.targetMonth])
    const snapshotId = digest([sourceIdentity, mapping.contentHash])
    return this.store.transaction(() => {
      actor = managerActor(this.store, actor)
      if (!this.store.get<Snapshot>('dingtalkSnapshots', snapshotId)) this.store.insert<Snapshot>('dingtalkSnapshots', { id: snapshotId, sourceIdentity, snapshot, mapping, candidate })
      const known = this.store.get<Snapshot>('dingtalkSnapshots', snapshotId)!
      const prior = this.ledger(sourceIdentity)
      const diff = compareMonthlyRows(mapping.rows, prior, this.plans(snapshot.targetMonth))
      const rows = mapping.rows.map((item, index) => ({ ...item.candidate, selected: diff.rows[index].status === 'new', ...(diff.rows[index].status === 'new' ? {} : { exclusionReason: diff.rows[index].status === 'imported' ? '该来源事项已导入，保留原目标' : '等待核对来源差异', exclusionKind: 'task' as const }) }))
      const provenance = { sourceIdentity, snapshotId, documentId: snapshot.documentId, sheetId: snapshot.sheetId, documentTitle: snapshot.documentTitle, sheetName: snapshot.sheetName, documentUrl: snapshot.documentUrl, targetMonth: snapshot.targetMonth, contentHash: mapping.contentHash, fetchedAt: known.snapshot.readAt }
      const batch = this.imports.createDocumentBatch(actor, { id: snapshotId, provenance, rows,
        parsed: { kind: 'table', fileName: `${snapshot.documentTitle} - ${snapshot.sheetName}.json`, mimeType: 'application/vnd.lab.dingtalk-sheet+json', sheets: [{ name: snapshot.sheetName, rows: snapshot.rows, merges: snapshot.merges }], warnings: [...mapping.warnings, ...mapping.issues.map(issue => `第${issue.sourceRow}行：${issue.message}`)] } })
      const bindingId = digest([snapshot.connectionId, snapshot.folderId, snapshot.targetMonth])
      const binding = this.store.get<Entity>('dingtalkMonthlyBindings', bindingId)
      const fields = { targetMonth: snapshot.targetMonth, candidate, sourceIdentity, lastFetchedAt: snapshot.readAt }
      if (binding) this.store.update<Entity & typeof fields>('dingtalkMonthlyBindings', bindingId, binding.version, fields)
      else this.store.insert<Entity & typeof fields>('dingtalkMonthlyBindings', { id: bindingId, ...fields })
      return batch
    })
  }
  private context(actor: User, id: string) {
    actor = managerActor(this.store, actor)
    const batch = this.imports.get(actor, id)
    if (!batch.dingtalk) throw new HttpError(400, '此批次不是钉钉月度目标')
    const snapshot = this.store.get<Snapshot>('dingtalkSnapshots', batch.dingtalk.snapshotId)
    if (!snapshot) throw new HttpError(409, '来源快照不存在，请重新获取')
    if (batch.mode !== 'draft' || batch.rows.length !== snapshot.mapping.rows.length || batch.rows.some(row => row.kind !== 'monthly' || row.month !== batch.dingtalk!.targetMonth)) throw new HttpError(409, '来源事项与获取周期不一致，请重新获取')
    return { actor, batch, snapshot }
  }
  private ledger(sourceIdentity: string) {
    // A plan can have several source rows AND several historical revisions. Keep all
    // aliases: dropping one can make an unchanged source row look newly importable.
    return this.store.list<Ledger>('dingtalkSourceItems').filter(item => item.sourceIdentity === sourceIdentity).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }
  private plans(month: string) {
    const users = this.store.list<User>('users')
    return this.store.list<MonthlyPlan>('plans').filter(plan => plan.month === month).map(plan => ({ ...plan, ownerName: users.find(user => user.id === plan.ownerId)?.name ?? '' }))
  }
  private resolutionFingerprint(row: ImportRow, status: string, plans: { id: string; version: number }[]) {
    return digest({ title: row.title, ownerId: row.ownerId, month: row.month, status, plans: plans.map(plan => [plan.id, plan.version]) })
  }
  review(actor: User, id: string): DingTalkBatchReview {
    const { batch, snapshot } = this.context(actor, id)
    const prior = this.ledger(snapshot.sourceIdentity), plans = this.plans(batch.dingtalk!.targetMonth)
    const diff = compareMonthlyRows(snapshot.mapping.rows, prior, plans)
    const rows = batch.rows.map(row => {
      const item = diff.rows.find(item => item.sourceRow === row.sourceRow)
      if (!item) throw new HttpError(409, '候选来源行发生变化，请重新获取')
      // Edits may introduce a duplicate which did not exist in the original sheet.
      const editedMatches = plans.filter(plan => normalizedTitle(plan.title) === normalizedTitle(row.title) && plan.id !== row.result?.id)
      const matching = plans.filter(plan => item.planIds.includes(plan.id) || item.status === 'new' && editedMatches.some(match => match.id === plan.id))
      const status = item.status === 'new' && matching.length ? 'ambiguous' as const : item.status
      const stored = this.store.get<Resolution>('dingtalkImportResolutions', digest([id, row.id]))
      const fingerprint = this.resolutionFingerprint(row, status, matching)
      const resolution = stored?.fingerprint === fingerprint ? { action: stored.action, planId: stored.planId, reason: stored.reason } : undefined
      const old = prior.find(value => item.priorSourceKeys.includes(value.sourceKey))
      const previousSourceText = old?.sourceText ?? matching.map(plan => `${plan.title}\n预期成果：${plan.expectedOutcome}\n验收标准：${plan.acceptanceCriteria}\n截止日期：${plan.dueDate}`).join('\n\n')
      return { rowId: row.id, sourceRow: row.sourceRow, title: row.title, status,
        reason: status !== item.status ? '校对后的标题与同月已有目标重复，请核对' : item.reason,
        previousSourceText, plans: matching.map(plan => ({ id: plan.id, title: plan.title, ownerName: plan.ownerName, month: plan.month })), resolution,
        requiresResolution: !row.result && (status === 'changed' || status === 'ambiguous' || status === 'imported' && matching.length !== 1) && !resolution }
    })
    const counts = { new: 0, imported: 0, changed: 0, ambiguous: 0 }
    rows.forEach(row => counts[row.status]++)
    return { batchId: id, batchVersion: batch.version, source: batch.dingtalk!, rows, counts, removed: diff.removed.map(item => ({ title: item.title, planId: item.planId })), warnings: snapshot.mapping.warnings }
  }
  resolve(actor: User, id: string, input: Record<string, unknown>): DingTalkResolveResult {
    return this.store.transaction(() => {
      const context = this.context(actor, id), batch = context.batch
      if (batch.version !== input.version || batch.status === 'committed') throw new HttpError(409, '批次已变化，请刷新后核对')
      const review = this.review(actor, id), item = review.rows.find(row => row.rowId === input.rowId)
      if (!item) throw new HttpError(400, '请选择有效来源事项')
      const action = String(input.action)
      if (!['new', 'link', 'exclude'].includes(action)) throw new HttpError(400, '来源处理方式无效')
      const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
      if (!reason || reason.length > 1000) throw new HttpError(400, '请填写不超过1000字的核对说明')
      if (action === 'new' && ['changed', 'imported'].includes(item.status)) throw new HttpError(409, '已导入来源的变更请在原目标中处理，不能重复新增')
      const planId = action === 'link' ? String(input.planId ?? '') : undefined
      if (action === 'link' && !item.plans.some(plan => plan.id === planId)) throw new HttpError(400, '请选择此次差异列出的同月目标')
      const row = batch.rows.find(row => row.id === item.rowId)!
      const plans = this.plans(batch.dingtalk!.targetMonth).filter(plan => item.plans.some(value => value.id === plan.id))
      const fields = { batchId: id, rowId: row.id, action: action as Resolution['action'], planId, reason, fingerprint: this.resolutionFingerprint(row, item.status, plans) }
      const resolutionId = digest([id, row.id]), old = this.store.get<Resolution>('dingtalkImportResolutions', resolutionId)
      if (old) this.store.update<Resolution>('dingtalkImportResolutions', resolutionId, old.version, fields)
      else this.store.insert<Resolution>('dingtalkImportResolutions', { id: resolutionId, ...fields })
      const updated = this.imports.edit(context.actor, id, { version: batch.version, rows: batch.rows.map(value => value.id !== row.id ? value : { ...value, selected: action === 'new', exclusionReason: action === 'new' ? '' : reason, exclusionKind: 'task' }) })
      return { batch: updated, review: this.review(actor, id) }
    })
  }
  async commit(actor: User, id: string, input: Record<string, unknown>): Promise<ImportBatch> {
    const before = this.context(actor, id)
    if (before.batch.status === 'committed') return before.batch
    if (before.batch.version !== input.version) throw new HttpError(409, '批次已变化，请刷新后核对')
    if (this.pending.has(id)) throw new HttpError(409, '此批次正在核对并导入，请稍后查看结果')
    this.pending.add(id)
    try {
      const source = before.snapshot.snapshot
      const fresh = await this.client.read(before.snapshot.candidate, source.targetMonth)
      if (fresh.connectionId !== source.connectionId || fresh.folderId !== source.folderId || fresh.documentId !== source.documentId || fresh.sheetId !== source.sheetId || mapMonthlySheet(fresh).contentHash !== before.batch.dingtalk!.contentHash) throw new HttpError(409, '钉钉原表已变化，请重新获取并核对差异', 'DINGTALK_SOURCE_CHANGED')
      return this.store.transaction(() => {
        const { batch, snapshot, actor: current } = this.context(actor, id)
        if (batch.status === 'committed') return batch
        if (batch.version !== input.version) throw new HttpError(409, '核对期间批次已变化，请保存并重新确认')
        const review = this.review(current, id)
        if (review.rows.some(row => row.requiresResolution)) throw new HttpError(409, '请先逐条处理来源变更和疑似重复事项')
        for (const raw of snapshot.mapping.rows) {
          const row = batch.rows.find(row => row.sourceRow === raw.sourceRow)!
          if (!row.selected) continue
          if (raw.issues.some(issue => issue.field === 'month')) throw new HttpError(400, '工作表月份与获取周期不一致，请重新选择来源')
          if (raw.issues.some(issue => issue.field === 'content' && issue.code === 'required') && row.expectedOutcome === raw.candidate.expectedOutcome) throw new HttpError(400, `第${row.sourceRow}行缺少工作内容，请补充；备注不能代替工作内容`)
        }
        const linked = new Map<string, string>()
        for (const item of review.rows) {
          const row = batch.rows.find(row => row.id === item.rowId)!
          const action = item.resolution?.action
          if (item.status === 'imported' && !action) {
            if (item.plans.length !== 1) throw new HttpError(409, '原来源目标不存在或不唯一，请核对')
            linked.set(row.id, item.plans[0].id)
          } else if (action === 'link') linked.set(row.id, item.resolution!.planId!)
          if ((linked.has(row.id) || action === 'exclude') && row.selected) throw new HttpError(409, '事项勾选与来源处理结论不一致，请重新核对')
          if (action === 'new' && !row.selected) throw new HttpError(409, '已确认新增的事项未勾选，请重新核对处理方式')
        }
        let committed: ImportBatch
        if (batch.rows.some(row => row.selected)) committed = this.imports.commitVerifiedDocument(current, id, input, batch.dingtalk!.contentHash)
        else {
          this.imports.assertDocumentCompletion(current, id, input)
          if (!linked.size && !batch.rows.every(row => !row.selected && row.exclusionReason?.trim())) throw new HttpError(400, '请明确处理所有来源事项后再确认')
          committed = this.store.update<ImportBatch>('importBatches', id, batch.version, { status: 'committed', committedAt: new Date().toISOString(), committedCount: 0, skippedCount: 0 })
        }
        const rows = committed.rows.map(row => linked.has(row.id) ? { ...row, result: { collection: 'plans', id: linked.get(row.id)! }, resultDisposition: 'existing' as const } : row)
        for (const row of rows) {
          if (row.result?.collection !== 'plans') continue
          const raw = snapshot.mapping.rows.find(item => item.sourceRow === row.sourceRow)!
          const ledgerId = digest([snapshot.sourceIdentity, raw.sourceKey])
          const fields = { sourceIdentity: snapshot.sourceIdentity, targetMonth: source.targetMonth, sourceKey: raw.sourceKey, contentHash: raw.contentHash, sourceNumber: raw.sourceNumber, title: raw.candidate.title, ownerName: raw.candidate.ownerName, sourceText: raw.candidate.sourceText, planId: row.result.id, actorId: current.id }
          const previous = this.store.get<Ledger>('dingtalkSourceItems', ledgerId)
          if (previous && previous.planId !== fields.planId) throw new HttpError(409, '同一来源事项已关联其他目标，请重新核对')
          if (previous) this.store.update<Ledger>('dingtalkSourceItems', ledgerId, previous.version, fields)
          else this.store.insert<Ledger>('dingtalkSourceItems', { id: ledgerId, ...fields })
        }
        committed = this.store.update<ImportBatch>('importBatches', id, committed.version, { rows, skippedCount: (committed.skippedCount ?? 0) + linked.size, excludedCount: rows.filter(row => !row.result && !row.selected).length, pendingCount: 0 })
        this.store.insert<import('../shared/types.ts').AuditEvent>('events', { entityType: 'import', entityId: id, actorId: current.id, action: 'dingtalk_commit', before: null, after: { snapshotId: snapshot.id, contentHash: batch.dingtalk!.contentHash, linked: [...linked], created: committed.committedCount }, reason: '' })
        return this.imports.get(current, id)
      })
    } finally { this.pending.delete(id) }
  }
}
