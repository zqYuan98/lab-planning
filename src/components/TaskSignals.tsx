import type { ReactNode } from 'react'
import { CalendarDays, ChevronDown, CircleHelp, ListTodo, SignalHigh, SignalLow, SignalMedium, Minus, Zap } from 'lucide-react'
import { priorityLabels, workKind, workKindLabels, type TaskPriority } from '../task-presentation'

export function PriorityBadge({ priority }: { priority?: TaskPriority }) {
  const level = priority ?? 'none'
  const Icon = { high: SignalHigh, medium: SignalMedium, low: SignalLow, none: Minus }[level]
  return <span className={`task-signal task-signal-priority task-signal-${level}`}><Icon size={13} aria-hidden="true" />{priorityLabels[level]}</span>
}

export function WorkTypeBadge(props: { isTemporary?: boolean; monthlyPlanId?: string | null; isMonthly?: boolean }) {
  const kind = workKind(props)
  const Icon = { monthly: CalendarDays, temporary: Zap, routine: ListTodo }[kind]
  return <span className={`task-signal task-signal-${kind}`}><Icon size={12} aria-hidden="true" />{kind === 'temporary' && props.isMonthly ? '临时目标' : workKindLabels[kind]}</span>
}

export function ContextHelp({ title, children }: { title: string; children: ReactNode }) {
  return <details className="context-help"><summary><CircleHelp size={14} aria-hidden="true" /><span>{title}</span><ChevronDown size={14} className="context-help-chevron" aria-hidden="true" /></summary><div className="context-help-content">{children}</div></details>
}

export function TaskLegend() {
  return <div className="task-legend"><ContextHelp title="颜色说明"><div className="task-legend-items"><PriorityBadge priority="high" /><PriorityBadge priority="medium" /><PriorityBadge priority="low" /><WorkTypeBadge isMonthly /><WorkTypeBadge isTemporary /><WorkTypeBadge /></div><p>优先级看色条与信号图标，工作类型看标签。逾期单独标记；临时任务纳入月度目标后保留临时来源。</p></ContextHelp></div>
}
