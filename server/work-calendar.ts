import type { CollaborationSettings } from '../shared/collaboration.ts'
import type { Store } from './store.ts'
export { shiftDay } from '../shared/work-calendar.ts'
export { calendarWorkingDay as workingDay, calendarWorkingDaysInWeek as workingDaysInWeek } from '../shared/china-work-calendar.ts'

/** The existing settings remain the single storage source, independent of collaboration enablement. */
export function readWorkCalendar(store: Store): { version: number; overrides: Record<string, boolean> } {
  const settings = store.get<CollaborationSettings>('collaborationSettings', 'collaboration')
  return { version: settings?.version ?? 0, overrides: settings?.calendarOverrides ?? {} }
}
