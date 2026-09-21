import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { WorkService } from '../server/domain-work.ts'
import { MonthlyService } from '../server/domain-plans.ts'
import { enqueueNotification, getNotification, openNotification } from '../server/notifications.ts'
import type { Notification } from '../shared/notifications.ts'
import type { MonthlyPlan, Task, User } from '../shared/types.ts'
import { externalNotificationContent, notificationEventChanges } from '../server/notification-content.ts'

function fixture(t: { after(fn: () => void): void }) {
  const store = new Store(':memory:'), work = new WorkService(store), monthly = new MonthlyService(store)
  const user = (name: string, role: User['role'] = 'member') => store.insert<User>('users', { name, email: `${name}@example.test`, role, active: true, position: '' })
  const manager = user('主管', 'manager'), member = user('成员'), other = user('其他成员')
  t.after(() => store.close())
  const task = () => work.createTask(manager, { title: '接口联调报告', description: '提交测试结果及异常清单', ownerId: member.id, dueDate: '2026-09-25', isTemporary: true, temporaryReason: '通知内容验收' })
  const rows = () => store.list<Notification>('notifications')
  return { store, work, monthly, manager, member, other, task, rows }
}

test('assignment projects actual requirements, owner and date into body and a meaningful action', t => {
  const f = fixture(t); f.task()
  const view = getNotification(f.store, f.member, f.rows()[0].id)
  assert.match(view.body, /接口联调报告/); assert.match(view.body, /提交测试结果及异常清单/)
  assert.match(view.body, /负责人：成员/); assert.match(view.body, /2026-09-25/)
  assert.equal(view.buttonText, '查看并确认安排'); assert.ok(view.confirmationToken)
})

test('weekly assignment uses this week commitment instead of long term task description', t => {
  const f = fixture(t), task = f.task()
  f.work.createWeeklyRecord(f.manager, { taskId: task.id, weekStart: '2026-09-21', commitment: '本周只完成第一组测试', submitted: true })
  const view = getNotification(f.store, f.member, f.rows().at(-1)!.id)
  assert.match(view.body, /本周只完成第一组测试/); assert.match(view.body, /2026-09-21/)
})

test('changes show true old/new dates and requirements, and raw facts never reach an unauthorized view', t => {
  const f = fixture(t), task = f.task()
  f.work.updateTask(f.manager, task.id, { version: task.version, dueDate: '2026-09-28', description: '增加异常复现步骤' })
  const row = f.rows().at(-1)!, view = getNotification(f.store, f.member, row.id)
  assert.match(view.body, /2026-09-25 → 2026-09-28/); assert.match(view.body, /提交测试结果及异常清单 → 增加异常复现步骤/)
  assert.equal(view.contentFacts, undefined)
  assert.throws(() => getNotification(f.store, f.other, row.id), { status: 404 })
})

test('manual reminder resolves source, never creates another confirmation and opens source action', t => {
  const f = fixture(t); f.task(); const original = f.rows()[0]
  const reminder = enqueueNotification(f.store, { eventKey: `manual:2026-09-20:${original.id}`, recipientId: f.member.id, kind: 'manual_reminder', title: '提醒', body: '通用提醒', targets: original.targets, actionable: false })!
  const view = getNotification(f.store, f.member, reminder.id)
  assert.match(view.body, /接口联调报告/); assert.equal(view.sourceNotificationId, original.id)
  assert.equal(view.canAcknowledge, false); assert.equal(view.sourceCanAcknowledge, true)
  assert.equal(view.buttonText, '查看并确认原安排')
  const source = getNotification(f.store, f.member, original.id)
  openNotification(f.store, f.member, original.id, true, source.confirmationToken)
  const after = getNotification(f.store, f.member, reminder.id)
  assert.equal(after.sourceCanAcknowledge, false)
  assert.equal(after.unavailable, false)
  assert.deepEqual(after.targets, [])
  assert.match(after.body, /原安排已确认/)
  assert.equal(f.store.list('notificationObligations').length, 1)
})

test('stale confirmation token rejects changed requirements and does not change task execution', t => {
  const f = fixture(t), task = f.task(), original = f.rows()[0]
  const view = getNotification(f.store, f.member, original.id)
  f.work.updateTask(f.manager, task.id, { version: task.version, description: '变更后的要求' })
  assert.throws(() => openNotification(f.store, f.member, original.id, true, view.confirmationToken), { status: 409 })
  assert.equal(f.store.list('weeklySubmissions').length, 0)
})

