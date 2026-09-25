import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import type { DingTalkClient } from '../server/dingtalk.ts'
import { Store } from '../server/store.ts'
import { addWeekDays, fridayDeadline, shanghaiWeek } from '../server/weekly-submission-clock.ts'
import type { AuditEvent } from '../shared/types.ts'
import type { WeeklyCycle, WeeklyDeadlineRepairPreview, WeeklyDuty, WeeklyRule, WeeklySubmissionView } from '../shared/weekly-submissions.ts'

const POLICY = '/weekly-submissions/deadline-policy'
const PREVIEW = '/weekly-submissions/deadline-repair/preview'
const REPAIR = '/weekly-submissions/deadline-repair'
interface ApiError { error: string; code?: string; requestId: string }

async function fixture(t: TestContext, withCycle = true) {
  // Anchor to the real current Shanghai week, then freeze only Date on Monday
  // morning. Network timers remain live and repairs stay open on every test day.
  const week = shanghaiWeek(new Date()), now = new Date(`${week}T01:00:00.000Z`)
  t.mock.timers.enable({ apis: ['Date'], now })
  const store = new Store(':memory:')
  const metadata = { version: 1, createdAt: new Date(`${addWeekDays(week, -7)}T00:00:00.000Z`).toISOString(), updatedAt: new Date(`${addWeekDays(week, -7)}T00:00:00.000Z`).toISOString() }
  const user = (id: string, role: StoredUser['role']) => store.restoreEntity<StoredUser>('users', {
    ...metadata, id, name: id, email: `${id}@example.test`, role, active: true, position: '', credentialVersion: 1, passwordHash: 'unused',
  })
  const manager = user('calendar-manager', 'manager'), member = user('calendar-member', 'member'), observer = user('calendar-observer', 'observer')
  const rule = store.restoreEntity<WeeklyRule>('weeklyRules', {
    ...metadata, id: 'weekly-submission-rule', enabled: true, effectiveWeek: week, timezone: 'Asia/Shanghai',
    windows: [{ fromWeek: week, toWeek: null }], planReviewEffectiveWeek: week,
  })
  if (withCycle) {
    store.restoreEntity<WeeklyCycle>('weeklyCycles', {
      ...metadata, id: week, week, deadlineAt: fridayDeadline(week), rosterIds: [member.id], needsReview: false,
      confirmedBy: manager.id, confirmationReason: '隔离接口测试名单', frozenAt: now.toISOString(),
    })
    for (const kind of ['results', 'plan'] as const) store.restoreEntity<WeeklyDuty>('weeklyDuties', {
      ...metadata, id: `calendar-${kind}`, ownerId: member.id, cycleWeek: week, kind,
      contentWeek: kind === 'results' ? week : addWeekDays(week, 7), deadlineAt: fridayDeadline(week),
    })
  }
  let externalCalls = 0
  const failExternal = async (): Promise<never> => { externalCalls++; throw new Error('External I/O is forbidden in calendar HTTP tests') }
  const provider: DingTalkClient = { configured: false, corpId: '', clientId: '', getIdentity: failExternal, send: failExternal, result: failExternal }
  const server = createApp({ store, enableScheduler: false, dingtalkClient: provider }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    store.close()
    assert.equal(externalCalls, 0)
  })
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`
  const client = (actor?: StoredUser) => {
    const cookie = actor ? `lab_session=${createSession(store, actor)}` : ''
    return async function request<T>(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST', expected = 200): Promise<T> {
      const response = await fetch(base + path, {
        method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const result = await response.text()
      assert.equal(response.status, expected, `${actor?.id ?? 'anonymous'} ${method} ${path}: ${result}`)
      return JSON.parse(result) as T
    }
  }
  const admin = client(manager), owner = client(member), viewer = client(observer), anonymous = client()
  const nextWeek = addWeekDays(week, 7)
  const overrides = { [addWeekDays(week, 3)]: false, [addWeekDays(week, 4)]: false, [addWeekDays(nextWeek, 3)]: false, [addWeekDays(nextWeek, 4)]: false }
  const calendarVersion = () => store.get<{ version: number }>('collaborationSettings', 'collaboration')?.version ?? 0
  const configure = () => admin<WeeklyRule>(POLICY, {
    version: store.get<WeeklyRule>('weeklyRules', rule.id)!.version, mode: 'last_workday', calendarVersion: calendarVersion(), calendarOverrides: overrides,
  }, 'PUT')
  const snapshot = () => JSON.stringify(['weeklyRules', 'weeklyCycles', 'weeklyDuties', 'weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments', 'weeklyPlanReviews',
    'collaborationSettings', 'weeklyDeadlineRepairReceipts', 'events', 'notifications', 'notificationDeliveries'].map(collection => [collection, store.list(collection)]))
  return { store, week, nextWeek, manager, member, observer, rule, admin, owner, viewer, anonymous, configure, calendarVersion, overrides, snapshot }
}

test('HTTP calendar commands require login, manager privileges and the observer route guard', async t => {
  const f = await fixture(t)
  const commands = [
    { path: POLICY, method: 'PUT', body: { version: f.rule.version, mode: 'last_workday', calendarVersion: 0, calendarOverrides: f.overrides } },
    { path: PREVIEW, method: 'POST', body: { week: f.week } },
    { path: REPAIR, method: 'POST', body: { week: f.week, token: 'not-a-preview', reason: '未授权修改' } },
  ]
  const before = f.snapshot(), revision = f.store.workspaceRevision()
  for (const command of commands) {
    await f.anonymous<ApiError>(command.path, command.body, command.method, 401)
    const memberError = await f.owner<ApiError>(command.path, command.body, command.method, 403)
    assert.match(memberError.error, /管理者/)
    const observerError = await f.viewer<ApiError>(command.path, command.body, command.method, 403)
    assert.equal(observerError.code, 'READ_ONLY_OBSERVER')
  }
  const hidden = await f.viewer<ApiError>(`/weekly-submissions?week=${f.week}`, undefined, 'GET', 404)
  assert.equal(hidden.code, 'READ_ONLY_OBSERVER')
  assert.equal(f.snapshot(), before)
  assert.equal(f.store.workspaceRevision(), revision)
})

test('HTTP policy saves both versions, applies next week and leaves persisted current and historical deadlines intact', async t => {
  const f = await fixture(t)
  const current = f.store.get<WeeklyCycle>('weeklyCycles', f.week)!
  const previousWeek = addWeekDays(f.week, -7)
  const previous = f.store.restoreEntity<WeeklyCycle>('weeklyCycles', {
    ...current, id: previousWeek, week: previousWeek, deadlineAt: fridayDeadline(previousWeek),
  })
  const oldDuties = f.store.list('weeklyDuties')
  const updated = await f.admin<WeeklyRule>(POLICY, {
    version: f.rule.version, mode: 'last_workday', calendarVersion: 0, calendarOverrides: f.overrides,
    fromWeek: f.week, // Clients cannot backdate the effective policy boundary.
  }, 'PUT')
  assert.equal(updated.version, f.rule.version + 1)
  assert.equal(f.calendarVersion(), 1)
  assert.equal(updated.deadlinePolicies?.length, 1)
  assert.equal(updated.deadlinePolicies?.[0].fromWeek, f.nextWeek)
  assert.equal(updated.deadlinePolicies?.[0].mode, 'last_workday')
  assert.deepEqual(updated.deadlinePolicies?.[0].calendarOverrides, f.overrides)
  assert.deepEqual(f.store.get('weeklyCycles', f.week), current)
  assert.deepEqual(f.store.get('weeklyCycles', previousWeek), previous)
  assert.deepEqual(f.store.list('weeklyDuties'), oldDuties)
  const active = await f.admin<WeeklySubmissionView>(`/weekly-submissions?week=${f.week}`)
  assert.equal(active.deadlineAt, fridayDeadline(f.week))
  assert.equal(active.workCalendar?.version, 1)
  assert.deepEqual(active.workCalendar?.overrides, f.overrides)
  const future = await f.admin<WeeklySubmissionView>(`/weekly-submissions?week=${f.nextWeek}`)
  assert.equal(future.deadlineAt, new Date(`${addWeekDays(f.nextWeek, 2)}T16:00:00+08:00`).toISOString())
  assert.equal(future.cycle, null)
  assert.equal(f.store.get('weeklyCycles', f.nextWeek), undefined)
  const memberView = await f.owner<WeeklySubmissionView>(`/weekly-submissions?week=${f.week}`)
  assert.equal(memberView.workCalendar, undefined)
})

test('HTTP policy rejects stale rule and calendar CAS versions atomically', async t => {
  const f = await fixture(t)
  const rule = await f.configure(), version = f.calendarVersion()
  const change = { ...f.overrides, [addWeekDays(f.nextWeek, 5)]: true }
  const before = f.snapshot()
  for (const input of [
    { version: f.rule.version, calendarVersion: version },
    { version: rule.version, calendarVersion: version - 1 },
    { version: rule.version },
    { calendarVersion: version },
  ]) {
    const rejected = await f.admin<ApiError>(POLICY, { ...input, mode: 'last_workday', calendarOverrides: change }, 'PUT', 409)
    assert.equal(rejected.code, 'VERSION_CONFLICT')
    assert.equal(f.snapshot(), before)
  }
  const next = await f.admin<WeeklyRule>(POLICY, { version: rule.version, calendarVersion: version, mode: 'last_workday', calendarOverrides: change }, 'PUT')
  assert.equal(next.version, rule.version + 1)
  assert.equal(f.calendarVersion(), version + 1)
  assert.equal(next.deadlinePolicies?.length, 1, 'another edit replaces the pending policy for the same future week')
  assert.equal(next.deadlinePolicies?.[0].version, 2)
  assert.equal(next.deadlinePolicies?.[0].fromWeek, f.nextWeek)
})

test('HTTP repair preview is read-only and a missing cycle is never created by preview', async t => {
  const f = await fixture(t, false)
  const before = f.snapshot(), revision = f.store.workspaceRevision()
  await f.admin<ApiError>(PREVIEW, { week: f.week }, 'POST', 404)
  await f.admin<ApiError>(PREVIEW, { week: f.nextWeek }, 'POST', 404)
  assert.equal(f.store.workspaceRevision(), revision)
  assert.equal(f.snapshot(), before)
  assert.equal(f.store.list('weeklyCycles').length, 0)
  assert.equal(f.store.list('weeklyDuties').length, 0)
})

test('HTTP repair requires a valid preview and nonempty reason, updates duties and audits once', async t => {
  const f = await fixture(t)
  await f.configure()
  const beforePreview = f.snapshot(), revision = f.store.workspaceRevision()
  const preview = await f.admin<WeeklyDeadlineRepairPreview>(PREVIEW, { week: f.week })
  assert.equal(f.store.workspaceRevision(), revision)
  assert.equal(f.snapshot(), beforePreview)
  assert.equal(preview.eligible, true)
  assert.equal(preview.unchanged, false)
  assert.equal(preview.previousDeadlineAt, fridayDeadline(f.week))
  assert.equal(preview.deadlineAt, new Date(`${addWeekDays(f.week, 2)}T16:00:00+08:00`).toISOString())
  assert.equal(preview.dutyCount, 2)
  assert.match(preview.token, /^\d{13}\.[a-f0-9]{64}$/)
  const before = f.snapshot()
  const invalid = [
    { body: { week: f.week, reason: '核对节假日' }, status: 400 },
    { body: { week: f.week, token: preview.token }, status: 400 },
    { body: { week: f.week, token: preview.token, reason: '   ' }, status: 400 },
    { body: { week: f.week, token: 'wrong-token', reason: '核对节假日' }, status: 409 },
    { body: { week: f.week, token: `${preview.token.slice(0, -1)}${preview.token.endsWith('0') ? '1' : '0'}`, reason: '核对节假日' }, status: 409 },
  ]
  for (const attempt of invalid) {
    await f.admin<ApiError>(REPAIR, attempt.body, 'POST', attempt.status)
    assert.equal(f.snapshot(), before, 'rejected repair must leave every business collection unchanged')
  }
  const frozenAt = f.store.get<WeeklyCycle>('weeklyCycles', f.week)!.frozenAt
  const input = { week: f.week, token: preview.token, reason: '工作日历复核确认提前至周三' }
  const repaired = await f.admin<WeeklyDeadlineRepairPreview>(REPAIR, input)
  assert.equal(repaired.unchanged, true)
  assert.equal(repaired.deadlineAt, preview.deadlineAt)
  const cycle = f.store.get<WeeklyCycle>('weeklyCycles', f.week)!
  assert.equal(cycle.deadlineAt, preview.deadlineAt)
  assert.equal(cycle.frozenAt, frozenAt)
  assert.deepEqual(cycle.deadlinePolicy, preview.deadlinePolicy)
  assert.ok(f.store.list<WeeklyDuty>('weeklyDuties').every(duty => duty.deadlineAt === preview.deadlineAt && duty.version === 2))
  const audits = f.store.list<AuditEvent>('events').filter(event => event.action === 'deadline_repair')
  assert.equal(audits.length, 3)
  assert.ok(audits.every(event => event.actorId === f.manager.id && event.reason === input.reason))
  assert.equal(f.store.list('weeklyDeadlineRepairReceipts').length, 1)
  const committed = f.snapshot()
  assert.equal((await f.admin<WeeklyDeadlineRepairPreview>(REPAIR, input)).unchanged, true)
  assert.equal(f.snapshot(), committed)
  await f.admin<ApiError>(REPAIR, { ...input, reason: '不能复用预览修改修复原因' }, 'POST', 409)
  assert.equal(f.snapshot(), committed)
})

test('HTTP calendar changes invalidate a repair token without changing the old cycle', async t => {
  const f = await fixture(t)
  const rule = await f.configure()
  const preview = await f.admin<WeeklyDeadlineRepairPreview>(PREVIEW, { week: f.week })
  await f.admin<WeeklyRule>(POLICY, {
    version: rule.version, calendarVersion: f.calendarVersion(), mode: 'last_workday',
    calendarOverrides: { ...f.overrides, [addWeekDays(f.week, 5)]: true },
  }, 'PUT')
  const before = f.snapshot()
  const error = await f.admin<ApiError>(REPAIR, { week: f.week, token: preview.token, reason: '已过期的日历预览' }, 'POST', 409)
  assert.match(error.error, /重新预览/)
  assert.equal(f.snapshot(), before)
  assert.equal(f.store.get<WeeklyCycle>('weeklyCycles', f.week)?.deadlineAt, fridayDeadline(f.week))
  assert.equal(f.store.list('weeklyDeadlineRepairReceipts').length, 0)
})
