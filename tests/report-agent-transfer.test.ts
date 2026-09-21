import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { Report } from '../shared/types.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { exportBusinessData, exportCsv, exportXlsx, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { uploadReportAsset, createReportTemplate, updateReportTemplate, previewReportTemplate, activateReportTemplate, enqueueReportAgent, finalizeAgentReport, downloadAgentReport } from '../server/report-agent-service.ts'
import { runReportAgentWorker } from '../server/report-agent-jobs.ts'
import { fixture } from './report-docx-fixtures.ts'
import ExcelJS from 'exceljs'

function accounts(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const domain = new Domain(store)
  const manager = domain.setup({ name: '报告管理者', email: 'report-transfer@example.test', password: 'Fixture-password-2026!' })
  return { store, domain, manager }
}
async function populated(t: TestContext) {
  const result = accounts(t), { store, manager } = result
  const asset = await uploadReportAsset(store, manager.id, { filename: '测试周报.docx', contentBase64: (await fixture()).toString('base64'), purpose: 'template' })
  let template = createReportTemplate(store, manager.id, { name: '测试周报', sourceAssetId: asset.id, effectiveWeek: '2026-09-21' })
  template = updateReportTemplate(store, manager.id, template.id, { expectedVersion: template.version, name: template.name, effectiveWeek: template.effectiveWeek, exampleAssetIds: [], rules: ['只写当前事实'], rulesConfirmed: true, bindings: [
    { regionId: 'p:0', label: '标题', kind: 'meta', meta: 'title', required: true },
    { regionId: 't:0', label: '本周成果', kind: 'dataset', dataset: 'outcomes', required: true, startRow: 1, endRow: 3, columns: [{ label: '事项', field: 'title', required: true }, { label: '成果', field: 'outcome', required: true }] },
  ] })
  template = await previewReportTemplate(store, manager.id, template.id, template.version)
  template = activateReportTemplate(store, manager.id, template.id, { expectedVersion: template.version, layoutVerified: true, layoutNote: '合成模板验证' })
  const job = enqueueReportAgent(store, manager.id, { requestId: 'fixture-generation', templateId: template.id, period: '2026-09-21', useAi: false })
  await runReportAgentWorker(store)
  let report = store.get<Report>('reports', job.reportId!)!
  report = await finalizeAgentReport(store, manager.id, report.id, { expectedVersion: report.version, reviewNote: '合成数据验收' })
  return { ...result, template, report, asset, job }
}

test('v4 migration preserves template and exact final DOCX bytes after account mapping', async t => {
  const source = await populated(t), target = accounts(t)
  const before = await downloadAgentReport(source.store, source.manager.id, source.report.id)
  const packet = exportBusinessData(source.store, source.manager)
  assert.equal(packet.formatVersion, 4)
  assert.equal(packet.collections.reportTemplates.length, 1)
  assert.equal(packet.collections.reportAssets.length, 3)
  assert.equal(JSON.stringify(packet).includes('leaseToken'), false)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  const restored = target.store.get<Report>('reports', source.report.id)!
  assert.equal(restored.authorId, target.manager.id)
  assert.equal(restored.agent!.template.createdBy, target.manager.id)
  assert.equal(restored.agent!.templateHash, source.report.agent!.templateHash)
  assert.equal(restored.agent!.migrationSourceHashes?.snapshotHash, source.report.agent!.snapshotHash)
  const after = await downloadAgentReport(target.store, target.manager.id, source.report.id)
  assert.deepEqual(after.bytes, before.bytes)
  assert.equal(after.sha256, before.sha256)
  assert.equal(target.store.list('reportAgentJobs').length, 0)
  assert.equal(target.store.list('reportAgentOccurrences').length, 0)
  assert.equal(target.store.get('settings', 'report-agent-schedule'), undefined)
  const repeat = previewRestore(target.store, target.manager, packet)
  assert.equal(repeat.canRestore, true, repeat.issues.join('\n'))
  assert.equal(repeat.counts.reportAssets.skip, 3)
  const roundTrip = exportBusinessData(target.store, target.manager)
  assert.equal(previewRestore(target.store, target.manager, roundTrip).canRestore, true)
})

test('migration rejects tampered source fingerprints before account remapping and damaged Word archives', async t => {
  const source = await populated(t), target = accounts(t), original = exportBusinessData(source.store, source.manager)
  const changed = structuredClone(original)
  changed.collections.reports[0].snapshot.users[0].name = '篡改名称'
  const hashPreview = previewRestore(target.store, target.manager, changed)
  assert.equal(hashPreview.canRestore, false)
  assert.ok(hashPreview.issues.some(issue => issue.includes('哈希不一致')))
  const corrupt = structuredClone(original)
  corrupt.collections.reportAssets[0].contentBase64 = Buffer.from('not a Word file').toString('base64')
  const filePreview = previewRestore(target.store, target.manager, corrupt)
  assert.equal(filePreview.canRestore, false)
  assert.ok(filePreview.issues.some(issue => issue.includes('校验和不一致')))
  const missing = structuredClone(original)
  missing.collections.reportAssets = missing.collections.reportAssets.filter(asset => asset.id !== source.report.agent!.finalAssetId)
  assert.equal(previewRestore(target.store, target.manager, missing).canRestore, false)
  assert.throws(() => previewRestore(target.store, target.manager, { ...original, formatVersion: 3 }), /格式/)
  const mapping = structuredClone(original)
  mapping.collections.reportTemplates[0].bindings[0].regionId = 'p:999'
  const badMapping = previewRestore(target.store, target.manager, mapping)
  assert.equal(badMapping.canRestore, false)
  assert.ok(badMapping.issues.some(issue => /映射/.test(issue)))
  const forged = structuredClone(original)
  forged.collections.reportAssets.find(asset => asset.purpose === 'template')!.inspection!.regions[0].text = '伪造解析结果'
  assert.equal(previewRestore(target.store, target.manager, forged).canRestore, false)
})

test('member exports omit report material; readable exports omit file base64', async t => {
  const source = await populated(t)
  const member = source.domain.createUser(source.manager, { name: '成员', email: 'report-member@example.test', password: 'Fixture-password-2026!', role: 'member' })
  const memberPacket = exportBusinessData(source.store, member)
  assert.deepEqual(memberPacket.collections.reportAssets, [])
  assert.deepEqual(memberPacket.collections.reportTemplates, [])
  assert.deepEqual(memberPacket.collections.reports, [])
  const packet = exportBusinessData(source.store, source.manager)
  assert.equal(exportCsv(packet).includes('contentBase64'), false)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(await exportXlsx(packet) as never)
  assert.ok(workbook.getWorksheet('reportAssets'))
  assert.equal(JSON.stringify(workbook.getWorksheet('reportAssets')!.getRow(1).values).includes('contentBase64'), false)
})