test('partly superseded batch separates current obligations from collaborator and updated items', t => {
  const f = fixture(t)
  const plan = (title: string, ownerId = f.member.id, collaboratorIds: string[] = []) => f.store.insert<MonthlyPlan>('plans', {
    title, ownerId, collaboratorIds, status: 'published', month: '2026-09', projectId: null, category: '研发', expectedOutcome: `${title}要求`,
    acceptanceCriteria: '可核验', dueDate: '2026-09-30', priority: 'medium', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '',
  })
  const a = plan('已替代目标'), b = plan('仍待确认目标'), c = plan('仅协作目标', f.other.id, [f.member.id])
  const targets = [a, b, c].map(row => ({ type: 'plan' as const, id: row.id, month: row.month }))
  const original = enqueueNotification(f.store, { eventKey: 'batch', recipientId: f.member.id, kind: 'monthly_published', title: '月目标', body: '旧摘要', targets, actionable: true })!
  enqueueNotification(f.store, { eventKey: 'replacement-a', recipientId: f.member.id, kind: 'plan_changed', title: '更新', body: '新要求', targets: [targets[0]], actionable: true })
  const view = getNotification(f.store, f.member, original.id)
  const states = Object.fromEntries(view.content!.items.map(item => [item.target.id, item.acknowledgement]))
  assert.deepEqual(states, { [a.id]: 'superseded', [b.id]: 'pending', [c.id]: 'not_required' })
  assert.match(view.body, /仍需本人确认 1 项/)
  const reminder = enqueueNotification(f.store, { eventKey: `manual:2026-09-20:${original.id}`, sourceNotificationId: original.id, recipientId: f.member.id,
    kind: 'manual_reminder', title: '提醒', body: '提醒', targets, actionable: false })!
  const reminded = getNotification(f.store, f.member, reminder.id)
  assert.deepEqual(reminded.targets.map(item => item.id), [b.id])
  assert.doesNotMatch(reminded.body, /已替代目标|仅协作目标/)
  openNotification(f.store, f.member, original.id, true, view.confirmationToken)
  assert.equal(getNotification(f.store, f.member, f.store.list<Notification>('notifications').find(row => row.eventKey === 'replacement-a')!.id).canAcknowledge, true)
})

test('partial permission loss strips hidden titles, changes, raw facts and counts from every projected field', t => {
  const f = fixture(t), first = f.task(), second = f.work.createTask(f.manager, { title: '仍可见事项', description: '可见要求', dueDate: '2026-09-25', ownerId: f.member.id, isTemporary: true, temporaryReason: '测试' })
  const original = enqueueNotification(f.store, { eventKey: 'permission-batch', recipientId: f.member.id, kind: 'work_assigned', title: '一组安排', body: '接口联调报告隐私正文',
    targets: [first, second].map(task => ({ type: 'task', id: task.id })), actionable: true })!
  f.store.update<Task>('tasks', first.id, first.version, { ownerId: f.other.id })
  const view = getNotification(f.store, f.member, original.id), serialized = JSON.stringify(view)
  assert.doesNotMatch(serialized, /接口联调报告|异常清单|隐私正文/)
  assert.equal(view.content?.totalCount, 1); assert.match(view.body, /仍可见事项/)
})

test('forged cross-recipient reminder source cannot disclose the other person arrangement', t => {
  const f = fixture(t); f.task(); const original = f.rows()[0]
  const forged = enqueueNotification(f.store, { eventKey: `manual:2026-09-20:${original.id}`, sourceNotificationId: original.id, recipientId: f.other.id,
    kind: 'manual_reminder', title: '提醒', body: '接口联调报告不应泄露', targets: original.targets, actionable: false })!
  const view = getNotification(f.store, f.other, forged.id)
  assert.equal(view.sourceNotificationId, undefined); assert.equal(view.sourceCanAcknowledge, false)
  assert.equal(view.unavailable, true)
  assert.doesNotMatch(JSON.stringify(view), /接口联调报告|异常清单/)
})

