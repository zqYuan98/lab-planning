import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import type { Entity, User } from '../shared/types.ts'
import type { Feedback, FeedbackActionInput, FeedbackAttachmentInput, FeedbackDetailResponse } from '../shared/feedback.ts'
import type { Notification } from '../shared/notifications.ts'
import { FeedbackService, safeFeedbackContext } from '../server/feedback-service.ts'
import { validateFeedbackAttachments } from '../server/feedback-attachments.ts'
import { notificationView, openNotification, targetAccessible } from '../server/notifications.ts'
import { userDeletionPreview } from '../server/user-deletion.ts'
import { exportBusinessData } from '../server/data-transfer.ts'
import { Store } from '../server/store.ts'

// Exported by the platform PNG encoder, including valid chunk checksums and compressed pixels.
const png: FeedbackAttachmentInput = { name: '截图.png', mimeType: 'image/png', dataBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAQSURBVBhXY/jPwPCfARkAAB7zAf+x9MCaAAAAAElFTkSuQmCC' }
function fixture(t: TestContext) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const user = (id: string, role: User['role'] = 'member', active = true) => store.insert<User>('users', { id, name: `姓名-${id}`, email: `${id}@feedback.test`, role, active, position: '' })
  const disabled = user('disabled', 'manager', false), manager = user('manager', 'manager'), otherManager = user('other-manager', 'manager'), member = user('member'), other = user('other')
  const service = new FeedbackService(store)
  let request = 0
  const create = (actor = member, attachments: FeedbackAttachmentInput[] = []) => service.create(actor, { requestId: `create-${++request}`, description: '保存周报后进度未更新', attachments })
  const action = (actor: User, detail: FeedbackDetailResponse, value: Omit<FeedbackActionInput, 'version' | 'requestId'>) => service.action(actor, detail.feedback.id, { requestId: `action-${++request}`, version: detail.feedback.version, ...value })
  return { store, service, manager, otherManager, disabled, member, other, create, action }
}

test('feedback chooses the first active manager; role and reporter scopes are enforced on every access', t => {
  const { service, manager, otherManager, disabled, member, other, create } = fixture(t)
  assert.deepEqual(service.meta(member), { managers: [{ id: manager.id, name: manager.name }, { id: otherManager.id, name: otherManager.name }], defaultAssigneeId: manager.id })
  const detail = create()
  assert.equal(detail.feedback.assigneeId, manager.id)
  assert.equal(detail.feedback.reporterId, member.id)
  assert.equal(service.list(member).counts.all, 1)
  assert.equal(service.list(other).counts.all, 0)
  assert.throws(() => service.list(other, { scope: 'all' }), { status: 403 })
  assert.equal(service.list(manager, { scope: 'all' }).items.length, 1)
  assert.throws(() => service.detail(other, detail.feedback.id), { status: 404 })
  assert.throws(() => service.detail(disabled, detail.feedback.id), { status: 401 })
  assert.throws(() => service.action(other, detail.feedback.id, { requestId: 'steal', version: 1, action: 'comment', text: '无权限' }), { status: 404 })
  assert.throws(() => service.action(member, detail.feedback.id, { requestId: 'accept', version: 1, action: 'start' }), { status: 403 })
})

