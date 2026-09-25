import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { cpus, platform, release, totalmem } from 'node:os'
import { resolve } from 'node:path'
import { TestDomain as Domain } from '../tests/fixtures/legacy-domain.ts'
import { PeriodWorkspaceService } from '../server/period-workspace.ts'
import { OverviewWorkspaceService } from '../server/overview-workspace.ts'
import { DirectoryWorkspaceService } from '../server/directory-workspace.ts'
import { ImportWorkspaceService } from '../server/import-workspace.ts'
import { TaskViewService } from '../server/task-view.ts'
import { collaborationDashboard } from '../server/collaboration-query.ts'
import { WorkspaceQueryService } from '../server/workspace-query.ts'
import type { Store } from '../server/store.ts'
import { legacyBootstrap } from '../tests/fixtures/r2-baseline/domain.ts'
import { performanceFixture, performanceNow, performanceSeed } from './r2-performance-fixture.ts'
import { assertPerformanceBudget, performanceBudgets, type PerformanceEndpoint, type ReadMeasurement } from './r2-performance-budgets.ts'

const args = process.argv.slice(2)
if (args.some(arg => !['--months=12', '--months=36'].includes(arg)) || args.length > 1) throw new Error('Usage: npm run perf [-- --months=12|--months=36]; no option checks both scales')
const scales = args.length ? [Number(args[0].split('=')[1])] : [12, 36]
const directory = resolve('output/r2-performance')
mkdirSync(directory, { recursive: true })
const baselineManifest = JSON.parse(readFileSync(new URL('../tests/fixtures/r2-baseline/manifest.json', import.meta.url), 'utf8'))
const failures: string[] = [], results: unknown[] = [], comparisons: unknown[] = [], queryPlans: unknown[] = []
const sha = (value: string) => createHash('sha256').update(value).digest('hex')
interface Sample extends ReadMeasurement { returnedRows: number; elapsedMs: number }
function measure(store: Store, run: () => unknown) {
  store.resetReadMetrics()
  const start = performance.now(), body = JSON.stringify(run())
  const sample: Sample = { elapsedMs: performance.now() - start, responseBytes: Buffer.byteLength(body), ...store.getReadMetrics() }
  return { body, sample }
}
function summarize(samples: Sample[]) {
  const times = samples.map(row => row.elapsedMs).sort((a, b) => a - b)
  return { p50Ms: times[Math.ceil(times.length * .5) - 1], p95Ms: times[Math.ceil(times.length * .95) - 1], samples }
}
try {
  for (const months of scales) {
    const fixture = performanceFixture(months), { store, actors, counts } = fixture
    try {
      const domain = new Domain(store), queries = new WorkspaceQueryService(store), periods = new PeriodWorkspaceService(store), overview = new OverviewWorkspaceService(store, () => new Date(performanceNow)), directoryQueries = new DirectoryWorkspaceService(store), imports = new ImportWorkspaceService(store), taskView = new TaskViewService(store)
      queryPlans.push({ months, entity: store.entityEventsExplain('plan', 'plan-2026-09-0'), entityType: store.entityEventsExplain('plan') })
      for (const [role, actor] of Object.entries(actors)) {
        // Two independently frozen old runs, then two warmups and seven new runs.
        const baseline = measure(store, () => legacyBootstrap(store, actor, true, false, new Date(performanceNow)))
        const baselineSecond = measure(store, () => legacyBootstrap(store, actor, true, false, new Date(performanceNow)))
        const current = measure(store, () => domain.bootstrap(actor, true, false, new Date(performanceNow)))
        const matches = current.body === baseline.body && baselineSecond.body === baseline.body
        comparisons.push({ months, role, byteIdentical: matches, baselineSha256: sha(baseline.body), currentSha256: sha(current.body) })
        if (!matches) failures.push(`${months} months ${role}: bootstrap differs from frozen 65317c6 baseline`)
        const oldRow = { months, role, endpoint: 'bootstrap', implementation: '65317c6-frozen', counts, ...summarize([baseline.sample, baselineSecond.sample]) }
        results.push(oldRow)
        console.log(JSON.stringify({ months, role, endpoint: 'bootstrap', implementation: 'baseline', p95Ms: oldRow.p95Ms, ...baseline.sample }))
        const actions: [PerformanceEndpoint, () => unknown][] = [
          ['bootstrap', () => domain.bootstrap(actor, true, false, new Date(performanceNow))],
          ['shell', () => queries.shell(actor)],
          ...(actor.role === 'observer' ? [] : [['tasks', () => queries.page(actor, 'tasks', { limit: 50 })] as [PerformanceEndpoint, () => unknown]]),
        ]
        if (actor.role !== 'observer') actions.push(
          ['weekly', () => periods.weekly(actor, { weekStart: '2026-09-21', limit: 50 })],
          ['monthly', () => periods.monthly(actor, { month: '2026-09', limit: 50 })],
          ['overview-personal', () => overview.personal(actor)],
          ['projects', () => directoryQueries.projects(actor, { limit: 50 })],
          ['goals', () => directoryQueries.goals(actor, { year: '2026', limit: 50 })],
          ['import-candidates', () => imports.candidates(actor, { kind: 'tasks', limit: 50 })],
          ['task-view', () => taskView.view(actor, 'task-2026-09-00')],
          ['collaboration', () => collaborationDashboard(store, actor, { limit: 50 }, new Date(performanceNow))],
        )
        if (actor.role === 'manager') actions.push(
          ['overview-department', () => overview.department(actor, { period: 'all', date: '2026-09-24', limit: 50 })],
          ['team', () => directoryQueries.team(actor, { limit: 50 })],
        )
        for (const [endpoint, run] of actions) {
          for (let index = 0; index < 2; index++) run()
          const samples = Array.from({ length: 7 }, () => measure(store, run).sample)
          for (const sample of samples) {
            try { assertPerformanceBudget(endpoint, sample) }
            catch (error) { failures.push(`${months} months ${role}: ${error instanceof Error ? error.message : error}`) }
          }
          const row = { months, role, endpoint, implementation: endpoint === 'bootstrap' ? '136c199-retired-test-fixture' : 'current', counts, ...summarize(samples) }
          results.push(row)
          console.log(JSON.stringify({ months, role, endpoint, implementation: endpoint === 'bootstrap' ? '136c199-retired-test-fixture' : 'current', p50Ms: row.p50Ms, p95Ms: row.p95Ms, ...samples[0] }))
        }
      }
    } finally { store.close() }
  }
} catch (error) {
  failures.push(error instanceof Error ? error.stack || error.message : String(error))
} finally {
  const uniqueFailures = [...new Set(failures)]
  writeFileSync(resolve(directory, 'results.json'), JSON.stringify({
    seed: performanceSeed, businessNow: performanceNow, generatedAt: new Date().toISOString(), scales,
    environment: { runtime: process.version, platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() },
    methodology: { database: 'isolated in-memory SQLite', baselineRuns: 2, currentWarmups: 2, currentSamples: 7, serializationIncluded: true,
      timeIsInformational: true, sqlMetric: 'SELECT statements; transaction BEGIN/COMMIT excluded', fixture: 'scripts/r2-performance-fixture.ts', baselineManifest, retiredSnapshot: '136c199 test-only; no runtime bootstrap route', r3Pages: 'dedicated production services; selected period or 50 rows with complete summaries' },
    budgets: performanceBudgets, passed: !uniqueFailures.length, comparisons, queryPlans, results, failures: uniqueFailures,
  }, null, 2))
  if (uniqueFailures.length) { console.error(uniqueFailures.join('\n')); process.exitCode = 1 }
  else console.log(`Performance gates passed at ${scales.join('/')} months. Evidence: output/r2-performance/results.json`)
}
