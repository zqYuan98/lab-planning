import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { Store, HttpError } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { ImportService } from '../server/import-service.ts'
import { DingTalkMonthlyImportService } from '../server/dingtalk-monthly-import.ts'
import type { DingTalkSheetSnapshot } from '../shared/dingtalk-documents.ts'
import type { DingTalkDocumentCandidate, DingTalkDocumentDiscovery } from '../shared/dingtalk-monthly-api.ts'
import type { ImportBatch, ImportRow } from '../shared/import-types.ts'
import type { MonthlyPlan, User } from '../shared/types.ts'

const headers = ['序号', '部门', '指标类型', '工作事项', '工作内容（做什么）', '交付产物（可量化验收标准）', '负责人', '截至时间', '备注']
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(t: TestContext, count = 1) {
  const store = new Store(':memory:'), domain = new Domain(store), imports = new ImportService(store)
  const actor = domain.setup({ name: '来源管理员', email: 'dingtalk-manager@example.test', password: 'Synthetic-pass-2026!' })
  const manager2 = domain.createUser(actor, { name: '接续管理员', email: 'dingtalk-manager2@example.test', password: 'Synthetic-pass-2026!', role: 'manager' })
  const member = domain.createUser(actor, { name: '目标负责人', email: 'dingtalk-member@example.test', password: 'Synthetic-pass-2026!', role: 'member' })
  const source: DingTalkSheetSnapshot = {
    connectionId: 'synthetic-connection', folderId: 'synthetic-folder', documentId: 'synthetic-document',
    documentTitle: '10月月报材料', documentUrl: 'https://alidocs.dingtalk.com/i/nodes/synthetic-document',
    path: ['人工智能实验室管理'], sheetId: 'synthetic-sheet', sheetName: '11月目标', targetMonth: '2026-11',
    range: `A1:I${count + 1}`, rows: [headers, ...Array.from({ length: count }, (_, index) => [String(index + 1), '人工智能实验室', '部门重点任务', `合成目标${index + 1}`, '调试接口\n核对数据', '提交验收清单', member.name, '2026-11-25', '保留原始备注'])].map((cells, index) => ({ rowNumber: index + 1, cells: [...cells] })),
    merges: [], mergesKnown: true, complete: true, readAt: '2026-11-06T02:00:00.000Z',
  }
  const candidate: DingTalkDocumentCandidate = { id: 'synthetic-candidate', documentId: source.documentId, documentTitle: source.documentTitle, documentUrl: source.documentUrl, sheetId: source.sheetId, sheetName: source.sheetName, path: source.path, recommended: true }
  const remote = { source, complete: true, readCalls: 0, discoverCalls: 0, deny: false, wait: undefined as Promise<void> | undefined, entered: undefined as (() => void) | undefined }
  const client = {
    status: () => ({ configured: true, folderId: source.folderId, folderName: '人工智能实验室管理', message: '合成测试连接', currentMonth: '2026-11', timeZone: 'Asia/Taipei' }),
    async discover(month: string, _url?: string): Promise<DingTalkDocumentDiscovery> {
      remote.discoverCalls++
      if (remote.deny) throw new HttpError(403, '合成文档权限不足')
      return { id: '', targetMonth: month, complete: remote.complete, warnings: [], candidates: [candidate], recommendedCandidateId: candidate.id }
    },
    async read(_candidate: DingTalkDocumentCandidate, _month: string): Promise<DingTalkSheetSnapshot> {
      remote.readCalls++
      remote.entered?.()
      if (remote.wait) await remote.wait
      if (remote.deny) throw new HttpError(403, '合成文档权限不足')
      return structuredClone(remote.source)
    },
  }
  const service = new DingTalkMonthlyImportService(store, imports, client)
  t.after(() => { imports.close(); store.close() })
  return { store, domain, imports, service, actor, manager2, member, remote, candidate, client }
}
type Fixture = ReturnType<typeof fixture>
async function fetchBatch(f: Fixture, actor: User = f.actor) {
  const discovery = await f.service.discover(actor, { month: '2026-11' })
  return f.service.fetch(actor, { discoveryId: discovery.id, candidateId: f.candidate.id })
}
function reviewBatch(f: Fixture, batch: ImportBatch, actor: User = f.actor, rows: ImportRow[] = batch.rows) {
  const sourceItemCount = rows.filter(row => row.selected || !row.exclusionReason?.trim() || !['duplicate', 'not_task'].includes(row.exclusionKind ?? 'task')).length
  return f.imports.edit(actor, batch.id, { version: batch.version, mode: 'draft', rows, completionReview: { confirmed: true, sourceItemCount } })
}
function existingPlan(f: Fixture, title = '合成目标1') {
  return f.domain.createPlan(f.actor, { title, month: '2026-11', category: '部门重点任务', ownerId: f.member.id, dueDate: '2026-11-25', expectedOutcome: '已有目标交付', acceptanceCriteria: '已有验收条件', priority: 'medium' })
}
const noPublicationOrNotification = (f: Fixture) => {
  for (const name of ['publications', 'notifications', 'notificationDeliveries', 'nativeOperations']) assert.equal(f.store.list(name).length, 0, `${name} must remain empty`)
}

