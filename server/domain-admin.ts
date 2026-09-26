import { assertBusinessActor } from './object-access.ts'
import type { AnnualGoal, Entity, MonthlyPlan, Project, User } from '../shared/types.ts'
import { canUseAccount, registrationApproved } from '../shared/auth-policy.ts'
import { checkPassword, hashPassword, safeUser, type StoredUser } from './auth.ts'
import { HttpError } from './store.ts'
import { DomainBase, bool, choice, manager, number, text, type Input } from './domain-common.ts'
import { userDeletionPreview } from './user-deletion.ts'
import { isManager } from './authorization.ts'

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
  register(input: Input) {
    const data = { name: text(input.name, '姓名', true, 100), email: email(input.email), position: text(input.position, '岗位', false, 100), passwordHash: hashPassword(input.password) }
    return this.store.transaction(() => {
      if (!this.store.list<User>('users').some(user => canUseAccount(user) && isManager(user))) throw new HttpError(409, '请先由部门负责人初始化工作空间')
      if (this.store.list<User>('users').some(user => user.email === data.email)) throw new HttpError(409, '该邮箱已注册或已提交申请，请登录或联系管理员')
      const user = this.store.insert<StoredUser>('users', { ...data, role: 'member', active: false, credentialVersion: 1, registrationStatus: 'pending', registrationReviewComment: '' })
      this.audit(user, 'user', user.id, 'register', null, safeUser(user))
      return { message: '申请已提交，等待管理员审批。通过后可使用邮箱和刚设置的密码登录。' }
    })
  }
  reviewRegistration(actor: User, id: string, input: Input): User {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    const decision = choice(input.decision, ['approve', 'reject'], '审核结果')
    const comment = text(input.comment, '审核说明', decision === 'reject', 1000)
    return this.store.transaction(() => {
      const before = this.current<StoredUser>('users', id, input)
      if (!['pending', 'rejected'].includes(before.registrationStatus ?? '')) throw new HttpError(409, '该账号不在待审核申请中，请刷新列表')
      const user = this.store.update<StoredUser>('users', id, before.version, { registrationStatus: decision === 'approve' ? 'approved' : 'rejected', registrationReviewComment: comment, active: decision === 'approve', role: 'member', credentialVersion: before.credentialVersion + 1 })
      this.audit(actor, 'user', id, `registration_${decision}`, safeUser(before), safeUser(user), comment)
      return safeUser(user)
    })
  }
  login(input: Input): User {
    const address = email(input.email)
    const user = this.store.list<StoredUser>('users').find(item => item.email === address)
    // Equal-cost hashing also for unknown accounts, to avoid account enumeration by timing.
    const valid = checkPassword(input.password, user?.passwordHash ?? `${'0'.repeat(32)}:${'0'.repeat(128)}`)
    if (!valid || !user) throw new HttpError(401, '邮箱或密码不正确，或账号已停用')
    if (user.registrationStatus === 'pending') throw new HttpError(403, '注册申请正在等待管理员审批，通过后即可登录')
    if (user.registrationStatus === 'rejected') throw new HttpError(403, '注册申请未通过，请联系管理员重新审核')
    if (!canUseAccount(user)) throw new HttpError(401, '邮箱或密码不正确，或账号已停用')
    return safeUser(user)
  }
  createUser(actor: User, input: Input): User {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    const data = { name: text(input.name, '姓名', true, 100), email: email(input.email), passwordHash: hashPassword(input.password), credentialVersion: 1, role: choice(input.role, ['manager', 'member', 'observer'], '角色'), position: text(input.position, '岗位', false, 100), active: true }
    return this.store.transaction(() => {
      if (this.store.list<StoredUser>('users').some(user => user.email === data.email)) throw new HttpError(409, '邮箱已存在')
      const user = this.store.insert<StoredUser>('users', data)
      this.audit(actor, 'user', user.id, 'create', null, safeUser(user))
      return safeUser(user)
    })
  }
  updateUser(actor: User, id: string, input: Input): User {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    const passwordHash = input.password === undefined ? undefined : hashPassword(input.password)
    return this.store.transaction(() => {
      const before = this.current<StoredUser>('users', id, input)
      const patch: Partial<StoredUser> = {}
      if (!registrationApproved(before)) throw new HttpError(409, '请先通过注册审核处理该申请')
      if (input.name !== undefined) patch.name = text(input.name, '姓名', true, 100)
      if (input.position !== undefined) patch.position = text(input.position, '岗位', false, 100)
      if (input.active !== undefined) patch.active = bool(input.active, '账号启用状态')
      if (input.role !== undefined) patch.role = choice(input.role, ['manager', 'member', 'observer'], '角色')
      if (passwordHash) { patch.passwordHash = passwordHash; patch.credentialVersion = before.credentialVersion + 1 }
      if (patch.active === false && before.active) patch.credentialVersion = before.credentialVersion + 1
      if (patch.role !== undefined && patch.role !== before.role) patch.credentialVersion = before.credentialVersion + 1
      const next = { ...before, ...patch }
      if (before.active && isManager(before) && (!next.active || !isManager(next)) && !this.store.list<User>('users').some(user => user.id !== id && user.active && isManager(user))) throw new HttpError(400, '必须保留至少一位启用的管理者')
      const user = this.store.update<StoredUser>('users', id, before.version, patch)
      this.audit(actor, 'user', id, passwordHash ? 'update_credentials' : 'update', safeUser(before), safeUser(user))
      return safeUser(user)
    })
  }
  private liveManager(actor: User): User {
    const current = this.store.get<User>('users', actor.id)
    if (!current || !canUseAccount(current)) throw new HttpError(403, '当前账号已不可用，请重新登录')
    manager(current)
    return safeUser(current)
  }
  userDeletionPreview(actor: User, id: string) {
    actor = assertBusinessActor(this.store, actor)
    return this.store.transaction(() => userDeletionPreview(this.store, this.liveManager(actor), this.need<User>('users', id)))
  }
  deleteUser(actor: User, id: string, input: Input) {
    actor = assertBusinessActor(this.store, actor)
    return this.store.transaction(() => {
      const currentActor = this.liveManager(actor)
      const before = this.current<StoredUser>('users', id, input)
      if (text(input.confirmName, '确认姓名', true, 100) !== before.name) throw new HttpError(400, '确认姓名与当前成员不一致')
      const preview = userDeletionPreview(this.store, currentActor, before)
      if (!preview.canDelete) throw new HttpError(409, `无法删除：${preview.blockers.map(blocker => blocker.label).join('、')}。有业务或历史记录的账号请停用，保留原有归属。`)
      // Preferences are operational state, not business history or a deletion blocker.
      for (const collection of ['sessions', 'integrationTokens', 'externalIdentities', 'collaborationPreferences']) {
        for (const operational of this.store.list<Entity & { userId: string }>(collection).filter(row => row.userId === id)) {
          this.store.delete(collection, operational.id, operational.version)
        }
      }
      // Preference-only receipts are disposable operational state, like the preferences themselves.
      for (const receipt of this.store.list<Entity & { actorId: string; command: string }>('collaborationCommandReceipts').filter(row => row.actorId === id && row.command === 'preferences')) {
        this.store.delete('collaborationCommandReceipts', receipt.id, receipt.version)
      }
      this.store.delete('users', id, before.version)
      this.audit(currentActor, 'user', id, 'delete', safeUser(before), null, '删除无业务或历史关联的账号；保留账号生命周期审计')
      return { deleted: true as const, id }
    })
  }
  createProject(actor: User, input: Input): Project {
    actor = assertBusinessActor(this.store, actor)
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
    actor = assertBusinessActor(this.store, actor)
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
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    return this.store.transaction(() => {
      const goal = this.store.insert<AnnualGoal>('annualGoals', { title: text(input.title, '年度目标', true, 300), year: number(input.year, '年份', 1900, 2200, true), target: text(input.target, '目标要求'), progress: number(input.progress ?? 0, '进展', 0, 100), ...(input.progressMode !== undefined ? { progressMode: choice(input.progressMode, ['manual', 'linked'], '进展方式') } : {}), description: text(input.description, '说明', false), ownerId: this.activeUser(input.ownerId ?? actor.id).id, status: 'active' })
      this.audit(actor, 'annualGoal', goal.id, 'create', null, goal)
      return goal
    })
  }
  updateAnnualGoal(actor: User, id: string, input: Input): AnnualGoal {
    actor = assertBusinessActor(this.store, actor)
    manager(actor)
    return this.store.transaction(() => {
      const before = this.current<AnnualGoal>('annualGoals', id, input)
      const patch: Partial<AnnualGoal> = {}
      if (input.title !== undefined) patch.title = text(input.title, '年度目标', true, 300)
      if (input.year !== undefined) patch.year = number(input.year, '年份', 1900, 2200, true)
      if (patch.year !== undefined && patch.year !== before.year && this.store.list<MonthlyPlan>('plans').some(plan => plan.annualGoalId === id && Number(plan.month.slice(0, 4)) !== patch.year)) throw new HttpError(409, '此年度目标已有其他年份的月度关联，请先调整关联')
      if (input.progressMode !== undefined) patch.progressMode = choice(input.progressMode, ['manual', 'linked'], '进展方式')
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
