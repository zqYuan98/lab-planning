import { createHash } from 'node:crypto'
import type { Entity, MonthlyPlan, Project, Publication, Report, Task, User, WeeklyRecord } from '../shared/types.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { manager } from './domain-common.ts'
import { HttpError, Store } from './store.ts'
import { businessEventCollections, canonical, collectionNames, emptyCollections, parsePacket, projectRow, remapUsers, rowReferences, storedCollection, type BusinessCollections, type BusinessDataPacket, type TransferCollection } from './data-transfer-schema.ts'

export interface RestoreCount { total: number; insert: number; skip: number }
export interface RestorePreview {
  canRestore: boolean; fingerprint: string; counts: Record<TransferCollection, RestoreCount>; issues: string[]
  missingUsers: Array<{ id: string; name: string; email: string; reason: string }>; mapping: Record<string, string>
}
interface CheckedRestore { preview: RestorePreview; rows: BusinessCollections }
const fingerprint = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

function requireManager(store: Store, actor: User) {
  manager(actor)
  const live = store.get<User>('users', actor.id)
  if (!live || !canUseAccount(live) || live.role !== 'manager') throw new HttpError(403, '仅有效管理者账号可以恢复业务数据')
}

function semanticIssues(name: TransferCollection, input: unknown, issue: (message: string) => void, nested = false) {
  const row = input as Record<string, unknown>
  const label = `${name}/${String(row.id)}`
  if (Date.parse(String(row.updatedAt)) < Date.parse(String(row.createdAt))) issue(`${label}：更新时间早于创建时间`)
  for (const field of ['id', ...(name === 'projects' ? ['name', 'code'] : ['annualGoals', 'plans', 'tasks', 'reports'].includes(name) ? ['title'] : [])]) {
    if (typeof row[field] === 'string' && !(row[field] as string).trim()) issue(`${label}：${field} 不能为空白`)
  }
  if (name === 'plans') {
    const plan = input as MonthlyPlan
    if (!plan.projectId && !plan.category.trim()) issue(`${label}：缺少所属项目或工作类别`)
    if (!plan.expectedOutcome.trim() || !plan.acceptanceCriteria.trim()) issue(`${label}：预期成果和验收标准不能为空白`)
    if (!plan.dueDate.startsWith(plan.month)) issue(`${label}：截止日期不在所属月份`)
    if (new Set(plan.collaboratorIds).size !== plan.collaboratorIds.length || plan.collaboratorIds.includes(plan.ownerId)) issue(`${label}：负责人或协作者映射后重复`)
    if (plan.status === 'published' && plan.publishedVersion === null) issue(`${label}：已发布计划缺少发布版本`)
    if (plan.status === 'merged' && !plan.mergedIntoId) issue(`${label}：已合并计划缺少目标计划`)
    if (['accepted', 'submitted'].includes(plan.acceptanceStatus) && !plan.actualOutcome.trim()) issue(`${label}：已提交或验收成果缺少实际成果`)
  }
  if (name === 'tasks') {
    const task = input as Task
    if (task.monthlyPlanId && task.isTemporary || !task.monthlyPlanId && (!task.isTemporary || !task.temporaryReason.trim())) issue(`${label}：任务关联与临时工作标记不一致`)
  }
  if (name === 'weeklyRecords') {
    const weekly = input as WeeklyRecord
    if (new Date(`${weekly.weekStart}T00:00:00Z`).getUTCDay() !== 1) issue(`${label}：所属周必须为周一`)
    if (!weekly.commitment.trim()) issue(`${label}：缺少本周承诺`)
    if (weekly.status === 'done' && !weekly.actualOutcome.trim()) issue(`${label}：已完成周记录缺少成果`)
    if (['blocked', 'not_done'].includes(weekly.status) && !weekly.blocker.trim()) issue(`${label}：阻塞或未完成周记录缺少原因`)
  }
  if (name === 'publications') {
    const publication = input as Publication
    if (new Set(publication.plans.map(plan => plan.id)).size !== publication.plans.length) issue(`${label}：发布快照包含重复计划`)
    for (const plan of publication.plans) {
      if (plan.month !== publication.month || plan.status !== 'published' || (plan.publishedVersion ?? Infinity) > publication.revision) issue(`${label}：发布快照与月份、状态或版本不一致`)
      semanticIssues('plans', plan, issue, true)
    }
  }
  if (name === 'reports') {
    const report = input as Report
    const validPeriod = report.type === 'monthly' ? /^\d{4}-(0[1-9]|1[0-2])$/.test(report.period)
      : /^\d{4}-\d{2}-\d{2}$/.test(report.period) && Number.isFinite(Date.parse(`${report.period}T00:00:00Z`)) && new Date(`${report.period}T00:00:00Z`).toISOString().slice(0, 10) === report.period && new Date(`${report.period}T00:00:00Z`).getUTCDay() === 1
    if (!validPeriod) issue(`${label}：报告周期无效`)
    if ((report.status === 'finalized') !== (report.finalizedAt !== null)) issue(`${label}：定稿状态与定稿时间不一致`)
    for (const [key, entries] of Object.entries(report.snapshot)) {
      const target = ({ contextPlans: 'plans', nextPlans: 'plans', nextWeeklyRecords: 'weeklyRecords', changes: 'events' } as Record<string, TransferCollection>)[key] ?? key as TransferCollection
      for (const entry of entries) semanticIssues(target, entry, issue, true)
    }
  }
  if (name === 'events') {
    const target = businessEventCollections[String(row.entityType)]
    if (target !== 'reports') for (const field of ['before', 'after']) {
      const snapshots = row[field] === null ? [] : Array.isArray(row[field]) ? row[field] as unknown[] : [row[field]]
      for (const snapshot of snapshots) semanticIssues(target, snapshot, issue, true)
    }
  }
  // Historical snapshots are validated as historical facts, not against the current workflow state.
  void nested
}

