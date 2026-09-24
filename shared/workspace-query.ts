import type { Report, User, Task, MonthlyPlan, WeeklyRecord, AuditEvent, Project } from './types'
import type { WorkRegisterResult } from './work-register'

export interface WorkspaceShellData {
  user: User
  capabilities: { manage: boolean; business: boolean; authorizedWork: boolean }
  accessScopeVersion: string
  operationEpoch: string
  aiConfigured: boolean
  counts: { openTasks: number }
}
export type ReportMetadata = Pick<Report, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'type' | 'period' | 'title' | 'status' | 'revision' | 'authorId' | 'finalizedAt'>
export interface WorkspacePage<T> { items: T[]; total: number; nextCursor: string | null; revision: string; accessScopeVersion: string }
export type WorkspaceResource = 'tasks' | 'weekly-records' | 'plans' | 'history' | 'progress' | 'reports' | 'candidates'
export type WorkspaceItem = Task | MonthlyPlan | WeeklyRecord | AuditEvent | ReportMetadata | User | Project | import('./collaboration').ProgressEvent
export interface RegisterPage extends WorkspacePage<WorkRegisterResult['rows'][number]> {
  result: WorkRegisterResult
  highCount: number
  references: { plans: MonthlyPlan[]; projects: Project[] }
}
