export type PageId =
  'overview' | 'monthly' | 'weekly' | 'goals' | 'projects' | 'reports' | 'team' | 'imports'
export interface NavigationIntent {
  action?: 'create' | 'review' | 'publish' | 'write-weekly'
  query?: string
  id?: string
  month?: string
  weekStart?: string
  status?: string
}
export type Navigate = (page: PageId, intent?: NavigationIntent) => void
