import type { WeeklyDeadlineRepairPreview, WeeklySubmissionView } from '../shared/weekly-submissions'

export const noWeeklyDeadline = '整周休息，本周期无提报义务'

/** A missing deadline is not a missing receipt. Always display server-calculated dates. */
export function weeklyDeadlineLabel(value: string | null): string {
  return value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : noWeeklyDeadline
}

export function formatWorkCalendar(overrides: Record<string, boolean>): string {
  return Object.entries(overrides).sort(([a], [b]) => a.localeCompare(b)).map(([date, working]) => `${date} ${working ? '工作' : '休息'}`).join('\n')
}

export function parseWorkCalendar(value: string): Record<string, boolean> {
  const overrides: Record<string, boolean> = {}
  for (const line of value.split('\n').map(text => text.trim()).filter(Boolean)) {
    const match = /^(\d{4}-\d{2}-\d{2})\s+(工作|休息)$/.exec(line)
    if (!match) throw new Error('日历每行格式：2026-10-01 休息，或 2026-10-10 工作')
    const date = new Date(`${match[1]}T00:00:00Z`)
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]) throw new Error(`日历日期无效：${match[1]}`)
    if (Object.hasOwn(overrides, match[1])) throw new Error(`日历日期重复：${match[1]}，请每个日期只保留一行`)
    overrides[match[1]] = match[2] === '工作'
  }
  return overrides
}

export function deadlinePolicyRequest(view: WeeklySubmissionView, mode: string, calendar: string) {
  if (mode !== 'friday' && mode !== 'last_workday') throw new Error('请选择截止方式')
  return { version: view.rule.version, mode, ...(view.workCalendar ? { calendarOverrides: parseWorkCalendar(calendar), calendarVersion: view.workCalendar.version } : {}) }
}

export function deadlineRepairRequest(preview: WeeklyDeadlineRepairPreview, reason: string) {
  if (!preview.eligible || preview.unchanged || !preview.token) throw new Error('当前预览不可执行，请重新预览并检查原因')
  if (!reason.trim()) throw new Error('请填写修复原因')
  return { week: preview.week, token: preview.token, reason: reason.trim() }
}
