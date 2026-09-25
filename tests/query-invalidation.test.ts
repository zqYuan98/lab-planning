import test from 'node:test'
import assert from 'node:assert/strict'
import { queryAffected, isReadOnlyCommand, shellAffected } from '../src/query-invalidation.ts'
import { workspaceQueryReader } from '../src/workspace-query-state.ts'
import { captureMutationContext, publishMutationResponse } from '../src/mutation-response.ts'

test('business dependencies refresh relevant pages and leave unrelated reads alone', () => {
  for (const page of ['/workspace/weekly?weekStart=2026-09-21', '/workspace/overview/personal', '/workspace/register']) assert.equal(queryAffected(page, '/tasks/one'), true)
  for (const page of ['/workspace/team', '/workspace/projects', '/workspace/annual-goals', '/workspace/reports', '/feedback']) assert.equal(queryAffected(page, '/tasks/one'), false)
  assert.equal(isReadOnlyCommand('/report-agent/templates/one/preview'), false, 'template preview persists an asset and a new template version')
  assert.equal(queryAffected('/workspace/reports', '/report-agent/templates/one/preview'), true)
  assert.equal(queryAffected('/workspace/overview/department', '/deadline-requests/one/decide'), true)
  assert.equal(queryAffected('/collaboration', '/collaboration/settings'), true)
  assert.equal(queryAffected('/workspace/projects', '/plans/one'), true)
  assert.equal(queryAffected('/workspace/annual-goals', '/annual-goals/one'), true)
  assert.equal(queryAffected('/native/settings', '/tasks/one'), false)
  assert.equal(queryAffected('/native/settings', '/native/settings'), true)
  assert.equal(queryAffected('/native/settings', '/dingtalk/bind'), true)
  assert.equal(queryAffected('/native/settings', '/users/one'), true)
  for (const page of ['/workspace/team', '/workspace/weekly', '/workspace/reports']) assert.equal(queryAffected(page, '/data/restore/commit'), true)
})

test('read-only previews keep mutation-context checks but never invalidate readers', async () => {
  const previews = ['/weekly-submissions/deadline-repair/preview', '/carry-workflows/preview', '/carry-workflows/one/preview-apply', '/followups/preview', '/data/restore/preview', '/period-reviews/preview', '/workspace/import-references']
  let reads = 0
  const reader = workspaceQueryReader({ load: async () => ++reads, accept: () => {}, clear: () => {}, error: () => {}, loading: () => {} })
  try {
    await reader.read()
    for (const path of previews) { assert.equal(isReadOnlyCommand(path), true); publishMutationResponse(captureMutationContext(), path, {}) }
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(reads, 1)
    assert.equal(publishMutationResponse(captureMutationContext() - 1, previews[0], {}), false)
  } finally { reader.dispose() }
})

test('business R4 refreshes progress aggregates and derived permissions after their source mutations', () => {
  for (const read of ['/workspace/annual-goals?year=2026', '/workspace/annual-goals/one']) {
    for (const mutation of ['/plans/one/accept', '/months/publish', '/carry-workflows/one/apply', '/annual-goals/one']) assert.equal(queryAffected(read, mutation), true)
    assert.equal(queryAffected(read, '/tasks/one'), false)
  }
  for (const read of ['/workspace/goal-owner/plans/one/tasks', '/weekly-review-queue?week=2026-09-21']) {
    for (const mutation of ['/tasks/one', '/plans/one', '/weekly-submissions/submit', '/users/one', '/data/restore/commit']) assert.equal(queryAffected(read, mutation), true)
  }
  assert.equal(queryAffected('/weekly-review-queue', '/weekly-review-delegation'), true)
  for (const mutation of ['/plans/one', '/months/publish', '/weekly-review-delegation']) assert.equal(shellAffected(mutation), true)
})

test('unrelated mutation does not abort a pending page read, relevant mutation refreshes with its receipt', async () => {
  let reads = 0, value = 0
  const reader = workspaceQueryReader({ load: async () => ++reads, accept: next => { value = next }, clear: () => {}, error: () => {}, loading: () => {}, affected: path => queryAffected('/workspace/annual-goals', path) })
  try {
    await reader.read()
    publishMutationResponse(captureMutationContext(), '/feedback', {})
    await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 1)
    publishMutationResponse(captureMutationContext(), '/annual-goals/one', {})
    await new Promise(resolve => setImmediate(resolve)); assert.equal(reads, 2); assert.equal(value, 2)
  } finally { reader.dispose() }
})
