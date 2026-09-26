import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { AnnualGoal, MonthlyPlan, Project, Task, WeeklyRecord } from '../shared/types.ts'
import { LIMITS } from '../shared/entity-rules.ts'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import { exportBusinessData, previewRestore, restoreBusinessData } from '../server/data-transfer.ts'

const full = (length: number, char = '字') => char.repeat(length)
function accounts(t: import('node:test').TestContext, suffix: string) {
  const store = new Store(':memory:'); t.after(() => store.close())
  const domain = new Domain(store)
  const manager = domain.setup({ name: full(LIMITS.personName, '管'), email: `manager@${suffix}.test`, password: 'Fixture-password-2026!' })
  const member = domain.createUser(manager, { name: full(LIMITS.personName, '成'), email: `member@${suffix}.test`, password: 'Other-fixture-password-2026!', role: 'member', position: full(LIMITS.position, '岗') })
  return { store, domain, manager, member }
}

test('records saved at every field limit export and restore unchanged', t => {
  const source = accounts(t, 'limits'), { domain, manager, member } = source
  const project = domain.createProject(manager, { name: full(LIMITS.projectName), code: full(LIMITS.projectCode, 'C'), description: full(LIMITS.text), ownerId: member.id })
  const goal = domain.createAnnualGoal(manager, { title: full(LIMITS.title), year: 2026, target: full(LIMITS.text), progress: 40, description: full(LIMITS.text), ownerId: member.id })
  const plan = domain.createPlan(manager, { ownerId: member.id, month: '2026-09', title: full(LIMITS.title), category: full(LIMITS.category), projectId: project.id, annualGoalId: goal.id,
    expectedOutcome: full(LIMITS.text), acceptanceCriteria: full(LIMITS.text), dueDate: '2026-09-30', priority: 'high', workSource: 'leader', assignedBy: full(LIMITS.assignedBy), assignedOn: '2026-09-01' })
  const task = domain.createTask(member, { title: full(LIMITS.title), description: full(LIMITS.text), dueDate: '2026-09-25', isTemporary: true, temporaryReason: full(LIMITS.text),
    workSource: 'leader', assignedBy: full(LIMITS.assignedBy), assignedOn: '2026-09-01', requestedOutcome: full(LIMITS.text), estimatedEffort: full(LIMITS.text), currentProgress: full(LIMITS.text), decisionNeeded: full(LIMITS.text) })
  const url = `https://evidence.example.test/${full(LIMITS.url - 'https://evidence.example.test/'.length, 'a')}`
  const weekly = domain.createWeeklyRecord(member, { taskId: task.id, weekStart: '2026-09-21', commitment: full(LIMITS.text), actualOutcome: full(LIMITS.text), blocker: full(LIMITS.text), nextAction: full(LIMITS.text), evidenceUrl: url })

  const target = accounts(t, 'limits')
  const packet = exportBusinessData(source.store, manager)
  const preview = previewRestore(target.store, target.manager, packet)
  assert.equal(preview.canRestore, true, preview.issues.join('\n'))
  restoreBusinessData(target.store, target.manager, packet, {}, preview.fingerprint)
  const restored = <T>(collection: string, id: string) => target.store.get<T>(collection, id)!
  assert.equal(restored<Project>('projects', project.id).name, project.name)
  assert.equal(restored<Project>('projects', project.id).code, project.code)
  assert.equal(restored<AnnualGoal>('annualGoals', goal.id).target, goal.target)
  for (const key of ['title', 'category', 'expectedOutcome', 'acceptanceCriteria', 'assignedBy'] as const) assert.equal(restored<MonthlyPlan>('plans', plan.id)[key], plan[key], `plan.${key}`)
  for (const key of ['title', 'description', 'temporaryReason', 'assignedBy', 'requestedOutcome', 'estimatedEffort', 'currentProgress', 'decisionNeeded'] as const) assert.equal(restored<Task>('tasks', task.id)[key], task[key], `task.${key}`)
  for (const key of ['commitment', 'actualOutcome', 'blocker', 'nextAction', 'evidenceUrl'] as const) assert.equal(restored<WeeklyRecord>('weeklyRecords', weekly.id)[key], weekly[key], `weekly.${key}`)
})

test('one character over a field limit is rejected when saving', t => {
  const { domain, manager, member } = accounts(t, 'limits-over')
  assert.throws(() => domain.createTask(member, { title: full(LIMITS.title + 1), dueDate: '2026-09-25', isTemporary: true, temporaryReason: '临时' }), { status: 400 })
  assert.throws(() => domain.createProject(manager, { name: full(LIMITS.projectName + 1), code: 'C', ownerId: member.id }), { status: 400 })
  assert.throws(() => domain.createTask(member, { title: '任务', description: full(LIMITS.text + 1), dueDate: '2026-09-25', isTemporary: true, temporaryReason: '临时' }), { status: 400 })
})

test('browser forms take entity length limits from shared/entity-rules', () => {
  const files: string[] = []
  const walk = (dir: string) => { for (const name of readdirSync(dir)) { const path = join(dir, name); if (statSync(path).isDirectory()) walk(path); else if (/\.tsx?$/.test(name)) files.push(path) } }
  walk(new URL('../src', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  const offenders = files.flatMap(file => {
    const source = readFileSync(file, 'utf8'), found: string[] = []
    const lineOf = (index: number) => source.slice(0, index).split('\n').length
    if (!/report/i.test(file)) for (const start of source.matchAll(/<(input|textarea)\b/g)) {
      // The opening tag ends at the first `>` that is not part of an arrow function.
      const rest = source.slice(start.index), end = rest.search(/(?<!=)\/?>/), tag = rest.slice(0, end)
      // Entity titles share one limit; a shorter form limit blocks editing a longer saved title.
      if (/name="title"/.test(tag) && /maxLength=\{\d+\}/.test(tag)) found.push(`${file}:${lineOf(start.index)}: title limit as a literal`)
    }
    for (const match of source.matchAll(new RegExp(`maxLength=\\{${LIMITS.text}\\}`, 'g'))) found.push(`${file}:${lineOf(match.index)}: free-text limit as a literal`)
    return found
  })
  assert.deepEqual(offenders, [])
})
