import test from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import type { MonthlyPlan, User, WeeklyRecord } from '../shared/types.ts'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import Monthly from '../src/pages/Monthly.tsx'
import Weekly from '../src/pages/Weekly.tsx'

function fixture() {
  const store = new Store(':memory:')
  const domain = new Domain(store)
  const manager = domain.setup({
    name: '主管',
    email: 'audit-manager@example.test',
    password: 'password123',
  })
  const member = domain.createUser(manager, {
    name: '研发',
    email: 'audit-owner@example.test',
    password: 'password123',
    role: 'member',
    position: '研发',
  })
  const collaborator = domain.createUser(manager, {
    name: '测试',
    email: 'audit-collaborator@example.test',
    password: 'password123',
    role: 'member',
    position: '测试',
  })
  const project = domain.createProject(manager, {
    name: '隔离审查项目',
    code: 'AUDIT',
    ownerId: manager.id,
  })
  const input = {
    month: '2026-09',
    title: '九月交付',
    projectId: project.id,
    category: '项目研发',
    expectedOutcome: '交付评测报告',
    acceptanceCriteria: '完成联合评审',
    dueDate: '2026-09-30',
    collaboratorIds: [collaborator.id],
  }
  function publish(owner: User, plan: MonthlyPlan) {
    const submitted = domain.submitPlan(manager, plan.id, {
      version: plan.version,
    })
    domain.reviewPlan(manager, plan.id, {
      version: submitted.version,
      decision: 'approve',
    })
    domain.publishMonth(manager, plan.month, { planIds: [plan.id] })
    return store.get<MonthlyPlan>('plans', plan.id)!
  }
  return {
    store,
    domain,
    manager,
    member,
    collaborator,
    project,
    input,
    publish,
  }
}

test('a previously submitted boundary-week record keeps its original month after withdrawal and task relink', () => {
  const f = fixture()
  try {
    const september = f.publish(
      f.member,
      f.domain.createPlan(f.manager, { ...f.input, ownerId: f.member.id }),
    )
    const october = f.publish(
      f.member,
      f.domain.carryPlan(f.manager, september.id, {
        month: '2026-10',
        dueDate: '2026-10-30',
        reason: '继续验证',
      }),
    )
    const task = f.domain.createTask(f.member, {
      title: '评测任务',
      monthlyPlanId: september.id,
      dueDate: september.dueDate,
    })
    const submitted = f.domain.createWeeklyRecord(f.member, {
      taskId: task.id,
      weekStart: '2026-09-28',
      commitment: '完成九月验证',
      actualOutcome: '已完成九月样本',
      status: 'done',
      submitted: true,
    })
    const withdrawn = f.domain.updateWeeklyRecord(f.member, submitted.id, {
      version: submitted.version,
      submitted: false,
    })
    f.domain.relinkTask(f.manager, task.id, {
      version: task.version,
      monthlyPlanId: october.id,
      reason: '从十月继续',
    })
    const historical = f.store.get<WeeklyRecord>('weeklyRecords', submitted.id)!
    assert.equal(historical.monthlyPlanId, september.id)
    assert.equal(historical.version, withdrawn.version)
    assert.equal(historical.actualOutcome, '已完成九月样本')
    const resubmitted = f.domain.updateWeeklyRecord(f.member, historical.id, {
      version: historical.version,
      submitted: true,
    })
    assert.equal(resubmitted.monthlyPlanId, september.id)
    const nextWeek = f.domain.carryWeeklyRecord(f.member, historical.id, {
      weekStart: '2026-10-05',
    })
    assert.equal(nextWeek.monthlyPlanId, october.id)
    assert.equal(nextWeek.taskId, task.id)
    assert.equal(nextWeek.actualOutcome, '')
  } finally {
    f.store.close()
  }
})

test('old-month collaborators cannot read peer task snapshots or weekly records', () => {
  const f = fixture()
  try {
    const september = f.publish(
      f.member,
      f.domain.createPlan(f.manager, { ...f.input, ownerId: f.member.id }),
    )
    const october = f.publish(
      f.member,
      f.domain.createPlan(f.manager, { ownerId: f.member.id,
        ...f.input,
        month: '2026-10',
        dueDate: '2026-10-30',
        title: '十月单独工作',
        collaboratorIds: [],
      }),
    )
    const task = f.domain.createTask(f.member, {
      title: '九月共同评测',
      monthlyPlanId: september.id,
      dueDate: september.dueDate,
    })
    const historical = f.domain.createWeeklyRecord(f.member, {
      taskId: task.id,
      weekStart: '2026-09-21',
      commitment: '完成共同评测',
      submitted: true,
    })
    const moved = f.domain.relinkTask(f.manager, task.id, {
      version: task.version,
      monthlyPlanId: october.id,
      reason: '独立承接',
    })
    f.domain.updateTask(f.member, task.id, {
      version: moved.version,
      title: '十月保密事项',
      description: '只属于十月新范围',
    })
    const future = f.domain.createWeeklyRecord(f.member, {
      taskId: task.id,
      weekStart: '2026-10-05',
      commitment: '十月私人草稿',
    })
    const visible = f.domain.bootstrap(f.collaborator)
    assert.ok(!visible.weeklyRecords.some(record => record.id === historical.id))
    assert.ok(!visible.weeklyRecords.some(record => record.id === future.id))
    assert.ok(!visible.tasks.some(item => item.id === task.id))
    assert.equal(
      f.domain.bootstrap(f.member).tasks.find((item) => item.id === task.id)
        ?.title,
      '十月保密事项',
    )
  } finally {
    f.store.close()
  }
})

