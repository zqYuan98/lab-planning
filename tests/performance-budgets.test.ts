import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertPerformanceBudget, budgetViolations, performanceBudgets, type PerformanceEndpoint } from '../scripts/r2-performance-budgets.ts'
import { performanceFixture } from '../scripts/r2-performance-fixture.ts'

test('performance ceilings fail at every exceeded dimension, including non-finite measurements', () => {
  for (const endpoint of Object.keys(performanceBudgets) as PerformanceEndpoint[]) {
  const actual = { ...performanceBudgets[endpoint] }
  assert.deepEqual(budgetViolations(endpoint, actual), [])
  for (const key of ['sql', 'parsedRows', 'parsedBytes', 'responseBytes'] as const) {
    for (const value of [actual[key] + 1, NaN, Infinity, -1]) assert.throws(() => assertPerformanceBudget(endpoint, { ...actual, [key]: value }), /Performance budget failed/)
  }
  }
})

test('a deliberately reduced budget makes the actual performance command report failure and exit nonzero', t => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-performance-gate-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const entry = new URL('../scripts/r2-performance.ts', import.meta.url).href
  const budgets = new URL('../scripts/r2-performance-budgets.ts', import.meta.url).href
  const code = `import {performanceBudgets} from ${JSON.stringify(budgets)};
    performanceBudgets.shell.sql = 0;
    process.chdir(${JSON.stringify(directory)});
    process.argv = ['node', 'r2-performance', '--months=12'];
    await import(${JSON.stringify(entry)});`
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { cwd: process.cwd(), encoding: 'utf8', timeout: 60_000 })
  assert.ifError(result.error)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /Performance budget failed/)
  const evidence = JSON.parse(readFileSync(join(directory, 'output/r2-performance/results.json'), 'utf8'))
  assert.equal(evidence.passed, false)
  assert.ok(evidence.failures.some((failure: string) => failure.includes('shell.sql')))
  assert.equal(evidence.comparisons.length, 3)
})

test('fixed synthetic fixture includes multi-member membership history, tombstones and revoked observer grants', () => {
  const first = performanceFixture(1), second = performanceFixture(1)
  try {
    assert.deepEqual(first.counts, second.counts)
    for (const collection of ['plans', 'tasks', 'weeklyRecords', 'events', 'publications', 'progressEvents', 'reports', 'objectGrants']) assert.deepEqual(first.store.list(collection), second.store.list(collection), collection)
    assert.equal(first.counts.members, 15)
    assert.equal(first.counts.tasks, 30)
    assert.equal(first.counts.weeklyRecords, 120)
    assert.throws(() => performanceFixture(0))
  } finally { first.store.close(); second.store.close() }
})
