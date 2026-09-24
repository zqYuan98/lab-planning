import test, { type TestContext } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { AuditEvent, Entity, User } from '../shared/types.ts'
import { createApp } from '../server/app.ts'
import { createSession, type StoredUser } from '../server/auth.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'
import { Domain } from '../server/domain.ts'
import { createIntegrationToken } from '../server/integration-auth.ts'
import { Store } from '../server/store.ts'

const password = 'Account-deletion-test-2026'
function fixture(t: TestContext) {
  const store = new Store(':memory:')
  t.after(() => store.close())
  const domain = new Domain(store)
  const manager = domain.setup({ name: '负责人', email: 'manager@delete.test', password })
  const member = domain.createUser(manager, { name: '测试成员', email: 'member@delete.test', password, role: 'member' })
  return { store, domain, manager, member }
}
const request = (user: User) => ({ version: user.version, confirmName: user.name })

test('an unused account can be deleted without erasing lifecycle audits or another account credentials', t => {
  const { store, domain, manager, member } = fixture(t)
  const target = domain.updateUser(manager, member.id, { version: member.version, role: 'manager' })
  createSession(store, store.get<StoredUser>('users', target.id)!)
  createSession(store, store.get<StoredUser>('users', manager.id)!)
  createIntegrationToken(store, target, { name: '未使用令牌' })
  createIntegrationToken(store, manager, { name: '仍在使用的负责人令牌' })
  const previousEvents = store.list<AuditEvent>('events')
  const preview = domain.userDeletionPreview(manager, target.id)
  assert.equal(preview.canDelete, true)
  assert.deepEqual(preview.blockers, [])
  assert.equal(JSON.stringify(preview).includes('passwordHash'), false)
  assert.equal(JSON.stringify(preview).includes('credentialVersion'), false)
  assert.deepEqual(domain.deleteUser(manager, target.id, request(target)), { deleted: true, id: target.id })
  assert.equal(store.get('users', target.id), undefined)
  assert.equal(store.list<{ userId: string }>('sessions').some(row => row.userId === target.id), false)
  assert.equal(store.list<{ userId: string }>('integrationTokens').some(row => row.userId === target.id), false)
  assert.equal(store.list('sessions').length, 1)
  assert.equal(store.list('integrationTokens').length, 1)
  assert.deepEqual(store.list<AuditEvent>('events').slice(0, previousEvents.length), previousEvents)
  const deleted = store.list<AuditEvent>('events').at(-1)!
  assert.equal(deleted.action, 'delete')
  assert.equal(deleted.entityId, target.id)
  assert.deepEqual(deleted.before, target)
  assert.equal(deleted.after, null)
  assert.equal(JSON.stringify(deleted).includes('passwordHash'), false)
  assert.throws(() => domain.login({ email: target.email, password }), { status: 401 })
  const replacement = domain.createUser(manager, { name: target.name, email: target.email, password, role: 'member' })
  assert.notEqual(replacement.id, target.id, 'reused email cannot take the removed identity')
})

test('pending, rejected and disabled unused accounts remain deletable despite their own lifecycle history', t => {
  const { store, domain, manager, member } = fixture(t)
  const disabled = domain.updateUser(manager, member.id, { version: member.version, active: false })
  domain.deleteUser(manager, disabled.id, request(disabled))
  for (const decision of ['pending', 'rejected'] as const) {
    domain.register({ name: '待核对成员', email: `${decision}@delete.test`, password })
    let applicant = store.list<User>('users').find(user => user.email === `${decision}@delete.test`)!
    if (decision === 'rejected') applicant = domain.reviewRegistration(manager, applicant.id, { version: applicant.version, decision: 'reject', comment: '误注册' })
    assert.equal(domain.userDeletionPreview(manager, applicant.id).canDelete, true)
    domain.deleteUser(manager, applicant.id, request(applicant))
  }
  assert.equal(store.list('users').length, 1)
})

