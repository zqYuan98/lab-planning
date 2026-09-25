import { Store } from '../server/store.ts'
import type { AuditEvent, Entity, MonthlyPlan, Publication, Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { ObjectGrant } from '../shared/object-access.ts'
import type { ProgressEvent } from '../shared/collaboration.ts'

export const performanceNow = '2026-09-24T04:00:00.000Z'
export const performanceSeed = 'r2-2026-09-24-v1'
const memberId = (index: number) => `member-${String(index % 15).padStart(2, '0')}`
const metadata = (id: string, at: string, version = 1): Entity => ({ id, version, createdAt: at, updatedAt: at })

/** Fixed synthetic history; never loads .env, reads a business database or sends I/O. */
export function performanceFixture(months: number) {
  if (!Number.isInteger(months) || months < 1 || months > 36) throw new Error('Performance fixture supports 1–36 months')
  const store = new Store(':memory:')
  const counts = { members: 15, months, plans: 0, tasks: 0, weeklyRecords: 0, events: 0, publications: 0, progressEvents: 0, reports: 0 }
  const put = <T extends Entity>(collection: string, row: T) => store.restoreEntity<T>(collection, row)
  const user = (id: string, role: User['role']) => put<User>('users', {
    ...metadata(id, '2020-01-01T00:00:00.000Z'), name: `合成${id}`, email: `${id}@performance.invalid`, role, active: true, position: '合成数据',
  })
  const manager = user('manager', 'manager'), members = Array.from({ length: 15 }, (_, index) => user(memberId(index), 'member'))
  const observer = user('observer', 'observer')
  const audit = (entityType: string, entityId: string, before: unknown, after: unknown, at: string, suffix: string, actorId = manager.id) => {
    counts.events++
    return put<AuditEvent>('events', { ...metadata(`event-${entityId}-${suffix}`, at), entityType, entityId, actorId, action: before === null ? 'create' : 'update', before, after, reason: '合成审计记录' })
  }
  store.transaction(() => {
    put('operationContexts', { ...metadata('business-commands', performanceNow), epoch: `${performanceSeed}-epoch` })
    for (let monthIndex = 0; monthIndex < months; monthIndex++) {
      const start = new Date(Date.UTC(2026, 9 - months + monthIndex, 1)), month = start.toISOString().slice(0, 7)
      const at = `${month}-01T00:00:00.000Z`
      const snapshots: MonthlyPlan[] = []
      const currentPlans: MonthlyPlan[] = []
      for (let planIndex = 0; planIndex < 6; planIndex++) {
        const id = `plan-${month}-${planIndex}`
        const original: MonthlyPlan = { ...metadata(id, at), month, title: `合成${month}目标${planIndex}`, projectId: null, category: '基准研究',
          ownerId: memberId(planIndex), collaboratorIds: [memberId(planIndex + 6)], expectedOutcome: '历史获准成员可以读取的成果范围。'.repeat(4),
          acceptanceCriteria: '合成验收标准', dueDate: `${month}-28`, priority: planIndex % 2 ? 'medium' : 'high', status: 'published', reviewComment: '',
          publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '' }
        const changed: MonthlyPlan = { ...original, version: 2, updatedAt: `${month}-08T00:00:00.000Z`, ownerId: memberId(planIndex + 1), collaboratorIds: [memberId(planIndex + 7)], title: `${original.title}权限变更`, expectedOutcome: '新成员可见内容。'.repeat(4) }
        const current: MonthlyPlan = { ...changed, version: 3, updatedAt: `${month}-15T00:00:00.000Z`, actualOutcome: '合成阶段成果', acceptanceStatus: 'accepted' }
        put('plans', current); counts.plans++; currentPlans.push(current)
        audit('plan', id, null, original, at, 'create')
        audit('plan', id, original, changed, changed.updatedAt, 'membership')
        audit('plan', id, changed, current, current.updatedAt, 'accepted')
        snapshots.push(original)
      }
      put<Publication>('publications', { ...metadata(`publication-${month}`, at), month, revision: 1, actorId: manager.id, reason: '合成发布', plans: snapshots }); counts.publications++
      for (let taskIndex = 0; taskIndex < 30; taskIndex++) {
        const ownerId = memberId(taskIndex), plan = currentPlans[taskIndex % 6], id = `task-${month}-${String(taskIndex).padStart(2, '0')}`
        const original: Task = { ...metadata(id, at), title: `合成任务 ${month} ${taskIndex}`, ownerId, monthlyPlanId: plan.id,
          description: '可重复的合成任务说明。'.repeat(5), dueDate: `${month}-28`, status: 'doing', isTemporary: false, temporaryReason: '', currentProgress: '' }
        const task: Task = { ...original, version: 2, updatedAt: `${month}-22T00:00:00.000Z`, currentProgress: '已完成一轮合成验证',
          ...(taskIndex === 29 ? { cancellation: { cancelledAt: `${month}-23T00:00:00.000Z`, cancelledBy: manager.id, reason: '合成取消' } } : {}) }
        // One verified historical task/month is intentionally absent from the live collection.
        if (taskIndex !== 28) put('tasks', task)
        counts.tasks++
        audit('task', id, null, original, at, 'create', ownerId)
        const progressAudit = audit('task', id, original, task, task.updatedAt, 'progress', ownerId)
        const firstMonday = new Date(start); firstMonday.setUTCDate(1 + (8 - firstMonday.getUTCDay()) % 7)
        for (let offset = 0; offset < 4; offset++) {
          const day = new Date(firstMonday); day.setUTCDate(day.getUTCDate() + offset * 7)
          const weekStart = day.toISOString().slice(0, 10), rowId = `weekly-${id}-${offset}`
          const row: WeeklyRecord = { ...metadata(rowId, `${weekStart}T01:00:00.000Z`), taskId: id, monthlyPlanId: plan.id, ownerId, weekStart,
            commitment: '完成合成验证阶段', actualOutcome: `合成进展${offset}`, evidenceUrl: '', blocker: '', nextAction: '', status: 'done', submitted: true,
            ...(taskIndex === 27 && offset === 0 ? { deletion: { deletedAt: `${month}-23T00:00:00.000Z`, deletedBy: manager.id, reason: '合成删除' } } : {}) }
          put('weeklyRecords', row); counts.weeklyRecords++
          audit('weeklyRecord', rowId, null, row, row.createdAt, 'create', ownerId)
        }
        put<ProgressEvent>('progressEvents', { ...metadata(`progress-${id}`, task.updatedAt), mutationId: `mutation-${id}`, taskId: id, weeklyRecordId: null,
          actorId: ownerId, ownerId, source: 'task', noteType: 'progress', note: '合成进展', noChangeReason: '', nextAction: '', proxyReason: '',
          changes: [{ field: 'task.currentProgress', before: '', after: task.currentProgress! }], meaningfulOwnerProgress: true, occurredAt: task.updatedAt, auditEventIds: [progressAudit.id] }); counts.progressEvents++
      }
      put<Report>('reports', { ...metadata(`report-${month}`, at), type: 'monthly', period: month, title: `合成报告 ${month}`, status: 'finalized', revision: 1,
        narrative: '历史定稿合成报告正文。'.repeat(200), authorId: manager.id, finalizedAt: `${month}-28T00:00:00.000Z`,
        snapshot: { plans: snapshots, tasks: [], weeklyRecords: [], projects: [], users: [], annualGoals: [], nextPlans: [], nextWeeklyRecords: [], publications: [], changes: [] } }); counts.reports++
    }
    for (let index = 0; index < 3; index++) {
      const objectId = `task-2026-09-0${index}`
      put<ObjectGrant>('objectGrants', { ...metadata(`grant-${index}`, '2026-09-01T00:00:00.000Z'), subjectId: observer.id, objectType: 'task', objectId,
        capabilities: ['read'], historyPolicy: 'all_history', objectVersion: 2, grantedBy: manager.id, grantedAt: '2026-09-01T00:00:00.000Z',
        expiresAt: null, revokedAt: index === 2 ? '2026-09-20T00:00:00.000Z' : null, reason: '合成授权及撤权', excludedFactIds: [] })
    }
  })
  return { store, actors: { manager, member: members[0], observer }, members, counts }
}
