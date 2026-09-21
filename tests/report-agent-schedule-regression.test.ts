import test from 'node:test'
import assert from 'node:assert/strict'
import type { Report, User } from '../shared/types.ts'
import type { ReportAgentSchedule, UpdateReportAgentScheduleInput } from '../shared/report-agent.ts'
import { Store } from '../server/store.ts'
import { getReportAgentSchedule, reportAgentMissedPeriods, runReportAgentSchedule, updateReportAgentSchedule } from '../server/report-agent-schedule.ts'
import { activateReportTemplate, createReportTemplate, enqueueReportAgent, previewReportTemplate, updateReportTemplate, uploadReportAsset } from '../server/report-agent-service.ts'
import { fixture, p } from './report-docx-fixtures.ts'

async function setup() {
  const store = new Store(':memory:')
  const manager = store.insert<User>('users', { name: '调度管理员', email: 'schedule@example.test', role: 'manager', position: '', active: true })
  const bytes = await fixture(p('周报'))
  const asset = await uploadReportAsset(store, manager.id, { filename: 'schedule.docx', purpose: 'template', contentBase64: bytes.toString('base64') })
  let template = createReportTemplate(store, manager.id, { name: '调度验证', sourceAssetId: asset.id, effectiveWeek: '2026-01-05' })
  template = updateReportTemplate(store, manager.id, template.id, { expectedVersion: template.version, name: template.name, bindings: template.bindings, rules: template.rules, rulesConfirmed: true, exampleAssetIds: [], effectiveWeek: template.effectiveWeek })
  template = await previewReportTemplate(store, manager.id, template.id, template.version)
  template = activateReportTemplate(store, manager.id, template.id, { expectedVersion: template.version, layoutVerified: true, layoutNote: '合成模板验证' })
  const initial = getReportAgentSchedule(store)
  const schedule = updateReportAgentSchedule(store, manager.id, { expectedVersion: initial.version, enabled: true, actorId: manager.id, templateId: template.id, weekday: 5, time: '17:30', targetWeek: 'current', useAi: false }, new Date('2026-08-01T00:00:00Z'))
  const update = (current: ReportAgentSchedule, change: Partial<UpdateReportAgentScheduleInput>, at: string) => updateReportAgentSchedule(store, manager.id, { expectedVersion: current.version, enabled: current.enabled, actorId: current.actorId, templateId: current.templateId, weekday: current.weekday, time: current.time, targetWeek: current.targetWeek, useAi: current.useAi, ...change }, new Date(at))
  return { store, manager, template, schedule, update }
}

test('no-op saves preserve the active schedule boundary, missed history and latest-only catch-up', async () => {
  const f = await setup()
  try {
    const now = new Date('2026-09-21T03:00:00Z')
    const before = reportAgentMissedPeriods(f.store, now)
    assert.ok(before.includes('2026-09-07'))
    const saved = f.update(f.schedule, {}, now.toISOString())
    assert.equal(saved.effectiveAt, f.schedule.effectiveAt)
    assert.deepEqual(reportAgentMissedPeriods(f.store, now), before)
    assert.equal(runReportAgentSchedule(f.store, now).length, 1)
    assert.equal(runReportAgentSchedule(f.store, now).length, 0)
    assert.deepEqual(f.store.list<Report>('reports').map(report => report.period), ['2026-09-14'])
    assert.deepEqual(reportAgentMissedPeriods(f.store, now), before)
  } finally { f.store.close() }
})

test('changing timing retains all old omissions and starts one new automatic timing window', async () => {
  const f = await setup()
  try {
    const now = new Date('2026-09-21T03:00:00Z'), before = reportAgentMissedPeriods(f.store, now)
    const changed = f.update(f.schedule, { weekday: 1, time: '09:00', targetWeek: 'previous' }, now.toISOString())
    assert.equal(changed.effectiveAt, now.toISOString())
    const after = reportAgentMissedPeriods(f.store, now)
    for (const period of before) assert.ok(after.includes(period), `lost omission ${period}`)
    assert.ok(after.includes('2026-09-14'), 'the last ungenerated old-window occurrence becomes a visible omission')
    assert.equal(runReportAgentSchedule(f.store, now).length, 0)
    assert.equal(runReportAgentSchedule(f.store, new Date('2026-09-28T01:00:00Z')).length, 1)
    assert.equal(runReportAgentSchedule(f.store, new Date('2026-09-28T01:01:00Z')).length, 0)
    assert.deepEqual(f.store.list<Report>('reports').map(report => report.period), ['2026-09-21'])
    assert.ok(reportAgentMissedPeriods(f.store, new Date('2026-09-28T01:01:00Z')).includes('2026-09-14'))
    assert.ok(!('missedPeriods' in getReportAgentSchedule(f.store)), 'public schedule DTO remains unchanged')
  } finally { f.store.close() }
})

