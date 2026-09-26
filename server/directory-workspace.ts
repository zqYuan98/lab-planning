import { Router } from 'express'
import { annualGoalProgress } from '../shared/annual-goals.ts'
import { projectPlan } from './plan-visibility.ts'
import type { AnnualGoal, MonthlyPlan, Project, User } from '../shared/types.ts'
import type { AnnualGoalDetail, DirectoryAccount, DirectoryAccountsPage, GoalsPage, ProjectsPage, RegistrationPage, TeamCounts, TeamPage } from '../shared/directory-workspace.ts'
import { safeUser } from './auth.ts'
import { HttpError, type Store } from './store.ts'
import { pageContext, pageWindow, queryKeys, queryText, type PageReadContext } from './page-read-common.ts'
import { historicalPlanDataSql } from './workspace-plan-snapshot.ts'
import { isManager, isObserver } from './authorization.ts'

type Query = Record<string, unknown>
type Value = string | number | null
const field = (name: string) => `json_extract(e.data,'$.${name}')`
const approved = `(COALESCE(${field('registrationStatus')},'approved')='approved')`
const usable = `${approved} AND ${field('active')}=1`
const userData = "json_remove(e.data,'$.passwordHash','$.credentialVersion')"
function oneOf(value: unknown, choices: string[], fallback: string) {
  const text = queryText(value) || fallback
  if (!choices.includes(text)) throw new HttpError(400, '查询范围无效')
  return text
}
const account = (user: User): DirectoryAccount => ({ id: user.id, name: user.name, role: user.role, position: user.position, active: user.active, ...(user.registrationStatus ? { registrationStatus: user.registrationStatus } : {}) })
const reviewUser = (user: User): User => ({ ...safeUser(user), ...(user.registrationStatus ? { registrationReviewComment: user.registrationReviewComment ?? '' } : {}) })