test('deletion requires a current active manager, fresh version and explicit matching identity', t => {
  const { store, domain, manager, member } = fixture(t)
  assert.throws(() => domain.userDeletionPreview(member, manager.id), { status: 403 })
  assert.throws(() => domain.deleteUser(member, manager.id, request(manager)), { status: 403 })
  assert.throws(() => domain.deleteUser(manager, member.id, { version: member.version }), { status: 400 })
  assert.throws(() => domain.deleteUser(manager, member.id, { ...request(member), confirmName: '其他人' }), { status: 400 })
  assert.throws(() => domain.deleteUser(manager, member.id, { confirmName: member.name }), { status: 409 })
  const changed = domain.updateUser(manager, member.id, { version: member.version, name: '更新姓名' })
  assert.throws(() => domain.deleteUser(manager, member.id, request(member)), { status: 409 })
  assert.equal(domain.userDeletionPreview(manager, manager.id).blockers.some(row => row.key === 'self'), true)
  assert.equal(domain.userDeletionPreview(manager, manager.id).blockers.some(row => row.key === 'lastManager'), true)
  assert.throws(() => domain.deleteUser(manager, manager.id, request(manager)), { status: 409 })
  const second = domain.createUser(manager, { name: '第二负责人', email: 'second@delete.test', password, role: 'manager' })
  const demoted = domain.updateUser(manager, second.id, { version: second.version, role: 'member' })
  assert.throws(() => domain.deleteUser(second, changed.id, request(changed)), { status: 403 })
  store.update<User>('users', demoted.id, demoted.version, { role: 'manager', active: false })
  assert.throws(() => domain.userDeletionPreview(second, changed.id), { status: 403 })
  assert.throws(() => domain.deleteUser(second, changed.id, request(changed)), { status: 403 })
  assert.ok(store.get('users', changed.id))
})

test('business owners, collaborators, operation actors and immutable nested snapshots block deletion', t => {
  const { store, domain, manager, member } = fixture(t)
  const user = member.id
  const managerId = manager.id
  const plan = { id: 'nested-plan', ownerId: managerId, collaboratorIds: [user] }
  const weekly = { id: 'nested-weekly', ownerId: managerId, workOrigin: { actorId: user } }
  const cases: Array<[string, Record<string, unknown>, string?]> = [
    ['projects', { ownerId: user }], ['annualGoals', { ownerId: user }],
    ['plans', { ownerId: managerId, collaboratorIds: [user] }], ['tasks', { ownerId: user }],
    ['tasks', { ownerId: managerId, workOrigin: { actorId: user } }], ['weeklyRecords', { ownerId: user }],
    ['weeklyRecords', weekly], ['historicalRecords', { importedBy: user, row: { ownerId: managerId } }, 'history'],
    ['historicalRecords', { importedBy: managerId, row: { ownerId: user } }, 'history'],
    ['publications', { actorId: managerId, plans: [plan] }], ['publications', { actorId: user, plans: [] }],
    ['reports', { authorId: user, snapshot: {} }], ['reports', { authorId: managerId, snapshot: { users: [member] } }],
    ['reports', { authorId: managerId, snapshot: { nextPlans: [plan] } }],
    ['reports', { authorId: managerId, snapshot: { nextWeeklyRecords: [weekly] } }],
    ['reports', { authorId: managerId, snapshot: { weeklySubmissions: [{ ownerId: user }] } }],
    ['events', { entityType: 'task', actorId: user, entityId: 'task', before: null, after: null }],
    ['events', { entityType: 'plan', actorId: managerId, entityId: 'plan', before: plan, after: null }],
    ['events', { entityType: 'import', actorId: user, entityId: 'batch', before: null, after: null }],
    ['events', { entityType: 'integrationCall', actorId: user, entityId: 'token', before: null, after: null }],
    ['events', { entityType: 'dataRestore', actorId: user, entityId: 'restore', before: null, after: null }],
  ]
  for (const [collection, fields, key = collection] of cases) {
    const item = store.insert<Entity & Record<string, unknown>>(collection, fields)
    const preview = domain.userDeletionPreview(manager, user)
    assert.equal(preview.canDelete, false, `${collection}: ${JSON.stringify(fields)}`)
    assert.equal(preview.blockers.find(row => row.key === key)?.count, 1)
    assert.throws(() => domain.deleteUser(manager, user, request(member)), { status: 409 })
    assert.deepEqual(store.get(collection, item.id), item)
    store.delete(collection, item.id, item.version)
  }
  assert.equal(domain.userDeletionPreview(manager, user).canDelete, true)
})

test('frozen weekly roster, obligations, submissions, missing and adjustments all retain the account', t => {
  const { store, domain, manager, member } = fixture(t)
  const user = member.id
  const cases: Array<[string, Record<string, unknown>]> = [
    ['weeklyCycles', { rosterIds: [user], confirmedBy: null }],
    ['weeklyCycles', { rosterIds: [], confirmedBy: user }],
    ['weeklyDuties', { ownerId: user }],
    ['weeklyMissing', { ownerId: user }],
    ['weeklyAdjustments', { ownerId: manager.id, actorId: user }],
    ['weeklyAdjustments', { ownerId: user, actorId: manager.id }],
    ['weeklySubmissions', { ownerId: user, actorId: manager.id, records: [], retainedDraftIds: [], retainedDraftManifest: [] }],
    ['weeklySubmissions', { ownerId: manager.id, actorId: user, records: [], retainedDraftIds: [], retainedDraftManifest: [] }],
    ['weeklySubmissions', { ownerId: manager.id, actorId: manager.id, records: [{ ownerId: user }], retainedDraftIds: [], retainedDraftManifest: [] }],
  ]
  for (const [collection, fields] of cases) {
    const item = store.insert<Entity & Record<string, unknown>>(collection, fields)
    assert.equal(domain.userDeletionPreview(manager, user).blockers.find(row => row.key === collection)?.count, 1)
    assert.throws(() => domain.deleteUser(manager, user, request(member)), { status: 409 })
    store.delete(collection, item.id, item.version)
  }
})

