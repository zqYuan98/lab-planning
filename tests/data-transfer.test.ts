import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import ExcelJS from 'exceljs'
import type { Entity, MonthlyPlan, Report, User, WeeklyRecord } from '../shared/types.ts'
import type { ImportRow } from '../shared/import-types.ts'
import { ImportService, type HistoricalRecord } from '../server/import-service.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { editReport, finalizeReport, generateReport } from '../server/reports.ts'
import { exportBusinessData, exportCsv, exportXlsx, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'

function accounts(t: TestContext, withMember = true) {
  const store = new Store(':memory:')
  t.after(() => store.close())
  const domain = new Domain(store)
  const manager = domain.setup({ name: '管理者', email: 'manager@transfer.test', password: 'Fixture-password-2026!' })
  const member = withMember ? domain.createUser(manager, { name: '成员', email: 'member@transfer.test', password: 'Other-fixture-password-2026!', role: 'member', position: '算法' }) : undefined
  return { store, domain, manager, member }
}

function historicalRow(owner: User, title = '历史资料原文'): ImportRow {
  return { id: 'historical-row-1', kind: 'monthly', selected: true, sourceSheet: '九月月报', sourceRow: 3, sourceText: title,
    ownerName: owner.name, ownerId: owner.id, projectName: '', projectId: '', category: '历史工作', title, month: '2026-09', weekStart: '', dueDate: '',
    expectedOutcome: '', acceptanceCriteria: '', actualOutcome: '原表成果', blocker: '', nextAction: '', sourceStatus: '完成', monthlyPlanId: '', linkedRowId: '', taskId: '', issues: ['保留原表缺项'],
  }
}

function populated(t: TestContext) {
  const fixture = accounts(t)
  const { store, domain, manager, member: maybeMember } = fixture
  const member = maybeMember!
  const project = domain.createProject(manager, { name: '算法项目', code: 'TRANSFER-01', description: '旧系统资料', ownerId: member.id })
  domain.createAnnualGoal(manager, { title: '年度交付', year: 2026, target: '形成平台能力', progress: 40, ownerId: member.id })
  let plan = domain.createPlan(manager, { ownerId: member.id, month: '2026-09', title: '九月计划', projectId: project.id, expectedOutcome: '完成第一版', acceptanceCriteria: '验收记录', dueDate: '2026-09-30' })
  plan = domain.submitPlan(manager, plan.id, { version: plan.version })
  plan = domain.reviewPlan(manager, plan.id, { version: plan.version, decision: 'approve', comment: '批准' })
  domain.publishMonth(manager, '2026-09', { planIds: [plan.id] })
  plan = store.get<MonthlyPlan>('plans', plan.id)!
  const task = domain.createTask(member, { title: '模型评测', monthlyPlanId: plan.id, dueDate: '2026-09-11' })
  let weekly = domain.createWeeklyRecord(member, { taskId: task.id, weekStart: '2026-09-07', commitment: '完成模型评测', submitted: true, status: 'done', actualOutcome: '报告生成时的原始成果' })
  let report = generateReport(store, 'weekly', '2026-09-07', manager.id)
  report = editReport(store, report.id, report.version, manager.id, '历史报告正文')
  report = finalizeReport(store, report.id, report.version, manager.id)
  weekly = domain.updateWeeklyRecord(member, weekly.id, { version: weekly.version, actualOutcome: '生成报告后补充的成果' })
  plan = domain.updatePlan(manager, plan.id, { version: plan.version, expectedOutcome: '完成第二版', reason: '调整实际目标' })
  const history = store.insert<HistoricalRecord>('historicalRecords', { importedBy: manager.id, batchId: 'source-batch-only', sourceId: 'original-file-only', row: historicalRow(member) })
  return { ...fixture, member, project, plan, task, weekly, report, history }
}

test('complete JSON migration preserves records, versions, history and frozen reports while mapping accounts', t => {
  const source = populated(t)
  const target = accounts(t)
  const packet = exportBusinessData(source.store, source.manager)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  assert.equal(preview.mapping[source.member.id], target.member!.id)
  assert.equal(preview.counts.plans.insert, 1)
  const userBefore = target.store.get('users', target.member!.id)
  const result = restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  assert.ok(result.restored > 10)
  assert.deepEqual(target.store.get('users', target.member!.id), userBefore, 'accounts and their credentials are never overwritten')
  const plan = target.store.get<MonthlyPlan>('plans', source.plan.id)!
  assert.equal(plan.ownerId, target.member!.id)
  assert.equal(plan.version, source.plan.version)
  assert.equal(plan.createdAt, source.plan.createdAt)
  assert.equal(plan.updatedAt, source.plan.updatedAt)
  const report = target.store.get<Report>('reports', source.report.id)!
  assert.equal(report.status, 'finalized')
  assert.equal(report.authorId, target.manager.id)
  assert.equal(report.finalizedAt, source.report.finalizedAt)
  assert.equal(report.snapshot.weeklyRecords[0].actualOutcome, '报告生成时的原始成果')
  assert.equal(report.snapshot.weeklyRecords[0].ownerId, target.member!.id)
  assert.equal(target.store.get<WeeklyRecord>('weeklyRecords', source.weekly.id)!.actualOutcome, '生成报告后补充的成果')
  assert.equal(target.store.get<HistoricalRecord>('historicalRecords', source.history.id)!.row.ownerId, target.member!.id)
  assert.equal(target.store.get<HistoricalRecord>('historicalRecords', source.history.id)!.sourceId, 'original-file-only')
  assert.equal(target.store.list('publications').length, 2)
  const repeat = previewRestore(target.store, target.manager, packet)
  assert.equal(repeat.canRestore, true, repeat.issues.join('\n'))
  assert.equal(repeat.counts.plans.skip, 1)
  assert.equal(restoreBusinessData(target.store, target.manager, packet, {}, repeat.fingerprint).restored, 0)
})

test('business exports exclude credentials, security settings and registration comments, including snapshot users', t => {
  const f = populated(t)
  const user = f.store.get<User>('users', f.member.id)!
  f.store.update<User & { apiKey: string }>('users', user.id, user.version, { apiKey: 'private-api-key', registrationReviewComment: 'private-registration-comment' })
  f.store.insert<Entity & { secret: string }>('sessions', { secret: 'private-session-secret' })
  f.store.insert<Entity & { baseUrl: string; model: string; visionModel: string; apiKey: string }>('settings', { id: 'ai-connection', baseUrl: 'https://example.test/v1', model: 'fixture', visionModel: '', apiKey: 'private-settings-secret' })
  f.store.insert<Entity & { entityType: string; entityId: string; actorId: string; before: null; after: unknown }>('events', { entityType: 'aiSettings', entityId: 'ai-connection', actorId: f.manager.id, before: null, after: { apiKey: 'private-audit-secret' } })
  const report = f.store.get<Report>('reports', f.report.id)!
  Object.assign(report.snapshot.users[0], { passwordHash: 'private-snapshot-password', registrationReviewComment: 'private-snapshot-comment' })
  f.store.update<Report>('reports', report.id, report.version, { snapshot: report.snapshot })
  const exported = JSON.stringify(exportBusinessData(f.store, f.manager))
  assert.doesNotMatch(exported, /passwordHash|credentialVersion|registrationReviewComment|apiKey|private-|sessions|aiSettings/)
})

test('corrected historical records export and restore both audit snapshots with account mappings', t => {
  const source = populated(t), target = accounts(t)
  const corrected = new ImportService(source.store).editHistory(source.manager, source.history.id, {
    version: source.history.version, reason: '核对原表后纠正责任人与成果',
    row: { ...source.history.row, ownerId: source.manager.id, ownerName: source.manager.name, actualOutcome: '纠正后的真实成果' },
  })
  const packet = exportBusinessData(source.store, source.manager, { type: 'history', month: '2026-09', ownerId: source.manager.id })
  assert.equal(packet.collections.history.length, 1)
  const audit = packet.collections.events.find(event => event.entityType === 'historicalRecord')!
  assert.ok(audit, 'filtered history export includes correction audits')
  assert.equal((audit.before as HistoricalRecord).row.actualOutcome, '原表成果')
  assert.equal((audit.after as HistoricalRecord).row.actualOutcome, '纠正后的真实成果')
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  const restored = target.store.get<HistoricalRecord>('historicalRecords', corrected.id)!
  assert.equal(restored.version, corrected.version)
  assert.equal(restored.row.ownerId, target.manager.id)
  assert.equal(restored.row.sourceText, source.history.row.sourceText)
  const restoredAudit = target.store.get<typeof audit>('events', audit.id)!
  assert.equal(restoredAudit.actorId, target.manager.id)
  assert.equal((restoredAudit.before as HistoricalRecord).importedBy, target.manager.id)
  assert.equal((restoredAudit.before as HistoricalRecord).row.ownerId, target.member!.id)
  assert.equal((restoredAudit.after as HistoricalRecord).row.ownerId, target.manager.id)
  assert.equal(restoredAudit.reason, '核对原表后纠正责任人与成果')
  assert.equal((restoredAudit.before as HistoricalRecord).row.actualOutcome, '原表成果')
  assert.equal((restoredAudit.after as HistoricalRecord).row.actualOutcome, '纠正后的真实成果')
  const broken = structuredClone(packet)
  ;(broken.collections.events[0].before as HistoricalRecord).row.ownerId = 'missing-historical-account'
  assert.match(previewRestore(target.store, target.manager, broken).issues.join('\n'), /missing-historical-account/)
})

test('member exports stay within visible work and history; filtered JSON includes required dependencies', t => {
  const f = populated(t)
  const outsider = f.domain.createUser(f.manager, { name: '其他成员', email: 'outsider@transfer.test', password: 'Fixture-password-2026!', role: 'member' })
  const privatePlan = f.domain.createPlan(f.manager, { ownerId: outsider.id, month: '2026-10', title: '其他成员的私有计划', category: '技术研究', expectedOutcome: '新成果', acceptanceCriteria: '新标准', dueDate: '2026-10-30' })
  f.store.insert<HistoricalRecord>('historicalRecords', { importedBy: outsider.id, batchId: 'private-batch', sourceId: 'private-source', row: historicalRow(outsider, '其他成员的私有历史') })
  const memberPacket = exportBusinessData(f.store, f.member)
  assert.equal(memberPacket.collections.plans.some(plan => plan.id === privatePlan.id), false)
  assert.equal(memberPacket.collections.history.length, 1)
  assert.equal(memberPacket.collections.reports.length, 0)
  assert.equal(memberPacket.collections.events.length, 0)
  assert.doesNotMatch(JSON.stringify(memberPacket), /其他成员的私有/)
  const filtered = exportBusinessData(f.store, f.manager, { type: 'weeklyRecords', month: '2026-09', ownerId: f.member.id, projectId: f.project.id })
  assert.equal(filtered.collections.weeklyRecords.length, 1)
  assert.equal(filtered.collections.tasks[0].id, f.task.id)
  assert.equal(filtered.collections.plans[0].id, f.plan.id)
  assert.equal(filtered.collections.projects[0].id, f.project.id)
  assert.ok(filtered.collections.events.length)
  const target = accounts(t)
  const preview = previewRestore(target.store, target.manager, filtered)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
})

test('missing and disabled accounts require explicit resolution and restore never creates default accounts', t => {
  const f = populated(t)
  const target = accounts(t, false)
  const packet = exportBusinessData(f.store, f.manager)
  const missing = previewRestore(target.store, target.manager, packet)
  assert.equal(missing.canRestore, false)
  assert.ok(missing.missingUsers.some(user => user.id === f.member.id))
  assert.throws(() => restoreBusinessData(target.store, target.manager, packet, {}, missing.fingerprint), { status: 409 })
  assert.equal(target.store.list('users').length, 1)
  assert.equal(target.store.list('projects').length, 0)
  let replacement = target.domain.createUser(target.manager, { name: '新账号', email: 'replacement@transfer.test', password: 'Fixture-password-2026!', role: 'member' })
  const explicit = { [f.member.id]: replacement.id }
  assert.equal(previewRestore(target.store, target.manager, packet, explicit).canRestore, true)
  replacement = target.domain.updateUser(target.manager, replacement.id, { version: replacement.version, active: false })
  const inactive = previewRestore(target.store, target.manager, packet, explicit)
  assert.equal(inactive.canRestore, false)
  assert.match(inactive.missingUsers.find(user => user.id === f.member.id)!.reason, /停用/)
  assert.equal(previewRestore(target.store, target.manager, packet, { [f.member.id]: target.manager.id }).canRestore, false, 'do not collapse two identities into one')
  assert.throws(() => previewRestore(f.store, f.member, packet), { status: 403 })
})

test('strict packet validation rejects secret-bearing fields and unknown collections at every nesting level', t => {
  const f = populated(t), target = accounts(t)
  const packet = exportBusinessData(f.store, f.manager)
  const badCollection = structuredClone(packet) as unknown as { collections: Record<string, unknown> }
  badCollection.collections.settings = [{ id: 'ai-connection', apiKey: 'injected' }]
  assert.throws(() => previewRestore(target.store, target.manager, badCollection), { status: 400 })
  const badUser = structuredClone(packet)
  Object.assign(badUser.collections.users[0], { role: 'manager', passwordHash: 'injected' })
  assert.throws(() => previewRestore(target.store, target.manager, badUser), { status: 400 })
  const badSnapshot = structuredClone(packet)
  Object.assign(badSnapshot.collections.reports[0].snapshot.users[0], { apiKey: 'injected' })
  assert.throws(() => previewRestore(target.store, target.manager, badSnapshot), { status: 400 })
  const badAudit = structuredClone(packet)
  const audit = badAudit.collections.events.find(event => event.entityType === 'plan' && event.after)!
  Object.assign(audit.after as object, { passwordHash: 'injected' })
  assert.throws(() => previewRestore(target.store, target.manager, badAudit), { status: 400 })
  assert.equal(target.store.list('plans').length, 0)
})

test('conflicting IDs, natural keys and broken references block the whole restore', t => {
  const f = populated(t), target = accounts(t)
  const packet = exportBusinessData(f.store, f.manager)
  target.domain.createProject(target.manager, { name: '同编号不同项目', code: f.project.code, ownerId: target.manager.id })
  const duplicateCode = previewRestore(target.store, target.manager, packet)
  assert.equal(duplicateCode.canRestore, false)
  assert.match(duplicateCode.issues.join('\n'), /重复业务键/)
  assert.throws(() => restoreBusinessData(target.store, target.manager, packet, {}, duplicateCode.fingerprint), { status: 409 })
  assert.equal(target.store.list('plans').length, 0)
  const target2 = accounts(t)
  const collision = structuredClone(packet)
  collision.collections.events[0].id = target2.store.list<Entity>('events')[0].id
  assert.match(previewRestore(target2.store, target2.manager, collision).issues.join('\n'), /已存在不同内容/, 'collision with an authentication audit is a conflict, not an internal error')
  const broken = structuredClone(packet)
  broken.collections.tasks[0].monthlyPlanId = 'missing-plan'
  assert.match(previewRestore(target2.store, target2.manager, broken).issues.join('\n'), /缺少关联 plans\/missing-plan/)
  const okay = previewRestore(target2.store, target2.manager, packet)
  restoreBusinessData(target2.store, target2.manager, packet, {}, okay.fingerprint)
  const conflict = structuredClone(packet)
  conflict.collections.plans[0].title = '同 ID 的不同内容'
  assert.match(previewRestore(target2.store, target2.manager, conflict).issues.join('\n'), /已存在不同内容/)
})

test('confirmation requires preview and rechecks packet and database changes inside the transaction', t => {
  const f = populated(t), target = accounts(t)
  const packet = exportBusinessData(f.store, f.manager)
  assert.throws(() => restoreBusinessData(target.store, target.manager, packet), { status: 400 })
  const preview = previewRestore(target.store, target.manager, packet)
  const changed = structuredClone(packet)
  changed.collections.plans[0].title = '预览后改动'
  assert.throws(() => restoreBusinessData(target.store, target.manager, changed, {}, preview.fingerprint), { status: 409 })
  target.domain.createProject(target.manager, { name: '预览后新增', code: 'AFTER-PREVIEW' })
  assert.throws(() => restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint), { status: 409 })
  assert.equal(target.store.list('plans').length, 0)
})

