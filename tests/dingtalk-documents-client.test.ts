import test from 'node:test'
import assert from 'node:assert/strict'
import { createDingTalkDocumentsClient, DingTalkDocumentError } from '../server/dingtalk-documents-client.ts'
import type { DingTalkDocumentCandidate } from '../shared/dingtalk-monthly-api.ts'

const env = { DINGTALK_CORP_ID: 'corp', DINGTALK_CLIENT_ID: 'app', DINGTALK_CLIENT_SECRET: 'secret-never-show', DINGTALK_DOCUMENT_OPERATOR_ID: 'union-private', DINGTALK_DOCUMENT_FOLDER_ID: 'root', DINGTALK_DOCUMENT_FOLDER_NAME: '测试目录' }
const node = { nodeId: 'doc-one', name: '2026年10月月报材料', type: 'FILE', category: 'ALIDOC', extension: 'axls', modifiedTimestamp: 1793926800000 }
const tab = { id: 'sheet-one', name: '11月目标' }
const matrix = [
  ['序号', '部门', '指标类型', '工作事项', '工作内容（做什么）', '交付产物（可量化验收标准）', '负责人', '截至时间', '备注'],
  ['1', '实验室', '重点任务', '合成任务', '完整第一行\n完整第二行', '合成验收标准', '测试成员', '2026年11月20日', ''],
]
const info = { ...tab, visibility: 'visible', rowCount: 100, columnCount: 26, lastNonEmptyRow: 1, lastNonEmptyColumn: 8 }
interface Call { url: URL; init: RequestInit; body?: unknown }
function setup(overrides: { env?: NodeJS.ProcessEnv; respond?: (call: Call, counters: { range: number; info: number }) => unknown; clock?: () => number } = {}) {
  const calls: Call[] = [], counters = { range: 0, info: 0 }
  const fetcher = (async (input: URL | RequestInfo, init: RequestInit) => {
    const call = { url: new URL(String(input)), init, body: init.body ? JSON.parse(String(init.body)) : undefined }; calls.push(call)
    if (call.url.pathname.includes('/ranges/')) counters.range++
    else if (call.url.pathname.endsWith('/sheets/sheet-one')) counters.info++
    let result = overrides.respond?.(call, counters)
    if (result === undefined) {
      if (call.url.pathname === '/v1.0/oauth2/accessToken') result = { accessToken: 'test-access-token', expireIn: 7200 }
      else if (call.url.pathname === '/v2.0/wiki/nodes') result = { nodes: [node] }
      else if (call.url.pathname.endsWith('/sheets')) result = { value: [tab, { id: 'completion', name: '10月目标完成情况' }] }
      else if (call.url.pathname.endsWith('/sheets/sheet-one')) result = info
      else if (call.url.pathname.includes('/ranges/')) result = { values: matrix, displayValues: matrix }
      else throw new Error(`Unexpected test endpoint ${call.url.pathname}`)
    }
    if (result instanceof Error) throw result
    return result instanceof Response ? result : new Response(JSON.stringify(result), { status: 200 })
  }) as typeof fetch
  const client = createDingTalkDocumentsClient({ env: overrides.env ?? env, fetch: fetcher, now: overrides.clock ?? (() => Date.parse('2026-11-06T01:00:00Z')) })
  return { client, calls, counters }
}
async function selected(m: ReturnType<typeof setup>): Promise<DingTalkDocumentCandidate> { return (await m.client.discover('2026-11')).candidates[0] }

test('document connection requires an explicit unionId and status neither requests nor reveals credentials', async () => {
  const m = setup({ env: { ...env, DINGTALK_DOCUMENT_OPERATOR_ID: '' } })
  assert.equal(m.client.status().configured, false)
  assert.equal(m.client.status().currentMonth, '2026-11')
  await assert.rejects(m.client.discover('2026-11'), (e: unknown) => e instanceof DingTalkDocumentError && e.code === 'DINGTALK_DOCUMENT_NOT_CONFIGURED')
  assert.equal(m.calls.length, 0)
  const ready = setup(); assert.equal(ready.client.status().configured, true)
  assert.doesNotMatch(JSON.stringify(ready.client.status()), /secret-never-show|union-private|test-access-token/)
  assert.equal(ready.calls.length, 0)
})