test('create and action retries are idempotent across stale versions; changed content cannot reuse the key', t => {
  const { service, store, manager, member } = fixture(t)
  const input = { requestId: 'fixed-create', description: '复现描述', context: { path: '/weekly?token=SECRET#access=SECRET', appVersion: '2026.9', token: 'PRIVATE' } }
  const detail = service.create(member, input), retry = service.create(member, input)
  assert.deepEqual(retry, detail)
  assert.deepEqual(detail.feedback.context, { path: '/weekly', appVersion: '2026.9' })
  assert.deepEqual(safeFeedbackContext({ path: '/work?view=weekly&month=2026-09&code=PRIVATE&search=PRIVATE#token=PRIVATE' }), { path: '/work?view=weekly&month=2026-09' })
  assert.throws(() => service.create(member, { ...input, description: '不同内容' }), { status: 409 })
  const change = { requestId: 'fixed-action', version: 1, action: 'start' as const }
  const started = service.action(manager, detail.feedback.id, change)
  const commented = service.action(member, detail.feedback.id, { requestId: 'comment', version: started.feedback.version, action: 'comment', text: '新信息' })
  assert.equal(service.action(manager, detail.feedback.id, change).feedback.version, commented.feedback.version, 'retry returns authorized current state without executing again')
  assert.throws(() => service.action(manager, detail.feedback.id, { ...change, version: 2 }), { status: 409 })
  assert.throws(() => service.action(manager, detail.feedback.id, { ...change, requestId: 'fresh-stale' }), { status: 409 })
  assert.equal(store.list('feedback').length, 1)
  assert.equal(store.list('feedbackEvents').length, 3)
  assert.equal(store.list('feedbackCommands').length, 3)
  assert.equal(JSON.stringify(store.list('feedback')).includes('SECRET'), false)
})

test('complete lifecycle distinguishes waiting, released verification, reporter confirmation, reopen and manager closure', t => {
  const { service, manager, otherManager, member, create, action } = fixture(t)
  let detail = create()
  detail = action(manager, detail, { action: 'assign', assigneeId: otherManager.id })
  detail = action(otherManager, detail, { action: 'request_info', reason: '请补充具体页面' })
  assert.equal(detail.feedback.waiting?.kind, 'request_info')
  detail = action(manager, detail, { action: 'comment', text: '管理侧说明' })
  assert.equal(detail.feedback.waiting?.kind, 'request_info', 'a manager comment does not claim the reporter has supplemented')
  detail = action(member, detail, { action: 'comment', text: '周进展页面' })
  assert.equal(detail.feedback.waiting, null)
  assert.throws(() => action(manager, detail, { action: 'defer', reason: '排期' }), { status: 400 })
  assert.throws(() => action(manager, detail, { action: 'defer', reason: '排期', reviewAt: '2000-01-01T00:00:00Z' }), { status: 400 })
  detail = action(manager, detail, { action: 'defer', reason: '下周复查', reviewAt: '2099-01-01T00:00:00Z' })
  assert.equal(detail.feedback.waiting?.reviewAt, '2099-01-01T00:00:00.000Z')
  assert.throws(() => action(manager, detail, { action: 'ready', resolution: '已修正缓存', releaseVersion: 'v2' }), { status: 400 })
  detail = action(manager, detail, { action: 'ready', resolution: '已修正缓存', releaseVersion: 'v2', released: true })
  assert.equal(detail.feedback.status, 'verification'); assert.equal(detail.feedback.closure, null)
  assert.ok(service.detail(member, detail.feedback.id).allowedActions.includes('confirm'))
  assert.throws(() => action(manager, detail, { action: 'confirm' }), { status: 409 })
  detail = action(member, detail, { action: 'reopen', reason: '手机上仍未修复' })
  assert.equal(detail.feedback.status, 'in_progress'); assert.equal(detail.feedback.releasedAt, null)
  detail = action(manager, detail, { action: 'ready', resolution: '补充手机修复', releaseVersion: 'v3', released: true })
  detail = action(member, detail, { action: 'confirm' })
  assert.equal(detail.feedback.closure?.kind, 'confirmed')
  assert.equal(detail.feedback.closure?.actorId, member.id)
  detail = action(member, detail, { action: 'reopen', reason: '问题再次出现' })
  assert.throws(() => action(manager, detail, { action: 'close', reason: ' ' }), { status: 400 })
  detail = action(manager, detail, { action: 'close', reason: '旧浏览器不在支持范围' })
  assert.equal(detail.feedback.closure?.kind, 'manager')
  assert.equal(detail.events.filter(event => event.action === 'reopen').length, 2)
})

