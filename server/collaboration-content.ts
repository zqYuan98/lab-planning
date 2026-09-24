import type { BusinessNotificationEvent, DeadlineChangeRequest, FollowupRequest, FollowupResponse, ProgressEvent, TaskTracking } from '../shared/collaboration.ts'
import type { CollaborationPreference, DigestItem, NotificationDigest } from '../shared/collaboration-notifications.ts'
import type { MonthlyPlan, Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { Notification, NotificationContent, NotificationTarget } from '../shared/notifications.ts'
import type { WeeklyDuty } from '../shared/weekly-submissions.ts'
import type { Store } from './store.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { isActiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { readCollaborationSettings, taskTrackingEligible } from './collaboration-policy.ts'
import { evaluateWorkRisks } from './collaboration-rules.ts'
import { planHasMergedSource, projectPlan } from './plan-visibility.ts'

const clean = (value: unknown) => typeof value === 'string' ? value.replace(/https?:\/\/[^\s<>]+/gi, '［链接请进入事项查看］').replace(/<[^>]*>/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').slice(0, 6000) : ''
const localTime = (value: string) => Number.isFinite(Date.parse(value)) ? `${new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')}（北京时间）` : value
const taskStatuses = { todo: '待开始', doing: '进行中', blocked: '阻塞', done: '成员自报完成' }
const planStatuses = { draft: '草稿', submitted: '待审核', approved: '已批准，等待发布', published: '已发布', returned: '退回待修改', merged: '已合并' }
const acceptanceStatuses = { pending: '未提交', submitted: '待验收', accepted: '已验收', not_completed: '未完成/需处理' }
const readableLine = (value: string) => clean(value).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)/g, localTime)

/** Old stored prose stays immutable; its timestamp/field labels are corrected only in the read projection. */
function historicalLines(item: DigestItem) {
  const lines = item.lines.map(readableLine).map(line => item.sourceKind === 'deadline_requested' ? line.replace(/^新截止：/, '原截止：') : line)
  if (lines.length && !lines[0].startsWith('当时记录：')) lines[0] = `当时记录：${lines[0]}`
  return lines
}

