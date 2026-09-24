import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { AuditEvent, Entity, Report, User } from '../shared/types.ts'
import type { TaskDelivery, DeliveryDecision } from '../shared/deliveries.ts'
import type { BlockerEpisode } from '../shared/collaboration.ts'
import type { DecisionRequest } from '../shared/support.ts'
import { Store } from '../server/store.ts'
import { WorkService } from '../server/domain-work.ts'
import { TaskDeliveryService } from '../server/task-deliveries.ts'
import { TaskSupportService } from '../server/task-support.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { parsePacket } from '../server/data-transfer-schema.ts'
import { getOperationEpoch } from '../server/operation-context.ts'

function accounts(t: TestContext, prefix: string) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const user = (id: string, role: User['role']) => store.insert<User>('users', { id: prefix + id, name: id, email: `${id}@delivery-transfer.test`, role, active: true, position: '' })
  return { store, member: user('owner', 'member'), manager: user('reviewer', 'manager'), coordinator: user('coordinator', 'member'), observer: user('observer', 'observer') }
}
function populated(t: TestContext) {
  const f = accounts(t, 'source-'), work = new WorkService(f.store), deliveries = new TaskDeliveryService(f.store), support = new TaskSupportService(f.store)
  const task = work.createTask(f.member, { title: '有交付和协调记录的任务', dueDate: '2026-09-30', isTemporary: true, temporaryReason: '专项' })
  const submitted = deliveries.submit(f.member, task.id, { requestId: 'first-submission', taskVersion: task.version, previousRevision: 0, actualOutcome: '冻结第一版结果', evidenceRefs: Array.from({ length: 30 }, (_, i) => `证据 ${i}`), acceptanceCriteria: '完成实验', reviewerId: f.manager.id })
  const returned = deliveries.decide(f.manager, submitted.delivery.id, { requestId: 'first-returned', seriesVersion: submitted.series.version, action: 'review', conclusion: 'returned', note: '补齐数据' })
  const revised = deliveries.submit(f.member, task.id, { requestId: 'second-submission', taskVersion: task.version, seriesId: submitted.series.id, seriesVersion: returned.series.version, previousRevision: 1, previousSubmissionId: submitted.delivery.id, actualOutcome: '冻结第二版结果', evidenceRefs: ['补充附件'], acceptanceCriteria: '全部样本通过', reviewerId: f.manager.id })
  deliveries.decide(f.manager, submitted.delivery.id, { requestId: 'correct-first-decision', seriesVersion: revised.series.version, action: 'correct', conclusion: 'accepted', note: '原始样本复核通过', supersedesDecisionId: returned.decision!.id })
  const blocked = work.updateTask(f.member, task.id, { version: task.version, status: 'blocked', blockerReason: '环境故障', blockerImpact: '本周实验无法运行', supportNeeded: '协调恢复', nextAction: '准备备用环境' })
  const episode = f.store.list<BlockerEpisode>('blockerEpisodes').find(row => row.parentTaskId === task.id)!
  support.assignBlocker(f.manager, episode.id, { requestId: 'assign-coordinator', version: episode.version, coordinatorId: f.coordinator.id, responseDueAt: '2026-09-26T09:00:00.000Z', reason: '环境值班' })
  const decision = support.createDecision(f.manager, { requestId: 'create-decision', taskId: task.id, taskVersion: blocked.version, blockerEpisodeId: episode.id, question: '是否切换环境', options: ['切换', '等待'], decisionOwnerId: f.manager.id, responseDueAt: '2026-09-25T09:00:00.000Z', reason: '业务判断' })
  support.decideDecision(f.manager, decision.id, { requestId: 'decide-environment', version: decision.version, result: '切换备用环境' })
  return { ...f, task, submitted, revised, episode, decision }
}

