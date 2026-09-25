import { shiftDay, workingDay } from './work-calendar.ts'
export { shiftDay, workingDay } from './work-calendar.ts'
/** Fixed Shanghai offset; business deadlines never follow the host time zone. */
export const shanghaiDate = (now: Date) => new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
export const shanghaiTime = (now: Date) => new Date(now.getTime() + 8 * 3600000).toISOString().slice(11, 16)
export const dayAt = (day: string, time = '09:00') => new Date(`${day}T${time}:00+08:00`)
export function adjacentWorkday(day: string, direction: -1 | 1, overrides: Record<string, boolean> = {}) {
  for (let count = 1; count <= 370; count++) { const date = shiftDay(day, count * direction); if (workingDay(date, overrides)) return date }
  throw new Error('工作日历中没有可用日期')
}
/** Counts dates strictly after start and before end, optionally including end. */
export function workdayCount(start: string, end: string, overrides: Record<string, boolean> = {}, includeEnd = false) {
  let count = 0
  for (let day = shiftDay(start, 1); day < end || includeEnd && day === end; day = shiftDay(day, 1)) if (workingDay(day, overrides)) count++
  return count
}
export function weekOf(day: string) { const weekday = new Date(`${day}T00:00:00Z`).getUTCDay(); return shiftDay(day, -(weekday + 6) % 7) }
