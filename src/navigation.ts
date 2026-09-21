export type PageId =
  'overview' | 'monthly' | 'weekly' | 'goals' | 'projects' | 'reports' | 'team' | 'imports' | 'messages' | 'notification-settings' | 'collaboration' | 'work-register' | 'feedback'
export interface NavigationIntent {
  action?: 'create' | 'create-task' | 'review' | 'publish' | 'write-weekly'
  query?: string
  id?: string
  month?: string
  weekStart?: string
  status?: string
  cycleWeek?: string
  kind?: 'results' | 'plan'
  ownerId?: string
  targetType?: 'task' | 'followup' | 'digest' | 'deadlineRequest'
}
export type Navigate = (page: PageId, intent?: NavigationIntent) => void
