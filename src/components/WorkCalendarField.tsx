import { Field } from '../ui'
import { formatWorkCalendar } from '../weekly-deadline-flow'

export default function WorkCalendarField({ overrides, onChange }: { overrides: Record<string, boolean>; onChange?: () => void }) {
  return <Field label="节假日与调休（共享工作日历）" hint="默认周一至周五为工作日。每行一个例外日期：2026-10-01 休息 或 2026-10-10 工作。删除某行将恢复该日期的默认规则。">
    <textarea name="calendar" rows={5} defaultValue={formatWorkCalendar(overrides)} onChange={onChange} />
  </Field>
}
