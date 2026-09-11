import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { WeeklySubmissionService } from '../server/weekly-submissions.ts'
import { exportBusinessData, exportCsv, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { collectionNames, parsePacket } from '../server/data-transfer-schema.ts'
import type { User, Task, WeeklyRecord, Report, MonthlyPlan } from '../shared/types.ts'
import type { WeeklyCycle, WeeklyDuty, WeeklySubmission } from '../shared/weekly-submissions.ts'

function fixture(t: TestContext, suffix: string, populate = false) {
  const store = new Store(':memory:')
  t.after(() => store.close())
  const user = (name: string, role: User['role'] = 'member') => store.restoreEntity<User>('users', {
    id: `${name}-${suffix}`, version: 1, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
    name, email: `${name}@transfer.test`, position: '', role, active: true,
  })
  const manager = user('manager', 'manager'), member = user('member'), other = user('other')
  let now = new Date('2026-09-06T01:00:00Z')
  const service = new WeeklySubmissionService(store, () => now)
  if (populate) {
    service.getRule()
    now = new Date('2026-09-11T07:59:59Z')
    const record = (submitted: boolean) => {
      const task = store.insert<Task>('tasks', { title: '验证任务', ownerId: member.id, monthlyPlanId: null, description: '', dueDate: '2026-09-30', status: 'doing', isTemporary: true, temporaryReason: '临时支持' })
      return store.insert<WeeklyRecord>('weeklyRecords', { taskId: task.id, ownerId: member.id, monthlyPlanId: null, weekStart: '2026-09-07', commitment: '完成评测', actualOutcome: '形成报告', status: 'doing', blocker: '', nextAction: '', evidenceUrl: '', submitted })
    }
    record(true); record(false)
    let view = service.view(member, '2026-09-07')
    const result = view.duties.find(d => d.kind === 'results')!
    service.submit(member, { dutyId: result.id, version: result.version, manifest: result.manifest, draftAction: 'retain', requestId: 'results-1' })
    now = new Date('2026-09-11T08:00:00Z')
    view = service.view(member, '2026-09-07')
    const plan = view.duties.find(d => d.kind === 'plan')!
    service.submit(manager, { dutyId: plan.id, version: plan.version, manifest: [], note: '下周暂无安排', reason: '代录', requestId: 'plan-1' })
    const otherDuty = service.view(other, '2026-09-07').duties[0]
    service.adjust(manager, { dutyId: otherDuty.id, version: otherDuty.version, action: 'exempt', reason: '出差' })
    const cycle = store.get<WeeklyCycle>('weeklyCycles', '2026-09-07')!
    store.update<WeeklyCycle>('weeklyCycles', cycle.id, cycle.version, { needsReview: true })
    service.confirmRoster(manager, { week: cycle.week, version: cycle.version + 1, rosterIds: cycle.rosterIds, reason: '核对历史名单' })
    const rule = service.getRule()
    service.updateRule(manager, { version: rule.version, enabled: false })
    store.insert<Report>('reports', { type: 'weekly', period: '2026-09-07', title: '冻结报告', status: 'finalized', revision: 1, narrative: '历史成果', authorId: manager.id, finalizedAt: now.toISOString(),
      snapshot: { plans: [], tasks: [], weeklyRecords: [], projects: [], annualGoals: [], users: [member], nextPlans: [], nextWeeklyRecords: [], publications: [], changes: [], weeklySubmissions: service.reportSummary('weekly', '2026-09-07') } })
  }
  return { store, service, manager, member, other }
}

test('v2 roundtrip remaps nested users and retains UUID duties, immutable timestamps, drafts and report summaries', t => {
  const source = fixture(t, 'source', true), target = fixture(t, 'target')
  const packet = exportBusinessData(source.store, source.manager)
  assert.equal(packet.formatVersion, 2)
  assert.equal(packet.collections.weeklySubmissions.length, 2)
  assert.ok(packet.collections.events.some(event => event.entityType === 'weeklyRule'))
  assert.ok(packet.collections.events.some(event => event.entityType === 'weeklyCycle'))
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  const old = packet.collections.weeklySubmissions.find(row => row.kind === 'results')!
  const restored = target.store.get<WeeklySubmission>('weeklySubmissions', old.id)!
  assert.equal(restored.ownerId, target.member.id)
  assert.equal(restored.actorId, target.member.id)
  assert.equal(restored.records[0].ownerId, target.member.id)
  assert.equal(restored.submittedAt, old.submittedAt)
  assert.deepEqual(restored.retainedDraftManifest, old.retainedDraftManifest)
  assert.equal(restored.dutyId, old.dutyId)
  assert.equal(target.store.get<WeeklyDuty>('weeklyDuties', old.dutyId)!.deadlineAt, '2026-09-11T08:00:00.000Z')
  const report = target.store.list<Report>('reports')[0]
  assert.equal(report.snapshot.weeklySubmissions!.find(row => row.kind === 'results' && row.ownerId === target.member.id)!.status, 'on_time')
  assert.equal(report.snapshot.weeklySubmissions!.find(row => row.kind === 'plan' && row.ownerId === target.member.id)!.missingAtDeadline, true)
  assert.ok(!JSON.stringify(report.snapshot.weeklySubmissions).includes('-source'))
  const repeat = previewRestore(target.store, target.manager, packet)
  assert.equal(repeat.canRestore, true, repeat.issues.join('\n'))
  assert.equal(repeat.counts.weeklySubmissions.skip, 2)
})

test('v1 restores no synthetic submission history and keeps old report snapshots without optional summary', t => {
  const source = fixture(t, 'source', true), target = fixture(t, 'target')
  const packet = exportBusinessData(source.store, source.manager)
  const legacy = structuredClone(packet) as unknown as { formatVersion: number; collections: Record<string, unknown[]> }
  legacy.formatVersion = 1
  for (const name of collectionNames.filter(name => ['weeklyRules', 'weeklyCycles', 'weeklyDuties', 'weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments'].includes(name))) delete legacy.collections[name]
  legacy.collections.events = []
  delete (legacy.collections.reports[0] as Report).snapshot.weeklySubmissions
  ;(legacy.collections.reports[0] as Report).finalizedAt = '2026-09-11T16:00:00+08:00'
  const preview = previewRestore(target.store, target.manager, legacy)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, legacy, {}, preview.fingerprint)
  assert.equal(target.store.list('weeklyMissing').length, 0)
  assert.equal(target.store.list('weeklySubmissions').length, 0)
  assert.equal(target.store.list<Report>('reports')[0].snapshot.weeklySubmissions, undefined)
  assert.equal(target.store.list<Report>('reports')[0].finalizedAt, '2026-09-11T16:00:00+08:00')
  assert.doesNotThrow(() => exportCsv(parsePacket(legacy)))
})