test('duplicate links reject cycles and safely propagate results through a chain without disclosing source data or actor', t => {
  const { service, store, manager, member, other, create, action } = fixture(t)
  let primary = service.create(other, { requestId: 'private', description: 'PRIVATE description', context: { path: '/private' } })
  let second = create(), third = create()
  second = action(manager, second, { action: 'duplicate', reason: '同类现象', duplicateOfId: primary.feedback.id })
  third = action(manager, third, { action: 'duplicate', reason: '同类现象', duplicateOfId: second.feedback.id })
  assert.throws(() => action(manager, primary, { action: 'duplicate', reason: '循环', duplicateOfId: third.feedback.id }), { status: 400 })
  assert.throws(() => action(manager, primary, { action: 'duplicate', reason: '自身', duplicateOfId: primary.feedback.id }), { status: 400 })
  const view = service.detail(member, second.feedback.id)
  assert.equal(view.feedback.duplicateLinked, true); assert.equal(view.feedback.duplicateOfId, undefined)
  assert.equal(JSON.stringify(view).includes(primary.feedback.id), false)
  assert.throws(() => service.detail(member, primary.feedback.id), { status: 404 })
  primary = action(manager, primary, { action: 'ready', resolution: 'PRIVATE fix internals', releaseVersion: 'v2026.09.21', released: true })
  assert.equal(service.detail(member, second.feedback.id).feedback.status, 'verification')
  assert.equal(service.detail(member, third.feedback.id).feedback.status, 'verification')
  primary = action(other, primary, { action: 'confirm' })
  const propagated = service.detail(member, second.feedback.id), serialized = JSON.stringify(propagated)
  assert.equal(propagated.feedback.status, 'verification', 'another reporter confirmation never closes this reporter issue')
  for (const secret of ['PRIVATE', primary.feedback.id, other.id, other.name]) assert.equal(serialized.includes(secret), false, secret)
  const updates = propagated.events.filter(event => event.action === 'duplicate_update')
  assert.ok(updates.every(event => event.actorId === '' && event.actorName === '系统关联回告'))
  const note = store.list<Notification>('notifications').filter(row => row.recipientId === member.id && row.kind === 'feedback_duplicate_update').at(-1)!
  assert.equal(note.actorId, undefined)
  second = action(member, propagated, { action: 'confirm' })
  primary = action(other, primary, { action: 'reopen', reason: '复现' })
  assert.equal(service.detail(member, second.feedback.id).feedback.status, 'closed', 'independently confirmed duplicates remain closed')
  assert.equal(service.detail(member, third.feedback.id).feedback.status, 'in_progress')
})

test('image validation rejects forged, oversized, excessive and damaged images; attachments are protected and metadata-only', t => {
  const { service, manager, member, other, create, action } = fixture(t)
  assert.equal(validateFeedbackAttachments([png])[0].size, Buffer.from(png.dataBase64, 'base64').length)
  for (const input of [[{ ...png, mimeType: 'image/jpeg' }], [{ ...png, mimeType: 'image/svg+xml' }], [{ ...png, dataBase64: Buffer.from('<html>payload</html>').toString('base64') }], [{ ...png, dataBase64: png.dataBase64.slice(0, -4) }], Array(4).fill(png), [{ ...png, dataBase64: 'A'.repeat(3 * 1024 * 1024) }]]) assert.throws(() => validateFeedbackAttachments(input), { status: 400 })
  let detail = create(member, [png])
  detail = action(member, detail, { action: 'comment', attachments: [png] })
  assert.equal(detail.feedback.attachmentCount, 2)
  assert.equal(detail.attachments.length, 2)
  assert.equal(JSON.stringify(detail).includes('dataBase64'), false)
  assert.equal(JSON.stringify(service.list(manager, { scope: 'all' })).includes(png.dataBase64), false)
  const id = detail.attachments[0].id
  assert.equal(service.attachment(member, detail.feedback.id, id).dataBase64, png.dataBase64)
  assert.equal(service.attachment(manager, detail.feedback.id, id).mimeType, 'image/png')
  assert.throws(() => service.attachment(other, detail.feedback.id, id), { status: 404 })
  assert.throws(() => service.attachment(member, create().feedback.id, id), { status: 404 })
})