test('seven source rows preview without creating plans, then require source review and import only drafts', async t => {
  const f = fixture(t, 7)
  let batch = await fetchBatch(f)
  assert.equal(batch.rows.length, 7)
  assert.equal(batch.mode, 'draft')
  assert.equal(batch.status, 'parsed')
  assert.equal(batch.requiresCompletionReview, true)
  assert.ok(batch.rows.every(row => row.ownerId === f.member.id && row.issues.length === 0))
  assert.equal(f.store.list('plans').length, 0)
  noPublicationOrNotification(f)
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /逐项核对/)
  assert.equal(f.store.list('plans').length, 0)
  batch = reviewBatch(f, batch)
  const saved = await f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.equal(saved.status, 'committed')
  assert.equal(saved.committedCount, 7)
  const plans = f.store.list<MonthlyPlan>('plans')
  assert.equal(plans.length, 7)
  assert.ok(plans.every(plan => plan.status === 'draft' && plan.publishedVersion === null && plan.acceptanceStatus === 'pending'))
  assert.ok(plans.every(plan => plan.expectedOutcome.includes('补充说明（原表备注）') && plan.category === '部门重点任务'))
  assert.equal(f.store.list('dingtalkSourceItems').length, 7)
  noPublicationOrNotification(f)
  assert.deepEqual((await f.service.commit(f.actor, batch.id, { version: batch.version })).rows, saved.rows)
  assert.equal(f.store.list('plans').length, 7)
})

test('ordinary members cannot discover, fetch, review, resolve, commit, or access document batches', async t => {
  const f = fixture(t), batch = await fetchBatch(f)
  assert.throws(() => f.service.status(f.member), { status: 403 })
  await assert.rejects(f.service.discover(f.member, { month: '2026-11' }), { status: 403 })
  await assert.rejects(f.service.fetch(f.member, {}), { status: 403 })
  assert.throws(() => f.service.review(f.member, batch.id), { status: 403 })
  assert.throws(() => f.service.resolve(f.member, batch.id, { version: batch.version }), { status: 403 })
  await assert.rejects(f.service.commit(f.member, batch.id, { version: batch.version }), { status: 403 })
  assert.throws(() => f.imports.get(f.member, batch.id), { status: 403 })
  assert.equal(f.store.list('plans').length, 0)
})

test('remote permissions and incomplete discovery prevent a preview from being saved', async t => {
  const f = fixture(t)
  f.remote.deny = true
  await assert.rejects(fetchBatch(f), /权限不足/)
  assert.equal(f.store.list('importBatches').length, 0)
  f.remote.deny = false; f.remote.complete = false
  await assert.rejects(fetchBatch(f), /查找尚未完成/)
  assert.equal(f.remote.readCalls, 0)
  assert.equal(f.store.list('importBatches').length, 0)
  f.remote.complete = true; f.remote.source.complete = false
  await assert.rejects(fetchBatch(f), /尚未完整读取/)
  assert.equal(f.store.list('importBatches').length, 0)
})

test('repeat fetch by either administrator restores the same batch and saved corrections', async t => {
  const f = fixture(t)
  let batch = await fetchBatch(f)
  batch = f.imports.edit(f.actor, batch.id, { version: batch.version, rows: batch.rows.map(row => ({ ...row, title: '已人工校对的目标' })) })
  const same = await fetchBatch(f), other = await fetchBatch(f, f.manager2)
  assert.equal(same.id, batch.id)
  assert.equal(other.id, batch.id)
  assert.equal(other.rows[0].title, '已人工校对的目标')
  assert.equal(other.version, batch.version)
  assert.equal(f.store.list('importBatches').length, 1)
  batch = reviewBatch(f, other, f.manager2)
  const saved = await f.service.commit(f.manager2, batch.id, { version: batch.version })
  assert.equal(saved.committedCount, 1)
  assert.equal((await fetchBatch(f)).id, batch.id)
  assert.equal(f.store.list('plans').length, 1)
})