export function collaborationTargetAccessible(store: Store, actor: User, target: NotificationTarget): boolean {
  const current = store.get<User>('users', actor.id)
  if (!current || !canUseAccount(current) || current.role === 'observer') return false
  actor = current
  if (target.type === 'digest') return store.get<NotificationDigest>('notificationDigests', target.id)?.recipientId === actor.id
  if (target.type === 'followup' || target.type === 'deadlineRequest') {
    const row = store.get<FollowupRequest | DeadlineChangeRequest>(target.type === 'followup' ? 'followupRequests' : 'deadlineChangeRequests', target.id)
    const task = row ? store.get<Task>('tasks', row.taskId) : undefined
    return !!row && !!task && isActiveTask(task) && (actor.role === 'manager' || row.ownerId === actor.id && task.ownerId === actor.id)
  }
  if (target.type === 'report') return actor.role === 'manager' && !!store.get<Report>('reports', target.id)
  if (target.type === 'summary') return actor.role === 'manager'
  if (target.type === 'plan') { const plan = store.get<MonthlyPlan>('plans', target.id); return !!plan && plan.status !== 'merged' && (actor.role === 'manager' || plan.ownerId === actor.id || plan.collaboratorIds.includes(actor.id)) }
  const collection = target.type === 'task' ? 'tasks' : target.type === 'weeklyRecord' ? 'weeklyRecords' : 'weeklyDuties'
  const row = store.get<Task | WeeklyRecord | WeeklyDuty>(collection, target.id)
  const task = target.type === 'task' ? row as Task | undefined : target.type === 'weeklyRecord' && row ? store.get<Task>('tasks', (row as WeeklyRecord).taskId) : undefined
  if (task && !isActiveTask(task)) return false
  return !!row && (target.type !== 'weeklyRecord' || isActiveWeeklyRecord(row as WeeklyRecord)) && (actor.role === 'manager' || row.ownerId === actor.id)
}
export function visibleDigestItems(store: Store, actor: User, digest: NotificationDigest): DigestItem[] {
  if (digest.recipientId !== actor.id) return []
  return digest.itemIds.flatMap(id => {
    const item = store.get<DigestItem>('digestItems', id)
    if (!item || item.recipientId !== actor.id || actor.role !== 'manager' && item.ownerId !== actor.id || !collaborationTargetAccessible(store, actor, item.target)) return []
    if (item.target.type === 'plan' && actor.role !== 'manager') {
      const plan = store.get<MonthlyPlan>('plans', item.target.id)!
      if (planHasMergedSource(plan, store)) return [{ ...item, title: clean(plan.title), lines: ['团队合并目标内容以当前有权访问的成果要求为准。', ...currentPlanLines(plan)] }]
    }
    const lines = historicalLines(item)
    if (item.target.type === 'followup') lines.push(...followupLines(store, actor, item.target))
    else if (item.target.type === 'deadlineRequest') lines.push(...deadlineLines(store, actor, item.target))
    else if (item.target.type === 'plan') {
      const plan = store.get<MonthlyPlan>('plans', item.target.id)
      if (plan) lines.push(...currentPlanLines(projectPlan(actor, plan, store)))
    }
    const task = item.taskId ? store.get<Task>('tasks', item.taskId) : undefined
    if (task) lines.push(`当前任务状态：${taskStatuses[task.status]}`)
    return [{ ...item, title: clean(item.title), lines }]
  })
}
function currentPlanLines(plan: MonthlyPlan) {
  return [`当前审核状态：${planStatuses[plan.status]}`, `当前成果验收：${acceptanceStatuses[plan.acceptanceStatus]}`]
}
function responseLines(store: Store, request: FollowupRequest) {
  if (request.status !== 'responded' || !request.respondedAt) return []
  const response = store.list<FollowupResponse>('followupResponses').find(row => row.followupRequestId === request.id && row.taskId === request.taskId
    && row.ownerId === request.ownerId && row.actorId === request.ownerId && row.respondedAt === request.respondedAt)
  const progress = response ? store.get<ProgressEvent>('progressEvents', response.progressEventId) : undefined
  if (!response || !progress || progress.source !== 'followup' || progress.taskId !== request.taskId || progress.ownerId !== request.ownerId
    || progress.actorId !== request.ownerId || progress.mutationId !== response.mutationId || progress.occurredAt !== response.respondedAt || progress.weeklyRecordId !== response.weeklyRecordId) return []
  const lines = [progress.note ? `本次回应进展：${clean(progress.note)}` : '', progress.noChangeReason ? `本次暂无变化原因：${clean(progress.noChangeReason)}` : '',
    progress.nextAction ? `本次回应下一步：${clean(progress.nextAction)}` : ''].filter(Boolean)
  const fields: Record<string, string> = { currentProgress: '进展', completionNote: '完成说明', actualOutcome: '实际成果', evidenceUrl: '成果材料', blocker: '阻塞原因', blockerReason: '阻塞原因', blockerImpact: '影响', supportNeeded: '需要支持', nextAction: '下一步' }
  for (const change of progress.changes) {
    const [scope, field, extra] = change.field.split('.')
    if (extra || !['task', 'weeklyRecord'].includes(scope) || !fields[field] || !change.after || field === 'nextAction' && change.after === progress.nextAction || field === 'currentProgress' && change.after === progress.note) continue
    lines.push(`本次回应${fields[field]}：${clean(change.after)}`)
  }
  return lines
}
function followupLines(store: Store, actor: User, target: NotificationTarget) {
  if (!collaborationTargetAccessible(store, actor, target)) return []
  const request = store.get<FollowupRequest>('followupRequests', target.id)
  if (!request) return []
  const task = store.get<Task>('tasks', request.taskId), owner = store.get<User>('users', request.ownerId)
  return [`负责人：${clean(owner?.name ?? '成员')}`, `当前更新要求：${clean(request.requirement)}`, `当前回应期限：${localTime(request.dueAt)}`,
    `当前截止：${task?.dueDate || '未设置'}`, request.status === 'open' ? '当前处理状态：待本人回应；请更新进度并明确回应本次催办，确认安排不等于回应。'
      : request.status === 'responded' ? `当前处理状态：已回应；回应于 ${localTime(request.respondedAt!)}${request.respondedAt! > request.dueAt ? '，晚于原回应期限' : ''}` : `当前处理状态：催办已结束；${clean(request.closeReason)}`,
    ...responseLines(store, request)]
}
function deadlineLines(store: Store, actor: User, target: NotificationTarget) {
  if (!collaborationTargetAccessible(store, actor, target)) return []
  const request = store.get<DeadlineChangeRequest>('deadlineChangeRequests', target.id), task = request ? store.get<Task>('tasks', request.taskId) : undefined
  if (!request || !task) return []
  return [`申请时原截止：${request.originalDueDate || '未设置'}`, `申请截止：${request.requestedDueDate}`, `申请原因：${clean(request.reason)}`,
    `当前处理状态：${({ open: '等待批准，原截止仍有效', approved: '已批准', returned: '已退回', cancelled: '已取消', superseded: '已失效' })[request.status]}`,
    `当前截止：${task.dueDate || '未设置'}`, ...(request.decidedAt ? [`处理时间：${localTime(request.decidedAt)}`] : []), ...(request.decisionNote ? [`处理意见：${clean(request.decisionNote)}`] : [])]
}
export function projectCollaborationContent(store: Store, actor: User, row: Notification, targets: NotificationTarget[], sendAt?: Date) {
  const content: NotificationContent = { heading: row.title, intro: `通知发生于 ${localTime(row.eventTime ?? row.createdAt)}；处理前请核对当前状态。`, items: [] }
  let buttonText = '查看工作摘要'
  for (const target of targets) {
    if (target.type === 'digest') {
      const digest = store.get<NotificationDigest>('notificationDigests', target.id)
      if (!digest) continue
      content.intro = `统计周期：${digest.periodStart}—${digest.periodEnd}；生成于 ${localTime(digest.generatedAt)}。`
      if (actor.role === 'manager' && digest.statistics?.length) content.intro += `\n周期统计（含本期已回告事实）：${digest.statistics.map(item => `${item.label} ${item.value}`).join('；')}。`
      for (const item of visibleDigestItems(store, actor, digest)) {
        if (sendAt && item.actionable && !itemStillActionable(store, item, sendAt)) continue
        content.items.push({ target: item.target, title: item.title, lines: item.lines })
      }
      if (digest.type === 'manual_followup') buttonText = content.items.some(item => item.target.type === 'followup' && store.get<FollowupRequest>('followupRequests', item.target.id)?.status === 'open') ? '更新进度并回应' : '查看进展'
      if (digest.type === 'weekly_manager') content.footer = '本周摘要包含已回告事实的周期汇总；正式周提报截止统计仍以原周提报回执为准。'
    } else if (target.type === 'followup') {
      const request = store.get<FollowupRequest>('followupRequests', target.id)
      const task = request ? store.get<Task>('tasks', request.taskId) : undefined
      if (request && task) content.items.push({ target, title: clean(task.title), lines: followupLines(store, actor, target) })
      buttonText = request?.status === 'open' ? '更新进度并回应' : '查看进展'
    } else if (target.type === 'deadlineRequest') {
      const request = store.get<DeadlineChangeRequest>('deadlineChangeRequests', target.id), task = request ? store.get<Task>('tasks', request.taskId) : undefined
      if (request && task) content.items.push({ target, title: clean(task.title), lines: deadlineLines(store, actor, target) })
      buttonText = request?.status === 'open' && actor.role === 'manager' ? '处理延期申请' : '查看延期结果'
    } else if (target.type === 'plan') {
      const raw = store.get<MonthlyPlan>('plans', target.id)
      if (!raw) continue
      const plan = projectPlan(actor, raw, store)
      content.items.push({ target, title: clean(plan.title), lines: [`成果要求：${clean(plan.expectedOutcome)}`, `目标截止：${plan.dueDate}`,
        `审核状态：${({ draft: '草稿', submitted: '待审核', approved: '已批准，等待发布', published: '已发布', returned: '退回待修改', merged: '已合并' })[plan.status]}`,
        `成果验收：${({ pending: '未提交', submitted: '待验收', accepted: '已验收', not_completed: '未完成/需处理' })[plan.acceptanceStatus]}`,
        ...(plan.reviewComment ? [`审核意见：${clean(plan.reviewComment)}`] : []), ...(plan.acceptanceNote && !planHasMergedSource(raw, store) ? [`验收说明：${clean(plan.acceptanceNote)}`] : [])] })
      buttonText = '查看并审核'
    } else if (target.type === 'report') {
      const report = store.get<Report>('reports', target.id)
      if (report) content.items.push({ target, title: clean(report.title), lines: [`报告周期：${report.period}`, `定稿版本：${report.revision}`, '请进入报告中心查看完整定稿。'] })
      buttonText = '查看定稿报告'
    } else {
      const eventId = /^collaboration:event:([a-zA-Z0-9_-]+)$/.exec(row.eventKey)?.[1]
      const event = eventId ? store.get<BusinessNotificationEvent>('businessNotificationEvents', eventId) : undefined
      const task = target.type === 'task' ? store.get<Task>('tasks', target.id) : undefined
      if (actor.role === 'manager' || event?.ownerId === actor.id) content.items.push({ target, title: clean(task?.title ?? row.title), lines: row.body.split('\n').map(readableLine) })
      buttonText = target.type === 'weeklySubmission' ? '查看事项' : '查看进展'
    }
  }
  content.totalCount = content.items.length
  if (!content.items.length) return { body: '该通知涉及的事项已处理或当前不可访问，请查看个人工作中的最新状态。', buttonText: '查看事项', contentUpdated: false }
  return { content, body: [content.heading, content.intro, ...content.items.flatMap(item => [item.title, ...item.lines]), content.footer].filter(Boolean).join('\n'), buttonText, contentUpdated: false }
}

