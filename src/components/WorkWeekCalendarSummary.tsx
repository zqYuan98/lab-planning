import type { WorkWeekCalendar } from '../../shared/china-work-calendar'

/** The server supplies working days; the Monday key still identifies the natural week. */
export default function WorkWeekCalendarSummary({ calendar, label = '本周' }: { calendar: WorkWeekCalendar; label?: string }) {
  return <div className="work-week-calendar" aria-label={`${label}工作日历`}>
    <p>{label}实际工作日：{calendar.workingDays.length ? <>{calendar.workingDays.map(day => {
      const weekday = new Date(`${day}T00:00:00Z`).getUTCDay()
      return `${day.slice(5)}${weekday === 0 || weekday === 6 ? '（调休上班）' : ''}`
    }).join('、')} · 共 {calendar.workingDays.length} 天</> : '整周休息，共 0 天'}</p>
    {!calendar.officialCalendarAvailable && <p className="form-hint">此周涉及的年份尚未完整载入国家节假日安排，暂按周一至周五及手工例外日期计算，请核对工作日历。</p>}
  </div>
}
