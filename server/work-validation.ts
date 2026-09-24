import type { Task, WeeklyRecord } from '../shared/types.ts'
import { HttpError } from './store.ts'

/** Constructed by server services, never spread from an HTTP request. */
export interface WorkValidationContext {
  type: 'task' | 'weeklyRecord'
  authority?: 'human' | 'trusted-import' | 'restore'
  formalSubmission?: boolean
}

const taskEvidenceFields = ['currentProgress', 'completionNote', 'evidenceUrl', 'blockerReason', 'blockerImpact', 'supportNeeded'] as const
const weeklyEvidenceFields = ['actualOutcome', 'evidenceUrl', 'blocker', 'blockerImpact', 'supportNeeded'] as const

/** Validate the effective record while distinguishing an explicit report from an unrelated legacy edit. */
export function validateWorkChange(before: Task | WeeklyRecord | undefined, normalizedPatch: Partial<Task> | Partial<WeeklyRecord>, context: WorkValidationContext): void {
  if (context.authority === 'trusted-import' || context.authority === 'restore') return
  const patch = normalizedPatch as Record<string, unknown>
  const next = { ...before, ...normalizedPatch } as unknown as Record<string, unknown>
  const evidenceFields = context.type === 'task' ? taskEvidenceFields : weeklyEvidenceFields
  const reporting = !before || context.formalSubmission || patch.status !== undefined
    || context.type === 'weeklyRecord' && patch.submitted === true
    || evidenceFields.some(field => patch[field] !== undefined)
  if (!reporting) return

  const errors: Record<string, string> = {}
  const require = (field: string, message: string) => {
    if (typeof next[field] !== 'string' || !next[field].trim()) errors[field] = message
  }
  if (context.type === 'task') {
    if (next.status === 'done') require('completionNote', '完成整个任务需要填写完成说明')
    if (next.status === 'blocked') {
      require('blockerReason', '任务受阻需要填写原因')
      require('blockerImpact', '正式报告阻塞需要填写阻塞影响')
      require('supportNeeded', '正式报告阻塞需要填写需要支持，可明确填写“暂不需要支持”')
    }
  } else {
    if (next.status === 'done') require('actualOutcome', '标记完成时需要填写实际成果')
    if (next.status === 'blocked' || next.status === 'not_done') require('blocker', '阻塞或未完成时需要填写原因')
    if (next.status === 'blocked' && (next.submitted || context.formalSubmission)) {
      require('blockerImpact', '正式报告本周工作阻塞需要填写阻塞影响')
      require('supportNeeded', '正式报告本周工作阻塞需要填写需要支持，可明确填写“暂不需要支持”')
    }
  }
  if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors)[0], 'WORK_VALIDATION_FAILED', errors)
}