test('v5 roundtrip maps all responsibility references, retains immutable revisions and skips operational sharing', t => {
  const source = populated(t), target = accounts(t, 'target-')
  source.store.insert<Entity & { subjectId: string; secret: string }>('objectGrants', { subjectId: source.observer.id, secret: 'operational-sharing-secret' })
  source.store.insert<Entity & { subjectId: string; narrative: string }>('scopedReports', { subjectId: source.observer.id, narrative: 'private-scoped-report' })
  const packet = exportBusinessData(source.store, source.manager, { type: 'tasks' })
  assert.equal(packet.formatVersion, 6)
  assert.equal(packet.collections.taskDeliveries.length, 2)
  assert.equal(packet.collections.deliveryDecisions.length, 2)
  assert.equal(packet.collections.decisionRequests.length, 1)
  assert.doesNotMatch(JSON.stringify(packet), /operational-sharing-secret|private-scoped-report|collaborationCommandReceipts|objectGrants/)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  const oldEpoch = getOperationEpoch(target.store)
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  const restored = target.store.get<TaskDelivery>('taskDeliveries', source.submitted.delivery.id)!
  assert.equal(restored.ownerId, target.member.id)
  assert.equal(restored.submittedBy, target.member.id)
  assert.equal(restored.reviewerIdSnapshot, target.manager.id)
  assert.equal(restored.submittedAt, source.submitted.delivery.submittedAt)
  assert.equal(restored.evidenceRefs.length, 30)
  assert.equal(target.store.get<BlockerEpisode>('blockerEpisodes', source.episode.id)?.coordinatorId, target.coordinator.id)
  assert.equal(target.store.get<DecisionRequest>('decisionRequests', source.decision.id)?.decidedBy, target.manager.id)
  assert.equal(target.store.list<DeliveryDecision>('deliveryDecisions').every(row => row.decidedBy === target.manager.id), true)
  assert.equal(target.store.list('notifications').length, 0)
  assert.equal(target.store.list('notificationDeliveries').length, 0)
  assert.notEqual(getOperationEpoch(target.store), oldEpoch)
  const repeat = previewRestore(target.store, target.manager, packet)
  assert.equal(repeat.canRestore, true, repeat.issues.join('\n'))
  assert.equal(restoreBusinessData(target.store, target.manager, packet, {}, repeat.fingerprint).restored, 0)
})

test('v5 preview rejects broken revision and decision chains, head state drift and mapped self-review', t => {
  const source = populated(t), target = accounts(t, 'target-'), original = exportBusinessData(source.store, source.manager)
  const invalid = (mutate: (packet: typeof original) => void, message: RegExp) => {
    const packet = structuredClone(original); mutate(packet)
    const preview = previewRestore(target.store, target.manager, packet)
    assert.equal(preview.canRestore, false)
    assert.match(preview.issues.join('\n'), message)
    assert.throws(() => restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint), { status: 409 })
    assert.equal(target.store.list('tasks').length, 0)
    assert.equal(target.store.list('taskDeliveries').length, 0)
    assert.equal(target.store.list('deliveryDecisions').length, 0)
  }
  invalid(packet => { packet.collections.taskDeliveries[1].supersedesId = null }, /修订链断裂/)
  invalid(packet => { packet.collections.deliverySeries[0].status = 'accepted' }, /当前状态与有效决定/)
  invalid(packet => { const row = packet.collections.deliveryDecisions.find(row => row.action === 'correct')!; row.supersedesDecisionId = row.id }, /循环|有效决定|当前状态/)
  invalid(packet => { packet.collections.deliverySeries[0].reviewerId = source.member.id }, /不能是成果责任人/)
  invalid(packet => { packet.collections.decisionRequests[0].blockerEpisodeId = 'missing-episode' }, /missing-episode/)
  invalid(packet => { packet.collections.deliveryDecisions = []; packet.collections.events = packet.collections.events.filter(row => row.entityType !== 'deliveryDecision') }, /历史版本必须已有有效终态/)
  invalid(packet => { packet.collections.taskDeliveries[0].taskVersion = packet.collections.tasks[0].version + 1 }, /冻结任务版本不能晚于/)
})

test('v5 restoration rejects cross-task blocker sources and action responsibility references atomically', t => {
  const source = populated(t), target = accounts(t, 'target-'), work = new WorkService(source.store)
  const otherTask = work.createTask(source.member, { title: '另一独立任务', dueDate: '2026-09-30', isTemporary: true, temporaryReason: '专项' })
  const otherWeekly = work.createWeeklyRecord(source.member, { taskId: otherTask.id, weekStart: '2026-09-21', commitment: '另一任务的周安排', submitted: false })
  const original = exportBusinessData(source.store, source.manager)
  const mutations: [string, (packet: typeof original) => void][] = [
    ['task source parent', packet => { packet.collections.blockerEpisodes[0].sourceId = otherTask.id }],
    ['weekly source parent', packet => { packet.collections.blockerEpisodes[0].sourceType = 'weeklyRecord'; packet.collections.blockerEpisodes[0].sourceId = otherWeekly.id }],
    ['action task parent', packet => { packet.collections.blockerActions[0].taskId = otherTask.id }],
    ['action owner snapshot', packet => { packet.collections.blockerActions[0].ownerId = source.manager.id }],
    ['decision blocker parent', packet => { packet.collections.decisionRequests[0].taskId = otherTask.id }],
  ]
  for (const [name, mutate] of mutations) {
    const packet = structuredClone(original); mutate(packet)
    const preview = previewRestore(target.store, target.manager, packet)
    assert.equal(preview.canRestore, false, name)
    assert.match(preview.issues.join('\n'), /阻塞来源必须属于|处理记录与阻塞|阻塞关联不属于/, name)
    assert.throws(() => restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint), { status: 409 })
    for (const collection of ['tasks', 'blockerEpisodes', 'blockerActions', 'taskDeliveries', 'decisionRequests']) assert.equal(target.store.list(collection).length, 0, collection)
  }
})

