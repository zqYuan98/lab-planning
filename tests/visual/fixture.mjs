import { mock } from 'node:test'
import { createApp } from '../../server/app.ts'
import { createDingTalkClient } from '../../server/dingtalk.ts'
import { createDingTalkDocumentsClient } from '../../server/dingtalk-documents-client.ts'
import { createDingTalkNativeClient } from '../../server/dingtalk-native.ts'
import { Domain } from '../../server/domain.ts'
import { Store } from '../../server/store.ts'
import { fridayDeadline } from '../../server/weekly-submission-clock.ts'
import { instant, origin, password } from './config-data.mjs'

// Keep "this week" and due dates stable on both sides of the HTTP boundary.
mock.timers.enable({ apis: ['Date'], now: new Date(instant) })
process.env.APP_ORIGIN = origin
process.env.COOKIE_SECURE = 'false'
process.env.TRUST_PROXY = 'false'
// No production database, scheduler or outbound workers participate in screenshot runs.
const store = new Store(':memory:')
const domain = new Domain(store)
const manager = domain.setup({ name: '验收管理者', email: 'manager@example.test', password })
const member = domain.createUser(manager, { name: '验收成员', email: 'member@example.test', password, role: 'member' })
const week = '2026-11-16'
store.insert('weeklyRules', {
  id: 'weekly-submission-rule', enabled: true, effectiveWeek: week, timezone: 'Asia/Shanghai',
  windows: [{ fromWeek: week, toWeek: null }], planReviewEffectiveWeek: week, managerSubmissionEffectiveWeek: week,
})
store.insert('weeklyCycles', {
  id: week, week, deadlineAt: fridayDeadline(week), rosterIds: [manager.id, member.id],
  needsReview: false, confirmedBy: manager.id, confirmationReason: '', frozenAt: instant, managerRosterApplied: true,
})
for (const [user, role] of [[manager, '管理'], [member, '成员']]) {
  const id = user.role
  const plan = store.insert('plans', {
    id: 'plan-' + id, ownerId: user.id, title: role + '月度验收', month: '2026-11',
    expectedOutcome: '交付操作说明', acceptanceCriteria: '核对演练记录',
    projectId: null, category: '日常工作', collaboratorIds: [], dueDate: '2026-11-30',
    priority: 'medium', status: 'published', publishedVersion: 1, sourcePlanId: null,
    actualOutcome: '', reviewComment: '', acceptanceStatus: 'pending', acceptanceNote: '',
  })
  const task = store.insert('tasks', {
    id: 'task-' + id, ownerId: user.id, monthlyPlanId: plan.id, title: role + '演练准备',
    dueDate: '2026-11-25', description: '核对发布验收步骤', status: 'doing',
    isTemporary: false, temporaryReason: '',
  })
  store.insert('weeklyRecords', {
    id: 'week-' + id, taskId: task.id, monthlyPlanId: plan.id, ownerId: user.id,
    weekStart: week, commitment: '完成操作演练', actualOutcome: '初稿已完成',
    evidenceUrl: '', blocker: '', nextAction: '复核演练记录', status: 'doing', submitted: false,
  })
}
const integrations = { env: {}, fetch: async () => { throw new Error('Visual fixture has no external integrations') } }
const app = createApp({
  store, enableScheduler: false, dingtalkClient: createDingTalkClient(integrations),
  documentsClient: createDingTalkDocumentsClient(integrations), nativeClient: createDingTalkNativeClient(integrations),
})
app.listen(Number(new URL(origin).port), '127.0.0.1')