test('member export includes only own facts and omits department rule, roster and audits', t => {
  const source = fixture(t, 'source', true)
  const packet = exportBusinessData(source.store, source.member)
  for (const name of ['weeklyDuties', 'weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments'] as const) assert.ok(packet.collections[name].every(row => row.ownerId === source.member.id))
  assert.equal(packet.collections.weeklyDuties.length, 2)
  assert.deepEqual(packet.collections.weeklyRules, [])
  assert.deepEqual(packet.collections.weeklyCycles, [])
  assert.deepEqual(packet.collections.events, [])
  assert.equal(packet.collections.reports.length, 0)
  assert.doesNotMatch(JSON.stringify(packet), /出差|核对历史名单/)
})

test('tampered duty, receipt, cutoff, draft and logical identities are rejected atomically', t => {
  const source = fixture(t, 'source', true), target = fixture(t, 'target')
  const packet = exportBusinessData(source.store, source.manager)
  const cases: Array<(copy: typeof packet) => void> = [
    copy => { copy.collections.weeklySubmissions[0].dutyId = 'missing-duty' },
    copy => { copy.collections.weeklySubmissions[0].records[0].ownerId = source.other.id },
    copy => { copy.collections.weeklySubmissions[0].records[0].weekStart = '2026-09-14' },
    copy => { copy.collections.weeklySubmissions[0].retainedDraftManifest[0].id = 'missing-draft' },
    copy => { copy.collections.weeklySubmissions[0].submittedAt = '2026-09-01T00:00:00.000Z' },
    copy => { copy.collections.weeklyMissing[0].detectedAt = '2026-09-11T07:59:59.000Z' },
    copy => { copy.collections.weeklyDuties[0].deadlineAt = '2026-09-11T09:00:00.000Z' },
    copy => { copy.collections.weeklyDuties.push({ ...copy.collections.weeklyDuties[0], id: crypto.randomUUID() }) },
    copy => { copy.collections.weeklyCycles[0].rosterIds = [] },
    copy => { copy.collections.weeklyRules[0].windows[0].fromWeek = '2026-09-14' },
    copy => { copy.collections.weeklyAdjustments[0].action = 'invalidate' },
  ]
  for (const mutate of cases) {
    const broken = structuredClone(packet); mutate(broken)
    const preview = previewRestore(target.store, target.manager, broken)
    assert.equal(preview.canRestore, false, mutate.toString())
    assert.throws(() => restoreBusinessData(target.store, target.manager, broken, {}, preview.fingerprint), { status: 409 })
  }
  const secret = structuredClone(packet)
  Object.assign(secret.collections.weeklySubmissions[0].retainedDraftManifest[0], { apiKey: 'poison' })
  assert.throws(() => previewRestore(target.store, target.manager, secret), { status: 400 })
  assert.equal(target.store.list('weeklyDuties').length, 0)
  const valid = previewRestore(target.store, target.manager, packet)
  restoreBusinessData(target.store, target.manager, packet, {}, valid.fingerprint)
  const conflict = structuredClone(packet)
  conflict.collections.weeklySubmissions[0].submittedAt = '2026-09-11T08:00:01.000Z'
  assert.match(previewRestore(target.store, target.manager, conflict).issues.join('\n'), /已存在不同内容/)
})

