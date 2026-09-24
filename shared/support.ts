import type { BlockerAction, BlockerEpisode } from './collaboration'
import type { Entity } from './types'

export type CoordinationState = 'unassigned' | 'awaiting_response' | 'in_progress' | 'responded' | 'management_closed'
export interface DecisionRequest extends Entity {
  taskId: string; blockerEpisodeId: string | null; question: string; options: string[]
  decisionOwnerId: string; responseDueAt: string; status: 'open' | 'decided' | 'cancelled'
  result: string; decidedAt: string | null; decidedBy: string | null; generation: number
  requestedBy: string; reason: string
}
export interface BlockerAssignInput { requestId: string; version: number; coordinatorId: string; responseDueAt: string; reason: string }
export interface BlockerHandleInput {
  requestId: string; version: number; action: 'record' | 'respond' | 'defer' | 'close'
  note: string; reviewAt?: string | null
}
export interface DecisionCreateInput {
  requestId: string; taskId: string; taskVersion: number; blockerEpisodeId?: string
  question: string; options: string[]; decisionOwnerId: string; responseDueAt: string; reason?: string
}
export interface DecisionUpdateInput {
  requestId: string; version: number; result?: string; reason?: string; decisionOwnerId?: string; responseDueAt?: string
}
export interface BlockerView {
  episode: BlockerEpisode; actions: BlockerAction[]; task: { id: string; title: string; ownerId: string }
  minimalContext: boolean; coordinatorAvailable: boolean; allowedActions: string[]
}
export interface TaskSupportView {
  blockers: BlockerView[]; decisions: (DecisionRequest & { allowedActions: string[]; ownerAvailable: boolean })[]
  eligibleCoordinators: { id: string; name: string }[]; eligibleDecisionOwners: { id: string; name: string }[]
  canCreateDecision: boolean; canEnrollBlocker: boolean
}
