import type { ReactNode } from 'react'
import { ChevronDown } from 'lucide-react'

/** Keep guidance available without competing with daily work. */
export default function WorkflowGuide({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="workflow-guide">
      <summary>{title}<ChevronDown size={16} aria-hidden="true" /></summary>
      {children}
    </details>
  )
}