test('reference-only goal projections cannot be restored as actual goal definitions', t => {
  const source = fixture(t, 'source'), target = fixture(t, 'target')
  const packet = exportBusinessData(source.store, source.manager)
  packet.collections.plans.push({ id: 'poison-goal', version: 1, createdAt: packet.exportedAt, updatedAt: packet.exportedAt, month: '2026-09', title: '可见引用标题', ownerId: source.member.id, collaboratorIds: [], projectId: null, category: '', expectedOutcome: '', acceptanceCriteria: '', dueDate: '', priority: 'medium', status: 'published', reviewComment: '', publishedVersion: 1, sourcePlanId: null, actualOutcome: '', acceptanceStatus: 'pending', acceptanceNote: '', visibility: 'reference' } satisfies MonthlyPlan)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, false)
  assert.match(preview.issues.join('\n'), /投影不能作为真实目标恢复/)
  assert.equal(target.store.list('plans').length, 0)
})

test('normal server bootstrap rule can be explicitly replaced without changing migrated history', t => {
  const source = fixture(t, 'source', true), target = fixture(t, 'target')
  const bootstrap = new WeeklySubmissionService(target.store).getRule()
  const packet = exportBusinessData(source.store, source.manager)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  assert.equal(preview.counts.weeklyRules.replace, 1)
  assert.equal(preview.counts.weeklyRules.insert, 0)
  assert.match(preview.notices.join('\n'), /尚未使用的默认规则/)
  assert.deepEqual(target.store.get('weeklyRules', bootstrap.id), bootstrap, 'preview is read-only')
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  assert.deepEqual(target.store.get('weeklyRules', bootstrap.id), packet.collections.weeklyRules[0])
  assert.ok(target.store.list<{ action: string }>('events').some(event => event.action === 'restore_default'))
  const missingBefore = target.store.list('weeklyMissing')
  const view = new WeeklySubmissionService(target.store, () => new Date('2026-09-11T09:00:00Z')).view(target.member, '2026-09-07')
  assert.equal(view.duties.find(duty => duty.kind === 'results')!.status, 'on_time')
  assert.equal(view.duties.find(duty => duty.kind === 'results')!.missingAtDeadline, false)
  assert.deepEqual(target.store.list('weeklyMissing'), missingBefore, 'reconciliation does not invent misses for restored on-time receipts')
  const repeat = previewRestore(target.store, target.manager, packet)
  assert.equal(repeat.canRestore, true, repeat.issues.join('\n'))
  assert.equal(repeat.counts.weeklyRules.skip, 1)
  assert.equal(repeat.counts.weeklyRules.replace, 0)
  const third = fixture(t, 'third')
  new WeeklySubmissionService(third.store).getRule()
  const secondPacket = exportBusinessData(target.store, target.manager)
  const secondPreview = previewRestore(third.store, third.manager, secondPacket)
  assert.equal(secondPreview.canRestore, true, secondPreview.issues.join('\n'))
  restoreBusinessData(third.store, third.manager, secondPacket, {}, secondPreview.fingerprint)
  const importedAudit = third.store.list<{ action: string; before: unknown; after: unknown }>('events').find(event => event.action === 'restore_default')!
  assert.deepEqual(importedAudit.before, bootstrap)
  assert.deepEqual(importedAudit.after, packet.collections.weeklyRules[0])
})

test('configured, audited or used rules never receive the bootstrap replacement exception', t => {
  const source = fixture(t, 'source', true)
  const packet = exportBusinessData(source.store, source.manager)
  for (const state of ['configured', 'audited', 'weeklyCycles', 'weeklyDuties', 'weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments', 'report'] as const) {
    const target = fixture(t, state)
    const service = new WeeklySubmissionService(target.store)
    const rule = service.getRule()
    if (state === 'configured') service.updateRule(target.manager, { version: rule.version, enabled: false })
    else if (state === 'audited') target.store.restoreEntity('events', packet.collections.events.find(event => event.entityType === 'weeklyRule')!)
    else if (state === 'report') target.store.restoreEntity('reports', packet.collections.reports[0])
    else target.store.restoreEntity(state, packet.collections[state][0])
    const preview = previewRestore(target.store, target.manager, packet)
    assert.equal(preview.canRestore, false, state)
    assert.equal(preview.counts.weeklyRules.replace, 0, state)
    assert.match(preview.issues.join('\n'), /weeklyRules\/weekly-submission-rule 已存在不同内容/, state)
    assert.deepEqual(preview.notices, [])
  }
})

