import test from 'node:test'
import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Store } from '../server/store.ts'
import { Domain } from '../server/domain.ts'
import Weekly from '../src/pages/Weekly.tsx'
import { buildOverview } from '../src/overview-data.ts'
import type { NavigationIntent } from '../src/navigation.ts'

test('member search and overview do not reveal peer work under a shared goal', () => {
  const store = new Store(':memory:')
  try {
    const domain = new Domain(store)
    const manager = domain.setup({
      name: '负责人',
      email: 'manager@example.test',
      password: 'ReviewPassword123',
    })
    const viewer = domain.createUser(manager, {
      name: '协作者甲',
      email: 'viewer@example.test',
      password: 'ReviewPassword123',
      position: '开发',
      role: 'member',
    })
    const owner = domain.createUser(manager, {
      name: '负责人乙',
      email: 'owner@example.test',
      password: 'ReviewPassword123',
      position: '开发',
      role: 'member',
    })
    let plan = domain.createPlan(manager, { ownerId: owner.id,
      month: '2026-09',
      title: '联合验证交付',
      projectId: null,
      category: '研发',
      collaboratorIds: [viewer.id],
      expectedOutcome: '交付验证报告',
      acceptanceCriteria: '评审通过',
      dueDate: '2026-09-30',
    })
    plan = domain.submitPlan(manager, plan.id, { version: plan.version })
    plan = domain.reviewPlan(manager, plan.id, {
      version: plan.version,
      decision: 'approve',
      comment: '',
    })
    domain.publishMonth(manager, plan.month, { planIds: [plan.id] })
    const task = domain.createTask(owner, {
      title: '协作接口联调',
      monthlyPlanId: plan.id,
      description: '',
      dueDate: '2026-09-11',
    })
    const blocked = domain.createWeeklyRecord(owner, {
      taskId: task.id,
      weekStart: '2026-09-07',
      commitment: '等待接口权限后完成联调',
      status: 'blocked',
      blocker: '等待权限开放',
      blockerImpact: '接口联调延期',
      supportNeeded: '请管理员开放接口权限',
      submitted: true,
    })
    const draftTask = domain.createTask(owner, {
      title: '协作测试文档',
      monthlyPlanId: plan.id,
      description: '',
      dueDate: '2026-09-11',
    })
    const draft = domain.createWeeklyRecord(owner, {
      taskId: draftTask.id,
      weekStart: blocked.weekStart,
      commitment: '编写验证用例草稿',
      submitted: false,
    })
    const data = domain.bootstrap(viewer)
    assert.ok(!data.tasks.some((item) => item.id === task.id))
    assert.ok(!data.weeklyRecords.some((item) => item.id === blocked.id))
    const overview = buildOverview(data, '2026-09-08')
    assert.equal(overview.blocked.length, 0)
    assert.equal(overview.drafts.length, 0)

    const render = (intent: NavigationIntent) =>
      renderToStaticMarkup(
        createElement(Weekly, {
          data,
          intent,
          refresh: async () => {},
          notify: () => {},
        }),
      )
    const search = render({
      id: task.id,
      weekStart: blocked.weekStart,
      query: task.title,
    })
    const attention = render({ id: blocked.id, weekStart: blocked.weekStart })
    const blockedScope = render({
      weekStart: blocked.weekStart,
      status: 'blocked',
    })
    const draftScope = render({ weekStart: draft.weekStart, status: 'draft' })
    const timeline = render({ weekStart: blocked.weekStart })
    assert.ok(data.plans.some(item => item.id === plan.id))
    for (const html of [search, attention, blockedScope, draftScope, timeline]) {
      assert.ok(!html.includes(blocked.commitment))
      assert.ok(!html.includes(draft.commitment))
    }
    assert.throws(
      () =>
        domain.updateWeeklyRecord(viewer, blocked.id, {
          version: blocked.version,
          blocker: '非法更新',
        }),
      { status: 403 },
    )
  } finally {
    store.close()
  }
})
