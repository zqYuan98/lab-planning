import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import type { Task, User } from '../shared/types.ts'
import { Domain } from '../server/domain.ts'
import { Store } from '../server/store.ts'
import { CollaborationService } from '../server/collaboration-service.ts'
import { exportBusinessData, exportCsv, exportXlsx, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { parsePacket, schemas } from '../server/data-transfer-schema.ts'
import { withSilentImport } from '../server/import-notification-context.ts'

function fixture(t: TestContext) {
  const store = new Store(':memory:'), domain = new Domain(store)
  t.after(() => store.close())
  const user = (id: string, role: User['role'] = 'member') => store.insert<User>('users', { id, name: id, email: `${id}@register.test`, role, active: true, position: '' })
  const manager = user('manager', 'manager'), member = user('member'), peer = user('peer')
  const capture = (extra: Record<string, unknown> = {}, actor = member) => domain.captureTasks(actor, { requestId: 'capture-register-001', titles: ['确认试点范围', '准备演示材料'], ...extra })
  return { store, domain, manager, member, peer, capture }
}

test('capture creates own independent temporary tasks with honest source, unknown dates and no assignment notifications', t => {
  const f = fixture(t), { tasks } = f.capture({ assignedBy: '张主任', assignedOn: '', requestedOutcome: '一页建议' })
  assert.equal(tasks.length, 2)
  assert.equal(new Set(tasks.map(task => task.id)).size, 2)
  for (const task of tasks) {
    assert.equal(task.ownerId, f.member.id)
    assert.equal(task.monthlyPlanId, null)
    assert.equal(task.isTemporary, true)
    assert.equal(task.temporaryReason, '领导交办：张主任')
    assert.equal(task.workSource, 'leader')
    assert.equal(task.assignedOn, '')
    assert.equal(task.dueDate, '')
    assert.equal(task.requestedOutcome, '一页建议')
    assert.deepEqual(task.workOrigin, { kind: 'self', actorId: f.member.id, reason: '' })
  }
  assert.equal(f.store.list('weeklyRecords').length, 0)
  assert.equal(f.store.list('weeklySubmissions').length, 0)
  assert.equal(f.store.list('notifications').length, 0)
  assert.equal(f.store.list('workRegisterCaptures').length, 1)
  const managerTasks = f.capture({}, f.manager).tasks
  assert.ok(managerTasks.every(task => task.ownerId === f.manager.id))
  assert.ok(managerTasks.every(task => !tasks.some(existing => existing.id === task.id)))
})

test('capture validates every item and metadata before any writes', t => {
  const f = fixture(t)
  const invalid = [
    { titles: [] }, { titles: Array(51).fill('事项') }, { titles: ['有效', ' '.repeat(2)] }, { titles: ['有效', '长'.repeat(301)] }, { titles: ['有效', 1] },
    { requestId: 'short' }, { workSource: 'assigned' }, { assignedBy: '人'.repeat(101) }, { assignedOn: '2026-02-30' }, { dueDate: '2026-13-01' },
    { requestedOutcome: '文'.repeat(12001) }, { monthlyPlanId: 'forged' },
  ]
  for (const extra of invalid) {
    assert.throws(() => f.capture(extra), { status: 400 })
    assert.equal(f.store.list('tasks').length, 0)
    assert.equal(f.store.list('events').length, 0)
    assert.equal(f.store.list('workRegisterCaptures').length, 0)
  }
})

test('capture rolls back every task and audit if receipt persistence fails, then can retry safely', t => {
  const f = fixture(t), insert = f.store.insert.bind(f.store)
  f.store.insert = ((collection: string, input: never) => {
    if (collection === 'workRegisterCaptures') throw new Error('simulated receipt write failure')
    return insert(collection, input)
  }) as typeof f.store.insert
  assert.throws(() => f.capture(), /receipt write failure/)
  assert.equal(f.store.list('tasks').length, 0)
  assert.equal(f.store.list('events').length, 0)
  assert.equal(f.store.list('workRegisterCaptures').length, 0)
  f.store.insert = insert
  assert.equal(f.capture().tasks.length, 2)
})

test('capture replays stable IDs after edits and rejects payload changes without duplicating tasks', t => {
  const f = fixture(t), first = f.capture({ workSource: 'coordination', dueDate: '2026-10-01' }).tasks
  const edited = f.domain.updateTask(f.member, first[0].id, { reason: '测试场景确认承诺调整', version: first[0].version, title: '已澄清的试点范围', currentProgress: '已交流' })
  const replay = new Domain(f.store).captureTasks(f.member, { titles: ['确认试点范围', '准备演示材料'], requestId: 'capture-register-001', dueDate: '2026-10-01', workSource: 'coordination' }).tasks
  assert.deepEqual(replay.map(task => task.id), first.map(task => task.id))
  assert.deepEqual(replay[0], edited)
  for (const extra of [{ titles: ['新事项'] }, { workSource: 'self' }, { dueDate: '2026-10-02' }, { assignedBy: '另一人' }, { requestedOutcome: '新增交付' }]) {
    assert.throws(() => f.capture({ workSource: 'coordination', dueDate: '2026-10-01', ...extra }), { status: 409 })
  }
  assert.equal(f.store.list('tasks').length, 2)
  assert.equal(f.store.list('workRegisterCaptures').length, 1)
})

test('capture rejects owner and origin spoofing including on replay for managers and members', t => {
  const f = fixture(t)
  for (const actor of [f.member, f.manager]) {
    f.capture({}, actor)
    assert.throws(() => f.capture({ ownerId: f.peer.id }, actor), { status: 403 })
    assert.throws(() => f.capture({ creationKind: 'assigned' }, actor), { status: 400 })
    assert.throws(() => f.capture({ creationKind: 'proxy' }, actor), { status: 400 })
    assert.throws(() => f.capture({ workOrigin: { kind: 'assigned', actorId: f.manager.id } }, actor), { status: 400 })
    assert.equal(f.capture({ ownerId: actor.id, creationKind: 'self' }, actor).tasks.length, 2)
  }
  assert.equal(f.store.list('tasks').length, 4)
  f.store.update<User>('users', f.member.id, f.member.version, { active: false })
  assert.throws(() => f.capture(), { status: 403, code: 'ACCESS_REVOKED' })
})

test('task metadata edits retain omitted fields, enforce versions and permissions, and support explicit unknown dates', t => {
  const f = fixture(t), task = f.capture().tasks[0]
  const metadata = { workSource: 'leader', assignedBy: '部门负责人', assignedOn: '2026-09-20', requestedOutcome: '演示与说明', priority: 'high', estimatedEffort: '约两天', currentProgress: '已完成初稿', decisionNeeded: '确认试点范围', waitingForFeedback: true } as const
  let edited = f.domain.updateTask(f.member, task.id, { reason: '测试场景确认承诺调整', version: task.version, ...metadata, dueDate: '2026-10-10', nextAction: '安排评审' })
  for (const [key, value] of Object.entries(metadata)) assert.equal(edited[key as keyof Task], value)
  assert.throws(() => f.domain.updateTask(f.peer, task.id, { version: edited.version, currentProgress: '他人写入' }), { status: 403 })
  assert.throws(() => f.domain.updateTask(f.member, task.id, { version: task.version, currentProgress: '旧编辑' }), { status: 409 })
  for (const extra of [{ priority: 'urgent' }, { waitingForFeedback: 'true' }, { assignedOn: '2026-09-31' }, { currentProgress: '长'.repeat(12001) }]) {
    assert.throws(() => f.domain.updateTask(f.member, task.id, { version: edited.version, ...extra }), { status: 400 })
  }
  edited = f.domain.updateTask(f.member, task.id, { reason: '测试场景确认承诺调整', version: edited.version, dueDate: '', assignedOn: '' })
  assert.equal(edited.dueDate, '')
  assert.equal(edited.assignedOn, '')
  assert.equal(edited.currentProgress, metadata.currentProgress)
  assert.equal(edited.nextAction, '安排评审')
  assert.deepEqual(edited.workOrigin, task.workOrigin)
  const base = { title: '普通任务', isTemporary: true, temporaryReason: '临时需求' }
  assert.throws(() => f.domain.createTask(f.member, base), { status: 400 })
  assert.equal(f.domain.createTask(f.member, { ...base, dueDate: '' }).dueDate, '')
})

test('completion requires explanation and clears feedback, while a completed week keeps the task active', t => {
  const f = fixture(t)
  let task = f.capture().tasks[0]
  const week = f.domain.createWeeklyRecord(f.member, { taskId: task.id, weekStart: '2026-09-14', commitment: '本周准备材料', actualOutcome: '整理好数据', status: 'done' })
  assert.equal(week.status, 'done')
  assert.equal(f.store.get<Task>('tasks', task.id)?.status, 'todo')
  assert.throws(() => f.domain.updateTask(f.member, task.id, { version: task.version, status: 'done' }), { status: 400 })
  assert.throws(() => f.domain.updateTask(f.member, task.id, { version: task.version, status: 'blocked' }), { status: 400 })
  task = f.domain.updateTask(f.member, task.id, { version: task.version, status: 'blocked', blockerReason: '等待数据', blockerImpact: '验收延期', supportNeeded: '请协助提供数据', waitingForFeedback: true })
  assert.equal(task.waitingForFeedback, true)
  task = f.domain.updateTask(f.member, task.id, { version: task.version, status: 'done', completionNote: '数据验收通过', waitingForFeedback: true })
  assert.equal(task.waitingForFeedback, false)
  assert.throws(() => f.domain.updateTask(f.member, task.id, { version: task.version, completionNote: '' }), { status: 400 })
})

test('register metadata does not bypass assigned task deadline approval or collaboration blocker checks', t => {
  const f = fixture(t), service = new CollaborationService(f.store)
  service.updateSettings(f.manager, { requestId: 'enable-register-policy', version: 0, enabled: true, pilotUserIds: [f.member.id], deadlineApprovalEnabled: true })
  const task = f.domain.createTask(f.manager, { title: '正式下达工作', ownerId: f.member.id, isTemporary: true, temporaryReason: '待关联', dueDate: '2099-10-01' })
  assert.ok(f.store.get('taskTrackings', task.id))
  assert.throws(() => f.domain.updateTask(f.member, task.id, { reason: '测试场景确认承诺调整', version: task.version, workSource: 'leader', dueDate: '' }), { status: 409 })
  assert.throws(() => f.domain.updateTask(f.member, task.id, { version: task.version, workSource: 'leader', status: 'blocked', blockerReason: '等待协作' }), { status: 400 })
  assert.equal(f.store.get<Task>('tasks', task.id)?.workSource, 'leader')
  assert.equal(f.store.get<Task>('tasks', task.id)?.dueDate, '2099-10-01')
})

test('ordinary and register updates enforce the same evidence while trusted history import preserves source facts', t => {
  const f = fixture(t)
  const create = () => f.domain.createTask(f.member, { title: '老任务', isTemporary: true, temporaryReason: '临时', dueDate: '2026-10-01' })
  const legacy = create(), throughRegister = create()
  assert.throws(() => f.domain.updateTask(f.member, legacy.id, { version: legacy.version, status: 'done' }), { status: 400 })
  const completed = f.domain.updateTask(f.member, legacy.id, { version: legacy.version, status: 'done', completionNote: '已验收完成' })
  assert.equal(completed.status, 'done')
  assert.equal(completed.waitingForFeedback, false)
  assert.throws(() => f.domain.updateTask(f.member, completed.id, { version: completed.version, status: 'blocked' }), { status: 400 })
  assert.equal(f.domain.updateTask(f.member, completed.id, { version: completed.version, status: 'blocked', blockerReason: '复核发现缺口', blockerImpact: '延后交付', supportNeeded: '暂不需要支持' }).status, 'blocked')
  assert.throws(() => f.domain.updateTask(f.member, throughRegister.id, { version: throughRegister.version, status: 'done', currentProgress: '' }), { status: 400 })
  assert.throws(() => f.domain.updateTask(f.member, throughRegister.id, { version: throughRegister.version, status: 'blocked', waitingForFeedback: true }), { status: 400 })
  assert.equal(f.domain.updateTask(f.member, throughRegister.id, { version: throughRegister.version, status: 'done', currentProgress: '完成', completionNote: '评审通过' }).status, 'done')
  const restored = f.capture().tasks[0]
  const silent = withSilentImport(f.store, () => f.domain.updateTask(f.member, restored.id, { version: restored.version, status: 'done' }))
  assert.equal(silent.status, 'done')
})

test('relinking a captured task retains its source, intake dates and register metadata', t => {
  const f = fixture(t)
  let task = f.capture({ assignedBy: '张主任', assignedOn: '2026-09-20', requestedOutcome: '建议书' }).tasks[0]
  task = f.domain.updateTask(f.member, task.id, { version: task.version, priority: 'high', currentProgress: '已调研', waitingForFeedback: true })
  let plan = f.domain.createPlan(f.manager, { month: '2026-09', title: '月度验证', category: '研发', ownerId: f.member.id, expectedOutcome: '验证报告', acceptanceCriteria: '通过评审', dueDate: '2026-09-30' })
  plan = f.domain.submitPlan(f.manager, plan.id, { version: plan.version })
  plan = f.domain.reviewPlan(f.manager, plan.id, { version: plan.version, decision: 'approve', comment: '' })
  f.domain.publishMonth(f.manager, plan.month, { planIds: [plan.id] })
  const linked = f.domain.relinkTask(f.manager, task.id, { version: task.version, monthlyPlanId: plan.id, reason: '纳入月目标' })
  assert.deepEqual(linked, { ...task, monthlyPlanId: plan.id, isTemporary: false, version: linked.version, updatedAt: linked.updatedAt })
})

test('JSON restore and business CSV/Excel preserve unknown dates and every optional register field', async t => {
  const f = fixture(t), task = f.capture({ assignedBy: '陈老师', assignedOn: '', requestedOutcome: '汇报材料' }).tasks[0]
  const edited = f.domain.updateTask(f.member, task.id, { version: task.version, priority: 'medium', estimatedEffort: '半天', currentProgress: '初稿完成', decisionNeeded: '确定评审时间', waitingForFeedback: true, nextAction: '预约评审' })
  const packet = exportBusinessData(f.store, f.manager)
  assert.deepEqual(parsePacket(packet).collections.tasks.find(row => row.id === task.id), edited)
  assert.equal('workRegisterCaptures' in packet.collections, false)
  const target = new Store(':memory:'); t.after(() => target.close())
  for (const user of [f.manager, f.member, f.peer]) target.restoreEntity('users', user)
  const preview = previewRestore(target, f.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target, f.manager, packet, {}, preview.fingerprint)
  assert.deepEqual(target.get<Task>('tasks', edited.id), edited)
  const csv = exportCsv(packet, 'tasks')
  for (const content of ['workSource', 'assignedBy', 'assignedOn', 'requestedOutcome', 'priority', 'estimatedEffort', 'currentProgress', 'decisionNeeded', 'waitingForFeedback', '陈老师', '半天']) assert.ok(csv.includes(content))
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await exportXlsx(packet) as never)
  const sheet = workbook.getWorksheet('tasks')!
  assert.ok((sheet.getRow(1).values as unknown[]).includes('waitingForFeedback'))
  assert.ok((sheet.getRow(2).values as unknown[]).includes('汇报材料'))
  assert.equal(schemas.tasks.safeParse({ ...edited, description: '文'.repeat(12001) }).success, false)
  assert.equal(schemas.tasks.safeParse({ ...edited, workSource: 'unknown' }).success, false)
})