test('business, attachments, events, commands and notification writes roll back together on failure', t => {
  const { service, store, member } = fixture(t)
  const insert = store.insert.bind(store)
  store.insert = ((collection: string, input: never) => { if (collection === 'notifications') throw new Error('notification transaction failure'); return insert(collection, input) }) as typeof store.insert
  assert.throws(() => service.create(member, { requestId: 'atomic', description: '不能丢失', attachments: [png] }), /notification transaction failure/)
  for (const collection of ['feedback', 'feedbackAttachments', 'feedbackEvents', 'feedbackCommands', 'notifications']) assert.equal(store.list(collection).length, 0, collection)
  store.insert = insert
  const detail = service.create(member, { requestId: 'atomic', description: '不能丢失', attachments: [png] })
  assert.equal(detail.attachments.length, 1)
})

test('feedback notifications remain in-app and cannot be acknowledged as a work arrangement', t => {
  const { store, service, manager, member, create, action } = fixture(t)
  let detail = create()
  detail = action(manager, detail, { action: 'ready', resolution: '已发布', releaseVersion: '2026.09', released: true })
  const row = store.list<Notification>('notifications').find(row => row.recipientId === member.id)!
  const view = notificationView(store, member, row)
  assert.equal(view.deliveryStatus, null); assert.equal(view.canAcknowledge, false)
  assert.equal(store.list('notificationDeliveries').length, 0)
  assert.equal(store.list('notificationObligations').length, 0)
  assert.equal(view.buttonText, '查看问题反馈')
  assert.match(view.body, /待验证/)
  assert.throws(() => openNotification(store, member, row.id, true), { status: 409 })
  openNotification(store, member, row.id)
  assert.equal(service.detail(member, detail.feedback.id).feedback.status, 'verification')
  assert.equal(targetAccessible(store, member, { type: 'feedback', id: detail.feedback.id }), true)
  detail = action(member, detail, { action: 'confirm' })
  assert.match(notificationView(store, member, row).body, /提报人已验证并确认解决/)
})

test('feedback user references block deletion while feedback and screenshots stay outside business exports', t => {
  const { store, manager, member, otherManager, create, action } = fixture(t)
  let detail = create(member, [png])
  detail = action(otherManager, detail, { action: 'comment', text: '保留历史处理者' })
  assert.ok(userDeletionPreview(store, manager, member).blockers.some(row => row.key === 'feedback'))
  assert.ok(userDeletionPreview(store, manager, member).blockers.some(row => row.key === 'feedbackAttachments'))
  assert.ok(userDeletionPreview(store, manager, otherManager).blockers.some(row => row.key === 'feedbackEvents'))
  const exported = JSON.stringify(exportBusinessData(store, manager))
  assert.equal(exported.includes(detail.feedback.id), false)
  assert.equal(exported.includes(png.dataBase64), false)
})

test('the initial receiver remains an auditable user reference after reassignment; receiver filters run before counts and paging', t => {
  const { store, service, manager, otherManager, member, create, action } = fixture(t)
  const first = create(); create(); create()
  action(otherManager, first, { action: 'assign', assigneeId: otherManager.id })
  assert.ok(userDeletionPreview(store, otherManager, manager).blockers.some(row => row.key === 'feedbackEvents'))
  const assigned = service.list(otherManager, { scope: 'all', assigneeId: otherManager.id, limit: 1 })
  assert.equal(assigned.counts.all, 1); assert.equal(assigned.counts.new, 1); assert.equal(assigned.nextCursor, null)
  assert.equal(assigned.items[0].id, first.feedback.id)
  assert.throws(() => service.list(member, { assigneeId: manager.id }), { status: 403 })
})

