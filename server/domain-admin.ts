import type { AnnualGoal, Project, User } from '../shared/types.ts'
import { checkPassword, hashPassword, safeUser, type StoredUser } from './auth.ts'
import { HttpError } from './store.ts'
import { DomainBase, bool, choice, manager, number, text, type Input } from './domain-common.ts'

function email(value: unknown) {
  const address = text(value, '邮箱', true, 254).toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address)) throw new HttpError(400, '邮箱格式不正确')
  return address
}

export class AdminService extends DomainBase {
  setup(input: Input): User {
    const name = text(input.name, '姓名', true, 100)
    const address = email(input.email)
    const passwordHash = hashPassword(input.password)
    return this.store.transaction(() => {
      if (this.store.list('users').length) throw new HttpError(409, '系统已初始化，请登录')
      const user = this.store.insert<StoredUser>('users', { name, email: address, passwordHash, credentialVersion: 1, role: 'manager', active: true, position: '部门负责人' })
      this.audit(user, 'user', user.id, 'setup', null, safeUser(user))
      return safeUser(user)
    })
  }
  login(input: Input): User {
    const address = email(input.email)
    const user = this.store.list<StoredUser>('users').find(item => item.email === address)
    // Equal-cost hashing also for unknown accounts, to avoid account enumeration by timing.
    const valid = checkPassword(input.password, user?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`)
    if (!valid || !user?.active) throw new HttpError(401, '邮箱或密码不正确，或账号已停用')
    return safeUser(user)
  }
  createUser(actor: User, input: Input): User {
    manager(actor)
    const data = { name: text(input.name, '姓名', true, 100), email: email(input.email), passwordHash: hashPassword(input.password), credentialVersion: 1, role: choice(input.role, ['manager', 'member'], '角色'), position: text(input.position, '岗位', false, 100), active: true }
    return this.store.transaction(() => {
      if (this.store.list<StoredUser>('users').some(user => user.email === data.email)) throw new HttpError(409, '邮箱已存在')
      const user = this.store.insert<StoredUser>('users', data)
      this.audit(actor, 'user', user.id, 'create', null, safeUser(user))
      return safeUser(user)
    })
  }
  updateUser(actor: User, id: string, input: Input): User {
    manager(actor)
    const passwordHash = input.password === undefined ? undefined : hashPassword(input.password)
    return this.store.transaction(() => {
      const before = this.current<StoredUser>('users', id, input)
      const patch: Partial<StoredUser> = {}
      if (input.name !== undefined) patch.name = text(input.name, '姓名', true, 100)
      if (input.position !== undefined) patch.position = text(input.position, '岗位', false, 100)
      if (input.active !== undefined) patch.active = bool(input.active, '账号启用状态')
      if (input.role !== undefined) patch.role = choice(input.role, ['manager', 'member'], '角色')
      if (passwordHash) { patch.passwordHash = passwordHash; patch.credentialVersion = before.credentialVersion + 1 }
      if (patch.active === false && before.active) patch.credentialVersion = before.credentialVersion + 1
      const next = { ...before, ...patch }
      if (before.active && before.role === 'manager' && (!next.active || next.role !== 'manager') && !this.store.list<User>('users').some(user => user.id !== id && user.active && user.role === 'manager')) throw new HttpError(400, '必须保留至少一位启用的管理者')
      const user = this.store.update<StoredUser>('users', id, before.version, patch)
      this.audit(actor, 'user', id, passwordHash ? 'update_credentials' : 'update', safeUser(before), safeUser(user))
      return safeUser(user)
    })
  }
  createProject(actor: User, input: Input): Project {
    manager(actor)
    return this.store.transaction(() => {
      const data = { name: text(input.name, '项目名称', true, 200), code: text(input.code, '项目编号', true, 50), description: text(input.description, '项目描述', false), ownerId: this.activeUser(input.ownerId ?? actor.id).id, status: 'active' as const }
      if (this.store.list<Project>('projects').some(project => project.code.toLowerCase() === data.code.toLowerCase())) throw new HttpError(409, '项目编号已存在')
      const project = this.store.insert<Project>('projects', data)
      this.audit(actor, 'project', project.id, 'create', null, project)
      return project
    })
  }
  updateProject(actor: User, id: string, input: Input): Project {
    manager(actor)
    return this.store.transaction(() => {
      const before = this.current<Project>('projects', id, input)
      const patch: Partial<Project> = {}
      if (input.name !== undefined) patch.name = text(input.name, '项目名称', true, 200)
      if (input.code !== undefined) {
        patch.code = text(input.code, '项目编号', true, 50)
        if (this.store.list<Project>('projects').some(project => project.id !== id && project.code.toLowerCase() === patch.code!.toLowerCase())) throw new HttpError(409, '项目编号已存在')
      }
      if (input.description !== undefined) patch.description = text(input.description, '项目描述', false)
      if (input.ownerId !== undefined && input.ownerId !== before.ownerId) patch.ownerId = this.activeUser(input.ownerId).id
      if (input.status !== undefined) patch.status = choice(input.status, ['active', 'archived'], '项目状态')
      const project = this.store.update<Project>('projects', id, before.version, patch)
      this.audit(actor, 'project', id, patch.status === 'archived' ? 'archive' : 'update', before, project)
      return project
    })
  }
  createAnnualGoal(actor: User, input: Input): AnnualGoal {
    manager(actor)
    return this.store.transaction(() => {
      const goal = this.store.insert<AnnualGoal>('annualGoals', { title: text(input.title, '年度目标', true, 300), year: number(input.year, '年份', 1900, 2200, true), target: text(input.target, '目标要求'), progress: number(input.progress ?? 0, '进展', 0, 100), description: text(input.description, '说明', false), ownerId: this.activeUser(input.ownerId ?? actor.id).id, status: 'active' })
      this.audit(actor, 'annualGoal', goal.id, 'create', null, goal)
      return goal
    })
  }
  updateAnnualGoal(actor: User, id: string, input: Input): AnnualGoal {
    manager(actor)
    return this.store.transaction(() => {
      const before = this.current<AnnualGoal>('annualGoals', id, input)
      const patch: Partial<AnnualGoal> = {}
      if (input.title !== undefined) patch.title = text(input.title, '年度目标', true, 300)
      if (input.year !== undefined) patch.year = number(input.year, '年份', 1900, 2200, true)
      if (input.target !== undefined) patch.target = text(input.target, '目标要求')
      if (input.progress !== undefined) patch.progress = number(input.progress, '进展', 0, 100)
      if (input.description !== undefined) patch.description = text(input.description, '说明', false)
      if (input.ownerId !== undefined && input.ownerId !== before.ownerId) patch.ownerId = this.activeUser(input.ownerId).id
      if (input.status !== undefined) patch.status = choice(input.status, ['active', 'completed'], '年度目标状态')
      const goal = this.store.update<AnnualGoal>('annualGoals', id, before.version, patch)
      this.audit(actor, 'annualGoal', id, 'update', before, goal)
      return goal
    })
  }
}
