import type { AuditEvent, MonthlyPlan, Task, User } from '../shared/types.ts'
import type { CommitmentValue, TaskCommitmentEvent } from '../shared/period-reviews.ts'
import type { Store } from './store.ts'
import { isSilentImport } from './import-notification-context.ts'

export function commitmentScope(task: Pick<Task, 'requestedOutcome' | 'description' | 'title'>): string {
  return task.requestedOutcome ? `${task.requestedOutcome}${task.description ? `\n\n任务说明：${task.description}` : ''}` : task.description || task.title
}

export function commitmentValue(store: Store, task: Task): CommitmentValue {
  return { title: task.title, ownerId: task.ownerId, monthlyPlanId: task.monthlyPlanId, projectId: task.monthlyPlanId ? store.get<MonthlyPlan>('plans', task.monthlyPlanId)?.projectId ?? null : null,
    dueDate: task.dueDate, scope: commitmentScope(task), cancelled: !!task.cancellation }
}
/** Base audit hook: deliberately independent from optional collaboration enrollment. */
export function recordTaskCommitment(store: Store, actor: User, event: AuditEvent): void {
  if (isSilentImport(store)) return
  if (event.entityType === 'plan' && event.before && event.after) {
    const before = event.before as MonthlyPlan, after = event.after as MonthlyPlan
    if (before.projectId === after.projectId) return
    for (const task of store.list<Task>('tasks').filter(row => row.monthlyPlanId === event.entityId)) {
      const next = commitmentValue(store, task)
      store.insert<TaskCommitmentEvent>('taskCommitmentEvents', { taskId: task.id, kind: 'association', oldValue: { ...next, projectId: before.projectId }, newValue: next,
        effectiveAt: event.createdAt, recordedAt: event.createdAt, actorId: actor.id, reason: event.reason || '月目标项目关系变更', sourceType: 'audit', sourceId: event.id, sourceVersion: event.version })
    }
    return
  }
  if (event.entityType !== 'task' || !event.after) return
  const before = event.before as Task | null, after = event.after as Task
  const oldValue = before ? commitmentValue(store, before) : null, newValue = commitmentValue(store, after)
  const kinds: TaskCommitmentEvent['kind'][] = !before ? ['initial'] : [
    ...(before.dueDate !== after.dueDate ? ['deadline' as const] : []), ...(before.ownerId !== after.ownerId ? ['owner' as const] : []),
    ...(oldValue!.scope !== newValue.scope || before.title !== after.title ? ['scope' as const] : []),
    ...(before.monthlyPlanId !== after.monthlyPlanId ? ['association' as const] : []), ...(!before.cancellation && after.cancellation ? ['cancellation' as const] : []),
  ]
  for (const kind of kinds) store.insert<TaskCommitmentEvent>('taskCommitmentEvents', { taskId: after.id, kind, oldValue, newValue,
    effectiveAt: event.createdAt, recordedAt: event.createdAt, actorId: actor.id, reason: event.reason || (kind === 'initial' ? '首次记录有效任务承诺' : '任务字段审计'), sourceType: 'audit', sourceId: event.id, sourceVersion: event.version })
}
