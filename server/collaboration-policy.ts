import type { CollaborationSettings, TaskTracking } from '../shared/collaboration.ts'
import type { MonthlyPlan, Project, Task, User } from '../shared/types.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { HttpError, type Store } from './store.ts'

export const COLLABORATION_SETTINGS_ID = 'collaboration'
export function readCollaborationSettings(store: Store): CollaborationSettings {
  return store.get<CollaborationSettings>('collaborationSettings', COLLABORATION_SETTINGS_ID) ?? {
    id: COLLABORATION_SETTINGS_ID, version: 0, createdAt: '', updatedAt: '', enabled: false,
    autoRulesEnabled: false, deadlineApprovalEnabled: false, dailyManagerEnabled: false,
    weeklyManagerEnabled: false, memberActionsEnabled: false, pilotUserIds: [], defaultManagerIds: [],
    calendarOverrides: {}, staleWorkdays: 3, blockerWorkdays: 2, enabledAt: null,
  }
}
export function collaborationEnabledFor(store: Store, ownerId: string): boolean {
  const settings = readCollaborationSettings(store)
  return settings.enabled && settings.pilotUserIds.includes(ownerId)
}
export function liveCollaborationActor(store: Store, actor: User, managerOnly = false): User {
  const current = store.get<User>('users', actor.id)
  if (!current || !canUseAccount(current) || current.role === 'observer' || managerOnly && current.role !== 'manager') throw new HttpError(403, managerOnly ? '此操作需要有效管理者权限' : '账号当前无业务操作权限')
  return current
}
export function collaborationTask(store: Store, actor: User, id: string): Task {
  const current = liveCollaborationActor(store, actor), task = store.get<Task>('tasks', id)
  if (!task || current.role !== 'manager' && task.ownerId !== current.id) throw new HttpError(404, '任务不存在或无权访问')
  return task
}
export function validManagerIds(store: Store, value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 3 || value.some(id => typeof id !== 'string') || new Set(value).size !== value.length) throw new HttpError(400, '管理接收人须为一位主接收人及最多两位抄送，且不能重复')
  for (const id of value as string[]) {
    const user = store.get<User>('users', id)
    if (!user || !canUseAccount(user) || user.role !== 'manager') throw new HttpError(400, '管理接收人必须是有效管理者')
  }
  return value as string[]
}
export function effectiveManagerIds(store: Store, task: Task): string[] {
  const tracking = store.get<TaskTracking>('taskTrackings', task.id)
  const live = (ids: string[]) => [...new Set(ids)].filter(id => {
    const user = store.get<User>('users', id)
    return !!user && canUseAccount(user) && user.role === 'manager'
  }).slice(0, 3)
  const configured = live(tracking?.managerRecipientIds ?? [])
  if (configured.length) return configured
  const original = task.workOrigin?.kind === 'assigned' ? live([task.workOrigin.actorId]) : []
  return original.length ? original : live(readCollaborationSettings(store).defaultManagerIds)
}
/** Business eligibility only; callers separately require an active tracking generation. */
export function taskTrackingEligible(store: Store, task: Task, _now = new Date()): boolean {
  if (!isActiveTask(task) || !collaborationEnabledFor(store, task.ownerId) || task.status === 'done') return false
  const owner = store.get<User>('users', task.ownerId)
  if (!owner || !canUseAccount(owner) || owner.role === 'observer') return false
  if (task.monthlyPlanId) {
    const plan = store.get<MonthlyPlan>('plans', task.monthlyPlanId)
    if (!plan || plan.status !== 'published' || plan.visibility) return false
    if (plan.projectId && store.get<Project>('projects', plan.projectId)?.status !== 'active') return false
  }
  return true
}
export function shanghaiDay(time: Date): string { return new Date(time.getTime() + 8 * 3600000).toISOString().slice(0, 10) }
export function collaborationWorkday(store: Store, day: string): boolean {
  const overrides = readCollaborationSettings(store).calendarOverrides
  if (Object.hasOwn(overrides, day)) return overrides[day]
  const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
  return weekday !== 0 && weekday !== 6
}
export function defaultFollowupDueAt(store: Store, now: Date): string {
  const day = new Date(`${shanghaiDay(now)}T00:00:00Z`)
  for (let offset = 1; offset <= 370; offset++) {
    day.setUTCDate(day.getUTCDate() + 1)
    const date = day.toISOString().slice(0, 10)
    if (collaborationWorkday(store, date)) return new Date(`${date}T17:00:00+08:00`).toISOString()
  }
  throw new HttpError(400, '日历内没有可用回应工作日')
}
