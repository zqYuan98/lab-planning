import { Router } from 'express'
import type { MonthlyPlan, Project, Task, User } from '../shared/types.ts'
import type { ImportCandidateKind, ImportCandidatePage, ImportReferences } from '../shared/import-workspace.ts'
import { registrationApproved } from '../shared/auth-policy.ts'
import { safeUser } from './auth.ts'
import { HttpError, type Store } from './store.ts'
import { pageContext, pageWindow, queryKeys, queryText } from './page-read-common.ts'
import { participates, projectPlan, visiblePlan } from './plan-visibility.ts'
import { isManager } from './authorization.ts'

const kinds = ['users', 'projects', 'plans', 'tasks'] as const
const field = (name: string, alias = 'e') => `json_extract(${alias}.data,'$.${name}')`
const activeUser = (alias: string) => `${field('active', alias)}=1 AND COALESCE(${field('registrationStatus', alias)},'approved')='approved'`

export class ImportWorkspaceService {
  constructor(private store: Store) {}
  candidates(actor: User, input: Record<string, unknown>): ImportCandidatePage {
    return this.store.readTransaction(() => {
      const context = pageContext(this.store, actor); actor = context.actor
      queryKeys(input, ['kind', 'q', 'ownerId', 'month', 'cursor', 'limit'])
      const kind = queryText(input.kind) as ImportCandidateKind
      if (!kinds.includes(kind)) throw new HttpError(400, '请选择候选类型')
      const q = queryText(input.q, 120), ownerId = queryText(input.ownerId), month = queryText(input.month, 7)
      if (month && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new HttpError(400, '月份无效')
      const values: (string | number | null)[] = [kind], predicates = ['e.collection=?']
      if (kind === 'users') predicates.push(activeUser('e'))
      if (kind === 'projects') predicates.push(`${field('status')}='active'`)
      if (kind === 'plans') {
        predicates.push(`${field('status')}<>'merged'`, `COALESCE(${field('visibility')},'') NOT IN ('reference','historical')`)
        if (!isManager(actor)) { predicates.push(`(${field('ownerId')}=? OR EXISTS(SELECT 1 FROM json_each(e.data,'$.collaboratorIds') c WHERE c.value=?))`, `(${field('projectId')} IS NULL OR ${field('projectId')}='' OR EXISTS(SELECT 1 FROM entities p WHERE p.collection='projects' AND p.id=${field('projectId')} AND ${field('status', 'p')}='active'))`); values.push(actor.id, actor.id) }
        if (month) { predicates.push(`${field('month')}=?`); values.push(month) }
      }
      if (kind === 'tasks') {
        predicates.push(`${field('cancellation')} IS NULL`, `EXISTS(SELECT 1 FROM entities u WHERE u.collection='users' AND u.id=${field('ownerId')} AND ${activeUser('u')})`)
        if (!isManager(actor)) { predicates.push(`${field('ownerId')}=?`); values.push(actor.id) }
        if (ownerId) { predicates.push(`${field('ownerId')}=?`); values.push(ownerId) }
      }
      if (q) { predicates.push(`instr(lower(COALESCE(${field(kind === 'users' || kind === 'projects' ? 'name' : 'title')},'')||' '||COALESCE(${field(kind === 'users' ? 'email' : kind === 'plans' ? 'month' : 'code')},'')),lower(?))>0`); values.push(q) }
      const where = predicates.join(' AND '), window = pageWindow(input, context, ['import-candidates', kind])
      const total = Number(this.store.selectRows(`SELECT COUNT(*) AS n FROM entities e WHERE ${where}`, values)[0].n)
      const items = this.store.selectJson<User | Project | MonthlyPlan | Task>(`SELECT e.data FROM entities e WHERE ${where} ORDER BY e.rowid DESC LIMIT ? OFFSET ?`, [...values, window.limit, window.offset])
        .map(row => kind === 'users' ? safeUser(row as User) : kind === 'plans' ? projectPlan(actor, row as MonthlyPlan, this.store) : row)
      const users = kind === 'tasks' ? [...new Set((items as Task[]).map(task => task.ownerId))].flatMap(id => { const user = this.store.get<User>('users', id); return user ? [safeUser(user)] : [] }) : []
      return { items, total, references: { users }, nextCursor: window.offset + items.length < total ? window.cursor(window.offset + items.length) : null, revision: context.revision, accessScopeVersion: context.accessScopeVersion }
    })
  }
  references(actor: User, input: unknown): ImportReferences {
    return this.store.readTransaction(() => {
      actor = pageContext(this.store, actor).actor
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw new HttpError(400, '引用查询无效')
      queryKeys(input as Record<string, unknown>, kinds)
      const ids = (kind: ImportCandidateKind): string[] => {
        const value = (input as Record<string, unknown>)[kind] ?? []
        if (!Array.isArray(value) || value.length > 100 || value.some(id => typeof id !== 'string' || !id || id.length > 200)) throw new HttpError(400, '每类引用最多 100 项')
        return [...new Set(value as string[])]
      }
      const get = <T>(kind: ImportCandidateKind) => ids(kind).flatMap(id => { const row = this.store.get<T>(kind, id); return row ? [row] : [] })
      const tasks = get<Task>('tasks').filter(row => isManager(actor) || row.ownerId === actor.id)
      const plans = get<MonthlyPlan>('plans').flatMap(row => {
        const plan = isManager(actor) || participates(row, actor.id) ? projectPlan(actor, row, this.store) : visiblePlan(this.store, actor, row)
        return plan ? [plan] : []
      })
      // Dependencies of an authorized selected item also need their labels outside candidate page one.
      const users = [...new Map([...get<User>('users'), ...tasks.flatMap(task => { const user = this.store.get<User>('users', task.ownerId); return user ? [user] : [] })].filter(row => isManager(actor) || registrationApproved(row)).map(row => [row.id, safeUser(row)])).values()]
      const projectIds = [...new Set(plans.flatMap(row => row.projectId ? [row.projectId] : []))]
      const projects = [...new Map([...get<Project>('projects'), ...projectIds.flatMap(id => { const project = this.store.get<Project>('projects', id); return project ? [project] : [] })].map(row => [row.id, row])).values()]
      return { users, projects, plans, tasks }
    })
  }
}
export function importWorkspaceRouter(store: Store) {
  const router = Router(), service = new ImportWorkspaceService(store)
  router.get('/workspace/import-candidates', (req, res) => res.json(service.candidates(req.user, req.query)))
  router.post('/workspace/import-references', (req, res) => res.json(service.references(req.user, req.body)))
  return router
}
