import { Field } from '../ui'
import { formatWorkCalendar } from '../weekly-deadline-flow'

export default function WorkCalendarField({ overrides, onChange }: { overrides: Record<string, boolean>; onChange?: () => void }) {
  return <Field label="节假日与调休（共享工作日历）" hint="已内置 2026 年国家法定节假日与调休安排；企业手工例外优先。每行一个例外日期：2026-10-01 休息 或 2026-10-10 工作。删除某行将恢复该日期的默认规则（2026 年按国家安排）；尚未载入国家安排的年份暂按周一至周五，可手工补充。">
    <textarea name="calendar" rows={5} defaultValue={formatWorkCalendar(overrides)} onChange={onChange} />
  </Field>
}
