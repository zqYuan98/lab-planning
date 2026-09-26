import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { readFileSync, readdirSync } from 'node:fs'
import { Store } from '../server/store.ts'
import { TestDomain as Domain } from './fixtures/legacy-domain.ts'
import { planVisibilityProjector, visiblePlan, visiblePlanHistory } from '../server/plan-visibility.ts'
import { workProgressProjector } from '../server/work-progress.ts'
import { ObjectAccessService } from '../server/object-access.ts'
import { legacyBootstrap } from './fixtures/r2-baseline/domain.ts'
import { visiblePlan as legacyVisiblePlan, visiblePlanHistory as legacyPlanHistory } from './fixtures/r2-baseline/plan-visibility.ts'
import { workProgressProjector as legacyProgress } from './fixtures/r2-baseline/work-progress.ts'
import { ObjectAccessService as LegacyObjectAccess } from './fixtures/r2-baseline/object-access.ts'
import type { AuditEvent, Entity, MonthlyPlan, Publication, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { ProgressEvent } from '../shared/collaboration.ts'
import type { ObjectGrant } from '../shared/object-access.ts'

const at = '2026-09-24T08:00:00.000Z', earlier = '2026-09-01T08:00:00.000Z'
function fixture(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date(at) })
  const store = new Store(':memory:'), domain = new Domain(store)
  t.after(() => store.close())
  const put = <T extends Entity>(collection: string, data: Omit<T, keyof Entity> & Partial<Entity>): T => store.restoreEntity<T>(collection, { version: 1, createdAt: earlier, updatedAt: earlier, ...data } as T)
  const user = (id: string, role: User['role']) => put<User>('users', { id, role, name: id, email: `${id}@r2.invalid`, position: '', active: true })
  const manager = user('manager', 'manager'), former = user('former', 'member'), current = user('current', 'member'), peer = user('peer', 'member'), observer = user('observer', 'observer')
  // The store creates a random epoch on open; replace it with the fixed fixture value.
  store.delete('operationContexts', 'business-commands', store.get<Entity>('operationContexts', 'business-commands')!.version)
  put<Entity & { epoch: string }>('operationContexts', { id: 'business-commands', epoch: 'fixed-r2-epoch' })
  const plan = (id: string, patch: Partial<MonthlyPlan> = {}) => put<MonthlyPlan>('plans', { id, month: '2026-09', title: id, projectId: null, category: '', ownerId: current.id, collaboratorIds: [], expectedOutcome: '个人预期秘密', acceptanceCriteria: '个人验收秘密', dueDate: '2026-09-30', priority: 'medium', status: 'published', reviewComment: '个人审核秘密', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', ...patch })
  const task = (id: string, patch: Partial<Task> = {}) => put<Task>('tasks', { id, title: id, monthlyPlanId: null, ownerId: former.id, description: '', dueDate: '2026-09-30', status: 'doing', isTemporary: false, temporaryReason: '', ...patch })
  const weekly = (task: Task, id: string, patch: Partial<WeeklyRecord> = {}) => put<WeeklyRecord>('weeklyRecords', { id, taskId: task.id, monthlyPlanId: task.monthlyPlanId, ownerId: task.ownerId, weekStart: '2026-09-21', commitment: id, actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'doing', submitted: true, ...patch })
  const audit = (id: string, entityType: string, entityId: string, before: unknown, after: unknown, patch: Partial<AuditEvent> = {}) => put<AuditEvent>('events', { id, entityType, entityId, actorId: manager.id, action: 'update', reason: '其他成员的私密说明', before, after, ...patch })
  const publication = (id: string, plans: MonthlyPlan[]) => put<Publication>('publications', { id, month: '2026-09', revision: 1, actorId: manager.id, reason: '发布私密说明', plans })
  const progress = (task: Task, id: string, patch: Partial<ProgressEvent> = {}) => put<ProgressEvent>('progressEvents', { id, mutationId: id, taskId: task.id, weeklyRecordId: null, actorId: task.ownerId, ownerId: task.ownerId, source: 'task', noteType: 'progress', note: '', noChangeReason: '', nextAction: '', proxyReason: '', changes: [], meaningfulOwnerProgress: true, occurredAt: earlier, auditEventIds: [], ...patch })
  return { store, domain, put, manager, former, current, peer, observer, plan, task, weekly, audit, publication, progress }
}

test('indexed audit reads preserve list row order and use the existing object index', t => {
  const f = fixture(t)
  f.audit('z-first', 'plan', 'same', null, null, { createdAt: at })
  f.audit('a-next', 'plan', 'same', null, null, { createdAt: earlier })
  f.audit('foreign', 'task', 'same', null, null)
  f.audit('another', 'plan', 'other', null, null)
  const all = f.store.list<AuditEvent>('events')
  assert.deepEqual(f.store.entityEvents('plan', 'same'), all.filter(e => e.entityType === 'plan' && e.entityId === 'same'))
  assert.deepEqual(f.store.entityTypeEvents(['task', 'plan']), all)
  assert.deepEqual(f.store.entityTypeEvents([]), [])
  assert.deepEqual(f.store.entityEvents("plan' OR 1=1 --", 'same'), [])
  for (const id of ['same', undefined]) {
    const details = f.store.entityEventsExplain('plan', id).map(row => row.detail).join('\n')
    assert.match(details, /SEARCH entities USING INDEX event_object_created/)
    t.diagnostic(details)
  }
  f.store.resetReadMetrics()
  f.store.entityEvents('plan', 'same')
  assert.equal(f.store.getReadMetrics().parsedRows, 2)
})

test('request plan index matches frozen membership snapshots, tie precedence and merged source redaction', t => {
  const f = fixture(t), p = f.plan('history', { version: 5 })
  const former = { ...p, ownerId: f.former.id, version: 3, title: 'same-version-before-wins' }
  f.audit('z-first', 'plan', p.id, former, { ...former, title: 'same-version-after-loses' })
  f.audit('a-second', 'plan', p.id, null, { ...former, title: 'same-version-next-event-loses' })
  f.publication('publication', [{ ...former, title: 'same-version-publication-loses' }])
  const publicationOnly = f.plan('publication-only')
  f.publication('publication-only-source', [{ ...publicationOnly, ownerId: f.former.id, version: 4 }])
  f.audit('wrong-id', 'plan', 'invalid', null, { ...former, id: 'history', version: 99 })
  const merged = f.plan('merged', { ownerId: f.former.id, mergedFromIds: ['secret-source'], isTemporary: true, status: 'returned' })
  const carried = f.plan('carried', { ownerId: f.former.id, sourcePlanId: merged.id })
  f.plan('carried-twice', { ownerId: f.former.id, sourcePlanId: carried.id })
  f.plan('merged-source', { ownerId: f.peer.id, collaboratorIds: [f.former.id], status: 'merged', mergedIntoId: merged.id, isTemporary: true, temporaryReason: '私密临时原因' })
  f.plan('cycle-a', { sourcePlanId: 'cycle-b', ownerId: f.former.id })
  f.plan('cycle-b', { sourcePlanId: 'cycle-a', ownerId: f.former.id })
  const plans = f.store.list<MonthlyPlan>('plans'), events = f.store.list<AuditEvent>('events'), publications = f.store.list<Publication>('publications')
  for (const actor of [f.manager, f.former, f.current, f.peer, f.observer]) {
    const indexed = planVisibilityProjector(f.store, actor, { plans, events, publications })
    for (const plan of plans) {
      const expected = legacyVisiblePlan(f.store, actor, plan)
      assert.deepEqual(indexed.visible(plan), expected, `${actor.id}:${plan.id}`)
      assert.deepEqual(visiblePlan(f.store, actor, plan), expected)
      assert.deepEqual(visiblePlanHistory(actor, plan.id, f.store.entityEvents('plan', plan.id), f.store), legacyPlanHistory(actor, plan.id, events, f.store))
    }
  }
  const result = planVisibilityProjector(f.store, f.former, { plans, events, publications })
  assert.equal(result.visible(p)?.title, 'same-version-before-wins')
  assert.equal(result.visible(carried)?.expectedOutcome, '团队合并目标，请按整体成果要求执行')
  assert.equal(result.visible(carried)?.sourcePlanId, null)
})

test('nonstandard legacy snapshot versions retain the exact stable-sort selection of the old reader', t => {
  const f = fixture(t)
  for (const [caseIndex, versions] of [['2', '10'], [1, undefined, 2], [1, 'bad', 2], [2, null, 3]].entries()) {
    const current = f.plan(`legacy-version-${caseIndex}`)
    for (const [index, version] of versions.entries()) f.audit(`legacy-version-${caseIndex}-${index}`, 'plan', current.id, null, { ...current, version, ownerId: f.former.id, title: `snapshot-${index}` })
    const indexed = planVisibilityProjector(f.store, f.former, { plans: f.store.list('plans'), events: f.store.list('events'), publications: [] })
    const expected = legacyVisiblePlan(f.store, f.former, current)
    assert.deepEqual(indexed.visible(current), expected, JSON.stringify(versions))
    assert.deepEqual(visiblePlan(f.store, f.former, current), expected)
  }
  assert.deepEqual(f.domain.bootstrap(f.former), legacyBootstrap(f.store, f.former))
})

test('bootstrap equals frozen baseline for all roles, historical missing tasks and deleted/cancelled rows', t => {
  const f = fixture(t), hidden = f.plan('hidden-plan'), historical = f.plan('historical-plan', { version: 5 })
  f.audit('plan-membership', 'plan', historical.id, { ...historical, version: 2, collaboratorIds: [f.former.id] }, historical)
  const task = f.task('owned', { monthlyPlanId: hidden.id, currentProgress: '总体结果' })
  f.audit('create-owned', 'task', task.id, null, task, { action: 'create' })
  f.weekly(task, 'active-record', { actualOutcome: '本周结果' })
  f.weekly(task, 'deleted-record', { actualOutcome: '删除的结果', deletion: { deletedAt: earlier, deletedBy: f.former.id, reason: '' } })
  f.weekly(task, 'future-record', { weekStart: '2026-10-05', actualOutcome: '未来结果' })
  const removed = { ...task, id: 'removed', monthlyPlanId: historical.id, version: 2, title: 'missing-task-first-snapshot' }
  f.audit('removed-before', 'task', removed.id, removed, { ...removed, title: 'same-version-after-loses' })
  f.weekly(removed, 'removed-record', { actualOutcome: '历史缺失任务成果' })
  f.weekly({ ...removed, id: 'no-snapshot' }, 'orphan-record')
  const cancelled = f.task('cancelled', { cancellation: { cancelledAt: earlier, cancelledBy: f.manager.id, reason: '取消原因' } })
  f.weekly(cancelled, 'cancelled-record')
  const removedCancelled = { ...cancelled, id: 'removed-cancelled' }
  f.audit('removed-cancelled', 'task', removedCancelled.id, null, removedCancelled)
  f.weekly(removedCancelled, 'removed-cancelled-record')
  f.task('peer-task', { ownerId: f.peer.id })
  const grant = f.put<ObjectGrant>('objectGrants', { id: 'grant', subjectId: f.observer.id, objectType: 'task', objectId: task.id, capabilities: ['read'], historyPolicy: 'all_history', objectVersion: 1, grantedBy: f.manager.id, grantedAt: earlier, expiresAt: null, revokedAt: null, reason: '', excludedFactIds: [] })
  for (const actor of [f.manager, f.former, f.current, f.peer, f.observer]) for (const origins of [false, true]) for (const deleted of [false, true]) {
    assert.deepEqual(f.domain.bootstrap(actor, origins, deleted), legacyBootstrap(f.store, actor, origins, deleted), `${actor.id}:${origins}:${deleted}`)
  }
  const own = f.domain.bootstrap(f.former)
  assert.equal(own.plans.find(p => p.id === hidden.id)?.visibility, 'reference')
  assert.equal(own.tasks.find(row => row.id === removed.id)?.title, 'missing-task-first-snapshot')
  assert.equal(own.weeklyRecords.some(row => row.id === 'cancelled-record'), false)
  assert.deepEqual(new ObjectAccessService(f.store).taskView(f.observer, task.id), new LegacyObjectAccess(f.store).taskView(f.observer, task.id))
  f.store.update<ObjectGrant>('objectGrants', grant.id, grant.version, { revokedAt: at })
  assert.deepEqual(f.domain.bootstrap(f.observer), legacyBootstrap(f.store, f.observer))
  assert.equal(f.domain.bootstrap(f.observer).authorizedWork?.length, 0)
  assert.throws(() => new ObjectAccessService(f.store).taskView(f.observer, task.id), { status: 404 })
  f.store.update<User>('users', f.former.id, f.former.version, { role: 'observer' })
  assert.deepEqual(f.domain.bootstrap(f.former), legacyBootstrap(f.store, f.former))
  assert.deepEqual(f.domain.bootstrap(f.former).tasks, [])
})

test('grouped progress retains evidence ordering, unknown facts, proxy and every weekly exclusion', t => {
  const f = fixture(t), task = f.task('progress', { currentProgress: '总体：完成　初稿', completionNote: '旧完成说明' }), peer = f.task('peer', { ownerId: f.peer.id })
  const active = f.weekly(task, 'active', { actualOutcome: '执行记录' })
  f.audit('audit-active', 'weeklyRecord', active.id, { ...active, actualOutcome: '' }, active)
  f.progress(task, 'z-evidence', { weeklyRecordId: active.id, source: 'weeklyRecord', actorId: f.manager.id, note: '代理执行记录', auditEventIds: ['audit-active'] })
  f.progress(task, 'a-evidence', { changes: [{ field: 'task.currentProgress', before: '', after: '总体:完成 初稿' }] })
  f.progress(task, '中-evidence', { note: '相同时间非ASCII标识' })
  f.progress(task, 'unknown', { note: '未知时间记录', occurredAt: '' })
  f.progress(task, 'no-change', { noteType: 'no_change', note: '不计入最新执行', occurredAt: at })
  for (const [id, patch] of Object.entries({ deleted: { deletion: { deletedAt: earlier, deletedBy: f.former.id, reason: '' } }, draft: { submitted: false }, future: { weekStart: '2026-10-05' }, unapproved: { planApproval: { required: true as const, approvedSubmissionId: null, approvedFingerprint: null } }, foreign: { ownerId: f.peer.id } })) {
    const record = f.weekly(task, id, { actualOutcome: `${id}结果`, ...patch })
    f.progress(task, `event-${id}`, { weeklyRecordId: record.id, note: `${id}事件`, occurredAt: at })
    f.audit(`audit-${id}`, 'weeklyRecord', record.id, { ...record, actualOutcome: '' }, record, { createdAt: at })
  }
  f.progress(peer, 'peer-evidence', { note: '其他成员结果' })
  for (const actor of [f.manager, f.former]) {
    const old = legacyProgress(f.store, actor, new Date(at)), current = workProgressProjector(f.store, actor, new Date(at))
    for (const row of actor.role === 'manager' ? [task, peer] : [task]) assert.deepEqual(current(row), old(row))
  }
  assert.throws(() => workProgressProjector(f.store, f.former)(peer), { status: 404 })
  assert.throws(() => workProgressProjector(f.store, f.observer), { status: 403 })
})

test('bootstrap parses shared collections once and reports measured reduction against independent baseline', t => {
  const f = fixture(t)
  for (let i = 0; i < 24; i++) {
    const plan = f.plan(`plan-${i}`)
    f.audit(`plan-audit-${i}`, 'plan', plan.id, { ...plan, ownerId: f.former.id }, plan)
    f.publication(`publication-${i}`, [{ ...plan, ownerId: f.former.id }])
    const task = f.task(`task-${i}`, { monthlyPlanId: plan.id, currentProgress: `总体${i}` })
    f.weekly(task, `record-${i}`, { actualOutcome: `成果${i}` })
    f.audit(`task-audit-${i}`, 'task', task.id, null, task, { action: 'create' })
  }
  for (let i = 0; i < 200; i++) f.audit(`unrelated-${i}`, 'configuration', `configuration-${i}`, null, { text: 'padding'.repeat(30) })
  f.store.resetReadMetrics()
  const before = performance.now(), expected = legacyBootstrap(f.store, f.former), legacyMs = performance.now() - before, legacy = f.store.getReadMetrics()
  const counts = new Map<string, number>(), list = f.store.list.bind(f.store)
  f.store.list = <T>(collection: string): T[] => { counts.set(collection, (counts.get(collection) ?? 0) + 1); return list<T>(collection) }
  f.store.resetReadMetrics()
  const started = performance.now(), actual = f.domain.bootstrap(f.former), currentMs = performance.now() - started, current = f.store.getReadMetrics()
  assert.deepEqual(actual, expected)
  for (const collection of ['events', 'publications', 'weeklyRecords', 'progressEvents']) assert.equal(counts.get(collection), 1, collection)
  assert.ok(current.parsedRows < legacy.parsedRows / 10)
  assert.ok(current.parsedBytes < legacy.parsedBytes / 10)
  assert.ok(current.sql <= 20)
  t.diagnostic(JSON.stringify({ legacy, current, legacyMs, currentMs }))
  // A new response sees changes immediately; the index does not survive across requests.
  const changed = f.store.get<MonthlyPlan>('plans', 'plan-0')!
  f.store.update<MonthlyPlan>('plans', changed.id, changed.version, { ownerId: f.former.id, title: '当前请求应看到的新标题' })
  assert.equal(f.domain.bootstrap(f.former).plans.find(p => p.id === changed.id)?.title, '当前请求应看到的新标题')
})

test('frozen oracle does not import current plan, progress, object-access or origin implementations', () => {
  const directory = new URL('./fixtures/r2-baseline/', import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('manifest.json', directory), 'utf8'))
  assert.equal(manifest.commit, '65317c6')
  for (const name of readdirSync(directory).filter(name => name.endsWith('.ts'))) {
    const source = readFileSync(new URL(name, directory), 'utf8')
    assert.doesNotMatch(source, /from ['"][^'"]*server\/(?:domain|plan-visibility|work-progress|object-access|work-origin)\.ts['"]/, name)
  }
})