/** Small directory reads: no task/weekly/report/history payload is returned. */
export class DirectoryWorkspaceService {
  constructor(private store: Store) {}
  private context(actor: User, managerOnly = false) {
    const context = pageContext(this.store, actor)
    if (managerOnly && !isManager(context.actor)) throw new HttpError(403, '此目录需要管理者权限')
    return context
  }
  private page<T>(input: Query, context: PageReadContext, scope: string, where: string, values: Value[], projection = 'e.data', order = `${field('createdAt')} DESC,e.id DESC`) {
    const window = pageWindow(input, context, scope)
    const total = Number(this.store.selectRows(`SELECT COUNT(*) AS n FROM entities e WHERE ${where}`, values)[0].n)
    const items = this.store.selectJson<T>(`SELECT ${projection} AS data FROM entities e WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, [...values, window.limit, window.offset])
    return { items, total, nextCursor: window.offset + items.length < total ? window.cursor(window.offset + items.length) : null, revision: context.revision, accessScopeVersion: context.accessScopeVersion }
  }
  private people(ids: string[], actor: User): Map<string, DirectoryAccount> {
    const keys = [...new Set(ids.filter(Boolean))]
    if (!keys.length) return new Map()
    const rows = this.store.selectJson<User>(`SELECT ${userData} AS data FROM entities e WHERE e.collection='users' AND e.id IN (${keys.map(() => '?').join(',')}) ${isManager(actor) ? '' : `AND ${approved}`}`, keys)
    return new Map(rows.map(user => [user.id, account(user)]))
  }
  private teamCounts(): TeamCounts {
    const row = this.store.selectRows(`SELECT
      SUM(CASE WHEN ${approved} AND ${field('active')}=1 THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN ${approved} AND COALESCE(${field('active')},0)=0 THEN 1 ELSE 0 END) AS inactive,
      SUM(CASE WHEN ${approved} THEN 1 ELSE 0 END) AS allCount,
      SUM(CASE WHEN ${approved} AND ${field('active')}=1 AND ${field('role')}='manager' THEN 1 ELSE 0 END) AS managers,
      SUM(CASE WHEN ${field('registrationStatus')}='pending' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN ${field('registrationStatus')}='rejected' THEN 1 ELSE 0 END) AS rejected FROM entities e WHERE e.collection='users'`)[0]
    return { active: Number(row.active ?? 0), inactive: Number(row.inactive ?? 0), all: Number(row.allCount ?? 0), activeManagers: Number(row.managers ?? 0), pending: Number(row.pending ?? 0), rejected: Number(row.rejected ?? 0) }
  }
  team(actor: User, input: Query): TeamPage {
    return this.store.readTransaction(() => {
      queryKeys(input, ['status', 'q', 'focusId', 'cursor', 'limit'])
      const context = this.context(actor, true), status = oneOf(input.status, ['active', 'inactive', 'all'], 'active'), q = queryText(input.q, 120), focusId = queryText(input.focusId)
      let where = `e.collection='users' AND ${approved}`
      const values: Value[] = []
      if (status !== 'all') { where += ` AND ${field('active')}=?`; values.push(status === 'active' ? 1 : 0) }
      if (q) { where += ` AND (instr(lower(COALESCE(${field('name')},'')),lower(?))>0 OR instr(lower(COALESCE(${field('email')},'')),lower(?))>0 OR instr(lower(COALESCE(${field('position')},'')),lower(?))>0)`; values.push(q, q, q) }
      const page = this.page<User>(input, context, 'team', where, values, userData)
      const focus = focusId ? this.store.selectJson<User>(`SELECT ${userData} AS data FROM entities e WHERE e.collection='users' AND e.id=?`, [focusId])[0] : undefined
      return { ...page, items: page.items.map(reviewUser), counts: this.teamCounts(), focus: focus ? reviewUser(focus) : null }
    })
  }
  registrations(actor: User, input: Query): RegistrationPage {
    return this.store.readTransaction(() => {
      queryKeys(input, ['status', 'cursor', 'limit'])
      const context = this.context(actor, true), status = oneOf(input.status, ['all', 'pending', 'rejected'], 'all')
      const where = `e.collection='users' AND ${field('registrationStatus')} ${status === 'all' ? "IN ('pending','rejected')" : '=?'}`
      const page = this.page<User>(input, context, 'registration-requests', where, status === 'all' ? [] : [status], userData, `CASE WHEN ${field('registrationStatus')}='pending' THEN 0 ELSE 1 END,${field('createdAt')} DESC,e.id DESC`)
      const counts = this.teamCounts()
      return { ...page, items: page.items.map(reviewUser), counts: { pending: counts.pending, rejected: counts.rejected } }
    })
  }
  accounts(actor: User, input: Query): DirectoryAccountsPage {
    return this.store.readTransaction(() => {
      queryKeys(input, ['purpose', 'q', 'role', 'selectedIds', 'cursor', 'limit'])
      const purpose = oneOf(input.purpose, ['assignment', 'notification', 'diagnostics', 'usage'], 'assignment'), context = this.context(actor, purpose !== 'assignment')
      const q = queryText(input.q, 120), role = oneOf(input.role, ['all', 'member', 'manager', 'observer', 'business'], 'all')
      let ids: string[] = []
      if (input.selectedIds !== undefined) {
        try {
          if (typeof input.selectedIds !== 'string' || input.selectedIds.length > 25_000) throw new Error()
          const parsed: unknown = JSON.parse(input.selectedIds)
          if (!Array.isArray(parsed) || parsed.length > 100 || parsed.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new Error()
          ids = [...new Set(parsed as string[])]
        } catch { throw new HttpError(400, '已选账号标识无效，每次最多 100 项') }
      }
      let base = `e.collection='users'${purpose === 'usage' ? ` AND ${field('role')}='member'` : ''}`
      if (!isManager(context.actor)) base += ` AND ${approved}`
      let where = `${base}${['assignment', 'notification'].includes(purpose) ? ` AND ${usable}` : ''}`
      const values: Value[] = []
      if (role === 'business') where += ` AND ${field('role')} IN ('member','manager')`
      else if (role !== 'all') { where += ` AND ${field('role')}=?`; values.push(role) }
      if (q) { where += ` AND (instr(lower(COALESCE(${field('name')},'')),lower(?))>0 OR instr(lower(COALESCE(${field('position')},'')),lower(?))>0)`; values.push(q, q) }
      const page = this.page<User>(input, context, 'directory-accounts', where, values, userData, `${field('name')} COLLATE NOCASE,e.id`)
      const selected = ids.length ? this.store.selectJson<User>(`SELECT ${userData} AS data FROM entities e WHERE ${base} AND e.id IN (${ids.map(() => '?').join(',')})`, ids) : []
      return { ...page, items: page.items.map(account), selected: selected.map(account) }
    })
  }
  private projectCounts(actor: User, ids: string[]) {
    if (!ids.length) return new Map<string, number>()
    const placeholders = ids.map(() => '?').join(',')
    const rows = isManager(actor)
      ? this.store.selectRows(`SELECT json_extract(data,'$.projectId') AS projectId,COUNT(*) AS n FROM entities WHERE collection='plans' AND json_extract(data,'$.status')='published' AND json_extract(data,'$.projectId') IN (${placeholders}) GROUP BY projectId`, ids)
      : this.store.selectRows(`WITH viewer AS (SELECT ? AS actorId), visible AS (
          SELECT CASE WHEN json_extract(p.data,'$.ownerId')=viewer.actorId OR EXISTS(SELECT 1 FROM json_each(p.data,'$.collaboratorIds') c WHERE c.value=viewer.actorId)
            THEN p.data ELSE ${historicalPlanDataSql('p.id', 'viewer.actorId')} END AS data
          FROM entities p,viewer WHERE p.collection='plans')
        SELECT json_extract(data,'$.projectId') AS projectId,COUNT(*) AS n FROM visible WHERE json_extract(data,'$.status')='published' AND json_extract(data,'$.projectId') IN (${placeholders}) GROUP BY projectId`, [actor.id, ...ids])
    return new Map(rows.map(row => [String(row.projectId), Number(row.n)]))
  }
  projects(actor: User, input: Query): ProjectsPage {
    return this.store.readTransaction(() => {
      queryKeys(input, ['status', 'q', 'focusId', 'cursor', 'limit'])
      const context = this.context(actor), status = oneOf(input.status, ['all', 'active'], 'active'), q = queryText(input.q, 120), focusId = queryText(input.focusId)
      let where = "e.collection='projects'"; const values: Value[] = []
      if (status === 'active') where += ` AND ${field('status')}='active'`
      if (q) { where += ` AND instr(COALESCE(${field('name')},'')||COALESCE(${field('code')},''),?)>0`; values.push(q) }
      const page = this.page<Project>(input, context, 'directory-projects', where, values)
      const focus = focusId ? this.store.get<Project>('projects', focusId) : undefined
      const rows = [...page.items, ...(focus ? [focus] : [])], owners = this.people(rows.map(row => row.ownerId), context.actor), published = this.projectCounts(context.actor, rows.map(row => row.id))
      const project = (row: Project) => ({ ...row, owner: owners.get(row.ownerId) ?? null, publishedPlanCount: published.get(row.id) ?? 0 })
      const counts = this.store.selectRows(`SELECT COUNT(*) AS allCount,SUM(CASE WHEN ${field('status')}='active' THEN 1 ELSE 0 END) AS active,SUM(CASE WHEN ${field('status')}='archived' THEN 1 ELSE 0 END) AS archived FROM entities e WHERE e.collection='projects'`)[0]
      return { ...page, items: page.items.map(project), counts: { all: Number(counts.allCount), active: Number(counts.active ?? 0), archived: Number(counts.archived ?? 0) }, focus: focus ? project(focus) : null }
    })
  }
  private annualPlans(actor: User, year: number, ids: string[]): MonthlyPlan[] {
    if (!ids.length || isObserver(actor)) return []
    const visibility = isManager(actor) ? '' : ` AND (${field('ownerId')}=? OR EXISTS(SELECT 1 FROM json_each(e.data,'$.collaboratorIds') c WHERE c.value=?))`
    return this.store.selectJson<MonthlyPlan>(`SELECT json_object('id',e.id,'month',${field('month')},'annualGoalId',${field('annualGoalId')},'sourcePlanId',${field('sourcePlanId')},'mergedIntoId',${field('mergedIntoId')},'mergedFromIds',json(COALESCE(${field('mergedFromIds')},'[]')),'status',${field('status')},'acceptanceStatus',${field('acceptanceStatus')}) AS data FROM entities e WHERE e.collection='plans' AND substr(${field('month')},1,4)=? AND ${field('annualGoalId')} IN (${ids.map(() => '?').join(',')}) AND ${field('visibility')} IS NULL${visibility}`, [String(year), ...ids, ...(isManager(actor) ? [] : [actor.id, actor.id])])
  }
  goalDetail(actor: User, id: string, input: Query): AnnualGoalDetail {
    return this.store.readTransaction(() => {
      queryKeys(input, ['cursor', 'limit'])
      const context = this.context(actor), goal = this.store.get<AnnualGoal>('annualGoals', id)
      if (!goal) throw new HttpError(404, '年度目标不存在')
      const plans = this.annualPlans(context.actor, goal.year, [id]), rows = plans.filter(plan => plan.status !== 'merged').sort((a,b) => b.month.localeCompare(a.month) || a.id.localeCompare(b.id))
      const window = pageWindow(input, context, `annual-goal:${id}`), selectedIds = rows.slice(window.offset, window.offset + window.limit).map(plan => plan.id)
      const selected = selectedIds.length ? this.store.selectJson<MonthlyPlan>(`SELECT data FROM entities WHERE collection='plans' AND id IN (${selectedIds.map(() => '?').join(',')}) ORDER BY json_extract(data,'$.month') DESC,id`, selectedIds) : []
      return { goal: { ...goal, owner: this.people([goal.ownerId], context.actor).get(goal.ownerId) ?? null, progressSummary: annualGoalProgress(goal, plans) }, items: selected.map(plan => projectPlan(context.actor, plan, this.store)), total: rows.length, nextCursor: window.offset + selected.length < rows.length ? window.cursor(window.offset + selected.length) : null, revision: context.revision, accessScopeVersion: context.accessScopeVersion }
    })
  }
  goals(actor: User, input: Query): GoalsPage {
    return this.store.readTransaction(() => {
      queryKeys(input, ['year', 'cursor', 'limit'])
      const context = this.context(actor), year = input.year === undefined ? new Date().getFullYear() : Number(input.year)
      if (!Number.isInteger(year) || year < 2020 || year > 2100 || Array.isArray(input.year)) throw new HttpError(400, '请选择 2020 至 2100 年')
      const where = `e.collection='annualGoals' AND ${field('year')}=?`
      const page = this.page<AnnualGoal>(input, context, 'directory-goals', where, [year]), owners = this.people(page.items.map(row => row.ownerId), context.actor)
      const linkedPlans = this.annualPlans(context.actor, year, page.items.map(goal => goal.id))
      const counts = this.store.selectRows(`SELECT COUNT(*) AS allCount,SUM(CASE WHEN ${field('status')}='active' THEN 1 ELSE 0 END) AS active,SUM(CASE WHEN ${field('status')}='completed' THEN 1 ELSE 0 END) AS completed FROM entities e WHERE ${where}`, [year])[0]
      return { ...page, items: page.items.map(row => ({ ...row, owner: owners.get(row.ownerId) ?? null, progressSummary: annualGoalProgress(row, linkedPlans) })), counts: { all: Number(counts.allCount), active: Number(counts.active ?? 0), completed: Number(counts.completed ?? 0) }, year }
    })
  }
}

export function directoryWorkspaceRouter(store: Store) {
  const router = Router(), service = new DirectoryWorkspaceService(store)
  router.get('/workspace/team', (req, res) => res.json(service.team(req.user, req.query)))
  router.get('/workspace/registration-requests', (req, res) => res.json(service.registrations(req.user, req.query)))
  router.get('/workspace/projects', (req, res) => res.json(service.projects(req.user, req.query)))
  router.get('/workspace/annual-goals/:id', (req, res) => res.json(service.goalDetail(req.user, String(req.params.id), req.query)))
  router.get('/workspace/annual-goals', (req, res) => res.json(service.goals(req.user, req.query)))
  router.get('/workspace/directory/accounts', (req, res) => res.json(service.accounts(req.user, req.query)))
  return router
}