test('changed remote cells or lost remote access preserve the preview and refuse commit', async t => {
  const f = fixture(t), batch = reviewBatch(f, await fetchBatch(f))
  f.remote.source.rows[1].cells[4] = '源表新内容'
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /原表已变化/)
  assert.equal(f.imports.get(f.actor, batch.id).status, 'parsed')
  assert.equal(f.store.list('plans').length, 0)
  f.remote.deny = true
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /权限不足/)
  assert.equal(f.store.list('plans').length, 0)
})

test('old screenshot or manual same-title plan requires an explicit difference decision', async t => {
  const f = fixture(t), plan = existingPlan(f)
  let batch = await fetchBatch(f)
  const view = f.service.review(f.actor, batch.id)
  assert.equal(view.rows[0].status, 'ambiguous')
  assert.equal(view.rows[0].requiresResolution, true)
  assert.deepEqual(view.rows[0].plans.map(item => item.id), [plan.id])
  batch = reviewBatch(f, batch)
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /逐条处理/)
  const resolved = f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[0].id, action: 'new', reason: '已核对为独立新增工作，保留两个目标' })
  batch = reviewBatch(f, resolved.batch)
  const saved = await f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.equal(saved.committedCount, 1)
  assert.equal(f.store.list('plans').length, 2)
})

test('linking a source row to an existing plan creates only a durable source association', async t => {
  const f = fixture(t), plan = existingPlan(f)
  let batch = await fetchBatch(f)
  batch = f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[0].id, action: 'link', planId: plan.id, reason: '确认是此前截图导入的同一事项' }).batch
  batch = reviewBatch(f, batch)
  const saved = await f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.equal(saved.committedCount, 0)
  assert.equal(saved.skippedCount, 1)
  assert.equal(saved.rows[0].result?.id, plan.id)
  assert.equal(saved.rows[0].resultDisposition, 'existing')
  assert.deepEqual(f.store.get<MonthlyPlan>('plans', plan.id), plan)
  assert.equal(f.store.list('plans').length, 1)
  assert.equal(f.store.list('dingtalkSourceItems').length, 1)
  noPublicationOrNotification(f)
})

test('source changes after an earlier import cannot be resolved as a new duplicate target', async t => {
  const f = fixture(t)
  let batch = reviewBatch(f, await fetchBatch(f))
  const saved = await f.service.commit(f.actor, batch.id, { version: batch.version })
  const original = f.store.get<MonthlyPlan>('plans', saved.rows[0].result!.id)!
  f.remote.source.rows[1].cells[4] = '后续修改的工作内容'
  batch = await fetchBatch(f)
  const view = f.service.review(f.actor, batch.id)
  assert.equal(view.rows[0].status, 'changed')
  assert.throws(() => f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[0].id, action: 'new', reason: '尝试重复创建' }), /不能重复新增/)
  assert.deepEqual(f.store.get<MonthlyPlan>('plans', original.id), original)
  assert.equal(f.store.list('plans').length, 1)
})

test('deleting an import batch preserves the source ledger and prevents recreation on refetch', async t => {
  const f = fixture(t)
  let batch = reviewBatch(f, await fetchBatch(f))
  const saved = await f.service.commit(f.actor, batch.id, { version: batch.version })
  const planId = saved.rows[0].result!.id
  f.imports.deleteBatch(f.actor, saved.id, { version: saved.version })
  assert.equal(f.store.list('plans').length, 1)
  assert.equal(f.store.list('dingtalkSourceItems').length, 1)
  batch = await fetchBatch(f)
  assert.notEqual(batch.id, saved.id)
  assert.equal(f.service.review(f.actor, batch.id).rows[0].status, 'imported')
  batch = reviewBatch(f, batch)
  const restored = await f.service.commit(f.manager2, batch.id, { version: batch.version })
  assert.equal(restored.committedCount, 0)
  assert.equal(restored.rows[0].result!.id, planId)
  assert.equal(f.store.list('plans').length, 1)
})

