import { api, ApiError } from './api'
import { captureMutationContext, MutationContextChangedError } from './mutation-response'
import type { EditableObject } from '../shared/task-view'
import type { DraftValues } from './draft-recovery'
import { editableDraftValues } from './draft-v3'

export function editingUnavailable(error: unknown) {
  return error instanceof MutationContextChangedError || error instanceof ApiError &&
    ([401, 403, 404].includes(error.status) || ['TASK_CANCELLED', 'WEEKLY_RECORD_DELETED'].includes(error.code || ''))
}

/** A conflict projection is usable only within the identity that requested it. */
export async function readEditableObject(path: string) {
  const context = captureMutationContext()
  const current = await api<EditableObject>(path)
  if (context !== captureMutationContext()) throw new MutationContextChangedError()
  return current
}

export function editableComparisonValues(current: EditableObject, local: DraftValues) {
  return editableDraftValues({ ...current.values, ...(current.relatedTask ? {
    __taskStatus: current.relatedTask.status, __taskCompletionNote: current.relatedTask.completionNote, __completeTask: '',
  } : {}) }, local)
}

/** A fresh authorized task read supersedes a projection retained during conflict recovery. */
export function currentRelatedTask<T extends { id: string; version: number }>(current: T | undefined, recovered: T | undefined): T | undefined {
  return current && recovered?.id === current.id && recovered.version > current.version ? recovered : current
}