test('direct sourcePlanId creation cannot bypass carry ownership or revive a merged source', () => {
  const f = fixture()
  try {
    let first = f.domain.createPlan(f.manager, { ...f.input, ownerId: f.member.id })
    const nextInput = {
      ...f.input,
      month: '2026-10',
      dueDate: '2026-10-30',
      sourcePlanId: first.id,
      collaboratorIds: [],
    }
    assert.throws(() => f.domain.createPlan(f.collaborator, nextInput), {
      status: 403,
    })
    let second = f.domain.createPlan(f.manager, { ownerId: f.member.id,
      ...f.input,
      title: '同成果的第二项提报',
    })
    first = f.domain.submitPlan(f.manager, first.id, { version: first.version })
    second = f.domain.submitPlan(f.manager, second.id, {
      version: second.version,
    })
    f.domain.mergePlans(f.manager, {
      planIds: [first.id, second.id],
      title: '联合交付',
      reason: '统一交付范围',
    })
    assert.throws(() => f.domain.createPlan(f.manager, { ...nextInput, ownerId: f.member.id }), {
      status: 400,
    })
    assert.throws(
      () =>
        f.domain.carryPlan(f.manager, first.id, {
          month: '2026-10',
          dueDate: '2026-10-30',
          reason: '尝试复活来源',
        }),
      { status: 400 },
    )
    assert.equal(
      f.store
        .list<MonthlyPlan>('plans')
        .filter((plan) => plan.month === '2026-10').length,
      0,
    )
  } finally {
    f.store.close()
  }
})

test('existing inactive collaborators survive normal plan edits while new inactive assignments stay forbidden', () => {
  const f = fixture()
  try {
    let plan = f.publish(f.member, f.domain.createPlan(f.manager, { ...f.input, ownerId: f.member.id }))
    f.domain.createTask(f.collaborator, {
      title: '原测试责任',
      monthlyPlanId: plan.id,
      dueDate: plan.dueDate,
    })
    f.domain.updateUser(f.manager, f.collaborator.id, {
      version: f.collaborator.version,
      active: false,
    })
    plan = f.domain.updatePlan(f.manager, plan.id, {
      version: plan.version,
      title: '调整后的交付名称',
      collaboratorIds: [f.collaborator.id],
      reason: '补全成果名称，保留已有任务责任',
    })
    assert.ok(plan.collaboratorIds.includes(f.collaborator.id))
    assert.throws(
      () =>
        f.domain.updatePlan(f.manager, plan.id, {
          version: plan.version,
          collaboratorIds: [],
          reason: '移除已有任务责任',
        }),
      { status: 400 },
    )
    assert.throws(() => f.domain.createPlan(f.manager, { ...f.input, ownerId: f.member.id }), { status: 400 })
    assert.equal(
      f.domain.planHistory(f.member, plan.id).at(-1)?.action,
      'published_change',
    )
  } finally {
    f.store.close()
  }
})

test('archived project proposals do not block the active publish batch or appear as new weekly choices', () => {
  const f = fixture()
  try {
    let archived = f.domain.createPlan(f.manager, { ownerId: f.member.id,
      ...f.input,
      title: '已归档待发布成果',
    })
    archived = f.domain.submitPlan(f.manager, archived.id, {
      version: archived.version,
    })
    f.domain.reviewPlan(f.manager, archived.id, {
      version: archived.version,
      decision: 'approve',
    })
    f.domain.createTask(f.member, {
      title: '已归档个人任务',
      monthlyPlanId: archived.id,
      dueDate: archived.dueDate,
    })
    f.domain.updateProject(f.manager, f.project.id, {
      version: f.project.version,
      status: 'archived',
    })
    let active = f.domain.createPlan(f.manager, { ownerId: f.member.id,
      ...f.input,
      projectId: null,
      title: '正常待发布成果',
    })
    active = f.domain.submitPlan(f.manager, active.id, {
      version: active.version,
    })
    f.domain.reviewPlan(f.manager, active.id, {
      version: active.version,
      decision: 'approve',
    })
    const data = f.domain.bootstrap(f.manager)
    const monthly = renderToStaticMarkup(
      createElement(Monthly, {
        data,
        refresh: async () => {},
        notify: () => {},
        intent: { action: 'publish', month: '2026-09' },
      }),
    )
    const publicationDialog =
      monthly.split('aria-label="发布部门月度目标"')[1] || ''
    assert.ok(publicationDialog.includes('正常待发布成果'))
    assert.ok(!publicationDialog.includes('已归档待发布成果'))
    const weekly = renderToStaticMarkup(
      createElement(Weekly, {
        data: f.domain.bootstrap(f.member),
        refresh: async () => {},
        notify: () => {},
        intent: { action: 'create', weekStart: '2026-09-07' },
      }),
    )
    assert.ok(weekly.includes('正常待发布成果'))
    assert.ok(!weekly.includes('已归档待发布成果'))
    assert.ok(!weekly.includes('已归档个人任务'))
  } finally {
    f.store.close()
  }
})
