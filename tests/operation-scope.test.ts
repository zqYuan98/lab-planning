import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { storeScope } from '../server/operation-scope.ts'
import { isSilentImport, withSilentImport } from '../server/import-notification-context.ts'

test('a store-scoped value is visible inside its operation only, even across awaits', async t => {
  const store = new Store(':memory:'), other = new Store(':memory:')
  t.after(() => { store.close(); other.close() })
  const scope = storeScope<string>()
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  const running = scope.run(store, 'A', async () => {
    assert.equal(scope.get(store), 'A')
    await gate
    assert.equal(scope.get(store), 'A', 'the value survives its own await')
    return scope.get(other)
  })
  // Runs while operation A is waiting: a module-level map keyed by store would leak 'A' here.
  assert.equal(scope.get(store), undefined)
  assert.equal(scope.has(store), false)
  release()
  assert.equal(await running, undefined, 'values are per store')
  assert.equal(scope.get(store), undefined)
})

test('nested scopes shadow and restore, and exceptions clear the value', () => {
  const store = new Store(':memory:')
  try {
    const scope = storeScope<number>()
    scope.run(store, 1, () => {
      scope.run(store, 2, () => assert.equal(scope.get(store), 2))
      assert.equal(scope.get(store), 1)
    })
    assert.throws(() => scope.run(store, 3, () => { throw new Error('boom') }), /boom/)
    assert.equal(scope.has(store), false)
    assert.equal(withSilentImport(store, () => isSilentImport(store)), true)
    assert.equal(isSilentImport(store), false)
  } finally { store.close() }
})