test('a local edit during the remote consistency check makes the older commit fail', async t => {
  const f = fixture(t), batch = reviewBatch(f, await fetchBatch(f))
  const entered = deferred(), release = deferred()
  f.remote.entered = entered.resolve; f.remote.wait = release.promise
  const committing = f.service.commit(f.actor, batch.id, { version: batch.version })
  await entered.promise
  const edited = f.imports.edit(f.actor, batch.id, { version: batch.version, rows: batch.rows.map(row => ({ ...row, title: '核对期间修改的标题' })) })
  release.resolve()
  await assert.rejects(committing, /批次已变化/)
  assert.equal(f.store.list('plans').length, 0)
  assert.equal(f.imports.get(f.actor, batch.id).rows[0].title, '核对期间修改的标题')
  f.remote.wait = undefined
  const ready = reviewBatch(f, edited)
  assert.equal((await f.service.commit(f.actor, ready.id, { version: ready.version })).committedCount, 1)
})

test('manager revocation while awaiting remote data is rechecked before writes', async t => {
  const f = fixture(t), batch = reviewBatch(f, await fetchBatch(f))
  const entered = deferred(), release = deferred()
  f.remote.entered = entered.resolve; f.remote.wait = release.promise
  const committing = f.service.commit(f.actor, batch.id, { version: batch.version })
  await entered.promise
  const stored = f.store.get<User>('users', f.actor.id)!
  f.store.update<User>('users', stored.id, stored.version, { active: false })
  release.resolve()
  await assert.rejects(committing, { status: 403 })
  assert.equal(f.store.list('plans').length, 0)
  assert.equal(f.store.list('dingtalkSourceItems').length, 0)
})

test('concurrent commits return a conflict while one read is in progress and create only once', async t => {
  const f = fixture(t), batch = reviewBatch(f, await fetchBatch(f))
  const entered = deferred(), release = deferred()
  f.remote.entered = entered.resolve; f.remote.wait = release.promise
  const committing = f.service.commit(f.actor, batch.id, { version: batch.version })
  await entered.promise
  await assert.rejects(f.service.commit(f.manager2, batch.id, { version: batch.version }), /正在核对并导入/)
  release.resolve()
  assert.equal((await committing).committedCount, 1)
  assert.equal(f.store.list('plans').length, 1)
})

test('failure when saving the source ledger rolls back all plan and batch writes', async t => {
  const f = fixture(t, 2), batch = reviewBatch(f, await fetchBatch(f))
  const insert = f.store.insert.bind(f.store)
  const mocked = t.mock.method(f.store, 'insert', (collection: string, value: Parameters<Store['insert']>[1]) => {
    if (collection === 'dingtalkSourceItems') throw new Error('合成账本写入失败')
    return insert(collection, value)
  })
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /合成账本写入失败/)
  assert.equal(f.store.list('plans').length, 0)
  assert.equal(f.store.list('dingtalkSourceItems').length, 0)
  assert.equal(f.store.list('importLinks').length, 0)
  assert.equal(f.store.list('historicalRecords').length, 0)
  assert.equal(f.imports.get(f.actor, batch.id).version, batch.version)
  assert.equal(f.imports.get(f.actor, batch.id).status, 'parsed')
  noPublicationOrNotification(f)
  mocked.mock.restore()
  assert.equal((await f.service.commit(f.actor, batch.id, { version: batch.version })).committedCount, 2)
})

test('synchronous import commit and mode changes cannot bypass remote validation or draft-only behavior', async t => {
  const f = fixture(t), batch = reviewBatch(f, await fetchBatch(f))
  assert.throws(() => f.imports.commit(f.actor, batch.id, { version: batch.version }), { code: 'DINGTALK_SOURCE_CHECK_REQUIRED' })
  assert.throws(() => f.imports.edit(f.actor, batch.id, { version: batch.version, mode: 'existing', rows: batch.rows }), /只可导入草稿/)
  assert.throws(() => f.imports.edit(f.actor, batch.id, { version: batch.version, mode: 'history', rows: batch.rows }), /只可导入草稿/)
  assert.equal(f.store.list('plans').length, 0)
  noPublicationOrNotification(f)
})