test('v5 evidence and decision-option schemas match command content limits without silently changing frozen text', t => {
  const source = populated(t), original = exportBusinessData(source.store, source.manager), valid = structuredClone(original)
  valid.collections.taskDeliveries[0].evidenceRefs = ['文'.repeat(4000), 'https://evidence.example/one', 'http://evidence.example/two', '普通文本证据：已归档']
  valid.collections.decisionRequests[0].options = ['案'.repeat(3000)]
  const parsed = parsePacket(valid)
  assert.deepEqual(parsed.collections.taskDeliveries[0].evidenceRefs, valid.collections.taskDeliveries[0].evidenceRefs)
  assert.deepEqual(parsed.collections.decisionRequests[0].options, valid.collections.decisionRequests[0].options)
  const invalid: ((packet: typeof original) => void)[] = [
    packet => { packet.collections.taskDeliveries[0].evidenceRefs = [' \t\n'] },
    packet => { packet.collections.taskDeliveries[0].evidenceRefs = ['javascript:alert(1)'] },
    packet => { packet.collections.taskDeliveries[0].evidenceRefs = [' FTP://files.example/file'] },
    packet => { packet.collections.taskDeliveries[0].evidenceRefs = ['data:text/plain,secret'] },
    packet => { packet.collections.taskDeliveries[0].evidenceRefs = ['文'.repeat(4001)] },
    packet => { packet.collections.taskDeliveries[0].evidenceRefs = Array.from({ length: 31 }, () => '证据') },
    packet => { packet.collections.taskDeliveries[0].actualOutcome = '   ' },
    packet => { packet.collections.taskDeliveries[0].acceptanceCriteriaSnapshot = '\t' },
    packet => { packet.collections.deliveryDecisions[0].note = '  ' },
    packet => { packet.collections.decisionRequests[0].options = [' \t'] },
    packet => { packet.collections.decisionRequests[0].options = ['案'.repeat(3001)] },
    packet => { packet.collections.decisionRequests[0].options = Array.from({ length: 21 }, () => '方案') },
    packet => { packet.collections.decisionRequests[0].question = '  ' },
  ]
  for (const mutate of invalid) { const packet = structuredClone(original); mutate(packet); assert.throws(() => parsePacket(packet), { status: 400 }) }
})

function legacySupportPacket(packet: ReturnType<typeof exportBusinessData>, formatVersion: 3 | 4) {
  const result = structuredClone(packet)
  result.formatVersion = formatVersion
  result.collections.taskCommitmentEvents = []; result.collections.historicalEvidence = []; result.collections.periodReviewSnapshots = []
  result.collections.deliverySeries = []; result.collections.taskDeliveries = []; result.collections.deliveryDecisions = []; result.collections.decisionRequests = []
  const phase2Types = new Set(['deliverySeries', 'taskDelivery', 'deliveryDecision', 'decisionRequest'])
  result.collections.events = result.collections.events.filter(event => !phase2Types.has(event.entityType))
  const stripSupport = (row: Record<string, unknown>) => { for (const field of ['coordinatorId', 'responseDueAt', 'coordinationState', 'responseNote', 'openedAtKnown']) delete row[field] }
  for (const row of result.collections.blockerEpisodes) stripSupport(row as unknown as Record<string, unknown>)
  for (const row of result.collections.blockerActions) { stripSupport(row as unknown as Record<string, unknown>); row.action = 'record' }
  for (const event of result.collections.events) if (event.entityType === 'blockerEpisode') for (const snapshot of [event.before, event.after]) if (snapshot) stripSupport(snapshot as Record<string, unknown>)
  return result
}

