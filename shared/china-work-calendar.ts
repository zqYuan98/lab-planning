import { shiftDay, workingDay } from './work-calendar'

/** 国办发明电〔2025〕7号，国务院办公厅 2025-11-04。
 * https://www.gov.cn/zhengce/content/202511/content_7047090.htm
 * Keep this live calendar separate from the immutable inputs in weekly deadline policies.
 */
const holidayRanges = [
  ['2026-01-01', 3], ['2026-02-15', 9], ['2026-04-04', 3], ['2026-05-01', 5],
  ['2026-06-19', 3], ['2026-09-25', 3], ['2026-10-01', 7],
] as const
const adjustedWorkdays = ['2026-01-04', '2026-02-14', '2026-02-28', '2026-05-09', '2026-09-20', '2026-10-10']
const officialOverrides: Readonly<Record<string, boolean>> = Object.freeze(Object.fromEntries([
  ...holidayRanges.flatMap(([start, length]) => Array.from({ length }, (_, offset) => [shiftDay(start, offset), false] as const)),
  ...adjustedWorkdays.map(day => [day, true] as const),
]))

/** Materialize the known national calendar when creating a new immutable policy. */
export function effectiveCalendarOverrides(overrides: Record<string, boolean> = {}): Record<string, boolean> {
  return Object.fromEntries(Object.entries({ ...officialOverrides, ...overrides }).sort(([a], [b]) => a.localeCompare(b)))
}

/** Company exceptions take precedence; years without published data retain weekday fallback. */
export function calendarWorkingDay(day: string, overrides: Record<string, boolean> = {}): boolean {
  if (Object.hasOwn(overrides, day)) return overrides[day]
  if (Object.hasOwn(officialOverrides, day)) return officialOverrides[day]
  return workingDay(day)
}

export function calendarWorkingDaysInWeek(week: string, overrides: Record<string, boolean> = {}): string[] {
  return Array.from({ length: 7 }, (_, offset) => shiftDay(week, offset)).filter(day => calendarWorkingDay(day, overrides))
}

export interface WorkWeekCalendar {
  week: string
  workingDays: string[]
  officialCalendarAvailable: boolean
}

export function getWorkWeekCalendar(week: string, overrides: Record<string, boolean> = {}): WorkWeekCalendar {
  return { week, workingDays: calendarWorkingDaysInWeek(week, overrides),
    officialCalendarAvailable: week.startsWith('2026-') && shiftDay(week, 6).startsWith('2026-') }
}
