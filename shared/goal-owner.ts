import type { Task, WeeklyRecord } from './types'
import type { WorkspacePage } from './workspace-query'

export type GoalOwnerTask = Pick<Task, 'id' | 'title' | 'ownerId' | 'status' | 'dueDate' | 'priority'> & { ownerName: string }
export type GoalOwnerWeekly = Pick<WeeklyRecord, 'id' | 'weekStart' | 'commitment' | 'actualOutcome' | 'blocker' | 'nextAction' | 'status'>
export interface GoalOwnerTasks extends WorkspacePage<GoalOwnerTask> { plan: { id: string; title: string; month: string }; readOnly: true }
export interface GoalOwnerProgress extends WorkspacePage<GoalOwnerWeekly> { task: GoalOwnerTask; readOnly: true }