test('discovery scopes by directory, reads only metadata and never mixes completion sheets', async () => {
  const m = setup(), found = await m.client.discover('2026-11')
  assert.equal(found.complete, true); assert.equal(found.candidates.length, 1)
  assert.equal(found.recommendedCandidateId, found.candidates[0].id)
  assert.deepEqual(found.candidates[0].path, ['测试目录', '2026年10月月报材料'])
  assert.equal(m.calls.filter(c => c.url.pathname.includes('/ranges/')).length, 0)
  assert.equal(m.calls[1].url.searchParams.get('parentNodeId'), 'root')
  assert.equal(m.calls[1].url.searchParams.get('operatorId'), 'union-private')
  assert.equal(m.calls[1].url.searchParams.get('maxResults'), '50')
  assert.equal(m.calls[2].url.pathname, '/v1.0/doc/workbooks/doc-one/sheets')
  assert.equal((m.calls[1].init.headers as Record<string, string>)['x-acs-dingtalk-access-token'], 'test-access-token')
  assert.ok(m.calls.every(c => c.init.redirect === 'error'))
})

test('yearless sources and duplicate month candidates require a deliberate selection', async () => {
  const yearless = setup({ respond: c => c.url.pathname === '/v2.0/wiki/nodes' ? { nodes: [{ ...node, name: '10月月报材料' }] } : undefined })
  const a = await yearless.client.discover('2026-11')
  assert.equal(a.candidates.length, 1); assert.equal(a.recommendedCandidateId, undefined); assert.match(a.warnings.join(''), /年份/)
  const duplicates = setup({ respond: c => c.url.pathname === '/v2.0/wiki/nodes' ? { nodes: [node, { ...node, nodeId: 'doc-two' }] } : undefined })
  const b = await duplicates.client.discover('2026-11')
  assert.equal(b.candidates.length, 2); assert.equal(b.recommendedCandidateId, undefined); assert.ok(b.candidates.every(c => !c.recommended))
})

test('pagination traverses authorized child folders and does not assume the first page is complete', async () => {
  const m = setup({ respond: c => {
    if (c.url.pathname !== '/v2.0/wiki/nodes') return undefined
    if (c.url.searchParams.get('parentNodeId') === 'child') return { nodes: [node] }
    if (c.url.searchParams.get('nextToken') === 'next') return { nodes: [{ nodeId: 'child', name: '月报', type: 'FOLDER' }] }
    return { nodes: [], nextToken: 'next' }
  } })
  const found = await m.client.discover('2026-11')
  assert.equal(found.complete, true); assert.equal(found.candidates.length, 1)
  assert.deepEqual(found.candidates[0].path, ['测试目录', '月报', '2026年10月月报材料'])
})

test('repeated cursors and traversal limits are incomplete and never produce preselection', async () => {
  const repeated = setup({ respond: c => c.url.pathname === '/v2.0/wiki/nodes' ? { nodes: [node], nextToken: 'same' } : undefined })
  const a = await repeated.client.discover('2026-11')
  assert.equal(a.complete, false); assert.equal(a.recommendedCandidateId, undefined); assert.match(a.warnings.join(''), /分页游标/)
  assert.equal(repeated.calls.filter(c => c.url.pathname === '/v2.0/wiki/nodes').length, 2)
  const limited = setup({ env: { ...env, DINGTALK_DOCUMENT_MAX_NODES: '1' }, respond: c => c.url.pathname === '/v2.0/wiki/nodes' ? { nodes: [node, { ...node, nodeId: 'doc-two' }] } : undefined })
  const b = await limited.client.discover('2026-11')
  assert.equal(b.complete, false); assert.equal(b.recommendedCandidateId, undefined)
  const deep = setup({ env: { ...env, DINGTALK_DOCUMENT_MAX_DEPTH: '1' }, respond: c => c.url.pathname === '/v2.0/wiki/nodes' ? { nodes: [{ nodeId: c.url.searchParams.get('parentNodeId') === 'root' ? 'child' : 'grandchild', name: '子目录', type: 'FOLDER', hasChildren: true }] } : undefined })
  assert.equal((await deep.client.discover('2026-11')).complete, false)
})

test('pasted links cannot change host, carry credentials or bypass the source folder', async () => {
  const m = setup()
  for (const url of ['http://alidocs.dingtalk.com/i/nodes/doc-one', 'https://attacker.test/i/nodes/doc-one', 'https://user:pass@alidocs.dingtalk.com/i/nodes/doc-one', 'https://alidocs.dingtalk.com/i/nodes/doc-one?token=secret']) {
    await assert.rejects(m.client.discover('2026-11', url), (e: unknown) => e instanceof DingTalkDocumentError && e.code === 'DINGTALK_DOCUMENT_URL_INVALID')
  }
  assert.equal(m.calls.length, 0)
  await assert.rejects(m.client.discover('2026-11', 'https://alidocs.dingtalk.com/i/nodes/outsider'), (e: unknown) => e instanceof DingTalkDocumentError && e.code === 'DINGTALK_DOCUMENT_OUT_OF_SCOPE')
  assert.equal(m.calls.filter(c => c.url.pathname.includes('outsider')).length, 0)
})

