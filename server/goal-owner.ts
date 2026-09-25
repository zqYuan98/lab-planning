import { Router } from 'express'
import type { MonthlyPlan, Task, User } from '../shared/types.ts'
import type { GoalOwnerProgress, GoalOwnerTask, GoalOwnerTasks, GoalOwnerWeekly } from '../shared/goal-owner.ts'
import { HttpError, type Store } from './store.ts'
import { pageContext, pageWindow, queryKeys, queryText, type PageReadContext } from './page-read-common.ts'

const taskProjection = `json_object('id',t.id,'title',json_extract(t.data,'$.title'),'ownerId',json_extract(t.data,'$.ownerId'),'ownerName',COALESCE(json_extract(u.data,'$.name'),'成员'),'status',json_extract(t.data,'$.status'),'dueDate',json_extract(t.data,'$.dueDate'),'priority',json_extract(t.data,'$.priority'))`
const linkedTasks = `t.collection='tasks' AND json_extract(t.data,'$.monthlyPlanId')=? AND json_extract(t.data,'$.cancellation') IS NULL`
const ownerJoin = `LEFT JOIN entities u ON u.collection='users' AND u.id=json_extract(t.data,'$.ownerId')`

/** Derived reads deliberately never grant access to the general task API or its writes. */
export class GoalOwnerService {
  constructor(private store: Store) {}
  private read<T>(actor: User, id: string, action: string, load: (context: PageReadContext, plan: MonthlyPlan) => T, taskId?: string): T {
    id = queryText(id, 200)
    if (!id) throw new HttpError(400, '目标标识无效')
    try {
      return this.store.transaction(() => {
        const context = pageContext(this.store, actor), plan = this.store.get<MonthlyPlan>('plans', id)
        if (!plan || plan.visibility || plan.status === 'merged' || context.actor.role !== 'manager' && plan.ownerId !== context.actor.id) throw new HttpError(404, '当前目标不存在或负责人权限已失效', 'ACCESS_REVOKED')
        const value = load(context, plan)
        const rows = (value as { items?: { id: string }[] }).items ?? []
        this.store.recordObjectRead({ actorId: context.actor.id, action, objectType: taskId ? 'task' : 'monthlyPlan', objectId: taskId ?? id, authorizedGoalId: id, objectIds: rows.map(row => row.id), outcome: 'allowed' })
        return value
      })
    } catch (error) {
      if (error instanceof HttpError && [403, 404].includes(error.status)) this.store.recordObjectRead({ actorId: actor.id, action, objectType: taskId ? 'task' : 'monthlyPlan', objectId: taskId ?? id, authorizedGoalId: id, objectIds: [], outcome: 'denied' })
      throw error
    }
  }
  tasks(actor: User, planId: string, input: Record<string, unknown>): GoalOwnerTasks {
    return this.read(actor, planId, 'goal_owner_tasks', (context, plan) => {
      queryKeys(input, ['q', 'cursor', 'limit'])
      const q = queryText(input.q, 120), window = pageWindow(input, context, ['goal-owner-tasks', plan.id])
      const where = `${linkedTasks}${q ? " AND instr(lower(json_extract(t.data,'$.title')),lower(?))>0" : ''}`, values = q ? [plan.id, q] : [plan.id]
      const total = Number(this.store.selectRows(`SELECT COUNT(*) AS n FROM entities t WHERE ${where}`, values)[0].n)
      const items = this.store.selectJson<GoalOwnerTask>(`SELECT ${taskProjection} AS data FROM entities t ${ownerJoin} WHERE ${where} ORDER BY t.id LIMIT ? OFFSET ?`, [...values, window.limit, window.offset])
      return { items, total, nextCursor: window.offset + items.length < total ? window.cursor(window.offset + items.length) : null, revision: context.revision, accessScopeVersion: context.accessScopeVersion, plan: { id: plan.id, title: plan.title, month: plan.month }, readOnly: true }
    })
  }
  weekly(actor: User, planId: string, taskId: string, input: Record<string, unknown>): GoalOwnerProgress {
    taskId = queryText(taskId, 200)
    return this.read(actor, planId, 'goal_owner_progress', (context, plan) => {
      queryKeys(input, ['cursor', 'limit'])
      const task = this.store.get<Task>('tasks', taskId)
      if (!task || task.cancellation || task.monthlyPlanId !== plan.id) throw new HttpError(404, '任务已离开当前目标或不存在', 'ACCESS_REVOKED')
      const window = pageWindow(input, context, ['goal-owner-progress', plan.id, task.id])
      const where = "collection='weeklyRecords' AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.monthlyPlanId')=? AND json_extract(data,'$.ownerId')=? AND json_extract(data,'$.submitted')=1 AND json_extract(data,'$.deletion') IS NULL", values = [task.id, plan.id, task.ownerId]
      const total = Number(this.store.selectRows(`SELECT COUNT(*) AS n FROM entities WHERE ${where}`, values)[0].n)
      const fields = ['id', 'weekStart', 'commitment', 'actualOutcome', 'blocker', 'nextAction', 'status']
      const projection = `json_object(${fields.flatMap(field => [`'${field}'`, `json_extract(data,'$.${field}')`]).join(',')})`
      const items = this.store.selectJson<GoalOwnerWeekly>(`SELECT ${projection} AS data FROM entities WHERE ${where} ORDER BY json_extract(data,'$.weekStart') DESC,id LIMIT ? OFFSET ?`, [...values, window.limit, window.offset])
      const selected = this.store.selectJson<GoalOwnerTask>(`SELECT ${taskProjection} AS data FROM entities t ${ownerJoin} WHERE t.collection='tasks' AND t.id=?`, [task.id])[0]
      return { items, total, nextCursor: window.offset + items.length < total ? window.cursor(window.offset + items.length) : null, revision: context.revision, accessScopeVersion: context.accessScopeVersion, task: selected, readOnly: true }
    }, taskId)
  }
}

export function goalOwnerRouter(store: Store) {
  const router = Router(), service = new GoalOwnerService(store)
  router.get('/workspace/goal-owner/plans/:id/tasks', (req, res) => res.json(service.tasks(req.user, String(req.params.id), req.query)))
  router.get('/workspace/goal-owner/plans/:id/tasks/:taskId/weekly', (req, res) => res.json(service.weekly(req.user, String(req.params.id), String(req.params.taskId), req.query)))
  return router
}
