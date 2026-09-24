import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { cpus, totalmem, platform, release } from 'node:os'
import { Store } from '../server/store.ts'
import { legacyBootstrap } from './phase3-baseline.ts'
import type { Task, User, WeeklyRecord, Report, AuditEvent } from '../shared/types.ts'

// Synthetic data only; in-memory isolated databases, no production config or network.
const mode = process.argv[2] || 'baseline'
const directory = resolve('output/phase3-performance')
mkdirSync(directory, { recursive: true })
const output: unknown[] = []
const shellStability: unknown[] = []
for (const scale of [1000, 10000, 100000]) {
  const store = new Store(':memory:')
  const manager = store.insert<User>('users', { id: 'manager', name: '经理', email: 'benchmark@example.invalid', role: 'manager', position: '', active: true })
  const member = store.insert<User>('users', { id: 'member', name: '成员', email: 'member@example.invalid', role: 'member', position: '', active: true })
  const observer = store.insert<User>('users', { id: 'observer', name: '观察者', email: 'observer@example.invalid', role: 'observer', position: '', active: true })
  store.transaction(() => {
    for (let i = 0; i < 20; i++) store.insert<Task>('tasks', { id: `task-${i}`, title: `固定活跃任务 ${i}`, ownerId: member.id, monthlyPlanId: null, description: '', dueDate: '', status: 'doing', isTemporary: true, temporaryReason: '基准' })
    const missing = { ...store.get<Task>('tasks', 'task-0')!, id: 'missing-task' }
    store.insert<AuditEvent>('events', { entityType: 'task', entityId: missing.id, actorId: member.id, action: 'update', reason: '', before: null, after: missing })
    for (let i = 0; i < scale; i++) store.insert<WeeklyRecord>('weeklyRecords', { id: `week-${i}`, taskId: i % 1000 === 0 ? (i === 0 ? missing.id : 'unrecoverable-' + i) : `task-${i % 20}`, ownerId: member.id, monthlyPlanId: null, weekStart: '2025-01-06', commitment: `历史周安排 ${i}`, actualOutcome: i < 20 ? '保存的历史成果' : '', evidenceUrl: '', blocker: '', nextAction: '', status: 'done', submitted: true })
    for (let i = 0; i < 4; i++) store.insert<Report>('reports', { id: `report-${i}`, type: 'monthly', period: '2025-01', title: '大正文历史报告', status: 'finalized', revision: i + 1, narrative: '历史报告正文。'.repeat(100000), snapshot: { tasks: [], plans: [], users: [], projects: [], annualGoals: [], weeklyRecords: [], nextPlans: [], nextWeeklyRecords: [], publications: [], changes: [] }, authorId: manager.id, finalizedAt: new Date().toISOString() })
  })
  const queries = mode === 'baseline' ? null : new (await import('../server/workspace-query.ts')).WorkspaceQueryService(store)
  for (const actor of [manager, member, observer]) {
    if (queries) {
      for (let i = 0; i < 20; i++) queries.shell(actor)
      const samples: number[] = []
      for (let i = 0; i < 1000; i++) { const start = performance.now(); JSON.stringify(queries.shell(actor)); samples.push(performance.now() - start) }
      samples.sort((a,b)=>a-b)
      shellStability.push({ role: actor.role, historyWeeklyRecords: scale, warmups: 20, samples: 1000, p50Ms: samples[500], p95Ms: samples[949] })
    }
    const actions: [string, () => unknown][] = queries ? [['shell', () => queries.shell(actor)], ...(actor.role === 'observer' ? [] : [['tasks', () => queries.page(actor, 'tasks', {})] as [string, () => unknown], ['register', () => queries.register(actor, {})] as [string, () => unknown]]), ...(actor.role === 'manager' ? [['reports', () => queries.page(actor, 'reports', {})] as [string, () => unknown]] : [])] : [['bootstrap', () => legacyBootstrap(store, actor)]]
    for (const [endpoint, run] of actions) {
      for (let i = 0; i < 3; i++) run()
      const samples: number[] = [], measurements: unknown[] = []
      for (let i = 0; i < 12; i++) {
        store.resetReadMetrics()
        const memoryBefore = process.memoryUsage(), start = performance.now()
        const body = JSON.stringify(run()), elapsed = performance.now() - start, memoryAfter = process.memoryUsage()
        samples.push(elapsed)
        measurements.push({ elapsedMs: elapsed, responseBytes: Buffer.byteLength(body), ...store.getReadMetrics(), heapUsedBefore: memoryBefore.heapUsed, heapUsedAfter: memoryAfter.heapUsed, rss: memoryAfter.rss })
      }
      samples.sort((a, b) => a - b)
      const row = { mode, role: actor.role, endpoint, historyWeeklyRecords: scale, activeTasks: 20, missingTaskRecords: scale / 1000, reportBodyCharacters: 2800000, p50Ms: samples[Math.floor(samples.length * .5)], p95Ms: samples[Math.ceil(samples.length * .95) - 1], measurements }
      output.push(row); console.log(JSON.stringify({ ...row, measurements: measurements[0] }))
    }
  }
  store.close()
}
writeFileSync(resolve(directory, `${mode}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), runtime: process.version, build: 'tsx source / SQLite in-memory WAL request (JSON serialization included)', warmups: 3, samples: 12, environment: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem() }, results: output }, null, 2))
if (shellStability.length) writeFileSync(resolve(directory, 'shell-stability.json'), JSON.stringify(shellStability, null, 2))
if (shellStability.length) {
  const checks = ['manager','member','observer'].map(role => {
    const timings = (shellStability as { role: string; p95Ms: number }[]).filter(row=>row.role===role)
    const rows = (output as { role: string; endpoint: string; measurements: { responseBytes: number; sql: number }[] }[]).filter(row=>row.role===role&&row.endpoint==='shell')
    const ratios = timings.slice(1).map((row,index)=>row.p95Ms/timings[index].p95Ms)
    return { role, responseBytes: rows.map(row=>row.measurements[0].responseBytes), sql: rows.map(row=>row.measurements[0].sql), tenfoldP95Ratios: ratios,
      passed: rows.every(row=>row.measurements[0].responseBytes===rows[0].measurements[0].responseBytes&&row.measurements[0].sql===rows[0].measurements[0].sql&&row.measurements[0].responseBytes<=102400)&&ratios.every(value=>value<=2)&&timings.every(row=>row.p95Ms<=5) }
  })
  writeFileSync(resolve(directory, 'acceptance.json'), JSON.stringify({ serviceP95BudgetMs: 5, shellMaximumBytes: 102400, sqlMetric: 'SELECT statements; fixed transaction BEGIN/COMMIT excluded', checks }, null, 2))
  if (checks.some(check=>!check.passed)) process.exitCode = 1
}
