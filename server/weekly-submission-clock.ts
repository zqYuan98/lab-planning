import { date, monday } from './domain-common.ts'

export function addWeekDays(day: string, amount: number): string {
  const value = new Date(`${day}T00:00:00Z`)
  value.setUTCDate(value.getUTCDate() + amount)
  return value.toISOString().slice(0, 10)
}
export function shanghaiWeek(now: Date): string {
  return monday(new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10))
}
export function cycleWeek(value: unknown): string {
  const day = date(value, '截止周期')
  if (monday(day) !== day) throw Object.assign(new Error('截止周期须为周一日期'), { status: 400 })
  return day
}
export const mondayInstant = (week: string) => new Date(`${week}T00:00:00+08:00`).toISOString()
export const fridayDeadline = (week: string) => new Date(`${addWeekDays(week, 4)}T16:00:00+08:00`).toISOString()