test('uncommitted import ownership and matched rows block deletion, including running and retained sources', t => {
  const { store, domain, manager, member } = fixture(t)
  const cases: Array<[string, Record<string, unknown>]> = [
    ['importBatches', { ownerId: member.id, rows: [] }],
    ['importBatches', { ownerId: manager.id, rows: [{ ownerId: member.id }] }],
    ['importSources', { ownerId: member.id }],
    ['importJobs', { ownerId: member.id, status: 'running' }],
    ['importJobs', { ownerId: member.id, status: 'completed' }],
    ['importParsedChunks', { rows: [{ ownerId: member.id }] }],
  ]
  for (const [collection, fields] of cases) {
    const item = store.insert<Entity & Record<string, unknown>>(collection, fields)
    assert.equal(domain.userDeletionPreview(manager, member.id).blockers.find(row => row.key === collection)?.count, 1)
    assert.throws(() => domain.deleteUser(manager, member.id, request(member)), { status: 409 })
    store.delete(collection, item.id, item.version)
  }
})

test('execution rechecks references added after preview and keeps historic assignment after reassignment', t => {
  const { store, domain, manager, member } = fixture(t)
  assert.equal(domain.userDeletionPreview(manager, member.id).canDelete, true)
  const project = domain.createProject(manager, { name: '新增关联', code: 'NEW', ownerId: member.id })
  assert.throws(() => domain.deleteUser(manager, member.id, request(member)), { status: 409 })
  domain.updateProject(manager, project.id, { version: project.version, ownerId: manager.id })
  const preview = domain.userDeletionPreview(manager, member.id)
  assert.equal(preview.blockers.some(row => row.key === 'projects'), false)
  assert.equal(preview.blockers.some(row => row.key === 'events'), true)
  assert.throws(() => domain.deleteUser(manager, member.id, request(member)), { status: 409 })
  assert.equal(store.list('projects').length, 1)
})

test('delivery and decision identities, revoked grants, frozen scoped reports and command actors retain accounts', t => {
  const { store, domain, manager, member } = fixture(t)
  const id = member.id, managerId = manager.id
  const cases: Array<[string, Record<string, unknown>]> = [
    ['deliverySeries', { reviewerId: id }],
    ['taskDeliveries', { ownerId: id, submittedBy: managerId, reviewerIdSnapshot: managerId, deadlineBasisRefs: [] }],
    ['taskDeliveries', { ownerId: managerId, submittedBy: id, reviewerIdSnapshot: null, deadlineBasisRefs: [] }],
    ['taskDeliveries', { ownerId: managerId, submittedBy: managerId, reviewerIdSnapshot: id, deadlineBasisRefs: [] }],
    ['deliveryDecisions', { decidedBy: id }],
    ['decisionRequests', { decisionOwnerId: id, requestedBy: managerId, decidedBy: null }],
    ['decisionRequests', { decisionOwnerId: managerId, requestedBy: id, decidedBy: null }],
    ['decisionRequests', { decisionOwnerId: managerId, requestedBy: managerId, decidedBy: id }],
    ['objectGrants', { subjectId: id, grantedBy: managerId, revokedAt: '2026-09-22T01:00:00.000Z' }],
    ['objectGrants', { subjectId: managerId, grantedBy: id }],
    ['scopedReports', { subjectId: id, finalizedBy: managerId }],
    ['scopedReports', { subjectId: managerId, finalizedBy: id }],
    ...['objectAccessCommands', 'collaborationCommandReceipts', 'workRegisterCaptures', 'weeklyAssignmentRequests', 'monthlyCarryRequests'].map(collection => [collection, { actorId: id }] as [string, Record<string, unknown>]),
  ]
  for (const [collection, fields] of cases) {
    const row = store.insert<Entity & Record<string, unknown>>(collection, fields)
    const blocker = domain.userDeletionPreview(manager, id).blockers.find(item => item.key === collection)
    assert.equal(blocker?.count, 1, `${collection}: ${JSON.stringify(fields)}`)
    assert.ok(blocker?.label)
    assert.throws(() => domain.deleteUser(manager, id, request(member)), { status: 409 })
    assert.deepEqual(store.get(collection, row.id), row)
    store.delete(collection, row.id, row.version)
  }
  assert.equal(domain.userDeletionPreview(manager, id).canDelete, true)
})

