// Frozen from git show 65317c6:shared/task-state.ts.
import type { Task } from '../../../shared/types'

/** Cancelling a task is independent from completing its work or deleting a weekly arrangement. */
export function isActiveTask(task: Pick<Task, 'cancellation'>): boolean { return !task.cancellation }