function inspectRestore(store: Store, packet: BusinessDataPacket, requestedMapping: Record<string, string>): CheckedRestore {
  const issues: string[] = []
  const issueSet = new Set<string>()
  const issue = (message: string) => { if (!issueSet.has(message)) { issueSet.add(message); issues.push(message) } }
  if (!requestedMapping || typeof requestedMapping !== 'object' || Array.isArray(requestedMapping) || Object.values(requestedMapping).some(value => typeof value !== 'string' || !value || value.length > 200)) throw new HttpError(400, '账号映射格式无效')
  const sourceUsers = new Map(packet.collections.users.map(user => [user.id, user]))
  const currentUsers = store.list<User>('users')
  const activeUsers = currentUsers.filter(canUseAccount)
  const neededUsers = new Set(collectionNames.flatMap(name => (packet.collections[name] as Entity[]).flatMap(row => rowReferences(name, row).filter(ref => ref.collection === 'users').map(ref => ref.id))))
  const mapping: Record<string, string> = Object.create(null)
  const missingUsers: RestorePreview['missingUsers'] = []
  const mappingTarget = new Map<string, string>()
  for (const sourceId of Object.keys(requestedMapping)) if (!sourceUsers.has(sourceId)) issue(`账号映射包含未在迁移包声明的来源账号：${sourceId}`)
  for (const sourceId of neededUsers) {
    const source = sourceUsers.get(sourceId)
    const explicit = Object.hasOwn(requestedMapping, sourceId) ? requestedMapping[sourceId] : undefined
    const candidates = source ? activeUsers.filter(user => explicit ? user.id === explicit : user.email.trim().toLowerCase() === source.email.trim().toLowerCase()) : []
    if (!source || candidates.length !== 1) {
      const reason = !source ? '迁移包缺少来源账号资料' : explicit ? '指定的目标账号不存在、已停用或未通过审核' : candidates.length ? '邮箱匹配到多个有效账号，请明确映射' : '未找到相同邮箱的有效账号，请先建立账号或指定映射'
      missingUsers.push({ id: sourceId, name: source?.name ?? '', email: source?.email ?? '', reason })
      issue(`账号 ${source?.name || sourceId}：${reason}`)
      continue
    }
    const target = candidates[0].id
    if (mappingTarget.has(target) && mappingTarget.get(target) !== sourceId) issue(`多个来源账号映射到了同一目标账号：${candidates[0].name}`)
    mapping[sourceId] = target; mappingTarget.set(target, sourceId)
  }
  const rows = emptyCollections()
  const current: Record<string, Entity[]> = {}
  const counts = {} as RestorePreview['counts']
  const available = {} as Record<TransferCollection, Map<string, Entity>>
  for (const name of collectionNames) {
    const incoming = packet.collections[name] as Entity[]
    const ids = new Set<string>()
    for (const row of incoming) {
      if (ids.has(row.id)) issue(`${name} 包含重复 ID：${row.id}`)
      ids.add(row.id)
    }
    if (name === 'users') {
      current[name] = currentUsers.map(user => ({ ...projectRow('users', user), registrationStatus: user.registrationStatus ?? 'approved' } as unknown as Entity))
      available[name] = new Map(activeUsers.map(user => [user.id, user]))
      counts[name] = { total: incoming.length, insert: 0, skip: incoming.length }
      continue
    }
    current[name] = store.list<Entity>(storedCollection(name))
    const existing = new Map(current[name].map(row => [row.id, row]))
    const transformed = incoming.map(row => remapUsers(name, row, mapping) as Entity)
    ;(rows[name] as Entity[]) = transformed
    available[name] = new Map([...existing, ...transformed.map(row => [row.id, row] as const)])
    const count = { total: transformed.length, insert: 0, skip: 0 }
    for (const row of transformed) {
      const before = existing.get(row.id)
      if (!before) count.insert++
      else if (canonical(before) === canonical(row)) count.skip++
      else issue(`${name}/${row.id} 已存在不同内容，恢复不会覆盖现有记录`)
      semanticIssues(name, row, issue)
    }
    counts[name] = count
  }
  for (const name of collectionNames.filter(name => name !== 'users')) for (const row of rows[name] as Entity[]) {
    for (const ref of rowReferences(name, row)) if (!available[ref.collection]?.has(ref.id)) issue(`${name}/${row.id} 缺少关联 ${ref.collection}/${ref.id}`)
  }
  const plans = available.plans as Map<string, MonthlyPlan>
  const tasks = available.tasks as Map<string, Task>
  for (const plan of rows.plans) {
    if (plan.status === 'published' && ![...available.publications.values()].some(value => {
      const publication = value as Publication
      return publication.month === plan.month && publication.revision === plan.publishedVersion && publication.plans.some(item => item.id === plan.id)
    })) issue(`plans/${plan.id}：缺少对应发布版本的计划快照`)
    const source = plan.sourcePlanId ? plans.get(plan.sourcePlanId) : undefined
    if (source && source.month >= plan.month) issue(`plans/${plan.id}：承接月份必须晚于来源月份`)
    if (plan.mergedIntoId) {
      const target = plans.get(plan.mergedIntoId)
      if (target && !target.mergedFromIds?.includes(plan.id)) issue(`plans/${plan.id}：合并来源与目标的关联不一致`)
      const visited = new Set([plan.id])
      let next: MonthlyPlan | undefined = target
      while (next) {
        if (visited.has(next.id)) { issue(`plans/${plan.id}：合并关联存在循环`); break }
        visited.add(next.id); next = next.mergedIntoId ? plans.get(next.mergedIntoId) : undefined
      }
    }
    for (const id of plan.mergedFromIds ?? []) if (plans.has(id) && plans.get(id)!.mergedIntoId !== plan.id) issue(`plans/${plan.id}：合并来源记录未指向当前目标`)
  }
  for (const task of rows.tasks) {
    const plan = task.monthlyPlanId ? plans.get(task.monthlyPlanId) : undefined
    if (plan && (plan.status === 'merged' || ![plan.ownerId, ...plan.collaboratorIds].includes(task.ownerId))) issue(`tasks/${task.id}：任务负责人未参与关联月计划或计划已合并`)
  }
  for (const row of rows.weeklyRecords) {
    const task = tasks.get(row.taskId), plan = row.monthlyPlanId ? plans.get(row.monthlyPlanId) : undefined
    if (task && task.ownerId !== row.ownerId) issue(`weeklyRecords/${row.id}：周记录与任务负责人不一致`)
    if (plan) {
      const end = new Date(`${row.weekStart}T00:00:00Z`); end.setUTCDate(end.getUTCDate() + 6)
      if (plan.month < row.weekStart.slice(0, 7) || plan.month > end.toISOString().slice(0, 7)) issue(`weeklyRecords/${row.id}：所属周与历史月计划月份不相交`)
      if (row.submitted && plan.status !== 'published') issue(`weeklyRecords/${row.id}：已提交周记录的月计划未发布`)
    } else if (task && !task.temporaryReason.trim()) issue(`weeklyRecords/${row.id}：未关联月计划的历史记录缺少临时工作来源说明`)
  }
  const unique = <T extends Entity>(name: TransferCollection, key: (row: T) => string) => {
    const seen = new Map<string, string>()
    for (const row of available[name].values() as Iterable<T>) {
      const value = key(row)
      if (seen.has(value) && seen.get(value) !== row.id) issue(`${name} 存在重复业务键：${value}`)
      seen.set(value, row.id)
    }
  }
  unique<Project>('projects', row => row.code.toLowerCase())
  unique<WeeklyRecord>('weeklyRecords', row => `${row.taskId}/${row.weekStart}`)
  unique<Publication>('publications', row => `${row.month}/${row.revision}`)
  unique<Report>('reports', row => `${row.type}/${row.period}/${row.revision}`)
  return {
    rows,
    preview: { canRestore: issues.length === 0, fingerprint: fingerprint({ packet, mapping, current }), counts, issues, missingUsers, mapping },
  }
}