test('a new same-title local plan appearing after preview forces duplicate resolution at commit', async t => {
  const f = fixture(t), batch = reviewBatch(f, await fetchBatch(f))
  existingPlan(f)
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /逐条处理/)
  assert.equal(f.store.list('plans').length, 1)
  assert.equal(f.store.list('dingtalkSourceItems').length, 0)
})

test('changing a matched plan invalidates a previous link decision before commit', async t => {
  const f = fixture(t), plan = existingPlan(f)
  let batch = await fetchBatch(f)
  batch = f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[0].id, action: 'link', planId: plan.id, reason: '核实为同一事项' }).batch
  batch = reviewBatch(f, batch)
  f.domain.updatePlan(f.actor, plan.id, { version: plan.version, expectedOutcome: '目标已被其他管理员修改' })
  assert.equal(f.service.review(f.actor, batch.id).rows[0].requiresResolution, true)
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /逐条处理/)
  assert.equal(f.store.list('dingtalkSourceItems').length, 0)
})

test('source remarks cannot silently satisfy missing work content; correction remains possible', async t => {
  const f = fixture(t)
  f.remote.source.rows[1].cells[4] = ''
  let batch = reviewBatch(f, await fetchBatch(f))
  assert.match(batch.rows[0].expectedOutcome, /补充说明/)
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /缺少工作内容/)
  assert.equal(f.store.list('plans').length, 0)
  batch = reviewBatch(f, batch, f.actor, batch.rows.map(row => ({ ...row, expectedOutcome: `人工补充实际工作内容\n\n${row.expectedOutcome}` })))
  assert.equal((await f.service.commit(f.actor, batch.id, { version: batch.version })).committedCount, 1)
})

test('a sheet month conflict cannot be bypassed by source review or an in-month due date', async t => {
  const f = fixture(t)
  f.remote.source.sheetName = '12月目标'
  let batch = await fetchBatch(f)
  assert.equal(batch.rows[0].month, '2026-11')
  assert.equal(batch.rows[0].dueDate, '2026-11-25')
  batch = reviewBatch(f, batch)
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /工作表月份/)
  assert.equal(f.store.list('plans').length, 0)
})

test('unknown merged-cell metadata is visible in preview and still requires explicit source review', async t => {
  const f = fixture(t)
  f.remote.source.mergesKnown = false
  let batch = await fetchBatch(f)
  assert.ok(batch.warnings.some(warning => warning.includes('合并单元格')))
  assert.equal(batch.requiresCompletionReview, true)
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /逐项核对/)
  batch = reviewBatch(f, batch)
  assert.equal((await f.service.commit(f.actor, batch.id, { version: batch.version })).committedCount, 1)
})

test('date conflicts remain visible and block selected drafts until manually corrected', async t => {
  const f = fixture(t)
  f.remote.source.rows[1].cells[7] = '2026-12-01'
  let batch = reviewBatch(f, await fetchBatch(f))
  assert.equal(batch.rows[0].dueDate, '2026-12-01')
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /截止日期须在所属月份/)
  assert.equal(f.store.list('plans').length, 0)
  batch = reviewBatch(f, batch, f.actor, batch.rows.map(row => ({ ...row, dueDate: '2026-11-30' })))
  const saved = await f.service.commit(f.actor, batch.id, { version: batch.version })
  const plan = f.store.get<MonthlyPlan>('plans', saved.rows[0].result!.id)!
  assert.equal(plan.dueDate, '2026-11-30')
  assert.match(f.imports.sourcePreview(f.actor, batch.id).sheets![0].rows[1].cells[7], /2026-12-01/)
})

test('link decisions cannot target an unrelated plan and a row cannot be both linked and selected', async t => {
  const f = fixture(t), plan = existingPlan(f), unrelated = existingPlan(f, '另一个无关目标')
  let batch = await fetchBatch(f)
  assert.throws(() => f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[0].id, action: 'link', planId: unrelated.id, reason: '无效关联尝试' }), /此次差异列出/)
  batch = f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[0].id, action: 'link', planId: plan.id, reason: '确认关联原目标' }).batch
  batch = reviewBatch(f, batch, f.actor, batch.rows.map(row => ({ ...row, selected: true })))
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /勾选与来源处理结论不一致/)
  assert.equal(f.store.list('plans').length, 2)
  assert.equal(f.store.list('dingtalkSourceItems').length, 0)
})