function obligationCurrent(store: Store, type: 'followup' | 'deadlineRequest', id: string, now: Date) {
  const obligation = store.get<FollowupRequest | DeadlineChangeRequest>(type === 'followup' ? 'followupRequests' : 'deadlineChangeRequests', id)
  const task = obligation ? store.get<Task>('tasks', obligation.taskId) : undefined
  const tracking = task ? store.get<TaskTracking>('taskTrackings', task.id) : undefined
  return !!obligation && obligation.status === 'open' && !!task && !!tracking && tracking.state === 'active' && tracking.generation === obligation.generation && task.ownerId === obligation.ownerId && taskTrackingEligible(store, task, now)
}
function itemStillActionable(store: Store, item: DigestItem, now: Date) {
  if (item.taskId) { const task = store.get<Task>('tasks', item.taskId); if (!task || !isActiveTask(task)) return false }
  if (item.target.type === 'followup' || item.target.type === 'deadlineRequest') return obligationCurrent(store, item.target.type, item.target.id, now)
  if (item.target.type === 'plan') {
    const plan = store.get<MonthlyPlan>('plans', item.target.id)
    return item.sourceKind === 'plan_review_requested' ? plan?.status === 'submitted' : item.sourceKind === 'plan_result_submitted' ? plan?.acceptanceStatus === 'submitted' : !!plan
  }
  if (item.sourceKind === 'risk') return evaluateWorkRisks(store, now).some(risk => risk.taskId === item.taskId && risk.generation === item.generation && item.sourceId.includes(risk.key))
  return true
}
/** Called immediately before actual send; historical views remain readable when a rule is paused. */
export function collaborationNotificationCurrent(store: Store, actor: User, row: Notification, now: Date): boolean {
  if (!row.kind.startsWith('collaboration_')) return true
  const settings = readCollaborationSettings(store)
  if (!settings.enabled || !canUseAccount(actor)) return false
  for (const target of row.targets) {
    if (!collaborationTargetAccessible(store, actor, target)) continue
    if (target.type === 'digest') {
      const digest = store.get<NotificationDigest>('notificationDigests', target.id)!
      if (digest.ruleVersion !== settings.version) continue
      const items = visibleDigestItems(store, actor, digest)
      if (['risk_member', 'risk_manager'].includes(digest.type) && !settings.autoRulesEnabled && !items.some(item => item.sourceKind !== 'risk')) continue
      // daily_manager also carries the mandatory minimum management feedback summary.
      if (digest.type === 'weekly_manager' && !settings.weeklyManagerEnabled || digest.type === 'member_actions' && (!settings.memberActionsEnabled || store.get<CollaborationPreference>('collaborationPreferences', actor.id)?.memberActionsEnabled === false)) continue
      if (items.some(item => !item.actionable || itemStillActionable(store, item, now))) return true
    } else if (target.type === 'followup' || target.type === 'deadlineRequest') {
      const obligation = store.get<FollowupRequest | DeadlineChangeRequest>(target.type === 'followup' ? 'followupRequests' : 'deadlineChangeRequests', target.id)
      if (obligation && (obligationCurrent(store, target.type, target.id, now) || !['collaboration_followup_requested', 'collaboration_followup_changed', 'collaboration_deadline_requested'].includes(row.kind))) return true
    } else return true
  }
  return false
}
