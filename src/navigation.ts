export type PageId =
  'overview' | 'monthly' | 'weekly' | 'goals' | 'projects' | 'reports' | 'team' | 'imports' | 'messages' | 'notification-settings' | 'collaboration' | 'work-register' | 'feedback' | 'authorized-work' | 'period-reviews'
export const taskSections = ['overview', 'weekly', 'deliveries', 'support', 'followups', 'history'] as const
export type TaskSection = typeof taskSections[number]
export interface OpenTaskIntent { taskId: string; section?: TaskSection; weeklyRecordId?: string; returnContext?: { url: string; scrollY: number } }
export function validTaskIntent(value: OpenTaskIntent): OpenTaskIntent | null {
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(value.taskId)) return null
  return { taskId: value.taskId, section: taskSections.includes(value.section!) ? value.section : 'overview',
    ...(value.weeklyRecordId && /^[a-zA-Z0-9_-]{1,200}$/.test(value.weeklyRecordId) ? { weeklyRecordId: value.weeklyRecordId } : {}), returnContext: value.returnContext }
}
/** All task entry points resolve through the single app-level detail host. */
export function openTask(value: OpenTaskIntent) {
  const intent = validTaskIntent(value)
  if (intent) window.dispatchEvent(new CustomEvent('workspace-open-task', { detail: intent }))
}
export interface NavigationIntent {
  action?: 'create' | 'create-task' | 'review' | 'publish' | 'write-weekly' | 'result'
  query?: string
  id?: string
  month?: string
  weekStart?: string
  status?: string
  cycleWeek?: string
  kind?: 'results' | 'plan'
  ownerId?: string
  section?: TaskSection
  weeklyRecordId?: string
  targetType?: 'task' | 'followup' | 'digest' | 'deadlineRequest' | 'blocker' | 'decisionRequest'
}
export type Navigate = (page: PageId, intent?: NavigationIntent) => void
