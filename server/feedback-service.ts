import { createHash } from 'node:crypto'
import type { Entity, User } from '../shared/types.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { feedbackStatuses, type Feedback, type FeedbackAction, type FeedbackActionInput, type FeedbackContext, type FeedbackCreateInput, type FeedbackDetailResponse, type FeedbackEvent, type FeedbackListQuery, type FeedbackListResponse, type FeedbackMetaResponse, type FeedbackView } from '../shared/feedback.ts'
import { HttpError, type Store } from './store.ts'
import { feedbackAttachmentMetadata, validateFeedbackAttachments, type StoredFeedbackAttachment } from './feedback-attachments.ts'
import { notifyFeedback } from './feedback-notifications.ts'
import { isManager, isObserver } from './authorization.ts'

interface FeedbackCommand extends Entity { actorId: string; operation: string; requestId: string; fingerprint: string; feedbackId: string }
const fail = (message: string): never => { throw new HttpError(400, message) }
const required = (value: unknown, label: string, max = 10000) => typeof value === 'string' && value.trim() && value.length <= max ? value.trim() : fail(`${label}不能为空且不得超过 ${max} 字符`)
const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : fail('请求格式无效')
const stable = (value: unknown): string => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(stable(item))) : Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).filter(([, item]) => item !== undefined).map(([key, item]) => [key, JSON.parse(stable(item))])) : value ?? null)
const hash = (value: unknown) => createHash('sha256').update(stable(value)).digest('hex')
const name = (store: Store, id: string) => store.get<User>('users', id)?.name ?? '成员'

/** Context is deliberately small and allowlisted; never retain authentication query/hash values. */
export function safeFeedbackContext(value: unknown): FeedbackContext {
  if (value === undefined) return {}
  const input = object(value), result: FeedbackContext = {}
  for (const key of ['appVersion', 'userAgent', 'viewport', 'errorRequestId'] as const) if (input[key] !== undefined) {
    if (typeof input[key] !== 'string' || input[key].length > (key === 'userAgent' ? 500 : 160)) fail('反馈环境信息格式无效')
    result[key] = (input[key] as string).replace(/[\x00-\x1f\x7f]/g, '')
  }
  if (input.path !== undefined) {
    if (typeof input.path !== 'string' || input.path.length > 2048) fail('反馈页面地址格式无效')
    try {
      const url = new URL(input.path as string, 'https://feedback.invalid')
      if (!['http:', 'https:'].includes(url.protocol)) fail('反馈页面地址格式无效')
      const safe = new URLSearchParams(), view = url.searchParams.get('view')
      if (view && ['overview', 'monthly', 'weekly', 'goals', 'projects', 'reports', 'team', 'imports', 'messages', 'notification-settings', 'collaboration', 'work-register', 'feedback'].includes(view)) safe.set('view', view)
      for (const key of ['month', 'weekStart', 'cycleWeek']) {
        const value = url.searchParams.get(key)
        if (value && /^\d{4}-\d{2}(?:-\d{2})?$/.test(value)) safe.set(key, value)
      }
      result.path = `${url.pathname}${safe.size ? `?${safe}` : ''}`
    } catch { fail('反馈页面地址格式无效') }
  }
  return result
}

