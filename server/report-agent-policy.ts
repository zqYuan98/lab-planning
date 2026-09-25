import type { ReportAgentType, ReportTemplate } from '../shared/report-agent.ts'
import type { Store } from './store.ts'

/** Once reviewed templates take over, pausing a schedule or archiving a version never reopens the legacy writer. */
export function reportTypeManaged(store: Store, type: ReportAgentType): boolean {
  return store.list<ReportTemplate>('reportTemplates').some(template => (template.type || 'weekly') === type && (template.status === 'active' || !!template.activatedAt))
}
