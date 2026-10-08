import test from 'node:test'
import assert from 'node:assert/strict'
import { Children, createElement, isValidElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Store } from '../server/store.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { fridayDeadline } from '../server/weekly-submission-clock.ts'
import { PersonalWeeklySubmissions } from '../src/components/WeeklySubmissionPanel.tsx'
import type { AuditEvent, User } from '../shared/types.ts'
import type { WeeklyCycle, WeeklyDutyView, WeeklyMissing, WeeklyRule } from '../shared/weekly-submissions.ts'

function fixture(nowValue = '2026-09-24T01:00:00Z') {
  const store = new Store(':memory:')
  let now = new Date(nowValue)
  const service = new WeeklySubmissionService(store, () => now)
  const entity = { version: 1, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z' }
  const user = (id: string, patch: Partial<User> = {}) => store.restoreEntity<User>('users', { ...entity, id, name: id, email: `${id}@test.local`, role: 'member', active: true, position: '', ...patch })
  const manager = user('manager', { role: 'manager' }), member = user('member'), observer = user('observer', { role: 'observer' })
  const rule = store.restoreEntity<WeeklyRule>('weeklyRules', { ...entity, id: 'weekly-submission-rule', enabled: true, effectiveWeek: '2026-09-07', planReviewEffectiveWeek: '2026-09-07', timezone: 'Asia/Shanghai', windows: [{ fromWeek: '2026-09-07', toWeek: null }] })
  const cycle = (week = '2026-09-21', patch: Partial<WeeklyCycle> = {}) => store.restoreEntity<WeeklyCycle>('weeklyCycles', { ...entity, id: week, week, deadlineAt: fridayDeadline(week), rosterIds: [member.id], needsReview: false, confirmedBy: null, confirmationReason: '', frozenAt: `${week}T01:00:00.000Z`, ...patch })
  return { store, service, user, manager, member, observer, rule, cycle, set: (value: string) => { now = new Date(value) } }
}

test('upgrade repairs the open automatic roster once and managers submit their own two duties without proxy reasons', () => {
  const f = fixture()
  try {
    f.cycle()
    f.user('inactive-manager', { role: 'manager', active: false })
    f.user('pending-manager', { role: 'manager', registrationStatus: 'pending' })
    f.user('midweek-manager', { role: 'manager', createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z' })
    const view = f.service.view(f.manager, '2026-09-21')
    assert.equal(view.rule.managerSubmissionEffectiveWeek, '2026-09-21')
    assert.deepEqual(view.cycle?.rosterIds, ['manager', 'member'])
    assert.equal(view.cycle?.managerRosterApplied, true)
    const own = view.duties.filter(row => row.ownerId === f.manager.id)
    assert.deepEqual(own.map(row => row.kind), ['results', 'plan'])
    for (const duty of own) {
      const receipt = f.service.submit(f.manager, { dutyId: duty.id, version: duty.version, manifest: [], requestId: duty.kind, note: '本周已完成管理协调，下周暂无新增安排' })
      assert.equal(receipt.ownerId, f.manager.id)
      assert.equal(receipt.actorId, f.manager.id)
      assert.equal(receipt.reason, '')
    }
    assert.ok(f.service.view(f.manager, view.week).duties.filter(row => row.ownerId === f.manager.id).every(row => row.status === 'on_time'))
    assert.deepEqual(f.service.view(f.member, view.week).cycle?.rosterIds, [f.member.id])
    assert.throws(() => f.service.view(f.observer, view.week), { status: 403 })
    const frozen = f.store.get<WeeklyCycle>('weeklyCycles', view.week)
    f.store.update<User>('users', f.manager.id, f.manager.version, { role: 'member' })
    f.service.reconcile()
    assert.deepEqual(f.store.get('weeklyCycles', view.week), frozen, 'later account changes never rebuild a repaired frozen roster')
  } finally { f.store.close() }
})

test('upgrading after cutoff never invents manager misses in materialized or unmaterialized history', () => {
  const f = fixture('2026-09-25T09:00:00Z')
  try {
    const old = f.cycle()
    assert.equal(f.service.getRule().managerSubmissionEffectiveWeek, '2026-09-28')
    f.service.reconcile()
    assert.deepEqual(f.store.get('weeklyCycles', old.id), old)
    assert.ok(f.store.list<WeeklyMissing>('weeklyMissing').every(row => row.ownerId === f.member.id))
    f.set('2026-10-02T09:00:00Z')
    const restarted = new WeeklySubmissionService(f.store, () => new Date('2026-10-02T09:00:00Z'))
    const next = restarted.view(f.manager, '2026-09-28')
    assert.equal(next.rule.managerSubmissionEffectiveWeek, '2026-09-28')
    assert.equal(next.duties.filter(row => row.ownerId === f.manager.id && row.missingAtDeadline).length, 2, 'future stopped-server catchup preserves manager responsibilities')
  } finally { f.store.close() }
})

test('manual roster decisions remain frozen and observers cannot be added during historical confirmation', () => {
  const f = fixture()
  try {
    const manual = f.cycle('2026-09-21', { confirmedBy: f.manager.id, confirmationReason: '按实际在岗情况确认' })
    const pending = f.cycle('2026-09-14', { needsReview: true })
    assert.equal(f.service.view(f.manager, manual.week).duties.filter(row => row.ownerId === f.manager.id).length, 0)
    assert.deepEqual(f.store.get('weeklyCycles', manual.id), manual)
    assert.throws(() => f.service.confirmRoster(f.manager, { week: pending.week, version: pending.version, rosterIds: [f.observer.id], reason: '核对名单' }), { status: 400 })
    const confirmed = f.service.confirmRoster(f.manager, { week: pending.week, version: pending.version, rosterIds: [f.manager.id, f.member.id], reason: '历史在岗管理员同样需要提报' })
    assert.deepEqual(confirmed.rosterIds, [f.manager.id, f.member.id])
  } finally { f.store.close() }
})

test('the repair uses roles at the start of the week and waits for confirmation if account history is ambiguous', () => {
  const f = fixture()
  try {
    f.cycle()
    const promoted = f.user('promoted', { role: 'manager', updatedAt: '2026-09-22T00:00:00Z' })
    f.store.restoreEntity<AuditEvent>('events', { id: 'promote', version: 1, createdAt: '2026-09-22T00:00:00Z', updatedAt: '2026-09-22T00:00:00Z', entityType: 'user', entityId: promoted.id, actorId: f.manager.id, action: 'update', before: { ...promoted, role: 'observer' }, after: promoted, reason: '任职调整' })
    const view = f.service.view(f.manager, '2026-09-21')
    assert.ok(!view.cycle?.rosterIds.includes(promoted.id))
    f.set('2026-09-28T01:00:00Z')
    assert.ok(f.service.view(f.manager, '2026-09-28').cycle?.rosterIds.includes(promoted.id))
  } finally { f.store.close() }
  const unknown = fixture()
  try {
    unknown.cycle()
    unknown.store.update<User>('users', unknown.manager.id, unknown.manager.version, { name: '无可追溯历史的修改' })
    const view = unknown.service.view(unknown.manager, '2026-09-21')
    assert.equal(view.cycle?.needsReview, true)
    assert.equal(view.duties.length, 0)
    assert.equal(unknown.store.list<WeeklyMissing>('weeklyMissing').filter(row => row.cycleWeek === view.week).length, 0)
  } finally { unknown.store.close() }
})

test('confirming an ambiguous current roster never adds the manager back on later reads', () => {
  const f = fixture()
  try {
    const pending = f.cycle('2026-09-21', { needsReview: true })
    const confirmed = f.service.confirmRoster(f.manager, { week: pending.week, version: pending.version, rosterIds: [f.member.id], reason: '核实本周无需管理员补报' })
    for (let i = 0; i < 3; i++) {
      const view = f.service.view(f.manager, pending.week)
      assert.deepEqual(view.cycle, confirmed)
      assert.ok(view.duties.every(duty => duty.ownerId === f.member.id))
    }
  } finally { f.store.close() }
})

test('upgrading during a frozen full holiday week preserves its lack of duties and starts managers next week', () => {
  const f = fixture()
  try {
    const rest = f.cycle('2026-09-21', { deadlineAt: null, deadlinePolicy: { policyVersion: 0, mode: 'last_workday', workingDays: [] } })
    const view = f.service.view(f.manager, rest.week)
    assert.equal(view.rule.managerSubmissionEffectiveWeek, '2026-09-28')
    assert.deepEqual(view.cycle, rest)
    assert.deepEqual(view.duties, [])
    assert.ok(!f.store.list<WeeklyMissing>('weeklyMissing').some(row => row.cycleWeek === rest.week))
    f.set('2026-09-28T01:00:00Z')
    assert.equal(f.service.view(f.manager, '2026-09-28').duties.filter(row => row.ownerId === f.manager.id).length, 2)
  } finally { f.store.close() }
})

test('personal manager cards expose both submit actions and keep other people out of the personal section', () => {
  const f = fixture()
  try {
    const duties = f.service.view(f.manager, '2026-09-21').duties
    const opened: [string, string][] = [], selected: string[] = []
    const props = { actorId: f.manager.id, duties, onSelectWork: (duty: WeeklyDutyView) => selected.push(duty.ownerId), onOpen: (duty: WeeklyDutyView, mode: 'submit' | 'detail') => opened.push([duty.ownerId, mode]) }
    const element = PersonalWeeklySubmissions(props)!
    const html = renderToStaticMarkup(element)
    for (const label of ['我的周提报', '填写本周进展', '填写下周计划', '本周完成情况']) assert.match(html, new RegExp(label))
    assert.equal((html.match(/核对并正式提交/g) ?? []).length, 2)
    function clickButtons(node: unknown) {
      if (!isValidElement<{ children?: unknown; onClick?: () => void }>(node)) return
      if (node.type === 'button') node.props.onClick?.()
      Children.forEach(node.props.children as never, clickButtons)
    }
    clickButtons(element)
    assert.deepEqual(selected, [f.manager.id, f.manager.id])
    assert.deepEqual(opened, [[f.manager.id, 'submit'], [f.manager.id, 'detail'], [f.manager.id, 'submit'], [f.manager.id, 'detail']])
    assert.equal(renderToStaticMarkup(createElement(PersonalWeeklySubmissions, { ...props, actorId: f.observer.id })), '')
  } finally { f.store.close() }
})