export class FeedbackService {
  constructor(private store: Store) {}
  private actor(actor: User) {
    const current = this.store.get<User>('users', actor.id)
    if (!current || !canUseAccount(current)) throw new HttpError(401, '请先登录')
    if (isObserver(current)) throw new HttpError(403, '观察者不能读取或处理个人反馈')
    return current
  }
  private row(actor: User, id: string): Feedback {
    const row = this.store.get<Feedback>('feedback', id)
    if (!row || !isManager(actor) && row.reporterId !== actor.id) throw new HttpError(404, '反馈不存在或无权访问')
    return row
  }
  private project(actor: User, row: Feedback): FeedbackView {
    const { duplicateOfId, ...safe } = row
    const assigneeAvailable = this.assigneeAvailable(row)
    return { ...safe, ...(isManager(actor) && duplicateOfId ? { duplicateOfId } : {}), reporterName: name(this.store, row.reporterId),
      assigneeName: `${name(this.store, row.assigneeId)}${assigneeAvailable ? '' : '（当前不可受理）'}`, assigneeAvailable }
  }
  private assigneeAvailable(row: Feedback): boolean {
    const assignee = this.store.get<User>('users', row.assigneeId)
    return !!assignee && isManager(assignee) && canUseAccount(assignee)
  }
  /** This runs only inside a successful command transaction; read views never change ownership. */
  private ensureAssignee(actor: User, row: Feedback): Feedback {
    if (this.assigneeAvailable(row)) return row
    const assigneeId = this.meta(actor).defaultAssigneeId
    if (!assigneeId) throw new HttpError(409, '原受理人当前不可受理，且暂无可用管理者；请保留输入并联系管理员恢复受理账号')
    const after = this.store.update<Feedback>('feedback', row.id, row.version, { assigneeId })
    this.event(actor, after, 'assign', `原受理人 ${name(this.store, row.assigneeId)} 当前不可受理，系统已自动改派给 ${name(this.store, assigneeId)}。`, [],
      { actorId: '', actorName: '系统自动改派', assigneeId, assigneeName: name(this.store, assigneeId) })
    return after
  }
  private rejectedRelease(id: string, version: string): boolean {
    return !!version && this.store.list<FeedbackEvent>('feedbackEvents').some(event => event.feedbackId === id && event.action === 'reopen' && event.releaseVersion === version)
  }
  meta(actor: User): FeedbackMetaResponse {
    this.actor(actor)
    const managers = this.store.list<User>('users').filter(user => isManager(user) && canUseAccount(user)).map(({ id, name }) => ({ id, name }))
    return { managers, defaultAssigneeId: managers[0]?.id ?? null }
  }
  list(actor: User, query: FeedbackListQuery = {}): FeedbackListResponse {
    actor = this.actor(actor)
    const scope = query.scope ?? 'mine', limit = query.limit ?? 30
    if (!['mine', 'all'].includes(scope) || !Number.isInteger(limit) || limit < 1 || limit > 100 || query.status !== undefined && !feedbackStatuses.includes(query.status)) fail('反馈筛选或分页参数无效')
    if (scope === 'all' && !isManager(actor)) throw new HttpError(403, '只有管理者可以查看全部反馈')
    if (query.assigneeId !== undefined) {
      if (!isManager(actor)) throw new HttpError(403, '只有管理者可以按受理人筛选反馈')
      if (!this.meta(actor).managers.some(manager => manager.id === query.assigneeId)) fail('请选择有效受理人')
    }
    const rows = this.store.list<Feedback>('feedback').filter(row => (scope === 'all' || row.reporterId === actor.id) && (!query.assigneeId || row.assigneeId === query.assigneeId))
    const counts: FeedbackListResponse['counts'] = { all: rows.length, new: 0, in_progress: 0, verification: 0, closed: 0 }
    for (const row of rows) counts[row.status]++
    let cursor: { updatedAt: string; id: string } | undefined
    if (query.cursor) {
      try {
        const parsed = JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8'))
        if (typeof parsed.id !== 'string' || !parsed.id || parsed.id.length > 200 || typeof parsed.updatedAt !== 'string' || new Date(parsed.updatedAt).toISOString() !== parsed.updatedAt) fail('反馈分页游标无效')
        cursor = parsed
      } catch { fail('反馈分页游标无效') }
    }
    const page = rows.filter(row => (!query.status || row.status === query.status) && (!cursor || row.updatedAt < cursor.updatedAt || row.updatedAt === cursor.updatedAt && row.id.localeCompare(cursor.id) < 0))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id)).slice(0, limit + 1)
    const items = page.slice(0, limit), last = items.at(-1)
    return { items: items.map(row => this.project(actor, row)), counts, nextCursor: page.length > limit && last ? Buffer.from(JSON.stringify({ updatedAt: last.updatedAt, id: last.id })).toString('base64url') : null }
  }
  private allowed(actor: User, row: Feedback): FeedbackAction[] {
    const actions: FeedbackAction[] = ['comment']
    if (row.status === 'verification' && row.reporterId === actor.id) actions.push('confirm')
    if (row.status === 'verification' || row.status === 'closed') actions.push('reopen')
    if (isManager(actor) && row.status !== 'closed') {
      actions.push('assign', 'request_info', 'defer', 'ready', 'close', 'duplicate')
      if (row.status === 'new' || row.status === 'in_progress') actions.push('start')
    }
    return actions
  }
  detail(actor: User, id: string): FeedbackDetailResponse {
    actor = this.actor(actor)
    const row = this.row(actor, id)
    return { feedback: this.project(actor, row), events: this.store.list<FeedbackEvent>('feedbackEvents').filter(event => event.feedbackId === id).map(event => {
      const { duplicateOfId, ...safe } = event
      return { ...safe, ...(isManager(actor) && duplicateOfId ? { duplicateOfId } : {}) }
    }), attachments: this.store.list<StoredFeedbackAttachment>('feedbackAttachments').filter(attachment => attachment.feedbackId === id).map(feedbackAttachmentMetadata), allowedActions: this.allowed(actor, row) }
  }
  attachment(actor: User, id: string, attachmentId: string): StoredFeedbackAttachment {
    this.row(this.actor(actor), id)
    const row = this.store.get<StoredFeedbackAttachment>('feedbackAttachments', attachmentId)
    if (!row || row.feedbackId !== id) throw new HttpError(404, '截图不存在或无权访问')
    return row
  }
  private command(actor: User, operation: string, input: Record<string, unknown>, perform: () => Feedback): FeedbackDetailResponse {
    const requestId = required(input.requestId, '请求标识', 160)
    if (!/^[A-Za-z0-9_.:-]+$/.test(requestId)) fail('请求标识格式无效')
    const id = hash([actor.id, requestId]), fingerprint = hash([operation, input])
    return this.store.transaction(() => {
      const previous = this.store.get<FeedbackCommand>('feedbackCommands', id)
      if (previous) {
        if (previous.fingerprint !== fingerprint) throw new HttpError(409, '此请求标识已用于不同内容，请使用新的请求标识')
        return this.detail(actor, previous.feedbackId)
      }
      const row = perform()
      this.store.insert<FeedbackCommand>('feedbackCommands', { id, actorId: actor.id, operation, requestId, fingerprint, feedbackId: row.id })
      return this.detail(actor, row.id)
    })
  }
  private event(actor: User, row: Feedback, action: FeedbackEvent['action'], text: string, attachments: ReturnType<typeof validateFeedbackAttachments>, extra: Partial<FeedbackEvent> = {}) {
    const event = this.store.insert<FeedbackEvent>('feedbackEvents', { feedbackId: row.id, actorId: action === 'duplicate_update' ? '' : actor.id, actorName: action === 'duplicate_update' ? '系统关联回告' : actor.name, action, text, status: row.status, attachmentIds: [], ...extra })
    const ids = attachments.map(attachment => this.store.insert<StoredFeedbackAttachment>('feedbackAttachments', { ...attachment, feedbackId: row.id, eventId: event.id, actorId: actor.id }).id)
    const saved = ids.length ? this.store.update<FeedbackEvent>('feedbackEvents', event.id, event.version, { attachmentIds: ids }) : event
    notifyFeedback(this.store, actor, row, saved)
    return saved
  }
  create(actor: User, value: FeedbackCreateInput | unknown): FeedbackDetailResponse {
    actor = this.actor(actor)
    const input = object(value)
    return this.command(actor, 'create', input, () => {
      const description = required(input.description, '问题描述'), kind = input.kind ?? 'bug', impact = input.impact ?? 'normal'
      if (!['bug', 'usability', 'suggestion'].includes(String(kind)) || !['blocking', 'normal'].includes(String(impact))) fail('反馈类型或影响范围无效')
      const assigneeId = this.meta(actor).defaultAssigneeId
      if (!assigneeId) throw new HttpError(409, '当前没有可受理反馈的管理者，请联系管理员')
      const attachments = validateFeedbackAttachments(input.attachments)
      const row = this.store.insert<Feedback>('feedback', { reporterId: actor.id, assigneeId, description, kind: kind as Feedback['kind'], impact: impact as Feedback['impact'], context: safeFeedbackContext(input.context),
        status: 'new', waiting: null, resolution: '', releaseVersion: '', releasedAt: null, closure: null, duplicateLinked: false, attachmentCount: attachments.length })
      this.event(actor, row, 'created', description, attachments, { assigneeId, assigneeName: name(this.store, assigneeId) })
      return row
    })
  }
  private checkDuplicate(id: string, targetId: string): Feedback {
    let current: string | undefined = targetId
    const seen = new Set([id])
    let target: Feedback | undefined
    while (current) {
      if (seen.has(current)) fail('不能关联自身或形成重复问题循环')
      seen.add(current)
      const row: Feedback | undefined = this.store.get<Feedback>('feedback', current)
      if (!row) fail('关联的主问题不存在')
      target ??= row
      current = row!.duplicateOfId
    }
    return target!
  }
  /** Share only the release result. Never copy another reporter's prose, context, attachments or identity. */
  private propagate(actor: User, source: Feedback, action: 'ready' | 'reopen' | 'close') {
    const queue = [source.id], seen = new Set(queue)
    while (queue.length) {
      const id = queue.shift()!
      for (const child of this.store.list<Feedback>('feedback').filter(row => row.duplicateOfId === id)) {
        if (seen.has(child.id)) continue
        seen.add(child.id); queue.push(child.id)
        if (child.status === 'closed') continue
        const ready = action === 'ready' && !!source.releasedAt
        // A failed verification belongs to this reporter. Re-announcing the same release
        // (including linking another primary) cannot overwrite that independent result.
        if (ready && this.rejectedRelease(child.id, source.releaseVersion)) continue
        const text = ready ? '关联问题的修复已上线，请验证本反馈是否解决。' : action === 'reopen' ? '关联问题已重新处理，本反馈继续跟进。' : '关联问题已结束处理；本反馈仍需单独核查，不代表你已确认解决。'
        const assigned = this.ensureAssignee(actor, child)
        const row = this.store.update<Feedback>('feedback', child.id, assigned.version, { status: ready ? 'verification' : 'in_progress', waiting: null,
          resolution: ready ? text : '', releaseVersion: ready ? source.releaseVersion : '', releasedAt: ready ? source.releasedAt : null })
        this.event(actor, row, 'duplicate_update', text, [], ready ? { releaseVersion: source.releaseVersion } : {})
      }
    }
  }
  action(actor: User, id: string, value: FeedbackActionInput | unknown): FeedbackDetailResponse {
    actor = this.actor(actor)
    const input = object(value)
    this.row(actor, id)
    return this.command(actor, `action:${id}`, input, () => {
      const before = this.row(actor, id), action = input.action as FeedbackAction
      if (!['comment', 'assign', 'start', 'request_info', 'defer', 'ready', 'confirm', 'reopen', 'close', 'duplicate'].includes(action)) fail('反馈处理动作无效')
      if (!this.allowed(actor, before).includes(action)) throw new HttpError(!isManager(actor) && !['comment', 'confirm', 'reopen'].includes(action) ? 403 : 409, '当前身份或反馈状态不允许此操作，请刷新查看')
      if (input.version !== before.version) throw new HttpError(409, '反馈已更新，请刷新后核对再提交；输入内容已保留')
      const attachments = validateFeedbackAttachments(input.attachments), patch: Partial<Feedback> = { attachmentCount: before.attachmentCount + attachments.length }, extra: Partial<FeedbackEvent> = {}
      let text = ''
      if (action === 'comment') {
        text = input.text === undefined || input.text === '' ? '' : required(input.text, '补充说明')
        if (!text && !attachments.length) fail('请填写补充说明或添加截图')
        if (actor.id === before.reporterId && before.waiting?.kind === 'request_info') patch.waiting = null
      } else if (action === 'assign') {
        const assigneeId = required(input.assigneeId, '受理人', 200)
        if (!this.meta(actor).managers.some(user => user.id === assigneeId)) fail('受理人必须是可登录的管理者')
        if (assigneeId === before.assigneeId) throw new HttpError(409, '该管理者已是当前受理人')
        patch.assigneeId = assigneeId; extra.assigneeId = assigneeId; extra.assigneeName = name(this.store, assigneeId); text = `已改派给 ${extra.assigneeName}`
      } else if (action === 'start') { patch.status = 'in_progress'; patch.waiting = null; text = '已开始处理' }
      else if (action === 'request_info' || action === 'defer') {
        text = required(input.reason, action === 'defer' ? '暂缓原因' : '需要补充的内容')
        let reviewAt: string | null = null
        if (action === 'defer') {
          if (typeof input.reviewAt !== 'string' || !Number.isFinite(Date.parse(input.reviewAt)) || Date.parse(input.reviewAt) <= Date.now()) fail('暂缓必须填写未来的复查时间')
          reviewAt = new Date(input.reviewAt as string).toISOString(); extra.reviewAt = reviewAt
        }
        patch.status = 'in_progress'; patch.waiting = { kind: action, reason: text, reviewAt }
      } else if (action === 'ready') {
        text = required(input.resolution, '解决说明'); const releaseVersion = required(input.releaseVersion, '实际可验证版本', 160)
        if (input.released !== true) fail('请明确确认修复已上线，成员现在可以验证')
        if (this.rejectedRelease(id, releaseVersion)) fail('该版本已被验证为未解决，请提供新的可验证修复版本')
        Object.assign(patch, { status: 'verification', waiting: null, closure: null, resolution: text, releaseVersion, releasedAt: new Date().toISOString() }); extra.releaseVersion = releaseVersion
      } else if (action === 'confirm') {
        if (actor.id !== before.reporterId || !before.releasedAt) throw new HttpError(403, '只有提报人可以确认已上线修复确实解决问题')
        text = '提报人已验证并确认解决'; patch.status = 'closed'; patch.waiting = null
        patch.closure = { kind: 'confirmed', reason: text, actorId: actor.id, closedAt: new Date().toISOString() }; extra.closureKind = 'confirmed'
      } else if (action === 'reopen') {
        text = required(input.reason, '重新打开原因')
        if (before.releaseVersion) extra.releaseVersion = before.releaseVersion
        Object.assign(patch, { status: 'in_progress', waiting: null, closure: null, resolution: '', releaseVersion: '', releasedAt: null })
      } else if (action === 'close') {
        text = required(input.reason, '结案原因'); patch.status = 'closed'; patch.waiting = null
        patch.closure = { kind: 'manager', reason: text, actorId: actor.id, closedAt: new Date().toISOString() }; extra.closureKind = 'manager'
      } else if (action === 'duplicate') {
        text = required(input.reason, '关联原因'); const duplicateOfId = required(input.duplicateOfId, '主问题编号', 200), target = this.checkDuplicate(id, duplicateOfId)
        if (before.duplicateOfId === duplicateOfId) throw new HttpError(409, '已经关联该主问题')
        Object.assign(patch, { duplicateLinked: true, duplicateOfId, status: 'in_progress', waiting: null, resolution: '', releaseVersion: '', releasedAt: null }); extra.duplicateOfId = duplicateOfId
        if (target.releasedAt && (target.status === 'verification' || target.closure?.kind === 'confirmed') && !this.rejectedRelease(id, target.releaseVersion)) Object.assign(patch, { status: 'verification', resolution: '关联问题的修复已上线，请验证本反馈是否解决。', releaseVersion: target.releaseVersion, releasedAt: target.releasedAt })
      }
      const assigned = action === 'assign' ? before : this.ensureAssignee(actor, before)
      const row = this.store.update<Feedback>('feedback', id, assigned.version, patch)
      this.event(actor, row, action, text, attachments, extra)
      // A primary reporter's confirmation is their result only; ready already informed duplicates.
      if (['ready', 'reopen', 'close'].includes(action)) this.propagate(actor, row, action as 'ready' | 'reopen' | 'close')
      if (action === 'duplicate' && row.status === 'verification') this.propagate(actor, row, 'ready')
      return row
    })
  }
}
