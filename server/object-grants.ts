import { createHash } from 'node:crypto'
import type { AuditEvent, Entity, Task, User } from '../shared/types.ts'
import type { ObjectCapability, ObjectGrant, ObjectType, ScopedReport, ScopeFact } from '../shared/object-access.ts'
import { HttpError, type Store } from './store.ts'
import { activeGrant, canReadObject, factVisible, historicalBoundary, liveObjectActor, ObjectAccessService } from './object-access.ts'

type Input = Record<string, unknown>
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => (value as Input)[key] !== undefined).map(key => [key, canonical((value as Input)[key])])) : value
const required = (value: unknown, label: string, max = 12000): string => { if (typeof value !== 'string' || !value.trim() || value.length > max) throw new HttpError(400, `${label}格式无效`); return value.trim() }
const conflict = () => new HttpError(409, '授权或对象版本已变化，请刷新后重试', 'VERSION_CONFLICT')
interface Receipt extends Entity { actorId: string; requestId: string; command: string; payloadHash: string; resultId: string }
export class ObjectGrantService {
  constructor(private store: Store, private clock: () => Date = () => new Date()) {}
  private manager(actor: User) { actor = liveObjectActor(this.store, actor); if (actor.role !== 'manager') throw new HttpError(403, '此操作需要有效管理者权限'); return actor }
  private audit(actor: User, type: string, id: string, action: string, before: unknown, after: unknown, reason: string) { this.store.insert<AuditEvent>('events', { entityType: type, entityId: id, actorId: actor.id, action, reason, before, after }) }
  private command<T>(actor: User, command: string, input: Input, collection: string, operation: (actor: User) => T & Entity): T {
    const requestId = required(input.requestId, '提交标识', 100)
    if (!/^[a-zA-Z0-9_-]{8,100}$/.test(requestId)) throw new HttpError(400, '提交标识须为 8 至 100 位字母、数字、短横线或下划线')
    return this.store.transaction(() => {
      actor = this.manager(actor)
      const id = hash([actor.id, command.split(':')[0], requestId]), payloadHash = hash(canonical([command, input])), prior = this.store.get<Receipt>('objectAccessCommands', id)
      if (prior) {
        if (prior.payloadHash !== payloadHash) throw new HttpError(409, '此提交标识已用于不同内容', 'IDEMPOTENCY_MISMATCH')
        const result = this.store.get<T & Entity>(collection, prior.resultId)
        if (!result) throw new HttpError(404, '原操作对象不存在')
        return result
      }
      const result = operation(actor)
      this.store.insert<Receipt>('objectAccessCommands', { id, actorId: actor.id, command, requestId, payloadHash, resultId: result.id })
      return result
    })
  }
  list(actor: User) { this.manager(actor); return { items: this.store.list<ObjectGrant>('objectGrants') } }
  listReports(actor: User) { this.manager(actor); return { items: this.store.list<ScopedReport>('scopedReports') } }
  grant(actor: User, input: Input): ObjectGrant {
    return this.command(actor, 'grant', input, 'objectGrants', current => {
      const subjectId = required(input.subjectId, '接收人', 200), subject = this.store.get<User>('users', subjectId)
      if (!subject) throw new HttpError(400, '接收人不存在')
      liveObjectActor(this.store, subject)
      if (subject.role !== 'observer') throw new HttpError(400, '对象授权接收人须为观察者')
      const type = input.objectType as ObjectType
      if (!['task', 'project_summary', 'scoped_report'].includes(type)) throw new HttpError(400, '授权对象类型无效')
      const objectId = required(input.objectId, '授权对象', 200), collection = { task: 'tasks', project_summary: 'projects', scoped_report: 'scopedReports' }[type], object = this.store.get<Entity & { subjectId?: string }>(collection, objectId)
      if (!object) throw new HttpError(404, '授权对象不存在')
      if (object.version !== input.objectVersion) throw conflict()
      if (type === 'scoped_report' && object.subjectId !== subject.id) throw new HttpError(400, '摘要接收人不匹配')
      const caps = input.capabilities
      if (!Array.isArray(caps) || !caps.includes('read') || caps.some(cap => !['read', 'read_evidence', 'export_summary'].includes(String(cap)))) throw new HttpError(400, '授权能力必须包含读取且仅使用支持的能力')
      const capabilities = [...new Set(caps)] as ObjectCapability[], historyPolicy = input.historyPolicy ?? 'current_onward'
      if (!['current_onward', 'all_history'].includes(String(historyPolicy))) throw new HttpError(400, '历史范围无效')
      const reason = required(input.reason, '授权原因', 2000), now = this.clock().toISOString()
      const expiresAt = input.expiresAt === undefined || input.expiresAt === null || input.expiresAt === '' ? null : required(input.expiresAt, '有效期', 40)
      if (expiresAt && (!Number.isFinite(Date.parse(expiresAt)) || new Date(expiresAt).toISOString() !== expiresAt || expiresAt <= now)) throw new HttpError(400, '有效期须为未来的规范 UTC 时间')
      const prior = this.store.list<ObjectGrant>('objectGrants').find(grant => grant.subjectId === subjectId && grant.objectType === type && grant.objectId === objectId)
      if (prior && input.version !== prior.version || !prior && input.version !== undefined && input.version !== 0) throw conflict()
      // Editing capabilities or expiry of an uninterrupted grant retains its original history boundary.
      // Revoked/expired grants and explicit history-policy changes always establish a new boundary.
      const continuing = prior && !prior.revokedAt && (!prior.expiresAt || prior.expiresAt > now) && prior.historyPolicy === historyPolicy
      const data = { subjectId, objectType: type, objectId, objectVersion: continuing ? prior.objectVersion : object.version, capabilities, historyPolicy: historyPolicy as ObjectGrant['historyPolicy'], grantedBy: current.id, grantedAt: continuing ? prior.grantedAt : now, expiresAt, revokedAt: null, reason, excludedFactIds: continuing ? prior.excludedFactIds : historyPolicy === 'all_history' ? [] : historicalBoundary(this.store, type, objectId) }
      const result = prior ? this.store.update<ObjectGrant>('objectGrants', prior.id, prior.version, data) : this.store.insert<ObjectGrant>('objectGrants', data)
      this.audit(current, 'objectGrant', result.id, prior ? 'update' : 'grant', prior ?? null, result, reason)
      return result
    })
  }
  revoke(actor: User, id: string, input: Input): ObjectGrant {
    return this.command(actor, `revoke:${id}`, input, 'objectGrants', current => {
      const before = this.store.get<ObjectGrant>('objectGrants', id)
      if (!before) throw new HttpError(404, '授权不存在')
      if (before.version !== input.version) throw conflict()
      const reason = required(input.reason, '撤销原因', 2000)
      if (before.revokedAt) return before
      const result = this.store.update<ObjectGrant>('objectGrants', id, before.version, { revokedAt: this.clock().toISOString(), reason })
      this.audit(current, 'objectGrant', id, 'revoke', before, result, reason)
      return result
    })
  }
  createReport(actor: User, input: Input): ScopedReport {
    return this.command(actor, 'scopedReport', input, 'scopedReports', current => {
      const subjectId = required(input.subjectId, '接收人', 200), subject = this.store.get<User>('users', subjectId)
      if (!subject || liveObjectActor(this.store, subject).role !== 'observer') throw new HttpError(400, '摘要接收人须为有效观察者')
      if (!Array.isArray(input.taskIds) || !input.taskIds.length || input.taskIds.length > 100 || input.taskIds.some(id => typeof id !== 'string') || new Set(input.taskIds).size !== input.taskIds.length) throw new HttpError(400, '请选择 1 至 100 个不重复的授权任务')
      if (input.includeHistory !== undefined && typeof input.includeHistory !== 'boolean') throw new HttpError(400, '历史选项无效')
      const title = required(input.title, '摘要标题', 300), manifest: ScopeFact[] = [], evidenceRefs: ScopedReport['evidenceRefs'] = [], paragraphs: string[] = []
      for (const id of input.taskIds as string[]) {
        const grant = activeGrant(this.store, subject, 'task', id), task = this.store.get<Task>('tasks', id)
        if (!task || !grant) throw new HttpError(403, '接收人须先获得全部来源任务的有效授权')
        const view = new ObjectAccessService(this.store).taskView(subject, id)
        manifest.push({ objectType: 'task', objectId: id, objectVersion: task.version, factType: 'current', factId: id, factVersion: task.version, occurredAt: null, recordedAt: this.clock().toISOString() })
        paragraphs.push(`${task.title}\n状态：${task.status}；截止：${task.dueDate || '未设置'}\n${view.task.currentProgress || '暂无总体进展'}${view.task.requestedOutcome ? `\n预期交付：${view.task.requestedOutcome}` : ''}`)
        if (input.includeHistory) {
          for (const row of view.weeklyRecords) {
            const fact: ScopeFact = { objectType: 'task', objectId: id, objectVersion: task.version, factType: 'weeklyRecord', factId: row.id, factVersion: row.version, occurredAt: row.createdAt, recordedAt: row.createdAt }
            if (!factVisible(grant, fact)) continue
            manifest.push(fact); paragraphs.push(`周执行 ${row.weekStart}：${row.actualOutcome || row.commitment}`)
          }
          for (const row of view.deliveries) {
            const stored = this.store.get<Entity>('taskDeliveries', row.id)!
            const fact: ScopeFact = { objectType: 'task', objectId: id, objectVersion: task.version, factType: 'delivery', factId: row.id, factVersion: stored.version, occurredAt: row.submittedAt, recordedAt: stored.createdAt }
            if (!factVisible(grant, fact)) continue
            manifest.push(fact); paragraphs.push(`交付第 ${row.revision} 版：${row.actualOutcome}`)
          }
        }
        // Keep external evidence separate from prose; independent read_evidence is always checked.
        if (view.task.evidenceUrl) evidenceRefs.push({ objectId: id, factId: id, value: view.task.evidenceUrl })
        if (input.includeHistory) for (const row of view.weeklyRecords) if (row.evidenceUrl) evidenceRefs.push({ objectId: id, factId: row.id, value: row.evidenceUrl })
      }
      const narrative = paragraphs.join('\n\n'), finalizedAt = this.clock().toISOString(), digest = hash({ title, narrative, manifest, evidenceRefs, subjectId, finalizedAt })
      const report = this.store.insert<ScopedReport>('scopedReports', { title, subjectId, narrative, manifest, evidenceRefs, finalizedBy: current.id, finalizedAt, hash: digest })
      this.audit(current, 'scopedReport', report.id, 'finalize', null, { id: report.id, hash: report.hash, subjectId }, '按接收人当前来源授权重新生成摘要')
      return report
    })
  }
  exportReport(actor: User, id: string): { title: string; narrative: string; hash: string } {
    actor = liveObjectActor(this.store, actor)
    if (!canReadObject(this.store, actor, 'scoped_report', id, 'export_summary')) throw new HttpError(404, '摘要不存在或导出授权已失效', 'ACCESS_REVOKED')
    const report = this.store.get<ScopedReport>('scopedReports', id)!
    return { title: report.title, narrative: report.narrative, hash: report.hash }
  }
}
