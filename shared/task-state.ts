import type { Task } from './types'

/** Cancelling a task is independent from completing its work or deleting a weekly arrangement. */
export function isActiveTask(task: Pick<Task, 'cancellation'>): boolean { return !task.cancellation }
