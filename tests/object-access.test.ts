import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AuditEvent, Entity, Project, Task, User, WeeklyRecord } from '../shared/types.ts'
import type { ObjectGrant } from '../shared/object-access.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { ObjectGrantService } from '../server/object-grants.ts'
import { ObjectAccessService, canReadObject, observerBootstrap, projectObject, readScopeVersion, reportSourcesAccessible } from '../server/object-access.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { FeedbackService } from '../server/feedback-service.ts'
import { currentNotificationMessage } from '../server/notification-worker.ts'
import type { Notification } from '../shared/notifications.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { ImportService } from '../server/import-service.ts'
import { TaskDeliveryService } from '../server/task-deliveries.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store), grants = new ObjectGrantService(store), access = new ObjectAccessService(store)
  t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.insert<StoredUser>('users', { id, name: id, email: `${id}@access.test`, role, active: true, position: '', passwordHash: '', credentialVersion: 1 })
  const manager = user('manager', 'manager'), member = user('member', 'member'), observer = user('observer', 'observer')
  const task = domain.createTask(member, { title: '公开任务', isTemporary: true, temporaryReason: '私密代录原因', currentProgress: '当前总体进展', dueDate: '2026-09-30' })
  let request = 0
  const grant = (objectId = task.id, extras: Record<string, unknown> = {}) => grants.grant(manager, { requestId: `grant-${++request}-request`, subjectId: observer.id, objectType: 'task', objectId, objectVersion: store.get<Entity>('tasks', objectId)?.version ?? 1, capabilities: ['read'], reason: '管理者指定范围', ...extras })
  const weekly = (weekStart: string, submitted = true) => domain.createWeeklyRecord(member, { taskId: task.id, weekStart, commitment: '周承诺', actualOutcome: '周实际成果', submitted })
  return { store, domain, grants, access, manager, member, observer, task, grant, weekly }
}

test('observer former owner and stale role instances cannot mutate any legacy domain service', t => {
  const f = fixture(t), row = f.weekly('2026-09-21'), former = f.store.update<User>('users', f.member.id, f.member.version, { role: 'observer' })
  const attempts = [
    () => f.domain.createTask(former, { title: 'no', isTemporary: true, temporaryReason: 'no' }),
    () => f.domain.updateTask(f.member, f.task.id, { version: f.task.version, title: 'no' }),
    () => f.domain.captureTasks(former, { requestId: 'attempt-capture-id', titles: ['no'] }),
    () => f.domain.createWeeklyAssignment(former, {}),
    () => f.domain.updateWeeklyRecord(former, row.id, { version: row.version, actualOutcome: 'no' }),
    () => f.domain.createPlan(former, { isTemporary: true }),
    () => new WeeklySubmissionService(f.store).submit(former, {}),
    () => new WeeklySubmissionService(f.store).view(former, '2026-09-21'),
    () => new CollaborationService(f.store).taskView(former, f.task.id),
    () => new FeedbackService(f.store).list(former),
    () => new ImportService(f.store).list(former),
    () => new ImportService(f.store).structured(former, {}),
  ]
  for (const action of attempts) assert.throws(action, { status: 403 })
  assert.equal(f.store.get<Task>('tasks', f.task.id)?.title, f.task.title)
  assert.equal(f.store.list('objectAccessCommands').length, 0)
})

test('observer bootstrap is independent, excludes global dictionaries and former ownership, and grants do not spread', t => {
  const f = fixture(t)
  f.store.insert<Project>('projects', { name: '敏感项目', code: 'SECRET', description: '秘密', ownerId: f.manager.id, status: 'active' })
  const extra = f.domain.createTask(f.member, { title: '另一个秘密任务', isTemporary: true, temporaryReason: '私密', dueDate: '2026-09-30' })
  assert.throws(() => f.access.taskView(f.observer, f.task.id), { status: 404 })
  f.grant()
  const bootstrap = observerBootstrap(f.store, f.observer)
  assert.deepEqual(bootstrap.users.map(user => user.id), [f.observer.id])
  for (const rows of [bootstrap.tasks, bootstrap.weeklyRecords, bootstrap.plans, bootstrap.projects, bootstrap.annualGoals, bootstrap.publications, bootstrap.reports]) assert.equal(rows.length, 0)
  assert.equal(bootstrap.authorizedWork?.length, 1)
  assert.equal(canReadObject(f.store, f.observer, 'task', extra.id), false)
  assert.equal(JSON.stringify(bootstrap).includes('秘密'), false)
})

