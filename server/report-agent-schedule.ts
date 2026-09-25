import type { Report } from '../shared/types.ts'
import type { ReportAgentOccurrence, ReportAgentSchedule, ReportAgentType, ReportTemplate, UpdateReportAgentScheduleInput } from '../shared/report-agent.ts'
import { HttpError, Store } from './store.ts'
import { addDays, normalizeReportPeriod, shiftMonth, requireReportManager } from './reports.ts'
import { parseAgentInput, updateReportAgentScheduleSchema } from './report-agent-schemas.ts'
import { enqueueReportAgent } from './report-agent-service.ts'

const scheduleId = (type: ReportAgentType) => type === 'monthly' ? 'report-agent-monthly-schedule' : 'report-agent-schedule'
/** Kept in SQLite settings with the schedule; business exports do not replay schedules. */
type StoredSchedule = ReportAgentSchedule & { missedPeriods?: string[] }
function publicSchedule(row: StoredSchedule): ReportAgentSchedule {
  const { missedPeriods: _history, ...schedule } = row
  return schedule
}
function completedPeriods(store: Store, type: ReportAgentType = 'weekly') {
  // Enqueuing manual generation already creates a frozen, reviewable draft.
  // Its subsequent writing state belongs to the job, not to the missing list.
  return new Set([
    ...store.list<ReportAgentOccurrence>('reportAgentOccurrences').filter(row => row.key.startsWith(`department:${type}:`)).map(row => row.period),
    ...store.list<Report>('reports').filter(report => report.type === type && report.agent).map(report => report.period),
  ])
}
export function getReportAgentSchedule(store: Store, type: ReportAgentType = 'weekly'): ReportAgentSchedule {
  const ID = scheduleId(type)
  return store.transaction(() => publicSchedule(store.get<StoredSchedule>('settings', ID) || store.insert<StoredSchedule>('settings', { id: ID, ...(type === 'monthly' ? { type, monthlyDay: 0, targetMonth: 'current' as const } : {}), enabled: false, actorId: '', templateId: '', weekday: 5, time: '17:30', targetWeek: 'current', timezone: 'Asia/Shanghai', effectiveAt: new Date().toISOString(), useAi: false, missedPeriods: [] })))
}
export function updateReportAgentSchedule(store: Store, actorId: string, raw: UpdateReportAgentScheduleInput, now = new Date()): ReportAgentSchedule {
  requireReportManager(store, actorId)
  const input = parseAgentInput(updateReportAgentScheduleSchema, raw), type = input.type || 'weekly', ID = scheduleId(type)
  if (type === 'monthly' && (input.monthlyDay === undefined || !input.targetMonth)) throw new HttpError(400, '月报调度须明确每月日期或月末，以及当月或上月。')
  return store.transaction(() => {
    const current = getReportAgentSchedule(store, type)
    if (input.enabled) {
      requireReportManager(store, input.actorId)
      const row = store.get<ReportTemplate>('reportTemplates', input.templateId)
      if (!row || (row.type || 'weekly') !== type || row.status !== 'active' || !row.layoutVerified) throw new HttpError(400, '定时生成须指定有效管理者和已核验模板。')
    }
    const newWindow = current.enabled !== input.enabled || current.weekday !== input.weekday || current.time !== input.time || current.targetWeek !== input.targetWeek || current.monthlyDay !== input.monthlyDay || current.targetMonth !== input.targetMonth
    const stored = store.get<StoredSchedule>('settings', ID)!, seen = completedPeriods(store, type)
    // Before changing an enabled timing window, preserve every ungenerated due
    // period, including its latest occurrence. That old window will no longer
    // be used to decide automatic catch-up under the new settings.
    const historical = new Set(stored.missedPeriods || [])
    if (current.enabled && newWindow) for (const row of occurrences(current, now)) historical.add(row.period)
    const missedPeriods = [...historical].filter(period => !seen.has(period)).sort().reverse()
    // Re-enabling starts a new window: time spent disabled never becomes a
    // backlog. No-op, owner, template and AI changes retain the existing window.
    return publicSchedule(store.update<StoredSchedule>('settings', ID, input.expectedVersion, { ...(type === 'monthly' ? { type, monthlyDay: input.monthlyDay, targetMonth: input.targetMonth } : {}), enabled: input.enabled, actorId: input.actorId, templateId: input.templateId, weekday: input.weekday, time: input.time, targetWeek: input.targetWeek, useAi: input.useAi, effectiveAt: newWindow ? now.toISOString() : current.effectiveAt, missedPeriods }))
  })
}
function occurrences(schedule: ReportAgentSchedule, now: Date) {
  if (!schedule.enabled) return []
  const localDate = new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10), thisMonday = normalizeReportPeriod('weekly', localDate)
  if (schedule.type === 'monthly') {
    const rows: Array<{ period: string; scheduledFor: string }> = []
    for (let offset = 0; offset < 120; offset++) {
      const month = shiftMonth(localDate.slice(0, 7), -offset)
      const last = new Date(`${shiftMonth(month, 1)}-01T00:00:00Z`); last.setUTCDate(0)
      // Explicit 29–31 dates clamp to the real month end in short months.
      const day = Math.min(schedule.monthlyDay || last.getUTCDate(), last.getUTCDate())
      const scheduledFor = new Date(`${month}-${String(day).padStart(2, '0')}T${schedule.time}:00+08:00`).toISOString()
      if (scheduledFor < schedule.effectiveAt) break
      if (scheduledFor <= now.toISOString()) rows.push({ period: schedule.targetMonth === 'previous' ? shiftMonth(month, -1) : month, scheduledFor })
    }
    return rows
  }
  const rows: Array<{ period: string; scheduledFor: string }> = []
  // Bounded history: at most ten years; only one most recent occurrence is auto-enqueued.
  for (let offset = 0; offset < 520; offset++) {
    const monday = addDays(thisMonday, -7 * offset), scheduledFor = new Date(`${addDays(monday, schedule.weekday - 1)}T${schedule.time}:00+08:00`).toISOString()
    if (scheduledFor < schedule.effectiveAt) break
    if (scheduledFor <= now.toISOString()) rows.push({ period: schedule.targetWeek === 'previous' ? addDays(monday, -7) : monday, scheduledFor })
  }
  return rows
}
function due(store: Store, now: Date, type: ReportAgentType) {
  const schedule = getReportAgentSchedule(store, type), seen = completedPeriods(store, type)
  return { schedule, seen, missing: occurrences(schedule, now).filter(row => !seen.has(row.period)) }
}
export function reportAgentMissedPeriods(store: Store, now = new Date(), type: ReportAgentType = 'weekly'): string[] {
  const { schedule, missing, seen } = due(store, now, type), latest = occurrences(schedule, now)[0]
  const historical = store.get<StoredSchedule>('settings', scheduleId(type))?.missedPeriods || []
  return [...new Set([...historical, ...missing.filter(row => row.period !== latest?.period).map(row => row.period)])]
    .filter(period => !seen.has(period)).sort().reverse()
}
export function runReportAgentSchedule(store: Store, now = new Date(), type: ReportAgentType = 'weekly'): string[] {
  const { schedule, seen } = due(store, now, type), target = occurrences(schedule, now)[0]
  if (!target || seen.has(target.period)) return []
  try { requireReportManager(store, schedule.actorId) } catch { return [] }
  const row = store.get<ReportTemplate>('reportTemplates', schedule.templateId)
  if (!row || (row.type || 'weekly') !== type || row.status !== 'active' || row.effectiveWeek > target.period) return []
  return store.transaction(() => {
    const key = `department:${type}:${target.period}`
    // Recheck inside the transaction so a manual draft created after the first
    // read cannot cause a second automatic version for the same period.
    if (completedPeriods(store, type).has(target.period)) return []
    const job = enqueueReportAgent(store, schedule.actorId, { requestId: `scheduled:${key}`, templateId: schedule.templateId, period: target.period, useAi: schedule.useAi })
    store.update('reportAgentJobs', job.id, job.version, { scheduledFor: target.scheduledFor } as never)
    store.insert<ReportAgentOccurrence>('reportAgentOccurrences', { id: key, key, ...target, scheduleVersion: schedule.version, jobId: job.id, reportId: job.reportId! })
    return [job.id]
  })
}