test('legacy messages show safely projected current details without replaying or inventing old differences', t => {
  const f = fixture(t), task = f.task()
  const old = f.store.insert<Notification>('notifications', { eventKey: 'legacy', recipientId: f.member.id, kind: 'work_changed', title: '旧消息', body: '旧正文',
    targets: [{ type: 'task', id: task.id }], actionable: false, openedAt: null, acknowledgedAt: null, supersededAt: null })
  const before = f.store.list('notificationDeliveries').length, view = getNotification(f.store, f.member, old.id)
  assert.match(view.body, /当前可访问/); assert.match(view.body, /接口联调报告/); assert.doesNotMatch(view.body, /→/)
  assert.equal(f.store.list('notificationDeliveries').length, before)
})

test('member requirement edit without new manager notification still invalidates the confirmation token', t => {
  const f = fixture(t), task = f.task(), original = f.rows()[0], view = getNotification(f.store, f.member, original.id)
  f.work.updateTask(f.member, task.id, { version: task.version, description: '本人补充新要求' })
  assert.equal(f.rows().length, 1)
  assert.throws(() => openNotification(f.store, f.member, original.id, true, view.confirmationToken), { status: 409 })
  assert.equal(getNotification(f.store, f.member, original.id).contentUpdated, true)
})

test('content projection removes links and preserves Unicode, with explicit minimal external policy', t => {
  const f = fixture(t), task = f.task()
  f.work.updateTask(f.manager, task.id, { version: task.version, description: '要求 https://secret.test/evidence?token=private <script>ignore</script> @全员 🧪' })
  const view = getNotification(f.store, f.member, f.rows().at(-1)!.id)
  assert.doesNotMatch(view.body, /https:\/\/secret|token=private|<script>|@全员/)
  assert.match(view.body, /🧪/)
  const previous = process.env.DINGTALK_NOTIFICATION_CONTENT_MODE
  process.env.DINGTALK_NOTIFICATION_CONTENT_MODE = 'minimal'
  t.after(() => { if (previous === undefined) delete process.env.DINGTALK_NOTIFICATION_CONTENT_MODE; else process.env.DINGTALK_NOTIFICATION_CONTENT_MODE = previous })
  const external = externalNotificationContent(view)
  assert.doesNotMatch(JSON.stringify(external), /接口联调报告|private|🧪/)
  assert.equal(external.card, undefined)
})