test('history boundary excludes preexisting rows even at identical grant timestamps; all_history still excludes private drafts', t => {
  const f = fixture(t), old = f.weekly('2026-09-21'), draft = f.weekly('2026-09-28', false)
  const grant = f.grant(), view = f.access.taskView(f.observer, f.task.id)
  assert.equal(view.weeklyRecords.length, 0)
  assert.equal(view.history.length, 0)
  assert.equal(view.task.currentProgress, '当前总体进展')
  assert.equal(view.task.temporaryReason, '')
  const newer = f.weekly('2026-10-05')
  assert.deepEqual(f.access.taskView(f.observer, f.task.id).weeklyRecords.map(row => row.id), [newer.id])
  const updated = f.grant(f.task.id, { version: grant.version, capabilities: ['read', 'read_evidence'] })
  assert.equal(updated.grantedAt, grant.grantedAt)
  assert.deepEqual(f.access.taskView(f.observer, f.task.id).weeklyRecords.map(row => row.id), [newer.id])
  f.grant(f.task.id, { version: updated.version, historyPolicy: 'all_history' })
  const full = f.access.taskView(f.observer, f.task.id)
  assert.deepEqual(full.weeklyRecords.map(row => row.id).sort(), [old.id, newer.id].sort())
  assert.equal(full.weeklyRecords.some(row => row.id === draft.id), false)
  assert.ok(full.history.every(row => !('before' in row) && !('after' in row) && !('reason' in row)))
})

test('capabilities are independent and grant/revoke commands are idempotent with one current grant', t => {
  const f = fixture(t)
  f.domain.updateTask(f.member, f.task.id, { version: f.task.version, evidenceUrl: 'https://evidence.example/result' })
  const input = { requestId: 'fixed-grant-command', subjectId: f.observer.id, objectType: 'task', objectId: f.task.id, objectVersion: 2, capabilities: ['read'], reason: 'scope' }
  const first = f.grants.grant(f.manager, input), scope = readScopeVersion(f.store, f.observer)
  assert.deepEqual(f.grants.grant(f.manager, input), first)
  assert.equal(f.store.list('objectGrants').length, 1)
  assert.equal(f.access.taskView(f.observer, f.task.id).task.evidenceUrl, undefined)
  assert.equal(canReadObject(f.store, f.observer, 'task', f.task.id, 'export_summary'), false)
  assert.throws(() => f.grants.grant(f.manager, { ...input, reason: 'changed' }), { status: 409, code: 'IDEMPOTENCY_MISMATCH' })
  const next = f.grant(f.task.id, { version: first.version, capabilities: ['read', 'read_evidence'] })
  assert.equal(next.id, first.id)
  assert.match(f.access.taskView(f.observer, f.task.id).task.evidenceUrl!, /evidence/)
  assert.notEqual(readScopeVersion(f.store, f.observer), scope)
  const revoke = { requestId: 'revoke-fixed-command', version: next.version, reason: '范围调整' }
  assert.deepEqual(f.grants.revoke(f.manager, next.id, revoke), f.grants.revoke(f.manager, next.id, revoke))
  assert.equal(f.access.list(f.observer).items.length, 0)
  assert.throws(() => f.access.detail(f.observer, next.id), { status: 404 })
})

test('scoped report regenerates prose only from permitted facts and revoke/regrant does not restore old all_history report', t => {
  const f = fixture(t), weekly = f.weekly('2026-09-21')
  f.domain.createTask(f.member, { title: '未授权机密内容', isTemporary: true, temporaryReason: 'secret', dueDate: '2026-09-30' })
  let source = f.grant(f.task.id, { historyPolicy: 'all_history', capabilities: ['read', 'export_summary'] })
  const report = f.grants.createReport(f.manager, { requestId: 'report-create-command', subjectId: f.observer.id, taskIds: [f.task.id], title: '范围摘要', includeHistory: true, narrative: '未授权机密内容' })
  assert.equal(report.narrative.includes('未授权机密内容'), false)
  assert.ok(report.manifest.some(fact => fact.factId === weekly.id))
  const reportGrant = f.grant(report.id, { objectType: 'scoped_report', objectVersion: report.version, capabilities: ['read', 'export_summary'] })
  assert.equal(canReadObject(f.store, f.observer, 'scoped_report', report.id), true)
  assert.equal(f.grants.exportReport(f.observer, report.id).narrative, report.narrative)
  source = f.grants.revoke(f.manager, source.id, { requestId: 'report-source-revoke', version: source.version, reason: 'remove' })
  assert.throws(() => projectObject(f.store, f.observer, 'scoped_report', report.id), { status: 404 })
  assert.throws(() => f.grants.exportReport(f.observer, report.id), { status: 404 })
  source = f.grant(f.task.id, { version: source.version, capabilities: ['read', 'export_summary'] })
  assert.equal(canReadObject(f.store, f.observer, 'scoped_report', report.id), false)
  assert.deepEqual(f.store.get('scopedReports', report.id), report)
  assert.equal(f.access.list(f.observer).items.some(item => item.id === reportGrant.id), false)
  f.grant(f.task.id, { version: source.version, historyPolicy: 'all_history', capabilities: ['read', 'export_summary'] })
  assert.equal(canReadObject(f.store, f.observer, 'scoped_report', report.id), true)
})

