import type { Entity, Task, WeeklyRecord } from './types.ts'

export type ObjectType = 'task' | 'project_summary' | 'scoped_report'
export type ObjectCapability = 'read' | 'read_evidence' | 'export_summary'
export type HistoryPolicy = 'current_onward' | 'all_history'
export interface ObjectGrant extends Entity {
  subjectId: string; objectType: ObjectType; objectId: string; capabilities: ObjectCapability[];
  historyPolicy: HistoryPolicy; objectVersion: number; grantedBy: string; grantedAt: string;
  expiresAt: string | null; revokedAt: string | null; reason: string;
  /** Exact preexisting fact identities eliminate same-millisecond boundary ambiguity. */
  excludedFactIds: string[];
}
export interface ScopeFact {
  objectType: 'task' | 'project_summary'; objectId: string; objectVersion: number;
  factType: 'current' | 'weeklyRecord' | 'delivery' | 'history'; factId: string; factVersion: number;
  occurredAt: string | null; recordedAt: string | null;
}
export interface ScopedReport extends Entity {
  subjectId: string; title: string; narrative: string; manifest: ScopeFact[];
  evidenceRefs: { objectId: string; factId: string; value: string }[];
  finalizedBy: string; finalizedAt: string; hash: string;
}
export interface AuthorizedWorkItem {
  id: string; objectType: ObjectType; objectId: string; title: string; capabilities: ObjectCapability[]; grantId: string; version: number;
}
export interface AuthorizedWorkResponse { items: AuthorizedWorkItem[]; scopeVersion: string }
export interface AuthorizedHistoryItem { id: string; action: string; occurredAt: string; actorName: string }
export interface AuthorizedDelivery {
  id: string; seriesId: string; revision: number; submittedAt: string; actualOutcome: string;
  evidenceRefs: unknown[]; acceptanceCriteriaSnapshot: string; status: string;
}
export interface AuthorizedTaskView {
  task: Task; weeklyRecords: WeeklyRecord[]; history: AuthorizedHistoryItem[]; deliveries: AuthorizedDelivery[];
  deliverySummary: { pending_review: number; accepted: number; returned: number; withdrawn: number };
  monthReference: { id: string; title: string } | null; projectReference: { id: string; name: string } | null;
  allowedActions: string[]; readOnlyReason: string;
}
export interface AuthorizedProjectSummary { id: string; name: string; scopeLabel: '授权范围内'; taskCount: number; completedTaskCount: number; blockedTaskCount: number }
