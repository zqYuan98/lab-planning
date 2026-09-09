import type { AuditEvent, Entity, MonthlyPlan, Project, User } from '../shared/types.ts'
import { Store, HttpError } from './store.ts'
import { canUseAccount } from '../shared/auth-policy.ts'

export type Input = Record<string, unknown>
export function text(value: unknown, label: string, required = true, max = 12000): string {
  if (value === undefined || value === null) {
    if (!required) return ''
    throw new HttpError(400, `请填写${label}`)
  }
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new HttpError(400, `${label}格式不正确`)
  return value.trim()
}
export function choice<const T extends string>(value: unknown, values: readonly T[], label: string): T {
  if (typeof value !== 'string' || !values.includes(value as T)) throw new HttpError(400, `${label}不正确`)
  return value as T
}
export function bool(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') throw new HttpError(400, `${label}必须是布尔值`)
  return value
}
export function number(value: unknown, label: string, min: number, max: number, integer = false): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new HttpError(400, `${label}范围不正确`)
  return value
}
export function month(value: unknown): string {
  const result = text(value, '月份', true, 7)
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(result)) throw new HttpError(400, '月份格式应为 YYYY-MM')
  return result
}
export function date(value: unknown, label = '日期'): string {
  const result = text(value, label, true, 10)
  const parsed = new Date(`${result}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(result) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result) throw new HttpError(400, `${label}不是有效日期`)
  return result
}
export function monday(value: unknown): string {
  const day = new Date(`${date(value, '所属周')}T00:00:00Z`)
  day.setUTCDate(day.getUTCDate() - (day.getUTCDay() + 6) % 7)
  return day.toISOString().slice(0, 10)
}
export function version(input: Input): number {
  if (!Number.isInteger(input.version) || Number(input.version) < 1) throw new HttpError(409, '缺少有效数据版本，请刷新后重试')
  return Number(input.version)
}
export function manager(actor: User) {
  if (actor.role !== 'manager') throw new HttpError(403, '此操作需要管理者权限')
}
export function own(actor: User, ownerId: string) {
  if (actor.role !== 'manager' && actor.id !== ownerId) throw new HttpError(403, '不能修改其他成员的记录')
}
export function participates(plan: MonthlyPlan, userId: string) { return plan.ownerId === userId || plan.collaboratorIds.includes(userId) }

export class DomainBase {
  constructor(protected store: Store) {}
  protected need<T>(collection: string, id: string): T {
    const result = this.store.get<T>(collection, id)
    if (!result) throw new HttpError(404, '记录不存在')
    return result
  }
  protected current<T extends Entity>(collection: string, id: string, input: Input): T {
    const before = this.need<T>(collection, id)
    if (before.version !== version(input)) throw new HttpError(409, '数据已更新，请刷新后重试')
    return before
  }
  protected activeUser(value: unknown): User {
    const user = this.need<User>('users', text(value, '负责人'))
    if (!canUseAccount(user)) throw new HttpError(400, '不能分配给已停用或未通过注册审核的成员')
    return user
  }
  protected activeProject(id: string): Project {
    const project = this.need<Project>('projects', id)
    if (project.status === 'archived') throw new HttpError(400, '项目已归档，不能新增计划或任务')
    return project
  }
  protected planVisible(actor: User, plan: MonthlyPlan): boolean {
    if (actor.role === 'manager' || participates(plan, actor.id)) return true
    return this.store.list<AuditEvent>('events').some(event => event.entityType === 'plan' && event.entityId === plan.id && [event.before, event.after].some(snapshot => {
      const item = snapshot as MonthlyPlan | null
      return item?.ownerId === actor.id || item?.collaboratorIds?.includes(actor.id)
    }))
  }
  protected audit(actor: User, entityType: string, entityId: string, action: string, before: unknown, after: unknown, reason = '') {
    this.store.insert<AuditEvent>('events', { entityType, entityId, actorId: actor.id, action, reason, before, after })
  }
  protected owner(actor: User, requested: unknown): string {
    const id = requested === undefined ? actor.id : text(requested, '负责人')
    own(actor, id)
    return this.activeUser(id).id
  }
}