test('report grant does not substitute for source export or evidence capabilities', t => {
  const f = fixture(t), source = f.grant()
  const report = f.grants.createReport(f.manager, { requestId: 'report-per-capability', subjectId: f.observer.id, taskIds: [f.task.id], title: '摘要' })
  f.grant(report.id, { objectType: 'scoped_report', capabilities: ['read', 'read_evidence', 'export_summary'] })
  assert.equal(canReadObject(f.store, f.observer, 'scoped_report', report.id), true)
  assert.equal(canReadObject(f.store, f.observer, 'scoped_report', report.id, 'read_evidence'), false)
  assert.throws(() => f.grants.exportReport(f.observer, report.id), { status: 404 })
  f.grant(f.task.id, { version: source.version, capabilities: ['read', 'export_summary'] })
  assert.equal(f.grants.exportReport(f.observer, report.id).hash, report.hash)
})

test('frozen report manifest rejects unknown historical times and mismatched or missing source facts', t => {
  const f = fixture(t), row = f.weekly('2026-09-21')
  f.grant(f.task.id, { historyPolicy: 'all_history' })
  const report = f.grants.createReport(f.manager, { requestId: 'unknown-fact-report', subjectId: f.observer.id, taskIds: [f.task.id], title: '摘要', includeHistory: true })
  assert.equal(reportSourcesAccessible(f.store, f.observer, report), true)
  const historical = report.manifest.find(fact => fact.factId === row.id)!
  for (const changed of [{ ...historical, recordedAt: null }, { ...historical, occurredAt: 'invalid' }, { ...historical, factId: 'missing' }, { ...historical, objectVersion: 999 }, { ...historical, factVersion: 999 }]) {
    assert.equal(reportSourcesAccessible(f.store, f.observer, { ...report, manifest: [changed] }), false)
  }
})

test('current delivery status is visible without exposing pregrant submission text and history uses each revision decision', t => {
  const f = fixture(t), service = new TaskDeliveryService(f.store)
  const first = service.submit(f.member, f.task.id, { requestId: 'safe-delivery-first', taskVersion: f.task.version, previousRevision: 0, actualOutcome: '早期成果正文', evidenceRefs: ['https://evidence.example/secret'], acceptanceCriteria: '成果可用', reviewerId: f.manager.id })
  const grant = f.grant()
  let view = f.access.taskView(f.observer, f.task.id)
  assert.equal(view.deliverySummary.pending_review, 1)
  assert.equal(view.deliveries.length, 0)
  const accepted = service.decide(f.manager, first.delivery.id, { requestId: 'safe-delivery-review', seriesVersion: first.series.version, action: 'review', conclusion: 'accepted', note: '符合要求' })
  service.submit(f.member, f.task.id, { requestId: 'safe-delivery-second', taskVersion: f.task.version, seriesId: first.series.id, seriesVersion: accepted.series.version, previousRevision: 1, previousSubmissionId: first.delivery.id, replaceAccepted: true, actualOutcome: '新版成果', evidenceRefs: [], acceptanceCriteria: '新版可用', reviewerId: f.manager.id })
  f.grant(f.task.id, { version: grant.version, historyPolicy: 'all_history' })
  view = f.access.taskView(f.observer, f.task.id)
  assert.equal(view.deliveries.find(row => row.id === first.delivery.id)?.status, 'accepted')
  assert.deepEqual(view.deliveries.find(row => row.id === first.delivery.id)?.evidenceRefs, [])
  assert.equal(view.deliverySummary.pending_review, 1)
})

