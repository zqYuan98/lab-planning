import type { Entity } from './types'

/** Operational opt-in: an absent setting delegates nobody. Never included in business restores. */
export interface WeeklyReviewDelegationSettings extends Entity { enabledOwnerIds: string[] }
export interface WeeklyReviewDelegationView {
  settings: WeeklyReviewDelegationSettings
  members: { id: string; name: string; available: boolean }[]
}
export type WholePlanReviewer = { kind: 'manager' } | { kind: 'goal_owner'; reviewerId: string; goalId: string }
export interface WeeklyReviewQueueItem {
  dutyId: string; version: number; ownerId: string; ownerName: string; contentWeek: string
  submissionId: string; submittedAt: string; reviewer: WholePlanReviewer; retainedDraftCount: number
  items: { recordId: string; taskTitle: string; goalTitle: string; commitment: string; change: 'new' | 'changed' | 'already-approved' }[]
}
export interface WeeklyReviewQueue { week: string; items: WeeklyReviewQueueItem[]; nextCursor: string | null }
