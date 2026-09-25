import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readBuildVersion } from '../server/build-version.ts'

test('analytics release identifier comes from built metadata; production cannot silently combine missing or invalid releases', t => {
  const directory = mkdtempSync(join(tmpdir(), 'lab-build-version-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  assert.equal(readBuildVersion(directory, false), 'development')
  assert.throws(() => readBuildVersion(directory, true), /重新执行/)
  writeFileSync(join(directory, 'build-info.json'), JSON.stringify({ version: 'release-2026.09.24' }))
  assert.equal(readBuildVersion(directory, true), 'release-2026.09.24')
  for (const version of ['', 'contains query?token=secret', 'x'.repeat(81), null]) {
    writeFileSync(join(directory, 'build-info.json'), JSON.stringify({ version }))
    assert.throws(() => readBuildVersion(directory, true), /重新执行/)
  }
})
