import type { ReactNode } from 'react'
import { CalendarDays, ChevronDown, CircleHelp, SignalHigh, Zap } from 'lucide-react'
import { priorityLabels, workKind, workKindLabels, type TaskPriority } from '../task-presentation'

export function PriorityBadge({ priority }: { priority?: TaskPriority }) {
  if (priority !== 'high') return null
  return <span className="task-signal task-signal-priority task-signal-high"><SignalHigh size={13} aria-hidden="true" />{priorityLabels.high}</span>
}

export function WorkTypeBadge(props: { isTemporary?: boolean; monthlyPlanId?: string | null; isMonthly?: boolean }) {
  const kind = workKind(props)
  if (kind === 'routine' || (kind === 'monthly' && props.isMonthly)) return null
  const Icon = kind === 'temporary' ? Zap : CalendarDays
  return <span className={`task-signal task-signal-${kind}`}><Icon size={12} aria-hidden="true" />{kind === 'temporary' && props.isMonthly ? '临时目标' : workKindLabels[kind]}</span>
}

export function ContextHelp({ title, children }: { title: string; children: ReactNode }) {
  return <details className="context-help"><summary><CircleHelp size={14} aria-hidden="true" /><span>{title}</span><ChevronDown size={14} className="context-help-chevron" aria-hidden="true" /></summary><div className="context-help-content">{children}</div></details>
}
