import type { AuditEvent, MonthlyPlan, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { Notification, NotificationChange, NotificationContent, NotificationFacts, NotificationSubject, NotificationTarget } from '../shared/notifications.ts'
import type { Store } from './store.ts'
import type { WeeklyDuty, WeeklySubmission, WeeklyAdjustment, WeeklyMissing } from '../shared/weekly-submissions.ts'
import { addWeekDays } from './weekly-submission-clock.ts'
import { participates, planHasMergedSource, projectPlan } from './plan-visibility.ts'
import { projectWeeklyDuty } from './weekly-duty-view.ts'
import { projectCollaborationContent } from './collaboration-content.ts'
import { feedbackStatusLabels, type Feedback } from '../shared/feedback.ts'
import { isManager, isObserver } from './authorization.ts'

export const targetKey = (target: NotificationTarget) => `${target.type}:${target.id}`
/** Plain business fragments only; evidence URLs belong behind the authenticated detail page. */
export function notificationText(value: unknown): string {
  return typeof value === 'string' ? Array.from(value.replace(/https?:\/\/[^\s<>]+/gi, '［链接请进入事项查看］')
    .replace(/<[^>]*>/g, '').replace(/@[\w\u4e00-\u9fff]+/g, match => `＠${match.slice(1)}`)
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').trim()).slice(0, 6000).join('') : ''
}
const name = (store: Store, id: string) => notificationText(store.get<User>('users', id)?.name ?? '成员')
export const notificationLocalTime = (date: Date) => `${new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')}（北京时间）`

export function notificationSubject(store: Store, target: NotificationTarget, actor: User): NotificationSubject | undefined {
  if (target.type === 'blocker' || target.type === 'decisionRequest') {
    const blocker = target.type === 'blocker' ? store.get<import('../shared/collaboration.ts').BlockerEpisode>('blockerEpisodes', target.id) : null
    const decision = target.type === 'decisionRequest' ? store.get<import('../shared/support.ts').DecisionRequest>('decisionRequests', target.id) : null
    const task = store.get<Task>('tasks', blocker?.parentTaskId ?? decision?.taskId ?? '')
    if (!task || isObserver(actor) || !isManager(actor) && actor.id !== task.ownerId && actor.id !== blocker?.coordinatorId) return
    return { target, title: notificationText(task.title), ownerId: task.ownerId, ownerName: name(store, task.ownerId), context: blocker ? '支持事项' : '决策事项',
      requirement: notificationText(blocker ? [blocker.reason, blocker.impact, blocker.supportNeeded].filter(Boolean).join('；') : decision?.question),
      dueDate: blocker?.responseDueAt ?? decision?.responseDueAt ?? '', status: blocker?.coordinationState ?? decision?.status }
  }
  if (target.type === 'plan') {
    const raw = store.get<MonthlyPlan>('plans', target.id)
    if (!raw) return
    const plan = projectPlan(actor, raw, store)
    return { target, title: notificationText(plan.title), ownerId: plan.ownerId, ownerName: name(store, plan.ownerId), context: `${plan.month} 月目标`,
      requirement: notificationText(plan.expectedOutcome), dueDate: plan.dueDate, acceptance: notificationText(plan.acceptanceCriteria),
      reviewComment: notificationText(plan.reviewComment), status: plan.status }
  }
  if (target.type !== 'task' && target.type !== 'weeklyRecord') return
  const weekly = target.type === 'weeklyRecord' ? store.get<WeeklyRecord>('weeklyRecords', target.id) : undefined
  const task = store.get<Task>('tasks', weekly?.taskId ?? (target.type === 'task' ? target.id : ''))
  if (!task || target.type === 'weeklyRecord' && !weekly) return
  const ownerId = weekly?.ownerId ?? task.ownerId
  return { target, title: notificationText(task.title), ownerId, ownerName: name(store, ownerId),
    context: weekly ? `${weekly.weekStart}—${addWeekDays(weekly.weekStart, 6)} 周安排` : '任务安排',
    requirement: notificationText(weekly ? weekly.commitment : task.description), dueDate: task.dueDate }
}

export function captureNotificationFacts(store: Store, targets: NotificationTarget[], actor: User | undefined, changes: NotificationChange[] = [], reason?: string): NotificationFacts {
  if (!actor) return { subjects: [], changes: [] }
  const maySeeReason = isManager(actor) || !targets.some(target => target.type === 'plan')
  return { subjects: targets.flatMap(target => { const value = notificationSubject(store, target, actor); return value ? [value] : [] }),
    changes, ...(reason && maySeeReason ? { reason: notificationText(reason) } : {}) }
}

/** Only a recipient who could see the previous object gets its old field values. */
export function notificationEventChanges(store: Store, event: AuditEvent, target: NotificationTarget, recipientId: string): NotificationChange[] {
  if (!event.before || !event.after) return []
  let before = event.before as Record<string, unknown>, after = event.after as Record<string, unknown>
  const recipient = store.get<User>('users', recipientId)
  if (!recipient) return []
  const wasVisible = isManager(recipient) || before.ownerId === recipientId
    || event.entityType === 'plan' && Array.isArray(before.collaboratorIds) && before.collaboratorIds.includes(recipientId)
  if (event.entityType === 'plan') {
    before = projectPlan(recipient, event.before as MonthlyPlan, store) as unknown as Record<string, unknown>
    after = projectPlan(recipient, event.after as MonthlyPlan, store) as unknown as Record<string, unknown>
  }
  const fields: Record<string, string> = event.entityType === 'task'
    ? { ownerId: '负责人', dueDate: '截止日期', description: '工作要求', title: '事项名称' }
    : event.entityType === 'weeklyRecord' ? { commitment: '本周要求' }
      : { ownerId: '负责人', dueDate: '截止日期', expectedOutcome: '成果要求', acceptanceCriteria: '验收标准', collaboratorIds: '协作成员', title: '目标名称' }
  const text = (field: string, value: unknown) => field === 'ownerId' ? name(store, String(value ?? ''))
    : field === 'collaboratorIds' && Array.isArray(value) ? value.map(id => name(store, String(id))).join('、') : notificationText(value)
  const memberVisible = (snapshot: unknown, field: string) => {
    if (event.entityType !== 'plan') return (snapshot as Task | WeeklyRecord).ownerId === recipientId
    const plan = snapshot as MonthlyPlan
    return participates(plan, recipientId) && !(planHasMergedSource(plan, store) && ['expectedOutcome', 'acceptanceCriteria'].includes(field))
  }
  return Object.entries(fields).flatMap(([field, label]) => JSON.stringify(before[field]) === JSON.stringify(after[field]) ? []
    : [{ target, field, label, ...(wasVisible ? { before: text(field, before[field]) } : {}), after: text(field, after[field]),
      memberVisibleBefore: memberVisible(event.before, field), memberVisibleAfter: memberVisible(event.after, field) }])
}

export function mergeNotificationChanges(previous: NotificationChange[], next: NotificationChange[]): NotificationChange[] {
  const combined = new Map(previous.map(change => [`${targetKey(change.target)}:${change.field}`, change]))
  for (const change of next) {
    const key = `${targetKey(change.target)}:${change.field}`, before = combined.get(key)
    combined.set(key, { ...change, ...(before ? { before: before.before, memberVisibleBefore: before.memberVisibleBefore } : {}) })
  }
  return [...combined.values()].filter(change => change.before === undefined || change.before !== change.after)
}

export function contentAsText(content: NotificationContent): string {
  return [content.heading, content.intro, ...content.items.flatMap(item => [item.title, ...item.lines]), content.footer].filter(Boolean).join('\n')
}

const headings: Record<string, string> = {
  work_assigned: '待确认安排', work_changed: '安排有更新', manual_reminder: '待确认安排', monthly_published: '月度计划已发布',
  plan_changed: '月度目标有更新', proposal_review: '临时目标待审核', proposal_result: '临时目标审核结果',
  weekly_reminder: '周提报待提交提醒', weekly_summary: '本周正式提报截止汇总',
}

export function projectNotificationContent(store: Store, actor: User, row: Notification, targets: NotificationTarget[], options: {
  canAcknowledge: boolean; sourceCanAcknowledge?: boolean; now?: Date; manualSource?: Notification
}): { content?: NotificationContent; body: string; buttonText: string; contentUpdated: boolean } {
  const now = options.now ?? new Date(), facts = options.manualSource?.contentFacts ?? row.contentFacts
  if (row.kind.startsWith('feedback_') || row.targets.some(target => target.type === 'feedback')) {
    const content: NotificationContent = { heading: notificationText(row.title), intro: notificationText(row.body), items: targets.flatMap(target => {
      if (target.type !== 'feedback') return []
      const feedback = store.get<Feedback>('feedback', target.id)
      if (!feedback || !isManager(actor) && feedback.reporterId !== actor.id) return []
      const closure = feedback.closure?.kind === 'confirmed' ? '提报人已验证并确认解决' : feedback.closure?.kind === 'manager' ? '管理者已结案；并非提报人确认解决' : ''
      return [{ target, title: notificationText(feedback.description).slice(0, 100), lines: [`当前状态：${feedbackStatusLabels[feedback.status]}`, `受理人：${name(store, feedback.assigneeId)}`,
        ...(feedback.status === 'verification' ? [`可验证版本：${notificationText(feedback.releaseVersion)}`, '请到反馈详情实际验证，再确认解决或重新打开。'] : []), ...(closure ? [closure] : [])] }]
    }) }
    if (!content.items.length) { content.intro = '反馈当前不可访问。'; content.heading = '问题反馈有更新' }
    return { content, body: contentAsText(content), buttonText: '查看问题反馈', contentUpdated: false }
  }
  if (row.kind.startsWith('collaboration_')) return projectCollaborationContent(store, actor, row, targets)
  if (row.kind === 'participation_removed') return { body: '你已不再参与一项月度目标，如有疑问请联系管理者。', buttonText: '查看事项', contentUpdated: false }
  if (!targets.length) return { body: options.manualSource?.acknowledgedAt ? '原安排已确认，无需重复确认。可进入原安排查看当前状态。' : '该安排已处理、已变更或当前不可访问，请查看原安排的最新状态。', buttonText: row.kind === 'manual_reminder' ? '查看原安排' : '查看事项', contentUpdated: false }
  const content: NotificationContent = { heading: headings[row.kind] ?? notificationText(row.title), items: [], totalCount: targets.length }
  let buttonText = '查看事项', contentUpdated = false
  if (row.kind === 'weekly_summary') {
    // Departmental counts were frozen by the scheduler; never recompute a historical cutoff.
    content.intro = notificationText(row.body); buttonText = '查看摘要'
  } else if (row.kind === 'weekly_reminder') {
    // Only read existing duties here. Reconciliation belongs to the scheduler,
    // never to inbox/preview GETs. The worker supplies freshly checked due targets.
    content.intro = `提醒发生于 ${notificationLocalTime(new Date(row.eventTime ?? row.createdAt))}；以下为截至 ${notificationLocalTime(now)} 的当前提报状态。`
    const data = { submissions: store.list<WeeklySubmission>('weeklySubmissions'), adjustments: store.list<WeeklyAdjustment>('weeklyAdjustments'),
      records: store.list<WeeklyRecord>('weeklyRecords'), missing: store.list<WeeklyMissing>('weeklyMissing'), progressEvents: store.list<import('../shared/collaboration.ts').ProgressEvent>('progressEvents') }
    let pendingCount = 0
    content.items = targets.flatMap(target => {
      const duty = store.get<WeeklyDuty>('weeklyDuties', target.id)
      if (!duty || duty.ownerId !== actor.id && !isManager(actor)) return []
      const current = projectWeeklyDuty(duty, data, now), records = current.records
      const pending = current.status !== 'exempt' && (!current.latestSubmission || current.changedSinceSubmission)
      if (pending) pendingCount++
      const state = current.status === 'exempt' ? '本周期已豁免，无需提交' : current.latestSubmission ? current.changedSinceSubmission ? '内容有修改，待重新正式提报' : '当前已正式提交，无需重复提交' : '尚未正式提报，请核对并提交'
      return [{ target, title: `${duty.kind === 'results' ? '本周完成情况' : '下周计划'}（${duty.contentWeek}—${addWeekDays(duty.contentWeek, 6)}）`,
        lines: [state, `正式提报截止：${notificationLocalTime(new Date(duty.deadlineAt))}`, `已有工作 ${records.length} 项`,
          ...records.slice(0, 3).map(record => `${notificationText(store.get<Task>('tasks', record.taskId)?.title ?? '周工作')}：${notificationText(record.commitment) || '具体要求待补充'}`),
          ...(records.length > 3 ? [`另有 ${records.length - 3} 项工作，进入核对`] : []),
          ...(records.length ? [] : ['暂无工作条目，请进入核对或说明情况'])] }]
    })
    content.totalCount = content.items.length
    buttonText = pendingCount ? '核对并正式提交' : '查看事项'
    if (!pendingCount) content.footer = '本通知涉及的提报当前均已处理，无需按旧提醒重复提交。'
  } else {
    content.items = targets.flatMap(target => {
      const subject = notificationSubject(store, target, actor)
      if (!subject) return []
      const snapshot = facts?.subjects.find(item => targetKey(item.target) === targetKey(target))
      // Requirement facts only, not progress/updatedAt: saving progress is not a new arrangement.
      const differs = !!snapshot && ['title', 'ownerId', 'requirement', 'dueDate', 'acceptance'].some(field =>
        snapshot[field as keyof NotificationSubject] !== subject[field as keyof NotificationSubject])
      contentUpdated ||= differs
      const lines = [`负责人：${subject.ownerName} · ${subject.context}`,
        `${target.type === 'plan' ? subject.ownerId === actor.id ? '成果要求' : '协作目标要求' : target.type === 'weeklyRecord' ? '本周要求' : '工作要求'}：${subject.requirement || '具体要求待补充'}`,
        `${target.type === 'plan' ? '目标截止' : '任务截止'}：${subject.dueDate || '截止日期未设置'}`]
      if (subject.acceptance) lines.push(`验收标准：${subject.acceptance}`)
      const rawPlan = target.type === 'plan' ? store.get<MonthlyPlan>('plans', target.id) : undefined
      const changes = (facts?.changes ?? []).filter(change => targetKey(change.target) === targetKey(target)
        && (isManager(actor) || change.memberVisibleAfter === true && !(rawPlan && planHasMergedSource(rawPlan, store) && ['expectedOutcome', 'acceptanceCriteria'].includes(change.field))))
        .map(change => isManager(actor) || change.memberVisibleBefore === true ? change : { ...change, before: undefined })
      for (const change of changes) lines.push(`${differs ? '通知时变更 · ' : ''}${change.label}：${change.before === undefined ? '已更新为 ' : `${change.before || '未设置'} → `}${change.after || '已清空'}`)
      if (['proposal_result', 'proposal_review'].includes(row.kind)) {
        if (subject.reviewComment && row.kind === 'proposal_result') lines.push(`审核意见：${subject.reviewComment}`)
        if (row.kind === 'proposal_result') lines.push(subject.status === 'published' ? '审核通过，现已正式发布' : subject.status === 'approved' ? '审核通过，等待管理者正式发布' : subject.status === 'returned' ? '已退回，请修改后重新提报' : '审核状态已有变化，请查看当前结果')
      }
      return [{ target, title: subject.title, lines }]
    })
    content.totalCount = content.items.length
    content.items.sort((left, right) => {
      const rank = (target: NotificationTarget) => target.type === 'plan' ? ({ high: 0, medium: 1, low: 2 }[store.get<MonthlyPlan>('plans', target.id)?.priority ?? 'medium']) : 1
      const due = (target: NotificationTarget) => notificationSubject(store, target, actor)?.dueDate || '9999-12-31'
      return rank(left.target) - rank(right.target) || due(left.target).localeCompare(due(right.target)) || targetKey(left.target).localeCompare(targetKey(right.target))
    })
    const actorName = row.actorId ? name(store, row.actorId) : ''
    if (row.kind === 'manual_reminder') {
      content.intro = options.sourceCanAcknowledge ? `${actorName || '管理者'}提醒你确认知悉以下安排。` : '原安排已处理或已更新，请查看最新状态。'
      buttonText = options.sourceCanAcknowledge ? '查看并确认原安排' : '查看原安排'
    } else if (row.kind === 'work_assigned') { content.intro = actorName ? `安排人：${actorName}` : '请查看具体要求。'; buttonText = options.canAcknowledge ? '查看并确认安排' : '查看事项' }
    else if (row.kind === 'work_changed') { content.intro = actorName ? `变更人：${actorName}` : '请核对最新工作要求。'; buttonText = options.canAcknowledge ? '查看变更并确认' : '查看变更' }
    else if (row.kind === 'plan_changed') { content.intro = actorName ? `变更人：${actorName}` : '请查看最新目标要求。'; buttonText = '查看目标变更' }
    else if (row.kind === 'monthly_published') { content.intro = `与你相关的目标共 ${content.items.length} 项；确认仅适用于本人负责的当前安排。`; buttonText = '查看本月安排' }
    else if (row.kind === 'proposal_review') { content.intro = actorName ? `提报人：${actorName}` : '请审核目标要求。'; buttonText = '查看并审核' }
    else if (row.kind === 'proposal_result') buttonText = '查看审核结果'
    if (facts?.reason && ['work_changed', 'plan_changed'].includes(options.manualSource?.kind ?? row.kind) && (isManager(actor) || !targets.some(target => target.type === 'plan'))) content.footer = `变更原因：${notificationText(facts.reason)}`
  }
  if (!row.contentSchemaVersion && !options.manualSource && !['weekly_reminder', 'weekly_summary'].includes(row.kind)) content.footer = [content.footer, '旧通知：以下为当前可访问的事项内容，不代表当时的完整快照。'].filter(Boolean).join('\n')
  if (contentUpdated) content.intro = [`通知发生于 ${notificationLocalTime(new Date(row.eventTime ?? row.createdAt))}；当前事项已有更新，请以当前要求为准。`, content.intro].filter(Boolean).join('\n')
  return { content, body: contentAsText(content), buttonText, contentUpdated }
}

export function externalNotificationContent(view: { title: string; body: string; content?: NotificationContent; buttonText?: string }) {
  if (process.env.DINGTALK_NOTIFICATION_CONTENT_MODE === 'minimal') return { title: '工作通知', body: '你有一项工作通知，请进入系统查看详情。', buttonText: '查看工作安排' }
  return { title: view.title, body: view.content && view.body.length > 32000 ? view.content.heading : view.body, card: view.content, buttonText: view.buttonText }
}