test('provider denial has a useful safe error without echoing tokens, operator IDs or response messages', async () => {
  const m = setup({ respond: c => c.url.pathname === '/v2.0/wiki/nodes' ? new Response(JSON.stringify({ code: 'permissionDenied', message: 'test-access-token union-private secret-never-show https://provider.test?token=secret' }), { status: 403 }) : undefined })
  await assert.rejects(m.client.discover('2026-11'), (e: unknown) => {
    assert.ok(e instanceof DingTalkDocumentError); assert.equal(e.code, 'DINGTALK_DOCUMENT_PERMISSION_DENIED')
    assert.doesNotMatch(JSON.stringify(e) + e.message, /test-access-token|union-private|secret-never-show|provider\.test/); return true
  })
  assert.equal(m.calls.length, 2)
})

test('AccessTokenPermissionDenied is a missing document scope and does not trigger token refresh', async () => {
  const m = setup({ respond: c => c.url.pathname === '/v2.0/wiki/nodes' ? new Response(JSON.stringify({ code: 'Forbidden.AccessDenied.AccessTokenPermissionDenied', message: 'requiredScopes=Wiki.Node.Read' }), { status: 403 }) : undefined })
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(m.client.discover('2026-11'), (e: unknown) => e instanceof DingTalkDocumentError && e.code === 'DINGTALK_DOCUMENT_PERMISSION_DENIED' && e.status === 403)
  assert.equal(m.calls.filter(c => c.url.pathname.endsWith('accessToken')).length, 1)
})

test('malformed metadata is rejected rather than treated as an empty directory', async () => {
  const m = setup({ respond: c => c.url.pathname === '/v2.0/wiki/nodes' ? { nextToken: '' } : undefined })
  await assert.rejects(m.client.discover('2026-11'), (e: unknown) => e instanceof DingTalkDocumentError && e.code === 'DINGTALK_DOCUMENT_RESPONSE_INVALID')
})

test('complete range read keeps multiline text and marks merge metadata unknown', async () => {
  const m = setup(), candidate = await selected(m), snapshot = await m.client.read(candidate, '2026-11')
  assert.equal(snapshot.complete, true); assert.equal(snapshot.range, 'A1:I2'); assert.equal(snapshot.rows.length, 2)
  assert.equal(snapshot.rows[1].cells[4], '完整第一行\n完整第二行')
  assert.equal(snapshot.mergesKnown, false); assert.deepEqual(snapshot.merges, []); assert.match(snapshot.warnings!.join(''), /未提供合并/)
  assert.equal(snapshot.remoteVersion, undefined)
  assert.equal(m.counters.range, 2); assert.equal(m.counters.info, 3)
  assert.equal(m.calls.filter(c => c.url.pathname.endsWith('accessToken')).length, 1)
  assert.doesNotMatch(JSON.stringify(snapshot), /union-private|secret-never-show|test-access-token/)
})

test('missing rows, missing columns, truncated flags and unsupported cell types never yield complete snapshots', async () => {
  for (const response of [
    { values: matrix.slice(0, 1), displayValues: matrix },
    { values: matrix.map(row => row.slice(0, 8)), displayValues: matrix },
    { values: matrix, displayValues: matrix, hasMore: true },
    { values: matrix, displayValues: matrix, truncated: true },
    { values: [matrix[0], [{ unexpected: true }, ...matrix[1].slice(1)]], displayValues: matrix },
  ]) {
    const m = setup({ respond: c => c.url.pathname.includes('/ranges/') ? response : undefined })
    const candidate = await selected(m)
    await assert.rejects(m.client.read(candidate, '2026-11'), DingTalkDocumentError)
    assert.equal(m.counters.range, 1)
  }
})

test('source changes during complete reads reject the snapshot, including edits without a size change', async () => {
  const changed = matrix.map(row => [...row]); changed[1][3] = '读取中被修改'
  const m = setup({ respond: (c, counters) => c.url.pathname.includes('/ranges/') && counters.range === 2 ? { values: changed, displayValues: changed } : undefined })
  await assert.rejects(m.client.read(await selected(m), '2026-11'), (e: unknown) => e instanceof DingTalkDocumentError && e.code === 'DINGTALK_DOCUMENT_SOURCE_CHANGED' && e.status === 409)
  const resized = setup({ respond: (c, counters) => c.url.pathname.endsWith('/sheets/sheet-one') && counters.info > 1 ? { ...info, lastNonEmptyRow: 2 } : undefined })
  await assert.rejects(resized.client.read(await selected(resized), '2026-11'), (e: unknown) => e instanceof DingTalkDocumentError && e.code === 'DINGTALK_DOCUMENT_SOURCE_CHANGED')
  assert.equal(resized.counters.range, 1)
})

