import test from 'node:test'
import assert from 'node:assert/strict'
import { pageContext, pageWindow, queryKeys, queryText, readPage } from '../server/page-read-common.ts'
import { Store } from '../server/store.ts'
import type { User } from '../shared/types.ts'

test('page cursor binds actor, role, scope, revision, epoch, filters and page size', t => {
  const store = new Store(':memory:'); t.after(() => store.close())
  const actor = store.insert<User>('users', { id: 'member', name: 'member', email: 'cursor@test.invalid', position: '', role: 'member', active: true })
  const context = pageContext(store, actor), query = { q: "literal%'_", limit: 2 }
  const first = readPage(query, [1, 2, 3], context, 'test')
  assert.deepEqual(first.items, [1, 2]); assert.equal(first.total, 3)
  assert.deepEqual(readPage({ ...query, cursor: first.nextCursor! }, [1, 2, 3], context, 'test').items, [3])
  const stale = (next = context, input: Record<string, unknown> = query, scope = 'test') => assert.throws(() => pageWindow({ ...input, cursor: first.nextCursor! }, next, scope), { status: 409, code: 'WORKSPACE_CURSOR_STALE' })
  stale({ ...context, actor: { ...actor, id: 'other' } }); stale({ ...context, actor: { ...actor, role: 'manager' } })
  for (const key of ['accessScopeVersion', 'operationEpoch', 'revision'] as const) stale({ ...context, [key]: 'changed' })
  stale(context, { ...query, q: 'different' }); stale(context, { ...query, limit: 3 }); stale(context, query, 'other')
  assert.throws(() => pageWindow({ ...query, cursor: `${first.nextCursor}x` }, context, 'test'), { status: 409 })
  for (const limit of [0, 101, 1.2, 'NaN', ['1'], true, null]) assert.throws(() => pageWindow({ limit }, context, 'test'), { status: 400 })
  store.update<User>('users', actor.id, actor.version, { active: false })
  assert.throws(() => pageContext(store, actor), { status: 403 })
})

test('query validation keeps SQL metacharacters literal and rejects unknown or structured input', () => {
  assert.equal(queryText("  %_';--  "), "%_';--")
  assert.throws(() => queryText(['bad']), { status: 400 })
  assert.throws(() => queryText('a\n'), { status: 400 })
  assert.throws(() => queryKeys({ injected: true }, ['q']), { status: 400 })
})