test('a manager closing the primary sends a safe result without closing linked feedback or copying a private reason', t => {
  const { service, manager, member, other, create, action } = fixture(t)
  let primary = create(other), child = create(member)
  child = action(manager, child, { action: 'duplicate', reason: '同类问题', duplicateOfId: primary.feedback.id })
  primary = action(manager, primary, { action: 'close', reason: 'PRIVATE internal reason' })
  const view = service.detail(member, child.feedback.id)
  assert.equal(primary.feedback.closure?.kind, 'manager')
  assert.equal(view.feedback.status, 'in_progress'); assert.equal(view.feedback.closure, null)
  assert.equal(JSON.stringify(view).includes('PRIVATE'), false)
  assert.match(view.events.at(-1)!.text, /仍需单独核查/)
})

test('primary confirmation and same-release ready never undo a linked reporter failed verification', t => {
  const { service, manager, member, other, create, action } = fixture(t)
  let primary = create(other), child = create(member)
  child = action(manager, child, { action: 'duplicate', reason: '同类现象', duplicateOfId: primary.feedback.id })
  primary = action(manager, primary, { action: 'ready', resolution: '修复第一版', releaseVersion: 'v1', released: true })
  child = action(member, service.detail(member, child.feedback.id), { action: 'reopen', reason: 'v1 在我的手机上仍然失败' })
  primary = action(manager, primary, { action: 'ready', resolution: '再次说明第一版', releaseVersion: 'v1', released: true })
  assert.deepEqual(service.detail(member, child.feedback.id), child, 'same release must preserve the rejection and version')
  primary = action(other, primary, { action: 'confirm' })
  assert.deepEqual(service.detail(member, child.feedback.id), child, 'another reporter confirmation must preserve the independent failure')
  assert.throws(() => action(manager, child, { action: 'ready', resolution: '仍是第一版', releaseVersion: 'v1', released: true }), { status: 400 })
  primary = action(other, primary, { action: 'reopen', reason: '准备进一步修复' })
  primary = action(manager, primary, { action: 'ready', resolution: '新手机修复', releaseVersion: 'v2', released: true })
  const current = service.detail(member, child.feedback.id)
  assert.equal(current.feedback.status, 'verification'); assert.equal(current.feedback.releaseVersion, 'v2')
  assert.ok(current.events.some(event => event.action === 'reopen' && event.releaseVersion === 'v1' && event.text.includes('仍然失败')))
})

test('linking an existing chain to an already confirmed released primary updates every open descendant safely', t => {
  const { service, manager, member, other, create, action } = fixture(t)
  let primary = create(other), middle = create(member), child = create(member)
  child = action(manager, child, { action: 'duplicate', reason: '同类现象', duplicateOfId: middle.feedback.id })
  primary = action(manager, primary, { action: 'ready', resolution: 'PRIVATE fix internals', releaseVersion: 'v1', released: true })
  primary = action(other, primary, { action: 'confirm' })
  middle = action(manager, middle, { action: 'duplicate', reason: '关联现有修复', duplicateOfId: primary.feedback.id })
  const current = service.detail(member, child.feedback.id)
  assert.equal(middle.feedback.status, 'verification'); assert.equal(current.feedback.status, 'verification')
  assert.equal(current.feedback.releaseVersion, 'v1')
  for (const secret of ['PRIVATE', primary.feedback.id, other.id, other.name]) assert.equal(JSON.stringify(current).includes(secret), false)
  assert.equal(current.events.at(-1)!.actorName, '系统关联回告')
})