test('read rechecks folder membership and does not trust a previously selected path', async () => {
  let removed = false
  const m = setup({ respond: c => removed && c.url.pathname === '/v2.0/wiki/nodes' ? { nodes: [] } : undefined })
  const candidate = await selected(m); removed = true
  await assert.rejects(m.client.read({ ...candidate, path: ['forged'] }, '2026-11'), (e: unknown) => e instanceof DingTalkDocumentError && e.code === 'DINGTALK_DOCUMENT_OUT_OF_SCOPE')
  assert.equal(m.counters.range, 0)
})

test('large and empty sheets stop before fetching cells', async () => {
  for (const shape of [{ ...info, lastNonEmptyRow: -1, lastNonEmptyColumn: -1 }, { ...info, rowCount: 20000, lastNonEmptyRow: 10000 }]) {
    const m = setup({ respond: c => c.url.pathname.endsWith('/sheets/sheet-one') ? shape : undefined })
    await assert.rejects(m.client.read(await selected(m), '2026-11'), DingTalkDocumentError)
    assert.equal(m.counters.range, 0)
  }
})

test('connection identity stays stable across fetch times and secret rotation but changes with the operator', async () => {
  const first = setup(), rotated = setup({ env: { ...env, DINGTALK_CLIENT_SECRET: 'rotated' }, clock: () => Date.parse('2026-11-07T01:00:00Z') }), other = setup({ env: { ...env, DINGTALK_DOCUMENT_OPERATOR_ID: 'different-union' } })
  const a = await first.client.read(await selected(first), '2026-11'), b = await rotated.client.read(await selected(rotated), '2026-11'), c = await other.client.read(await selected(other), '2026-11')
  assert.equal(a.connectionId, b.connectionId); assert.notEqual(a.connectionId, c.connectionId)
  assert.notEqual(a.readAt, b.readAt)
})

test('concurrent discoveries share one in-flight token acquisition', async () => {
  const m = setup()
  await Promise.all([m.client.discover('2026-11'), m.client.discover('2026-11')])
  assert.equal(m.calls.filter(c => c.url.pathname.endsWith('accessToken')).length, 1)
})

test('empty pages with ever-changing cursors still obey a finite request budget', async () => {
  let pages = 0
  const m = setup({ respond: c => c.url.pathname === '/v2.0/wiki/nodes' ? { nodes: [], nextToken: `cursor-${++pages}` } : undefined })
  const found = await m.client.discover('2026-11')
  assert.equal(found.complete, false); assert.equal(pages, 50); assert.match(found.warnings.join(''), /分页查找限额/)
})

test('complete range retrieval covers every chunk using original row numbers', async () => {
  const source = Array.from({ length: 201 }, (_, index) => index ? [String(index), '实验室', '任务', `合成事项${index}`, '说明', '验收', '测试成员', '2026-11-30', ''] : matrix[0])
  const m = setup({ respond: c => {
    if (c.url.pathname.endsWith('/sheets/sheet-one')) return { ...info, rowCount: 500, lastNonEmptyRow: 200 }
    if (c.url.pathname.includes('/ranges/')) {
      const range = decodeURIComponent(c.url.pathname.split('/').at(-1)!), match = /^A(\d+):I(\d+)$/.exec(range)!
      const rows = source.slice(Number(match[1]) - 1, Number(match[2])); return { values: rows, displayValues: rows }
    }
    return undefined
  } })
  const snapshot = await m.client.read(await selected(m), '2026-11')
  assert.equal(snapshot.range, 'A1:I201'); assert.equal(snapshot.rows.length, 201)
  assert.equal(snapshot.rows[200].rowNumber, 201); assert.equal(snapshot.rows[200].cells[3], '合成事项200')
  assert.equal(m.counters.range, 4)
})

test('January discovery correctly recommends the preceding December material', async () => {
  const m = setup({ respond: c => {
    if (c.url.pathname === '/v2.0/wiki/nodes') return { nodes: [{ ...node, name: '2026年12月月报材料' }] }
    if (c.url.pathname.endsWith('/sheets')) return { value: [{ ...tab, name: '1月目标' }, { id: 'last-year', name: '11月目标' }] }
    return undefined
  } })
  const found = await m.client.discover('2027-01')
  assert.equal(found.candidates.length, 1); assert.equal(found.candidates[0].sheetName, '1月目标')
  assert.equal(found.recommendedCandidateId, found.candidates[0].id)
})

test('official Wiki titles may include .axls and keep their original source spelling', async () => {
  const m = setup({ respond: c => c.url.pathname === '/v2.0/wiki/nodes' ? { nodes: [{ ...node, name: '2026年10月月报材料.axls' }] } : undefined })
  const found = await m.client.discover('2026-11')
  assert.equal(found.candidates[0].documentTitle, '2026年10月月报材料.axls')
  assert.equal(found.recommendedCandidateId, found.candidates[0].id)
})