test('a link decision becomes stale when its target is deleted and requires explicit resolution', async t => {
  const f = fixture(t), plan = existingPlan(f)
  let batch = await fetchBatch(f)
  batch = f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[0].id, action: 'link', planId: plan.id, reason: '确认关联原目标' }).batch
  batch = reviewBatch(f, batch)
  const deleted = f.domain.deletePlan(f.actor, plan.id, { version: plan.version, reason: '来源重复' })
  const review = f.service.review(f.actor, batch.id)
  assert.equal(review.rows[0].resolution, undefined)
  assert.equal(review.rows[0].requiresResolution, true)
  assert.match(review.rows[0].reason, /原目标已删除/)
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /逐条处理/)
  assert.deepEqual(f.store.get('plans', plan.id), deleted)
  assert.deepEqual(f.imports.get(f.actor, batch.id), batch)
  assert.equal(f.store.list('dingtalkSourceItems').length, 0)
  batch = f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[0].id, action: 'exclude', reason: '确认排除已删除目标来源' }).batch
  batch = reviewBatch(f, batch)
  const saved = await f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.equal(saved.committedCount, 0)
  assert.equal(saved.excludedCount, 1)
  assert.equal(f.store.list('plans').length, 1)
})

test('removing every source item by explicit exclusion records the decision without creating work', async t => {
  const f = fixture(t)
  let batch = await fetchBatch(f)
  batch = f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[0].id, action: 'exclude', reason: '经核对本期不纳入系统目标' }).batch
  batch = reviewBatch(f, batch)
  const saved = await f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.equal(saved.status, 'committed')
  assert.equal(saved.committedCount, 0)
  assert.equal(saved.excludedCount, 1)
  assert.equal(f.store.list('plans').length, 0)
  noPublicationOrNotification(f)
})

test('source aliases A and B remain linked to one corrected plan when a later source row C appears', async t => {
  const f = fixture(t)
  f.remote.source.rows[1].cells[3] = '源表旧标题A'
  let batch = await fetchBatch(f)
  batch = reviewBatch(f, batch, f.actor, batch.rows.map(row => ({ ...row, title: '人工校对新标题' })))
  const first = await f.service.commit(f.actor, batch.id, { version: batch.version })
  const planId = first.rows[0].result!.id
  const rowB = [...f.remote.source.rows[1].cells]
  rowB[0] = '2'; rowB[3] = '人工校对新标题'
  f.remote.source.rows.push({ rowNumber: 3, cells: rowB }); f.remote.source.range = 'A1:I3'
  batch = await fetchBatch(f)
  let view = f.service.review(f.actor, batch.id)
  assert.deepEqual(view.rows.map(row => row.status), ['imported', 'ambiguous'])
  batch = f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[1].id, action: 'link', planId, reason: '源表B是A校对后的同一目标，明确建立别名关联' }).batch
  batch = reviewBatch(f, batch)
  const aliasSaved = await f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.equal(aliasSaved.committedCount, 0)
  assert.deepEqual(aliasSaved.rows.map(row => row.result?.id), [planId, planId])
  assert.equal(f.store.list<{ planId: string }>('dingtalkSourceItems').filter(item => item.planId === planId).length, 2)
  const rowC = [...rowB]; rowC[0] = '3'; rowC[3] = '后续独立新增C'; rowC[4] = 'C需要独立交付'
  f.remote.source.rows.push({ rowNumber: 4, cells: rowC }); f.remote.source.range = 'A1:I4'
  batch = await fetchBatch(f)
  view = f.service.review(f.actor, batch.id)
  assert.deepEqual(view.rows.map(row => row.status), ['imported', 'imported', 'new'])
  assert.deepEqual(view.rows[0].plans.map(plan => plan.id), [planId])
  assert.equal(view.rows[0].requiresResolution, false)
  assert.equal(batch.rows[0].selected, false, 'A must never become a new selected row after B was linked')
  batch = reviewBatch(f, batch)
  const saved = await f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.equal(saved.committedCount, 1)
  assert.deepEqual(saved.rows.slice(0, 2).map(row => row.result?.id), [planId, planId])
  assert.equal(f.store.list('plans').length, 2)
  assert.equal(f.store.get<MonthlyPlan>('plans', planId)!.title, '人工校对新标题')
})