test('disable and re-enable preserve historical omissions without creating a disabled-period backlog', async () => {
  const f = await setup()
  try {
    assert.equal(runReportAgentSchedule(f.store, new Date('2026-09-21T03:00:00Z')).length, 1)
    const disabled = f.update(f.schedule, { enabled: false }, '2026-09-22T03:00:00Z')
    const historical = reportAgentMissedPeriods(f.store, new Date('2026-09-22T03:00:00Z'))
    assert.ok(historical.includes('2026-09-07'))
    assert.deepEqual(reportAgentMissedPeriods(f.store, new Date('2026-10-20T03:00:00Z')), historical)
    assert.equal(runReportAgentSchedule(f.store, new Date('2026-10-20T03:00:00Z')).length, 0)
    const enabled = f.update(disabled, { enabled: true }, '2026-10-20T03:00:00Z')
    assert.equal(enabled.effectiveAt, '2026-10-20T03:00:00.000Z')
    assert.deepEqual(reportAgentMissedPeriods(f.store, new Date('2026-10-20T03:00:00Z')), historical)
    assert.equal(runReportAgentSchedule(f.store, new Date('2026-10-20T03:00:00Z')).length, 0)
    assert.equal(runReportAgentSchedule(f.store, new Date('2026-10-23T09:30:00Z')).length, 1)
    assert.equal(runReportAgentSchedule(f.store, new Date('2026-10-23T09:31:00Z')).length, 0)
    assert.deepEqual(f.store.list<Report>('reports').map(report => report.period), ['2026-09-14', '2026-10-19'])
    assert.deepEqual(reportAgentMissedPeriods(f.store, new Date('2026-10-23T09:31:00Z')), historical)
  } finally { f.store.close() }
})

test('owner and AI changes do not erase history or skip the latest eligible occurrence', async () => {
  const f = await setup()
  try {
    const successor = f.store.insert<User>('users', { name: '接管管理员', email: 'successor@example.test', role: 'manager', position: '', active: true })
    const now = new Date('2026-09-21T03:00:00Z'), before = reportAgentMissedPeriods(f.store, now)
    const changed = f.update(f.schedule, { actorId: successor.id, useAi: true }, now.toISOString())
    assert.equal(changed.effectiveAt, f.schedule.effectiveAt)
    assert.deepEqual(reportAgentMissedPeriods(f.store, now), before)
    assert.equal(runReportAgentSchedule(f.store, now).length, 1)
    assert.deepEqual(f.store.list<Report>('reports').map(report => report.period), ['2026-09-14'])
  } finally { f.store.close() }
})


test('manually backfilling an older missed period clears its durable omission as soon as a draft exists', async () => {
  const f = await setup()
  try {
    const now = new Date('2026-09-21T03:00:00Z')
    f.update(f.schedule, { weekday: 1, time: '09:00', targetWeek: 'previous' }, now.toISOString())
    assert.ok(reportAgentMissedPeriods(f.store, now).includes('2026-09-07'))
    const job = enqueueReportAgent(f.store, f.manager.id, { requestId: 'manual-older-backfill', templateId: f.template.id, period: '2026-09-07', useAi: false })
    assert.equal(job.status, 'queued')
    assert.equal(f.store.get<Report>('reports', job.reportId!)?.status, 'draft')
    assert.ok(!reportAgentMissedPeriods(f.store, now).includes('2026-09-07'))
    assert.ok(reportAgentMissedPeriods(f.store, now).includes('2026-09-14'))
    assert.equal(f.store.list('reportAgentOccurrences').length, 0, 'manual work is not relabeled as an automatic occurrence')
  } finally { f.store.close() }
})

test('automatic generation respects an existing manual agent draft and does not cascade to older missing periods', async () => {
  const f = await setup()
  try {
    const now = new Date('2026-09-21T03:00:00Z')
    const job = enqueueReportAgent(f.store, f.manager.id, { requestId: 'manual-latest-week', templateId: f.template.id, period: '2026-09-14', useAi: false })
    assert.equal(runReportAgentSchedule(f.store, now).length, 0)
    assert.equal(runReportAgentSchedule(f.store, new Date('2026-09-21T03:01:00Z')).length, 0)
    assert.equal(f.store.list('reports').length, 1)
    assert.equal(f.store.list('reportAgentJobs').length, 1)
    assert.equal(f.store.list('reportAgentOccurrences').length, 0)
    assert.ok(reportAgentMissedPeriods(f.store, now).includes('2026-09-07'))
    // Legacy deterministic reports must not suppress the template-based agent.
    const { id: _id, version: _version, createdAt: _created, updatedAt: _updated, agent: _agent, ...legacy } = f.store.get<Report>('reports', job.reportId!)!
    f.store.insert<Report>('reports', { ...legacy, period: '2026-09-21' })
    assert.equal(runReportAgentSchedule(f.store, new Date('2026-09-28T03:00:00Z')).length, 1)
    assert.deepEqual(f.store.list<Report>('reports').filter(report => report.agent).map(report => report.period), ['2026-09-14', '2026-09-21'])
  } finally { f.store.close() }
})