test('a write failure rolls back previously restored entities and leaves no restore audit', t => {
  const f = populated(t), target = accounts(t)
  const packet = exportBusinessData(f.store, f.manager)
  const preview = previewRestore(target.store, target.manager, packet)
  const beforeEvents = target.store.list('events')
  const original = target.store.restoreEntity.bind(target.store)
  t.mock.method(target.store, 'restoreEntity', (collection: string, entity: Entity) => {
    if (collection === 'plans') throw new Error('injected storage failure')
    return original(collection, entity)
  })
  assert.throws(() => restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint), /injected storage failure/)
  assert.equal(target.store.list('projects').length, 0)
  assert.equal(target.store.list('annualGoals').length, 0)
  assert.deepEqual(target.store.list('events'), beforeEvents)
})

test('CSV and XLSX preserve Unicode and multiline text without creating spreadsheet formulas', async t => {
  const f = populated(t)
  const packet = exportBusinessData(f.store, f.manager)
  packet.collections.projects[0].name = '=HYPERLINK("https://example.test","中文")'
  packet.collections.projects[0].description = '\t+1+1\n第二行'
  packet.collections.plans[0].title = '@SUM(1,2)'
  packet.collections.plans[0].expectedOutcome = '-1+1'
  packet.collections.reports[0].narrative = '文'.repeat(31999) + '🚀' + '长正文中文\n'.repeat(2000)
  const csv = exportCsv(packet, 'projects')
  assert.ok(csv.startsWith('\uFEFF'))
  assert.ok(csv.includes("'=HYPERLINK"))
  assert.ok(csv.includes("'\t+1+1\n第二行"))
  assert.ok(exportCsv(packet, 'all').includes('"collection"'))
  const buffer = await exportXlsx(packet)
  assert.equal(buffer.subarray(0, 2).toString(), 'PK')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer)
  for (const sheet of workbook.worksheets) sheet.eachRow(row => row.eachCell(cell => assert.notEqual(cell.type, ExcelJS.ValueType.Formula)))
  const reportSheet = workbook.getWorksheet('reports')!
  const headers = reportSheet.getRow(1).values as string[]
  const narrativeColumns = headers.map((value, index) => ({ value, index })).filter(item => item.value === 'narrative' || item.value?.startsWith('narrative__part'))
  assert.ok(narrativeColumns.length > 1)
  assert.equal(narrativeColumns.map(item => reportSheet.getRow(2).getCell(item.index).text).join(''), packet.collections.reports[0].narrative)
  assert.equal(workbook.getWorksheet('projects')!.getCell('B2').value, packet.collections.projects[0].version)
})