export function previewRestore(store: Store, actor: User, input: unknown, mapping: Record<string, string> = {}): RestorePreview {
  requireManager(store, actor)
  const packet = parsePacket(input)
  return store.transaction(() => { requireManager(store, actor); return inspectRestore(store, packet, mapping).preview })
}

export function restoreBusinessData(store: Store, actor: User, input: unknown, mapping: Record<string, string> = {}, expectedFingerprint?: string) {
  requireManager(store, actor)
  if (typeof expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(expectedFingerprint)) throw new HttpError(400, '请先预览迁移包，再携带预览指纹确认恢复')
  const packet = parsePacket(input)
  return store.transaction(() => {
    requireManager(store, actor)
    const checked = inspectRestore(store, packet, mapping)
    if (checked.preview.fingerprint !== expectedFingerprint) throw new HttpError(409, '迁移包、账号映射或现有数据已变化，请重新预览后确认')
    if (!checked.preview.canRestore) throw new HttpError(409, `迁移包尚有 ${checked.preview.issues.length} 项问题，请先修正预览中的缺项或冲突`)
    let restored = 0, skipped = 0
    for (const name of collectionNames.filter(name => name !== 'users')) for (const row of checked.rows[name] as Entity[]) {
      if (store.get(storedCollection(name), row.id)) { skipped++; continue }
      store.restoreEntity(storedCollection(name), row); restored++
    }
    const restoredAt = new Date().toISOString()
    if (restored) store.insert<Entity & { entityType: string; entityId: string; actorId: string; action: string; reason: string; before: null; after: unknown }>('events', {
      entityType: 'dataRestore', entityId: expectedFingerprint, actorId: actor.id, action: 'restore', reason: '', before: null,
      after: { application: packet.application, formatVersion: packet.formatVersion, exportedAt: packet.exportedAt, restored, skipped, restoredAt },
    })
    return { restored, skipped, restoredAt, counts: checked.preview.counts }
  })
}
