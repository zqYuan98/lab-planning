import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { WorkspaceQueryService } from '../server/workspace-query.ts'
import { applyMigrations, STORAGE_VERSION } from '../server/storage-migrations.ts'
import type { Entity, Task, User, WeeklyRecord, Report, MonthlyPlan, AuditEvent, Publication } from '../shared/types.ts'
import { buildWorkRegister, workRegisterToday, workRegisterViewLabels } from '../shared/work-register.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id, role, name: id, email: `${id}@test.invalid`, position: '', active: true })
  const manager = user('manager', 'manager'), member = user('member', 'member'), peer = user('peer', 'member'), observer = user('observer', 'observer')
  const service = new WorkspaceQueryService(store), domain = new Domain(store)
  const task = (id: string, patch: Partial<Task> = {}) => store.insert<Task>('tasks', { id, title: `工作${id}`, ownerId: member.id, monthlyPlanId: null, description: '', dueDate: '2026-09-30', status: 'doing', isTemporary: false, temporaryReason: '', ...patch })
  const weekly = (task: Task, weekStart: string, patch: Partial<WeeklyRecord> = {}) => store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, ownerId: task.ownerId, monthlyPlanId: null, weekStart, commitment: '周承诺', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'planned', submitted: false, ...patch })
  return { store, service, domain, manager, member, peer, observer, task, weekly }
}
function pages(f: ReturnType<typeof fixture>, actor: User, resource: Parameters<WorkspaceQueryService['page']>[1], query: Record<string, unknown> = {}) {
  let cursor: string | null = null, expected: number | null = null; const items: Entity[] = []
  do { const page = f.service.page(actor, resource, { ...query, limit: 7, ...(cursor ? { cursor } : {}) }); expected ??= page.total; assert.equal(page.total, expected); items.push(...page.items); cursor = page.nextCursor } while (cursor)
  assert.equal(items.length, expected); assert.equal(new Set(items.map(row => row.id)).size, items.length)
  return items
}
test('paged tasks match authorized full collection, stable ties and cancellation predicate', t => {
  const f = fixture(t)
  for (let i = 0; i < 137; i++) f.task(`own-${i}`, { createdAt: '2025-01-01T00:00:00.000Z' })
  f.task('cancelled', { cancellation: { cancelledAt: new Date().toISOString(), cancelledBy: f.manager.id, reason: '撤销' } })
  for (let i = 0; i < 8; i++) f.task(`peer-${i}`, { ownerId: f.peer.id })
  for (const actor of [f.manager, f.member]) {
    const expected = f.domain.bootstrap(actor).tasks.map(row => row.id).sort()
    assert.deepEqual(pages(f, actor, 'tasks').map(row => row.id).sort(), expected)
  }
  assert.equal(f.service.page(f.member, 'tasks', {}).items.length, 50)
  assert.equal(f.service.page(f.member, 'tasks', { includeCancelled: 'true' }).total, 138)
  assert.throws(() => f.service.page(f.member, 'tasks', { limit: 101 }), /分页/)
  assert.throws(() => f.service.page(f.member, 'tasks', { sql: '1=1' }), /不支持/)
  assert.equal(f.service.page(f.member, 'tasks', { ownerId: f.peer.id }).total, 0)
})
test('open work crosses creation months; weekly pages share active and authorization predicates', t => {
  const f = fixture(t), task = f.task('older'), done = f.task('done', { status: 'done' }), cancelled = f.task('cancel', { cancellation: { cancelledAt: new Date().toISOString(), cancelledBy: f.manager.id, reason: '取消' } })
  f.weekly(task, '2026-09-21'); f.weekly(done, '2026-09-21'); f.weekly(cancelled, '2026-09-21'); f.weekly(task, '2026-09-14', { deletion: { deletedAt: new Date().toISOString(), deletedBy: f.member.id, reason: '' } })
  assert.deepEqual(f.service.page(f.member, 'tasks', { scope: 'open', month: '2027-01' }).items.map(row => row.id), [task.id])
  assert.deepEqual(pages(f, f.member, 'weekly-records').map(row => row.id).sort(), f.domain.bootstrap(f.member).weeklyRecords.map(row => row.id).sort())
})
test('cursor binds actor, permission, query and data revision and cannot be forged', t => {
  const f = fixture(t); for (let i = 0; i < 8; i++) f.task(`t-${i}`)
  const first = f.service.page(f.member, 'tasks', { limit: 2 }), cursor = first.nextCursor!
  assert.throws(() => f.service.page(f.peer, 'tasks', { limit: 2, cursor }), /已更新/)
  assert.throws(() => f.service.page(f.member, 'tasks', { limit: 2, cursor, q: 'another' }), /已更新/)
  assert.throws(() => f.service.page(f.member, 'tasks', { limit: 2, cursor: `${cursor}x` }), /已更新/)
  f.store.update<User>('users', f.member.id, f.member.version, { position: '已变更' })
  assert.throws(() => f.service.page(f.member, 'tasks', { limit: 2, cursor }), /已更新/)
  const next = f.service.page(f.member, 'tasks', { limit: 2 })
  f.task('new')
  assert.throws(() => f.service.page(f.member, 'tasks', { limit: 2, cursor: next.nextCursor! }), /已更新/)
})
test('shell stays bounded and role-safe; report listing never parses bodies or snapshots', t => {
  const f = fixture(t), task = f.task('active')
  const before = f.service.shell(f.member); f.store.resetReadMetrics(); f.service.shell(f.member); const baseline = f.store.getReadMetrics()
  f.store.transaction(() => { for (let i = 0; i < 1000; i++) f.weekly(task, '2025-01-06') })
  const report = f.store.insert<Report>('reports', { type: 'monthly', period: '2026-09', title: '秘密报告', authorId: f.manager.id, status: 'draft', revision: 1, finalizedAt: null, narrative: '大正文'.repeat(100000), snapshot: { tasks: [], plans: [], weeklyRecords: [], annualGoals: [], projects: [], users: [], nextPlans: [], nextWeeklyRecords: [], publications: [], changes: [] } })
  f.store.resetReadMetrics(); const after = f.service.shell(f.member), measured = f.store.getReadMetrics()
  assert.deepEqual(after, before); assert.equal(measured.sql, baseline.sql); assert.equal(measured.parsedRows, baseline.parsedRows); assert.ok(Buffer.byteLength(JSON.stringify(after)) < 100 * 1024)
  f.store.resetReadMetrics(); const reports = f.service.page(f.manager, 'reports', {})
  assert.equal(reports.total, 1); assert.equal('snapshot' in reports.items[0], false); assert.equal('narrative' in reports.items[0], false); assert.ok(f.store.getReadMetrics().parsedBytes < 5000)
  assert.equal(f.service.report(f.manager, report.id).narrative, report.narrative)
  assert.throws(() => f.service.page(f.member, 'reports', {}), /管理者/)
  assert.equal(f.service.shell(f.observer).counts.openTasks, 0)
  for (const resource of ['tasks', 'plans', 'weekly-records', 'history', 'reports', 'candidates'] as const) assert.throws(() => f.service.page(f.observer, resource, {}), /观察者/)
})
test('work register all pages and aggregate counts match the established full workload', t => {
  const f = fixture(t), week = buildWorkRegister({ user: f.member, tasks: [], weeklyRecords: [] }).weekStart
  for (let i = 0; i < 35; i++) {
    const task = f.task(`work-${i}`, { workSource: i % 2 ? 'leader' : 'self', status: i % 7 === 0 ? 'done' : i % 6 === 0 ? 'blocked' : 'doing', waitingForFeedback: i % 4 === 0, priority: i % 3 === 0 ? 'high' : 'low' })
    if (i % 2 === 0) f.weekly(task, week)
  }
  f.task('review', { status: 'done', importSource: { batchId: 'b', sourceId: 's', rowId: 'r', sourceStatus: 'done' } })
  f.store.insert<MonthlyPlan>('plans', { title: '未拆分目标', ownerId: f.member.id, month: '2025-01', projectId: null, category: '', collaboratorIds: [], expectedOutcome: '', acceptanceCriteria: '', dueDate: '', priority: 'high', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '' })
  const full = f.domain.bootstrap(f.member)
  for (const view of Object.keys(workRegisterViewLabels) as (keyof typeof workRegisterViewLabels)[]) {
    const expected = buildWorkRegister(full, { view, today: workRegisterToday() }); let cursor: string | null = null; const ids: string[] = []
    do { const page = f.service.register(f.member, { view, limit: 4, ...(cursor ? { cursor } : {}) }); ids.push(...page.items.map(row => `${row.kind}:${row.id}`)); assert.equal(page.total, expected.rows.length); assert.deepEqual(page.result.counts, expected.counts); cursor = page.nextCursor } while (cursor)
    assert.deepEqual(ids.sort(), expected.rows.map(row => `${row.kind}:${row.id}`).sort())
  }
})
test('candidate role predicates apply before paging and SQL metacharacters remain literal', t => {
  const f = fixture(t)
  assert.deepEqual(f.service.page(f.member, 'candidates', { kind: 'user', role: 'manager', limit: 1 }).items.map(row => row.id), [f.manager.id])
  assert.equal(f.service.page(f.member, 'tasks', { q: "' OR 1=1 --" }).total, 0)
})
test('register preserves a missing live task as a verified read-only historical reference', t => {
  const f = fixture(t), task = f.task('historical', { currentProgress: '已有历史进展', workSource: 'leader' })
  f.weekly(task, '2025-01-06')
  f.store.insert<AuditEvent>('events', { entityType: 'task', entityId: task.id, actorId: f.member.id, action: 'update', reason: '', before: null, after: task })
  f.store.insert<AuditEvent>('events', { entityType: 'task', entityId: task.id, actorId: f.manager.id, action: 'update', reason: '', before: null, after: { ...task, ownerId: f.peer.id, version: 4, description: '其他责任人的私密内容' } })
  f.store.delete('tasks', task.id, task.version)
  const baseline = buildWorkRegister(f.domain.bootstrap(f.member)), page = f.service.register(f.member, {})
  assert.deepEqual(page.items.map(row=>row.id), baseline.rows.map(row=>row.id)); assert.deepEqual(page.result.counts, baseline.counts)
  assert.equal(page.total, 1); assert.equal(page.items[0].historicalReference, true); assert.equal(page.items[0].progress, '已有历史进展')
  assert.equal(JSON.stringify(page).includes('其他责任人的私密内容'), false)
  assert.equal(f.store.get('tasks', task.id), undefined)
})
test('register keyword search preserves established progress, source, status and business-text scope', t => {
  const f = fixture(t), week = buildWorkRegister({user:f.member,tasks:[],weeklyRecords:[]}).weekStart
  const task = f.task('search', { workSource: 'leader', status: 'blocked', blockerReason: '等待专线开通', assignedOn: '2026-08-03', estimatedEffort: '两个工作日' })
  f.weekly(task, week, { actualOutcome: '核心实验取得突破' })
  f.store.insert<MonthlyPlan>('plans', { title: '月度探索', ownerId: f.member.id, month: '2026-09', projectId: null, category: '算法验证', collaboratorIds: [], expectedOutcome: '', acceptanceCriteria: '准确率验收门槛', dueDate: '', priority: 'medium', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '试验成果', acceptanceStatus: 'pending', acceptanceNote: '' })
  const data = f.domain.bootstrap(f.member)
  for (const q of ['专线开通','两个工作日','2026-08-03','核心实验','领导交办','受阻','验收门槛','算法验证','月度目标','试验成果']) {
    const expected = buildWorkRegister(data,{query:q}), page = f.service.register(f.member,{q,limit:1})
    assert.equal(page.total,expected.rows.length,q)
    assert.deepEqual(page.items.map(row=>row.id).sort(),expected.rows.map(row=>row.id).sort(),q)
  }
})
test('legacy creation evidence preserves leader source and assigner search without relabeling explicit sources', t => {
  const f=fixture(t), legacy=f.task('legacy-source')
  f.store.insert<AuditEvent>('events',{entityType:'task',entityId:legacy.id,actorId:f.manager.id,action:'create',reason:'',before:null,after:legacy})
  f.task('explicit-source',{workSource:'leader'})
  const full=f.domain.bootstrap(f.member)
  for(const q of ['领导交办','按下发记录','manager']) {
    const expected=buildWorkRegister(full,{view:'leader',query:q}),page=f.service.register(f.member,{view:'leader',q})
    assert.equal(page.total,expected.rows.length,q)
    assert.deepEqual(page.items.map(row=>row.id).sort(),expected.rows.map(row=>row.id).sort(),q)
  }
})
test('register plan references and inherited filters use only the member-visible current or historical snapshot', t => {
  const f = fixture(t)
  const plan = (id: string, patch: Partial<MonthlyPlan> = {}) => f.store.insert<MonthlyPlan>('plans', { id, title: `当前私密目标${id}`, ownerId: f.peer.id, month: '2026-09', projectId: null, category: '', collaboratorIds: [], expectedOutcome: '当前私密内容', acceptanceCriteria: '', dueDate: '', priority: 'low', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', ...patch })
  const audited = plan('audited'), published = plan('published'), unseen = plan('unseen'), current = plan('current', { collaboratorIds: [f.member.id], title: '当前参与目标', expectedOutcome: '' })
  const snapshot = { ...audited, title: '本人参与期间目标', expectedOutcome: '当时获准内容', priority: 'high' as const, isTemporary: true, ownerId: f.member.id, version: 3 }
  f.store.insert<AuditEvent>('events', { entityType: 'plan', entityId: audited.id, actorId: f.manager.id, action: 'update', reason: '不要泄露审计原因', before: snapshot, after: { ...audited, version: 4 } })
  // Equal-version ties retain the same first visible audit snapshot as legacy bootstrap.
  f.store.insert<AuditEvent>('events', { entityType: 'plan', entityId: audited.id, actorId: f.manager.id, action: 'update', reason: '', before: null, after: { ...snapshot, title: '后置同版快照', priority: 'low', isTemporary: false } })
  f.store.insert<AuditEvent>('events', { entityType: 'plan', entityId: 'wrong-plan', actorId: f.manager.id, action: 'update', reason: '', before: null, after: { ...snapshot, version: 100, title: '不属于此目标的审计' } })
  f.store.insert<Publication>('publications', { month: '2026-09', revision: 1, actorId: f.manager.id, reason: '不要泄露发布原因', plans: [
    { ...published, title: '发布时可见目标', expectedOutcome: '', collaboratorIds: [f.member.id], priority: 'high', isTemporary: true, version: 2 },
    { ...published, title: '同次发布中私密版本', collaboratorIds: [], version: 8 },
    { ...unseen, title: '同次发布中其他成员的目标' },
  ] })
  for (const item of [audited, published, unseen, current]) f.task(`task-${item.id}`, { monthlyPlanId: item.id })
  f.task('explicit-priority', { monthlyPlanId: audited.id, priority: 'low' })
  f.task('other-owner', { ownerId: f.peer.id, monthlyPlanId: audited.id, title: '别人的任务私密内容' })
  const full = f.domain.bootstrap(f.member), baseline = buildWorkRegister(full), expectedPlans = new Map(full.plans.map(item => [item.id, item]))
  const priorityFor = (row: typeof baseline.rows[number]) => row.priority ?? (row.kind === 'task' ? expectedPlans.get(row.task.monthlyPlanId ?? '')?.priority : undefined)
  const kindFor = (row: typeof baseline.rows[number]) => row.kind === 'plan' ? row.plan.isTemporary ? 'temporary' : 'monthly' : row.task.isTemporary || row.task.temporaryReason?.trim() || expectedPlans.get(row.task.monthlyPlanId ?? '')?.isTemporary ? 'temporary' : row.task.monthlyPlanId ? 'monthly' : 'routine'
  for (const priority of [undefined, 'high', 'medium', 'low']) for (const kind of [undefined, 'temporary', 'monthly']) {
    const query = { ...(priority ? { priority } : {}), ...(kind ? { kind } : {}) }, expected = baseline.rows.filter(row => (!priority || priorityFor(row) === priority) && (!kind || kindFor(row) === kind))
    const page = f.service.register(f.member, query)
    assert.equal(page.total, expected.length, JSON.stringify(query))
    assert.deepEqual(page.items.map(row => row.id).sort(), expected.map(row => row.id).sort(), JSON.stringify(query))
    assert.equal(page.highCount, baseline.rows.filter(row => row.isActive && priorityFor(row) === 'high').length)
    for (const reference of page.references.plans) assert.deepEqual(reference, expectedPlans.get(reference.id))
    for (const row of page.items) assert.equal(row.priority, priorityFor(baseline.rows.find(item => item.id === row.id)!))
    for (const privateText of ['当前私密目标', '当前私密内容', '后置同版快照', '不属于此目标的审计', '不要泄露', '别人的任务私密内容', '同次发布中']) assert.equal(JSON.stringify(page).includes(privateText), false, privateText)
  }
  assert.equal(f.service.register(f.member, {}).references.plans.find(item => item.id === unseen.id)?.visibility, 'reference')
  assert.equal(f.service.register(f.member, {}).references.plans.find(item => item.id === audited.id)?.visibility, 'historical')
  f.task('manager-own', { ownerId: f.manager.id, monthlyPlanId: audited.id })
  const managerPage = f.service.register(f.manager, { priority: 'low', kind: 'monthly' })
  assert.equal(managerPage.total, 1)
  assert.equal(managerPage.items[0].id, 'manager-own')
  assert.deepEqual(managerPage.references.plans, [audited])
  assert.equal(f.service.register(f.manager, { priority: 'high', kind: 'temporary' }).total, 0)
})

test('historical register plan lookup returns one bounded snapshot as unrelated and superseded history grows', t => {
  const f = fixture(t)
  const plan = f.store.insert<MonthlyPlan>('plans', { title: '现在不可见', ownerId: f.peer.id, month: '2026-09', projectId: null, category: '', collaboratorIds: [], expectedOutcome: '', acceptanceCriteria: '', dueDate: '', priority: 'low', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '' })
  const snapshot = { ...plan, ownerId: f.member.id, title: '之前可见', priority: 'high' as const, version: 5 }
  f.store.insert<AuditEvent>('events', { entityType: 'plan', entityId: plan.id, actorId: f.manager.id, action: 'update', reason: '', before: snapshot, after: plan })
  f.task('bounded-plan', { monthlyPlanId: plan.id })
  f.service.register(f.member, {})
  f.store.resetReadMetrics()
  const before = f.service.register(f.member, {}), metrics = f.store.getReadMetrics()
  f.store.transaction(() => {
    for (let i = 0; i < 500; i++) f.store.insert<AuditEvent>('events', { entityType: 'plan', entityId: i % 2 ? plan.id : `unrelated-${i}`, actorId: f.manager.id, action: 'update', reason: '无关历史'.repeat(100), before: { ...snapshot, version: 2 }, after: plan })
  })
  f.store.resetReadMetrics()
  const after = f.service.register(f.member, {})
  assert.deepEqual(after.items, before.items)
  assert.deepEqual(after.references, before.references)
  assert.deepEqual(f.store.getReadMetrics(), metrics)
})

test('storage migration rejects future databases and index failure rolls back the version', () => {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec('CREATE TABLE entities(collection TEXT,id TEXT,version INTEGER,data TEXT,PRIMARY KEY(collection,id));CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,name TEXT,applied_at TEXT)')
    db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(1, 'old', '2026-01-01')
    db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(2, 'old', '2026-01-01')
    db.exec('CREATE INDEX event_object_created ON entities(id)')
    assert.throws(() => applyMigrations(db), /already exists/)
    assert.equal(db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get()?.n, 2)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='task_active_owner_created'").get(), undefined)
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name='weekly_active_task_owner_week'").get(), undefined)
    db.exec('DROP INDEX event_object_created'); applyMigrations(db)
    assert.equal(db.prepare('SELECT MAX(version) AS n FROM schema_migrations').get()?.n, STORAGE_VERSION)
    db.prepare('INSERT INTO schema_migrations VALUES(?,?,?)').run(STORAGE_VERSION + 1, 'future', '2026-01-01')
    assert.throws(() => applyMigrations(db), /数据库版本高于/)
  } finally { db.close() }
})