test('merged and inherited goals enforce the existing field visibility for current facts and historical changes', t => {
  const f = fixture(t)
  const merged = f.store.insert<MonthlyPlan>('plans', { month: '2026-09', title: '合并目标', projectId: null, category: '研发', ownerId: f.member.id,
    collaboratorIds: [f.other.id], expectedOutcome: '秘密甲：其他成员个人内容', acceptanceCriteria: '秘密乙：个人验收', dueDate: '2026-09-30', priority: 'high', status: 'published',
    reviewComment: '秘密丙：管理备注', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', mergedFromIds: ['private-source'] })
  const inherited = f.store.insert<MonthlyPlan>('plans', { ...merged, id: undefined, title: '承接目标', mergedFromIds: undefined, sourcePlanId: merged.id })
  for (const plan of [merged, inherited]) {
    const target = { type: 'plan' as const, id: plan.id, month: plan.month }
    const row = enqueueNotification(f.store, { eventKey: `privacy-${plan.id}`, recipientId: f.member.id, kind: 'plan_changed', title: '目标更新', body: '秘密甲', targets: [target], actionable: true,
      contentFacts: { subjects: [], reason: '秘密丁：其他成员个人说明', changes: [{ target, field: 'expectedOutcome', label: '成果要求', before: '秘密戊', after: '秘密己' }] } })!
    const view = getNotification(f.store, f.member, row.id)
    assert.match(view.body, /团队合并目标/)
    assert.doesNotMatch(JSON.stringify(view), /秘密[甲乙丙丁戊己]/)
    const changes = notificationEventChanges(f.store, { id: 'event', version: 1, createdAt: plan.createdAt, updatedAt: plan.updatedAt,
      actorId: f.manager.id, entityType: 'plan', entityId: plan.id, action: 'published_change', reason: '秘密丁', before: plan, after: { ...plan, expectedOutcome: '秘密庚' } }, target, f.member.id)
    assert.deepEqual(changes, [])
  }
})

test('only the returned temporary goal owner receives permitted review comments', t => {
  const f = fixture(t)
  const plan = f.monthly.create(f.member, { month: '2026-09', title: '临时提报', category: '研发', expectedOutcome: '实验报告', acceptanceCriteria: '待细化的要求', dueDate: '2026-09-30', isTemporary: true, temporaryReason: '临时需要' })
  const submitted = f.monthly.submit(f.member, plan.id, { version: plan.version })
  f.monthly.review(f.manager, plan.id, { version: submitted.version, decision: 'return', comment: '请补充验收标准' })
  const row = f.rows().find(item => item.kind === 'proposal_result')!
  assert.match(getNotification(f.store, f.member, row.id).body, /请补充验收标准/)
})

test('matching a merged goal placeholder never grants access to historical private changes', t => {
  const f = fixture(t)
  const plan = f.store.insert<MonthlyPlan>('plans', { month: '2026-09', title: '合并目标', projectId: null, category: '研发', ownerId: f.member.id,
    collaboratorIds: [], expectedOutcome: '团队合并目标，请按整体成果要求执行', acceptanceCriteria: '由管理者确认整体成果验收要求', dueDate: '2026-09-30', priority: 'high', status: 'published',
    reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', mergedFromIds: ['private-source'] })
  const target = { type: 'plan' as const, id: plan.id }
  const row = enqueueNotification(f.store, { eventKey: 'equal-placeholder', recipientId: f.member.id, kind: 'plan_changed', title: '目标更新', body: '', targets: [target], actionable: true,
    contentFacts: { subjects: [], changes: [{ target, field: 'expectedOutcome', label: '成果要求', before: '秘密：合并前个人内容', after: plan.expectedOutcome, memberVisibleBefore: true, memberVisibleAfter: true }] } })!
  const view = getNotification(f.store, f.member, row.id)
  assert.match(view.body, /团队合并目标/)
  assert.doesNotMatch(JSON.stringify(view), /秘密|合并前个人内容|→/)
})

test('a former manager sees only historical values visible through their member ownership', t => {
  const f = fixture(t), task = f.task(), target = { type: 'task' as const, id: task.id }
  const after = { ...task, ownerId: f.manager.id, description: '本人接手后的要求' }
  const changes = notificationEventChanges(f.store, { id: 'transfer', version: 1, createdAt: task.createdAt, updatedAt: task.updatedAt,
    actorId: f.manager.id, entityType: 'task', entityId: task.id, action: 'update', reason: '', before: { ...task, description: '秘密：原成员个人要求' }, after }, target, f.manager.id)
  f.store.update<Task>('tasks', task.id, task.version, after)
  const row = enqueueNotification(f.store, { eventKey: 'manager-transfer', recipientId: f.manager.id, kind: 'work_changed', title: '安排更新', body: '', targets: [target], actionable: true,
    contentFacts: { subjects: [], changes } })!
  assert.match(getNotification(f.store, f.manager, row.id).body, /秘密：原成员个人要求/)
  const member = f.store.update<User>('users', f.manager.id, f.manager.version, { role: 'member' })
  const view = getNotification(f.store, member, row.id)
  assert.match(view.body, /工作要求：已更新为 本人接手后的要求/)
  assert.doesNotMatch(JSON.stringify(view), /秘密|原成员个人要求/)
})

test('a high priority near deadline goal is visible before lower priority bulk entries', t => {
  const f = fixture(t)
  const targets = Array.from({ length: 4 }, (_, index) => {
    const plan = f.store.insert<MonthlyPlan>('plans', { month: '2026-09', title: index === 3 ? '优先处理目标' : `普通目标${index}`, projectId: null, category: '研发', ownerId: f.member.id,
      collaboratorIds: [], expectedOutcome: '交付报告', acceptanceCriteria: '', dueDate: index === 3 ? '2026-09-21' : '2026-09-30', priority: index === 3 ? 'high' : 'low', status: 'published',
      reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '' })
    return { type: 'plan' as const, id: plan.id }
  })
  const row = enqueueNotification(f.store, { eventKey: 'sorted', recipientId: f.member.id, kind: 'monthly_published', title: '月目标', body: '发布', targets, actionable: true })!
  assert.equal(getNotification(f.store, f.member, row.id).content?.items[0].title, '优先处理目标')
})
