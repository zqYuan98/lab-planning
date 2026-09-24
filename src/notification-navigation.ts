import type { NotificationTarget, DeliveryStatus } from '../shared/notifications'
import type { NavigationIntent, PageId } from './navigation'
import { taskSections } from './navigation'
import { createSubmissionRequestId } from './weekly-submission-flow'

export function entryLocation(location: { pathname: string; search: string }): { page: PageId; intent?: NavigationIntent } {
  const params = new URLSearchParams(location.search)
  const identifier = (key: string) => { const value = params.get(key); return value && /^[a-zA-Z0-9_-]{1,200}$/.test(value) ? value : undefined }
  if (location.pathname === '/entry') {
    const id = identifier('notificationId')
    return { page: 'messages', intent: id ? { id } : undefined }
  }
  if (location.pathname === '/work' && ['monthly', 'weekly', 'collaboration', 'reports', 'work-register', 'feedback', 'authorized-work', 'period-reviews'].includes(params.get('view') || '')) {
    const page = params.get('view') as PageId
    const intent: NavigationIntent = {}
    const id = identifier('id'), ownerId = identifier('ownerId')
    if (id) intent.id = id
    const section = params.get('section')
    if (taskSections.includes(section as typeof taskSections[number])) intent.section = section as typeof taskSections[number]
    const weeklyRecordId = identifier('weeklyRecordId')
    if (weeklyRecordId) intent.weeklyRecordId = weeklyRecordId
    if (ownerId) intent.ownerId = ownerId
    const targetType = params.get('targetType')
    if (['task', 'followup', 'digest', 'deadlineRequest', 'blocker', 'decisionRequest'].includes(targetType || '')) intent.targetType = targetType as NavigationIntent['targetType']
    const month = params.get('month')
    if (month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month)) intent.month = month
    for (const key of ['weekStart', 'cycleWeek'] as const) {
      const value = params.get(key)
      if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) continue
      const date = new Date(`${value}T00:00:00Z`)
      if (Number.isFinite(date.getTime()) && date.getUTCDay() === 1 && date.toISOString().slice(0, 10) === value) intent[key] = value
    }
    const kind = params.get('kind')
    if (kind === 'results' || kind === 'plan') intent.kind = kind
    if (params.get('action') === 'review') intent.action = 'review'
    if (page==='monthly' && params.get('action')==='result') intent.action='result'
    if (page === 'monthly' && params.get('action') === 'create-task') intent.action = 'create-task'
    if (page === 'weekly' && params.get('action') === 'create') intent.action = 'create'
    return { page, intent }
  }
  return { page: location.pathname === '/work' ? 'messages' : 'overview' }
}

export function navigationUrl(page: PageId, intent?: NavigationIntent): string {
  if (page === 'messages') return intent?.id ? `/entry?notificationId=${encodeURIComponent(intent.id)}` : '/work'
  if (!['monthly', 'weekly', 'collaboration', 'reports', 'work-register', 'feedback', 'authorized-work', 'period-reviews'].includes(page)) return '/'
  const params = new URLSearchParams({ view: page })
  for (const key of ['id', 'ownerId', 'month', 'weekStart', 'cycleWeek', 'kind', 'targetType', 'section', 'weeklyRecordId'] as const) if (intent?.[key]) params.set(key, intent[key]!)
  if (intent?.action === 'review') params.set('action', 'review')
  if(page==='monthly' && intent?.action==='result')params.set('action','result')
  if (page === 'monthly' && intent?.action === 'create-task') params.set('action', 'create-task')
  if (page === 'weekly' && intent?.action === 'create') params.set('action', 'create')
  return `/work?${params}`
}

/** Targets are server-projected; keep the submission cycle separate from its content week. */
export function notificationNavigation(target: NotificationTarget): { page: PageId; intent: NavigationIntent } {
  if (target.type === 'task') return {page:'work-register',intent:{id:target.id,targetType:'task',section:'overview'}}
  if (target.type === 'feedback') return { page: 'feedback', intent: { id: target.id } }
  if (['followup', 'digest', 'deadlineRequest', 'blocker', 'decisionRequest'].includes(target.type)) return { page: 'collaboration', intent: { id: target.id, targetType: target.type as NavigationIntent['targetType'] } }
  if (target.type === 'report') return { page: 'reports', intent: { id: target.id } }
  if (target.type === 'plan') return { page: 'monthly', intent: { id: target.id, month: target.month } }
  if (target.type === 'weeklySubmission' || target.type === 'summary') return {
    page: 'weekly', intent: { action: 'review', weekStart: target.weekStart || target.cycleWeek,
      cycleWeek: target.cycleWeek || target.weekStart, kind: target.kind },
  }
  return { page: 'weekly', intent: { id: target.id, weekStart: target.weekStart } }
}

export const deliveryLabels: Record<DeliveryStatus, string> = {
  pending: '待发送', sending: '发送处理中', accepted: '平台已受理', delivered: '平台报告成功',
  failed: '发送失败', unknown: '结果未知', skipped: '已取消 / 未绑定',
}

export interface SubmissionAttempt { fingerprint: string; requestId: string }
/** Replays an unchanged failed request; edits create a separate idempotency scope. */
export function assignmentAttempt(previous: SubmissionAttempt | null, payload: unknown,
  createId = createSubmissionRequestId): SubmissionAttempt {
  const fingerprint = JSON.stringify(payload)
  return previous?.fingerprint === fingerprint ? previous : { fingerprint, requestId: createId() }
}
