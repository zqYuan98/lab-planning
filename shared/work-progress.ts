export type EvidenceQuality = 'recorded' | 'audit_reconstructed' | 'unknown'
export interface ExecutionProgress {
  text: string
  sourceType: 'task' | 'weeklyRecord' | 'progress'
  sourceId: string
  weekStart?: string
  occurredAt: string | null
  recordedAt: string | null
  actorId: string
  proxy: boolean
  evidenceQuality: EvidenceQuality
}
export interface WorkProgress {
  overallProgress: { text: string; changedAt: string | null; evidenceRef: string | null } | null
  latestExecution: ExecutionProgress | null
  historicalExecution: ExecutionProgress[]
}