test('delivery and decision audit snapshots retain prior responsibility after reassignment', t => {
  const { store, domain, manager, member } = fixture(t)
  for (const [entityType, snapshot] of [
    ['deliverySeries', { reviewerId: member.id }], ['taskDelivery', { ownerId: member.id, deadlineBasisRefs: [] }],
    ['deliveryDecision', { decidedBy: member.id }], ['decisionRequest', { decisionOwnerId: member.id }],
  ] as const) {
    const event = store.insert<AuditEvent>('events', { entityType, entityId: 'historical', actorId: manager.id, action: 'reassign', reason: '', before: snapshot, after: null })
    assert.equal(domain.userDeletionPreview(manager, member.id).blockers.find(row => row.key === 'events')?.count, 1, entityType)
    assert.throws(() => domain.deleteUser(manager, member.id, request(member)), { status: 409 })
    store.delete('events', event.id, event.version)
  }
})

test('audit failure rolls back account and credential deletion atomically', t => {
  const { store, domain, manager, member } = fixture(t)
  createSession(store, store.get<StoredUser>('users', member.id)!)
  store.insert<Entity & { userId: string; memberActionsEnabled: boolean }>('collaborationPreferences', { id: member.id, userId: member.id, memberActionsEnabled: false })
  const userBefore = store.get('users', member.id)
  const sessionsBefore = store.list('sessions')
  const preferencesBefore = store.list('collaborationPreferences')
  const originalInsert = store.insert.bind(store)
  store.insert = ((collection: string, input: never) => { if (collection === 'events') throw new Error('audit unavailable'); return originalInsert(collection, input) }) as typeof store.insert
  assert.throws(() => domain.deleteUser(manager, member.id, request(member)), /audit unavailable/)
  store.insert = originalInsert
  assert.deepEqual(store.get('users', member.id), userBefore)
  assert.deepEqual(store.list('sessions'), sessionsBefore)
  assert.deepEqual(store.list('collaborationPreferences'), preferencesBefore)
})

test('business export and restore remain complete after unused account removal; credentials and lifecycle stay local', t => {
  const source = fixture(t)
  source.domain.createProject(source.manager, { name: '保留项目', code: 'PRESERVED' })
  source.domain.deleteUser(source.manager, source.member.id, request(source.member))
  const packet = exportBusinessData(source.store, source.manager)
  assert.equal(packet.collections.users.some(row => row.id === source.member.id), false)
  assert.equal(packet.collections.events.some(row => row.entityType === 'user'), false)
  const target = fixture(t)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  assert.equal(target.store.list('projects').length, 1)
  assert.equal(JSON.stringify(packet).includes('passwordHash'), false)
})

test('HTTP preview/delete enforce authentication, manager access, same origin, version and session invalidation', async t => {
  const { store, domain, manager, member } = fixture(t)
  const server = createApp({ store }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const managerCookie = `lab_session=${createSession(store, store.get<StoredUser>('users', manager.id)!)}`
  const memberCookie = `lab_session=${createSession(store, store.get<StoredUser>('users', member.id)!)}`
  const send = async (path: string, cookie: string, method = 'GET', body?: unknown, from = origin) => fetch(`${origin}/api${path}`, {
    method, headers: { cookie, origin: from, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const previewPath = `/users/${member.id}/deletion-preview`
  assert.equal((await send(previewPath, '')).status, 401)
  assert.equal((await send(previewPath, memberCookie)).status, 403)
  const preview = await send(previewPath, managerCookie)
  assert.equal(preview.status, 200)
  assert.equal((await preview.json()).canDelete, true)
  assert.equal((await send(`/users/${member.id}`, managerCookie, 'DELETE', request(member), 'https://other.test')).status, 403)
  assert.equal((await send(`/users/${member.id}`, memberCookie, 'DELETE', request(member))).status, 403)
  assert.equal((await send(`/users/${member.id}`, managerCookie, 'DELETE', { ...request(member), version: 99 })).status, 409)
  const removed = await send(`/users/${member.id}`, managerCookie, 'DELETE', request(member))
  assert.equal(removed.status, 200)
  assert.deepEqual(await removed.json(), { deleted: true, id: member.id })
  assert.equal((await send('/bootstrap', memberCookie)).status, 401)
  assert.equal((await send(previewPath, managerCookie)).status, 404)
  assert.equal(domain.bootstrap(manager).users.some(user => user.id === member.id), false)
})
