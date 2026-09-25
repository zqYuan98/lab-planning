import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import type { Task, User, WeeklyRecord } from '../shared/types.ts'
import type { BlockerEpisode, CollaborationSettings, FollowupRequest, TaskTracking } from '../shared/collaboration.ts'
import { collaborationDashboard } from '../server/collaboration-query.ts'
import { evaluateWorkRisks, risksForActor } from '../server/collaboration-rules.ts'
import { enrollTaskTracking } from '../server/collaboration-tracking.ts'
import { summarizeCollaborationTask } from '../shared/collaboration-task-summary.ts'

const now = new Date('2026-09-24T09:00:00.000Z'), baseline = new Date('2026-09-01T00:00:00.000Z')
function fixture(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id, name: id, email: `${id}@test.invalid`, position: '', active: true, role })
  const manager = user('manager', 'manager'), member = user('member', 'member'), peer = user('peer', 'member'), observer = user('observer', 'observer')
  store.insert<CollaborationSettings>('collaborationSettings', { id: 'collaboration', enabled: true, enabledAt: baseline.toISOString(), autoRulesEnabled: false, deadlineApprovalEnabled: false, dailyManagerEnabled: false, weeklyManagerEnabled: false, memberActionsEnabled: true, pilotUserIds: [member.id, peer.id], defaultManagerIds: [manager.id], calendarOverrides: { '2026-09-22': false }, staleWorkdays: 3, blockerWorkdays: 2 })
  const task = (id: string, patch: Partial<Task> = {}) => store.insert<Task>('tasks', { id, title: id, ownerId: member.id, description: '', monthlyPlanId: null, dueDate: '2026-09-23', status: 'doing', isTemporary: false, temporaryReason: '', ...patch })
  const tracking = (task: Task) => enrollTaskTracking(store, task, manager, baseline, 'manual')
  const weekly = (task: Task, patch: Partial<WeeklyRecord> = {}) => store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, ownerId: task.ownerId, monthlyPlanId: null, weekStart: '2026-09-21', commitment: '', actualOutcome: '', evidenceUrl: '', blocker: '', nextAction: '', status: 'planned', submitted: true, ...patch })
  return { store, manager, member, peer, observer, task, tracking, weekly }
}
test('collaboration pages retain whole-scope counters and current-page references across periods', t => {
  const f = fixture(t)
  for (let i = 0; i < 77; i++) { const task = f.task(`task-${i}`, { status: i % 4 === 0 ? 'done' : 'doing' }); if (i % 4) f.tracking(task) }
  f.task('peer-only', { ownerId: f.peer.id }); f.task('cancelled', { cancellation: { cancelledBy: f.manager.id, cancelledAt: now.toISOString(), reason: '' } })
  for (const actor of [f.manager, f.member]) {
    const expected = f.store.list<Task>('tasks').filter(row => !row.cancellation && (actor.role === 'manager' || row.ownerId === actor.id))
    let cursor: string | null = null; const ids: string[] = []
    do { const page = collaborationDashboard(f.store, actor, { limit: '7', ...(cursor ? { cursor } : {}) }, now); assert.equal(page.counts.all, expected.length); assert.equal(page.counts.unfinished, expected.filter(row => row.status !== 'done').length); assert.equal(page.counts.risks, risksForActor(f.store, actor, now).length); assert.ok(page.tasks.every(row => row.owner?.id === row.task.ownerId)); assert.ok(page.risks.every(risk => page.tasks.some(row => row.task.id === risk.taskId))); ids.push(...page.tasks.map(row => row.task.id)); cursor = page.nextCursor } while (cursor)
    assert.deepEqual(ids, expected.map(row => row.id))
    const search = collaborationDashboard(f.store, actor, { q: 'task-76', limit: '1' }, now)
    assert.equal(search.total, 1); assert.equal(search.counts.all, expected.length)
    assert.equal(collaborationDashboard(f.store, actor, { filter: 'done' }, now).total, expected.filter(row => row.status === 'done').length)
  }
})
test('actor-scoped risk projection matches existing calendar, paused, closed and blocker rules', t => {
  const f = fixture(t), blocked = f.task('blocked', { status: 'blocked' }), paused = f.task('paused'), closed = f.task('closed'), resolved = f.task('resolved', { status: 'blocked' }), peer = f.task('peer', { ownerId: f.peer.id })
  f.tracking(blocked); const pausedTracking = f.tracking(paused), closedTracking = f.tracking(closed); f.tracking(resolved); f.tracking(peer)
  f.store.update<TaskTracking>('taskTrackings', paused.id, pausedTracking.version, { state: 'paused', reviewAt: '2026-09-23T00:00:00Z', pauseReason: '等待确认' })
  f.store.update<TaskTracking>('taskTrackings', closed.id, closedTracking.version, { state: 'closed' })
  const episode = (task: Task, patch: Partial<BlockerEpisode> = {}) => f.store.insert<BlockerEpisode>('blockerEpisodes', { sourceType: 'task', sourceId: task.id, parentTaskId: task.id, ownerId: task.ownerId, generation: 1, openedAt: baseline.toISOString(), openedBy: f.member.id, resolvedAt: null, resolvedBy: null, reason: '受阻', impact: '', supportNeeded: '需要支持', reviewAt: null, closureReason: '', ...patch })
  episode(blocked); episode(resolved, { resolvedAt: now.toISOString() }); episode(blocked, { managementClosedAt: now.toISOString() })
  f.store.insert<FollowupRequest>('followupRequests', { taskId: blocked.id, weeklyRecordId: null, ownerId: f.member.id, requestedBy: f.manager.id, managerRecipientIds: [f.manager.id], generation: 1, requirement: '请更新', dueAt: '2026-09-23T00:00:00Z', status: 'open', respondedAt: null, closedAt: null, closedBy: null, closeReason: '', lastChangedBy: f.manager.id, changeReason: '' })
  const assertEquivalent = () => { const original = evaluateWorkRisks(f.store, now); for (const actor of [f.manager, f.member]) assert.deepEqual(risksForActor(f.store, actor, now), original.filter(risk => actor.role === 'manager' || risk.ownerId === actor.id && !risk.managerOnly)) }
  assertEquivalent()
  assert.ok(risksForActor(f.store, f.manager, now).some(row => row.kind === 'pause_review')); assert.ok(!risksForActor(f.store, f.member, now).some(row => row.kind === 'pause_review'))
  f.store.update<User>('users', f.peer.id, f.peer.version, { active: false }); assertEquivalent()
  f.store.update<Task>('tasks', blocked.id, blocked.version, { status: 'done' }); assertEquivalent()
})
test('weekly summary SQL preserves submitted visibility, current drafts and latest past precedence', t => {
  const f = fixture(t), task = f.task('summary')
  f.weekly(task, { weekStart: '2026-09-14', status: 'done', actualOutcome: '上周完成' })
  f.weekly(task, { submitted: false, status: 'doing', actualOutcome: '本周草稿' })
  f.weekly(task, { weekStart: '2026-09-28', actualOutcome: '未来不展示' })
  f.weekly(task, { weekStart: '2026-09-21', submitted: true, actualOutcome: '待审批不可见', planApproval: { required: true, approvedSubmissionId: null, approvedFingerprint: null } })
  f.weekly(task, { actualOutcome: '已删除不可见', deletion: { deletedAt: now.toISOString(), deletedBy: f.member.id, reason: '' } })
  for (const actor of [f.manager, f.member]) {
    const page = collaborationDashboard(f.store, actor, {}, now), expected = summarizeCollaborationTask(task, f.store.list<WeeklyRecord>('weeklyRecords'), actor, now)
    assert.deepEqual(page.tasks[0].weeklySummary, expected.weeklySummary); assert.equal(page.tasks[0].overallStatusNeedsConfirmation, expected.overallStatusNeedsConfirmation)
  }
})
test('collaboration rejects unknown parameters, stale cursors and revoked roles without reading unrelated history', t => {
  const f = fixture(t), task = f.task('own'); f.task('tail')
  assert.throws(() => collaborationDashboard(f.store, f.manager, { text: 'unexpected' }, now), /不支持/)
  assert.throws(() => collaborationDashboard(f.store, f.observer, {}, now), /观察者/)
  const page = collaborationDashboard(f.store, f.member, { limit: '1' }, now)
  assert.throws(() => collaborationDashboard(f.store, f.peer, { limit: '1', cursor: page.nextCursor! }, now), /已更新/)
  f.store.resetReadMetrics(); collaborationDashboard(f.store, f.member, { limit: '1' }, now); const before = f.store.getReadMetrics()
  f.store.transaction(() => { for (let i = 0; i < 200; i++) f.weekly(task, { weekStart: '2020-01-06', actualOutcome: '正文'.repeat(1000) }) })
  f.store.resetReadMetrics(); collaborationDashboard(f.store, f.member, { limit: '1' }, now); const after = f.store.getReadMetrics()
  assert.ok(after.parsedRows <= before.parsedRows + 1); assert.ok(after.parsedBytes < before.parsedBytes + 10000)
  assert.throws(() => collaborationDashboard(f.store, f.member, { limit: '1', cursor: page.nextCursor! }, now), /已更新/)
  f.store.update<User>('users', f.member.id, f.member.version, { role: 'observer' })
  assert.throws(() => collaborationDashboard(f.store, f.member, {}, now), /观察者/)
})