test('bootstrap replacement rolls back after later write failure and rechecks preview changes', t => {
  const source = fixture(t, 'source', true), target = fixture(t, 'target')
  const service = new WeeklySubmissionService(target.store)
  const bootstrap = service.getRule()
  const packet = exportBusinessData(source.store, source.manager)
  const preview = previewRestore(target.store, target.manager, packet)
  const beforeEvents = target.store.list('events')
  const original = target.store.restoreEntity.bind(target.store)
  const mock = t.mock.method(target.store, 'restoreEntity', (name: string, entity: Parameters<typeof original>[1]) => {
    if (name === 'weeklyDuties') throw new Error('injected after rule replacement')
    return original(name, entity)
  })
  assert.throws(() => restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint), /injected after rule replacement/)
  assert.deepEqual(target.store.get('weeklyRules', bootstrap.id), bootstrap)
  assert.deepEqual(target.store.list('events'), beforeEvents)
  assert.deepEqual(target.store.list('weeklyCycles'), [])
  mock.mock.restore()
  service.updateRule(target.manager, { version: bootstrap.version, enabled: false })
  assert.throws(() => restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint), { status: 409 })
  assert.equal(previewRestore(target.store, target.manager, packet).counts.weeklyRules.replace, 0)
  const used = fixture(t, 'used')
  const unused = new WeeklySubmissionService(used.store).getRule()
  const beforeUse = previewRestore(used.store, used.manager, packet)
  assert.equal(beforeUse.canRestore, true)
  new WeeklySubmissionService(used.store, () => new Date(`${unused.effectiveWeek}T01:00:00Z`)).reconcile()
  assert.ok(used.store.list('weeklyCycles').length > 0)
  assert.throws(() => restoreBusinessData(used.store, used.manager, packet, {}, beforeUse.fingerprint), { status: 409 })
  assert.equal(previewRestore(used.store, used.manager, packet).counts.weeklyRules.replace, 0)
})

test('weekly timestamp schemas reject equivalent offset and non-millisecond representations at every new nesting level', t => {
  const source = fixture(t, 'source', true), target = fixture(t, 'target')
  const packet = exportBusinessData(source.store, source.manager)
  const paths: Array<Array<string | number>> = []
  for (const name of ['weeklyRules', 'weeklyCycles', 'weeklyDuties', 'weeklySubmissions', 'weeklyMissing', 'weeklyAdjustments'] as const) {
    for (const field of Object.keys(packet.collections[name][0]).filter(key => key.endsWith('At'))) paths.push(['collections', name, 0, field])
  }
  paths.push(['collections', 'reports', 0, 'snapshot', 'weeklySubmissions', 0, 'deadlineAt'])
  paths.push(['collections', 'reports', 0, 'snapshot', 'weeklySubmissions', 0, 'firstSubmittedAt'])
  const ruleAudit = packet.collections.events.findIndex(event => event.entityType === 'weeklyRule')
  const cycleAudit = packet.collections.events.findIndex(event => event.entityType === 'weeklyCycle')
  paths.push(['collections', 'events', ruleAudit, 'before', 'createdAt'])
  paths.push(['collections', 'events', ruleAudit, 'createdAt'])
  paths.push(['collections', 'events', cycleAudit, 'updatedAt'])
  paths.push(['collections', 'events', cycleAudit, 'after', 'deadlineAt'])
  packet.collections.reports[0].snapshot.changes.push(packet.collections.events[cycleAudit])
  paths.push(['collections', 'reports', 0, 'snapshot', 'changes', 0, 'after', 'frozenAt'])
  for (const path of paths) for (const representation of ['offset', 'noMillis'] as const) {
    const copy = structuredClone(packet)
    let parent: any = copy
    for (const part of path.slice(0, -1)) parent = parent[part]
    const field = path.at(-1)!, before = parent[field] as string
    assert.equal(typeof before, 'string', path.join('.'))
    const equivalent = new Date(Date.parse(before) + 8 * 3600000).toISOString().replace('Z', '+08:00')
    assert.equal(Date.parse(equivalent), Date.parse(before))
    parent[field] = representation === 'offset' ? equivalent : before.replace(/\.\d{3}Z$/, 'Z')
    assert.throws(() => previewRestore(target.store, target.manager, copy), { status: 400 }, `${path.join('.')}: ${representation}`)
  }
  assert.deepEqual(target.store.list('weeklyMissing'), [])
  assert.deepEqual(target.store.list('weeklySubmissions'), [])
})