test('v3-v4 retain genuine legacy support but reject new responsibility fields, actions and audit types', t => {
  const source = populated(t), original = exportBusinessData(source.store, source.manager)
  for (const version of [3, 4] as const) {
    const legacy = legacySupportPacket(original, version)
    assert.equal(parsePacket(legacy).collections.blockerEpisodes.length, 1)
    const inject: ((packet: typeof legacy) => void)[] = [
      packet => { packet.collections.blockerEpisodes[0].coordinatorId = source.coordinator.id },
      packet => { packet.collections.blockerEpisodes[0].responseDueAt = '2026-09-25T09:00:00.000Z' },
      packet => { packet.collections.blockerEpisodes[0].coordinationState = 'responded' },
      packet => { packet.collections.blockerEpisodes[0].responseNote = '新协调回应' },
      packet => { packet.collections.blockerEpisodes[0].openedAtKnown = false },
      packet => { packet.collections.blockerActions[0].coordinatorId = source.coordinator.id },
      packet => { packet.collections.blockerActions[0].action = 'assign' },
      packet => { packet.collections.blockerActions[0].action = 'respond' },
      packet => { packet.collections.blockerActions[0].action = 'resolve' },
      packet => { (packet.collections.events.find(event => event.entityType === 'blockerEpisode')!.after as BlockerEpisode).responseNote = '不能把新增责任藏进旧格式审计' },
      packet => { packet.collections.events.push(structuredClone(original.collections.events.find(event => event.entityType === 'deliverySeries')!)) },
    ]
    for (const mutate of inject) { const packet = structuredClone(legacy); mutate(packet); assert.throws(() => parsePacket(packet), { status: 400 }) }
  }
})

test('v3-v4 cannot conceal phase2 facts in null audit snapshots or frozen report change history', t => {
  const source = populated(t), original = exportBusinessData(source.store, source.manager)
  for (const version of [3, 4] as const) {
    const legacy = legacySupportPacket(original, version)
    const newAudit = structuredClone(original.collections.events.find(event => event.entityType === 'deliverySeries')!)
    const nullSnapshots = structuredClone(legacy)
    nullSnapshots.collections.events.push({ ...newAudit, before: null, after: null })
    assert.throws(() => parsePacket(nullSnapshots), { status: 400 })
    const nested = structuredClone(legacy)
    const changes: AuditEvent[] = [newAudit]
    const report: Report = { id: 'nested-phase2-report', version: 1, createdAt: original.exportedAt, updatedAt: original.exportedAt, type: 'weekly', period: '2026-09-21', title: '冻结报告', status: 'draft', revision: 1, narrative: '', authorId: source.manager.id, finalizedAt: null,
      snapshot: { plans: [], tasks: [], weeklyRecords: [], projects: [], users: [], annualGoals: [], nextPlans: [], nextWeeklyRecords: [], publications: [], changes } }
    nested.collections.reports.push(report)
    assert.throws(() => parsePacket(nested), { status: 400 })
    report.snapshot.changes = [structuredClone(original.collections.events.find(event => event.entityType === 'blockerEpisode')!)]
    assert.throws(() => parsePacket(nested), { status: 400 })
  }
})

test('v1-v4 remain readable and do not accept delivery facts under an old format number', t => {
  const source = populated(t), packet = exportBusinessData(source.store, source.manager)
  assert.throws(() => parsePacket({ ...packet, formatVersion: 4 }), { status: 400 })
  for (const version of [1, 2, 3, 4] as const) {
    const legacy = accounts(t, `legacy-${version}-`)
    const old = structuredClone(exportBusinessData(legacy.store, legacy.manager))
    old.formatVersion = version
    if (version === 1) for (const key of ['weeklyRules', 'weeklyCycles', 'weeklyDuties', 'weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments']) delete (old.collections as unknown as Record<string, unknown>)[key]
    assert.deepEqual(parsePacket(old).collections.taskDeliveries, [])
  }
})

test('stale manager downgraded to observer cannot export or preview/restore business packets', t => {
  const source = populated(t), packet = exportBusinessData(source.store, source.manager)
  source.store.update<User>('users', source.manager.id, source.manager.version, { role: 'observer' })
  assert.throws(() => exportBusinessData(source.store, source.manager), { status: 403 })
  assert.throws(() => previewRestore(source.store, source.manager, packet), { status: 403 })
  assert.throws(() => restoreBusinessData(source.store, source.manager, packet, {}, '0'.repeat(64)), { status: 403 })
})