test('several source revisions and renumbered aliases of one plan never become multiple target matches or new work', async t => {
  const f = fixture(t)
  let batch = reviewBatch(f, await fetchBatch(f))
  const first = await f.service.commit(f.actor, batch.id, { version: batch.version })
  const planId = first.rows[0].result!.id
  for (const revision of [2, 3, 4]) {
    f.remote.source.rows[1].cells[4] = `源表第${revision}次修订工作内容`
    batch = await fetchBatch(f)
    const view = f.service.review(f.actor, batch.id)
    assert.equal(view.rows[0].status, 'changed')
    assert.deepEqual(view.rows[0].plans.map(plan => plan.id), [planId])
    assert.equal(view.rows[0].requiresResolution, true)
    assert.throws(() => f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[0].id, action: 'new', reason: '不能把旧来源修订重复新建' }), /不能重复新增/)
    batch = f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[0].id, action: 'link', planId, reason: `确认第${revision}版仍对应同一目标` }).batch
    batch = reviewBatch(f, batch)
    assert.equal((await f.service.commit(f.actor, batch.id, { version: batch.version })).committedCount, 0)
  }
  // The same old content is then seen under two new source numbers. Exact aliases
  // must be deduplicated by target plan, without erasing any source evidence.
  f.remote.source.rows[1].cells[4] = '源表第2次修订工作内容'
  for (const sourceNumber of ['99', '100']) {
    f.remote.source.rows[1].cells[0] = sourceNumber
    batch = await fetchBatch(f)
    const view = f.service.review(f.actor, batch.id)
    assert.equal(view.rows[0].status, 'imported')
    assert.deepEqual(view.rows[0].plans.map(plan => plan.id), [planId])
    assert.equal(view.rows[0].requiresResolution, false)
    assert.equal(view.removed.length, 0, 'historical revisions of a present target are not removed targets')
    batch = reviewBatch(f, batch)
    assert.equal((await f.service.commit(f.actor, batch.id, { version: batch.version })).committedCount, 0)
  }
  assert.equal(f.store.list('plans').length, 1)
  assert.equal(f.store.list<{ planId: string }>('dingtalkSourceItems').filter(item => item.planId === planId).length, 6)
})

for (const change of ['deleted', 'soft_deleted', 'moved'] as const) test(`an imported target ${change} from this month can be excluded while other new work proceeds`, async t => {
  const f = fixture(t)
  let batch = reviewBatch(f, await fetchBatch(f))
  const first = await f.service.commit(f.actor, batch.id, { version: batch.version })
  const plan = f.store.get<MonthlyPlan>('plans', first.rows[0].result!.id)!
  if (change === 'deleted') f.store.delete('plans', plan.id, plan.version)
  else if (change === 'soft_deleted') f.domain.deletePlan(f.actor, plan.id, { version: plan.version, reason: '确认来源重复' })
  else f.store.update<MonthlyPlan>('plans', plan.id, plan.version, { month: '2026-12', dueDate: '2026-12-25' })
  const next = [...f.remote.source.rows[1].cells]; next[0] = '2'; next[3] = '仍可处理的新增目标'; next[4] = '独立工作内容'
  f.remote.source.rows.push({ rowNumber: 3, cells: next }); f.remote.source.range = 'A1:I3'
  batch = await fetchBatch(f)
  const view = f.service.review(f.actor, batch.id)
  assert.equal(view.rows[0].status, 'imported')
  assert.deepEqual(view.rows[0].plans, [])
  assert.equal(view.rows[0].requiresResolution, true)
  if (change === 'soft_deleted') assert.match(view.rows[0].reason, /原目标已删除，请排除此来源并核对保留的目标/)
  assert.equal(view.rows[1].status, 'new')
  assert.throws(() => f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[0].id, action: 'new', reason: '不能自动重建原目标' }), /不能重复新增/)
  batch = reviewBatch(f, batch)
  await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /逐条处理/)
  batch = f.service.resolve(f.actor, batch.id, { version: batch.version, rowId: batch.rows[0].id, action: 'exclude', reason: '原目标已删除或移出本月，保留来源且不重建' }).batch
  batch = reviewBatch(f, batch)
  const saved = await f.service.commit(f.actor, batch.id, { version: batch.version })
  assert.equal(saved.committedCount, 1)
  assert.equal(saved.excludedCount, 1)
  assert.equal(saved.rows[0].result, undefined)
  assert.equal(f.store.list<MonthlyPlan>('plans').filter(item => item.month === '2026-11' && !item.deletion).length, 1)
  if (change === 'deleted') assert.equal(f.store.get('plans', plan.id), undefined)
  else if (change === 'soft_deleted') {
    assert.ok(f.store.get<MonthlyPlan>('plans', plan.id)!.deletion)
    assert.equal(f.store.list<{ planId: string }>('dingtalkSourceItems').filter(item => item.planId === plan.id).length, 1)
  }
  else assert.equal(f.store.get<MonthlyPlan>('plans', plan.id)!.month, '2026-12')
})