test('grant/revoke/report audit and command failures rollback permissions and receipts atomically', t => {
  const f = fixture(t), original = f.store.insert.bind(f.store)
  f.store.insert = ((collection: string, input: unknown) => { if (collection === 'objectAccessCommands') throw new Error('receipt failure'); return original(collection, input as never) }) as typeof f.store.insert
  assert.throws(() => f.grant(), /receipt failure/)
  assert.equal(f.store.list('objectGrants').length, 0)
  assert.equal(f.store.list<AuditEvent>('events').some(row => row.entityType === 'objectGrant'), false)
  f.store.insert = original
  const grant = f.grant(), scope = readScopeVersion(f.store, f.observer)
  f.store.insert = ((collection: string, input: unknown) => { if (collection === 'events') throw new Error('audit failure'); return original(collection, input as never) }) as typeof f.store.insert
  assert.throws(() => f.grants.revoke(f.manager, grant.id, { requestId: 'rollback-revoke-command', version: grant.version, reason: 'why' }), /audit failure/)
  assert.equal(readScopeVersion(f.store, f.observer), scope)
  assert.throws(() => f.grants.createReport(f.manager, { requestId: 'rollback-report-command', subjectId: f.observer.id, taskIds: [f.task.id], title: '摘要' }), /audit failure/)
  assert.equal(f.store.list('scopedReports').length, 0)
  f.store.insert = original
})

test('expiry, disable and stale privileged actor revalidate immediately; pending business sends stop', t => {
  const f = fixture(t), grant = f.grant(), scope = readScopeVersion(f.store, f.observer)
  f.store.update<ObjectGrant>('objectGrants', grant.id, grant.version, { expiresAt: '2000-01-01T00:00:00.000Z' })
  assert.equal(f.access.list(f.observer).items.length, 0)
  assert.notEqual(readScopeVersion(f.store, f.observer), scope)
  f.store.update<User>('users', f.manager.id, f.manager.version, { role: 'observer' })
  assert.throws(() => f.grants.list(f.manager), { status: 403 })
  assert.throws(() => f.domain.createUser(f.manager, {}), { status: 403 })
  assert.equal(currentNotificationMessage(f.store, f.observer, {} as Notification, new Date()), undefined)
  f.store.update<User>('users', f.observer.id, f.observer.version, { active: false })
  assert.throws(() => f.access.list(f.observer), { status: 403 })
})

test('project summary counts only separately authorized tasks and never includes task details', t => {
  const f = fixture(t), project = f.domain.createProject(f.manager, { name: '项目', code: 'P' }), plan = f.domain.createPlan(f.manager, { month: '2026-09', title: '目标', projectId: project.id, category: '研发', ownerId: f.member.id, collaboratorIds: [], expectedOutcome: '成果', acceptanceCriteria: '检查', dueDate: '2026-09-30', priority: 'medium' })
  f.store.update<Task>('tasks', f.task.id, f.task.version, { monthlyPlanId: plan.id })
  f.domain.createTask(f.member, { title: '秘密任务', isTemporary: true, temporaryReason: '不共享', dueDate: '2026-09-30' })
  f.grant(project.id, { objectType: 'project_summary' })
  assert.deepEqual(projectObject(f.store, f.observer, 'project_summary', project.id), { id: project.id, name: '项目', scopeLabel: '授权范围内', taskCount: 0, completedTaskCount: 0, blockedTaskCount: 0 })
  f.grant()
  assert.equal((projectObject(f.store, f.observer, 'project_summary', project.id) as { taskCount: number }).taskCount, 1)
})

test('observer HTTP fence denies legacy reads, exports, attachments and writes even for formerly owned records', async t => {
  const f = fixture(t), grant = f.grant(), app = createApp({ store: f.store }), server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, cookie = `lab_session=${createSession(f.store, f.observer)}`
  for (const path of ['/reports', '/report-agent/assets', '/data/export', '/weekly-submissions', '/plans/private/history', '/feedback/private/attachments/private', '/notifications', `/collaboration/tasks/${f.task.id}`]) {
    assert.equal((await fetch(base + path, { headers: { cookie } })).status, 404, path)
  }
  assert.equal((await fetch(`${base}/tasks/${f.task.id}`, { method: 'PATCH', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: 1, title: 'no' }) })).status, 403)
  const shell = await (await fetch(`${base}/workspace`, { headers: { cookie } })).json() as { user: User; capabilities: { business: boolean } }
  assert.equal(shell.user.id, f.observer.id); assert.equal(shell.capabilities.business, false)
  assert.equal((await fetch(`${base}/authorized-work/${grant.id}`, { headers: { cookie } })).status, 200)
  f.grants.revoke(f.manager, grant.id, { requestId: 'http-revoke-command', version: grant.version, reason: 'remove' })
  assert.equal((await fetch(`${base}/authorized-work/${grant.id}`, { headers: { cookie } })).status, 404)
})
