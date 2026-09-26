import type { Entity, ReportSchedule, User } from '../shared/types.ts'
import type { Store } from './store.ts'
import type { RuntimeHeartbeat } from '../shared/notification-diagnostics.ts'
import { generateReport, normalizeReportPeriod, shiftMonth } from './reports.ts'
import { reportTypeManaged } from './report-agent-policy.ts'
import { WeeklySubmissionService } from './weekly-submissions.ts'
import { runNotificationReminders } from './notification-reminders.ts'
import { beginRuntimeRun, runtimeHeartbeat } from './runtime-health.ts'
import { publishCollaborationEvents } from './collaboration-notifications.ts'
import { runCollaborationDigests } from './collaboration-digests.ts'
import { isManager } from './authorization.ts'

interface ScheduleRun extends Entity { key: string; type: 'weekly' | 'monthly'; period: string; reportId: string }
const SCHEDULE_ID = 'report-schedule'
const SLOW_TICK_MS = 200
export function getReportSchedule(store: Store): ReportSchedule {
  return store.transaction(() => store.get<ReportSchedule>('settings', SCHEDULE_ID) || store.insert<ReportSchedule>('settings', {
    id: SCHEDULE_ID, enabled: false, weeklyDay: 5, weeklyTime: '17:00', monthlyDay: 0, monthlyTime: '18:00', timezone: 'Asia/Shanghai'
  }))
}
export function updateReportSchedule(store: Store, input: Record<string, unknown>): ReportSchedule {
  const current = getReportSchedule(store)
  if (typeof input.enabled !== 'boolean' || !Number.isInteger(input.weeklyDay) || Number(input.weeklyDay) < 1 || Number(input.weeklyDay) > 7
    || !Number.isInteger(input.monthlyDay) || Number(input.monthlyDay) < 0 || Number(input.monthlyDay) > 28
    || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.weeklyTime)) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(input.monthlyTime))) {
    throw Object.assign(new Error('请填写有效的报告日期与时间。'), { status: 400 })
  }
  return store.update<ReportSchedule>('settings', SCHEDULE_ID, Number(input.version), { enabled: input.enabled,
    weeklyDay: Number(input.weeklyDay), weeklyTime: String(input.weeklyTime), monthlyDay: Number(input.monthlyDay), monthlyTime: String(input.monthlyTime), timezone: current.timezone })
}
/** A durable run key is committed atomically with the generated draft. No network side effects. */
export function runScheduledReports(store: Store, now = new Date()): string[] {
  const schedule = getReportSchedule(store)
  if (!schedule.enabled) return []
  const local = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now)
  const part = (kind: string) => local.find(p => p.type === kind)!.value
  const date = `${part('year')}-${part('month')}-${part('day')}`, time = `${part('hour')}:${part('minute')}`
  const dayOfWeek = new Date(`${date}T00:00:00Z`).getUTCDay() || 7
  const lastDay = new Date(`${shiftMonth(date.slice(0, 7), 1)}-01T00:00:00Z`)
  lastDay.setUTCDate(0)
  const actor = store.list<User>('users').find(u => u.active && isManager(u))
  if (!actor) return []
  const due: { type: 'weekly' | 'monthly'; period: string }[] = []
  // A reviewed template owns its type even while its scheduler is paused.
  const agentWeekly = reportTypeManaged(store, 'weekly')
  if (!agentWeekly && dayOfWeek === schedule.weeklyDay && time >= schedule.weeklyTime) due.push({ type: 'weekly', period: normalizeReportPeriod('weekly', date) })
  if (!reportTypeManaged(store, 'monthly') && Number(part('day')) === (schedule.monthlyDay || lastDay.getUTCDate()) && time >= schedule.monthlyTime) {
    due.push({ type: 'monthly', period: schedule.monthlyDay === 0 ? date.slice(0, 7) : shiftMonth(date.slice(0, 7), -1) })
  }
  const reportIds: string[] = []
  for (const target of due) {
    store.transaction(() => {
      const key = `${target.type}:${target.period}`
      if (store.get<ScheduleRun>('scheduleRuns', key)) return
      const report = generateReport(store, target.type, target.period, actor.id)
      store.insert<ScheduleRun>('scheduleRuns', { id: key, key, ...target, reportId: report.id })
      reportIds.push(report.id)
    })
  }
  return reportIds
}
export interface SchedulerOptions { intervalMs?: number; onHeartbeat?: (heartbeat: RuntimeHeartbeat) => void }
export function startScheduler(store: Store, options: SchedulerOptions = {}): () => void {
  const submissions = new WeeklySubmissionService(store)
  const report = () => options.onHeartbeat?.(runtimeHeartbeat(store, 'scheduler'))
  // Log the slow steps so stalls can be attributed.
  const timed = (step: string, run: () => unknown, steps: Record<string, number>) => {
    const started = performance.now()
    try { run() } finally { steps[step] = Math.round(performance.now() - started) }
  }
  const tick = () => {
    const finish = beginRuntimeRun(store, 'scheduler'); let success = true
    report()
    const steps: Record<string, number> = {}, started = performance.now()
    try { timed('weeklyReconcile', () => submissions.reconcile(), steps) } catch (error) { success = false; console.error('周提报核对未完成：', error instanceof Error ? error.message : '未知错误') }
    try { timed('reports', () => runScheduledReports(store), steps) } catch (error) { success = false; console.error('报告定时任务未完成：', error instanceof Error ? error.message : '未知错误') }
    try { timed('reminders', () => runNotificationReminders(store), steps) } catch (error) { success = false; console.error('消息提醒生成失败：', error instanceof Error ? error.name : '未知错误') }
    try { timed('collaboration', () => { publishCollaborationEvents(store); runCollaborationDigests(store) }, steps) } catch (error) { success = false; console.error('工作协作摘要生成失败：', error instanceof Error ? error.name : '未知错误') }
    const ms = Math.round(performance.now() - started)
    if (ms >= SLOW_TICK_MS) console.warn(JSON.stringify({ event: 'slow_scheduler_tick', ms, steps }))
    finish(success)
    report()
  }
  const interval = setInterval(tick, options.intervalMs ?? 30000)
  interval.unref()
  tick()
  return () => clearInterval(interval)
}