test('a confirmed monthly binding preselects only the same sole candidate from a complete discovery', async t => {
  const f = fixture(t)
  let candidates = [{ ...f.candidate, recommended: false }], complete = true
  t.mock.method(f.client, 'discover', async (month: string): Promise<DingTalkDocumentDiscovery> => ({ id: '', targetMonth: month, complete, warnings: [], candidates: structuredClone(candidates) }))
  const unbound = await f.service.discover(f.actor, { month: '2026-11' })
  assert.equal(unbound.recommendedCandidateId, undefined)
  await f.service.fetch(f.actor, { discoveryId: unbound.id, candidateId: f.candidate.id })
  const bound = await f.service.discover(f.manager2, { month: '2026-11' })
  assert.equal(bound.recommendedCandidateId, f.candidate.id)
  assert.equal(bound.candidates[0].recommended, true)
  candidates.push({ ...f.candidate, id: 'another-candidate', documentId: 'another-document', recommended: false })
  const multiple = await f.service.discover(f.actor, { month: '2026-11' })
  assert.equal(multiple.recommendedCandidateId, undefined)
  assert.ok(multiple.candidates.every(item => !item.recommended))
  candidates = [{ ...f.candidate, recommended: false }]; complete = false
  assert.equal((await f.service.discover(f.actor, { month: '2026-11' })).recommendedCandidateId, undefined)
  complete = true
  assert.equal((await f.service.discover(f.actor, { month: '2026-12' })).recommendedCandidateId, undefined, 'a new month cannot reuse the old monthly binding')
  candidates = [{ ...f.candidate, id: 'replacement-candidate', documentId: 'replacement-document', recommended: false }]
  assert.equal((await f.service.discover(f.actor, { month: '2026-11' })).recommendedCandidateId, undefined, 'a different sole candidate still needs confirmation')
})

test('edited titles use NFKC and whitespace normalization when detecting an existing monthly target', async t => {
  const f = fixture(t), plan = existingPlan(f, 'AI 平台')
  let batch = await fetchBatch(f)
  assert.equal(f.service.review(f.actor, batch.id).rows[0].status, 'new')
  for (const title of ['AI  平台', 'ＡＩ　 平台']) {
    batch = reviewBatch(f, batch, f.actor, batch.rows.map(row => ({ ...row, title })))
    const view = f.service.review(f.actor, batch.id)
    assert.equal(view.rows[0].status, 'ambiguous')
    assert.equal(view.rows[0].requiresResolution, true)
    assert.deepEqual(view.rows[0].plans.map(item => item.id), [plan.id])
    await assert.rejects(f.service.commit(f.actor, batch.id, { version: batch.version }), /逐条处理/)
  }
  assert.equal(f.store.list('plans').length, 1)
  assert.equal(f.store.list('dingtalkSourceItems').length, 0)
})

test('a downgraded manager can list their ordinary uploads while document batches stay hidden', async t => {
  const f = fixture(t), documentBatch = await fetchBatch(f)
  const ordinary = await f.imports.upload(f.actor, { fileName: '本人普通上传.txt', text: '本人普通资料', mode: 'history' })
  const other = await f.imports.upload(f.manager2, { fileName: '他人普通上传.txt', text: '他人普通资料', mode: 'history' })
  const stored = f.store.get<User>('users', f.actor.id)!
  f.store.update<User>('users', stored.id, stored.version, { role: 'member' })
  const visible = f.imports.list(f.actor)
  assert.ok(visible.some(batch => batch.id === ordinary.id))
  assert.ok(!visible.some(batch => batch.id === documentBatch.id))
  assert.ok(!visible.some(batch => batch.id === other.id))
  assert.throws(() => f.imports.get(f.actor, documentBatch.id), { status: 403 })
  assert.equal(f.imports.get(f.actor, ordinary.id).id, ordinary.id)
})