test('a disabled or demoted receiver is shown honestly and automatically reassigned with an atomic event and in-app notice', async t => {
  for (const unavailable of ['disabled', 'demoted'] as const) await t.test(unavailable, sub => {
    const { store, service, manager, otherManager, member, create } = fixture(sub)
    const detail = create()
    store.update<User>('users', manager.id, manager.version, unavailable === 'disabled' ? { active: false } : { role: 'member' })
    const list = service.list(member)
    assert.equal(list.items[0].assigneeAvailable, false); assert.match(list.items[0].assigneeName, /当前不可受理/)
    const input = { requestId: `receiver-${unavailable}`, version: detail.feedback.version, action: 'comment' as const, text: '继续补充现场情况' }
    const after = service.action(member, detail.feedback.id, input)
    assert.equal(after.feedback.assigneeId, otherManager.id); assert.equal(after.feedback.assigneeAvailable, true)
    const assignment = after.events.find(event => event.action === 'assign')!
    assert.equal(assignment.actorId, ''); assert.equal(assignment.actorName, '系统自动改派'); assert.equal(assignment.assigneeId, otherManager.id)
    assert.equal(store.list<Notification>('notifications').some(row => row.recipientId === otherManager.id && row.kind === 'feedback_assign'), true)
    assert.equal(store.list<Notification>('notifications').some(row => row.recipientId === otherManager.id && row.kind === 'feedback_comment'), true)
    assert.deepEqual(service.action(member, detail.feedback.id, input), after, 'retry must not repeat assignment or comment')
    assert.equal(store.list('notificationDeliveries').length, 0)
  })
})

test('closed feedback reopening secures a receiver, and auto-assignment rolls back with any failed notification', t => {
  const { store, service, manager, otherManager, member, create, action } = fixture(t)
  let detail = create()
  detail = action(manager, detail, { action: 'close', reason: '暂未复现' })
  store.update<User>('users', manager.id, manager.version, { active: false })
  const input = { requestId: 'reopen-receiver', version: detail.feedback.version, action: 'reopen' as const, reason: '现在可以复现' }
  const insert = store.insert.bind(store)
  store.insert = ((collection: string, input: never) => { if (collection === 'notifications') throw new Error('notification transaction failure'); return insert(collection, input) }) as typeof store.insert
  assert.throws(() => service.action(member, detail.feedback.id, input), /notification transaction failure/)
  assert.equal(store.get<Feedback>('feedback', detail.feedback.id)?.assigneeId, manager.id)
  assert.equal(store.get<Feedback>('feedback', detail.feedback.id)?.version, detail.feedback.version)
  assert.equal(service.detail(member, detail.feedback.id).events.filter(event => event.action === 'assign').length, 0)
  store.insert = insert
  const after = service.action(member, detail.feedback.id, input)
  assert.equal(after.feedback.status, 'in_progress'); assert.equal(after.feedback.assigneeId, otherManager.id)
  assert.equal(after.events.filter(event => event.action === 'assign').length, 1)
})

test('when all receivers are unavailable the command fails without losing or falsely recording the supplement', t => {
  const { store, service, manager, otherManager, member, create } = fixture(t)
  const detail = create()
  for (const user of [manager, otherManager]) store.update<User>('users', user.id, user.version, { active: false })
  assert.throws(() => service.action(member, detail.feedback.id, { requestId: 'no-receiver', version: detail.feedback.version, action: 'comment', text: '输入仍在客户端' }), { status: 409 })
  assert.equal(service.detail(member, detail.feedback.id).events.length, 1)
  assert.equal(store.list('feedbackCommands').length, 1)
})

test('feedback cursors separate equal timestamps and counts cover the entire authorized scope', t => {
  const { store, service, member, other, create } = fixture(t)
  for (let i = 0; i < 7; i++) create()
  create(other)
  for (const row of store.list<Feedback>('feedback')) {
    store.delete('feedback', row.id, row.version)
    store.restoreEntity<Feedback>('feedback', { ...row, updatedAt: '2026-09-21T00:00:00.000Z' })
  }
  const seen = new Set<string>(); let cursor: string | undefined
  do {
    const page = service.list(member, { limit: 2, cursor })
    assert.equal(page.counts.all, 7)
    for (const row of page.items) { assert.ok(!seen.has(row.id)); seen.add(row.id) }
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  assert.equal(seen.size, 7)
  assert.throws(() => service.list(member, { cursor: 'invalid' }), { status: 400 })
})
