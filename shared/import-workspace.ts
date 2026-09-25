import type { MonthlyPlan, Project, Task, User } from './types'
import type { WorkspacePage } from './workspace-query'
export interface ImportReferences { users: User[]; projects: Project[]; plans: MonthlyPlan[]; tasks: Task[] }
export type ImportCandidateKind = keyof ImportReferences
export interface ImportReferenceIds { users: string[]; projects: string[]; plans: string[]; tasks: string[] }
export interface ImportCandidatePage extends WorkspacePage<User | Project | MonthlyPlan | Task> { references: Pick<ImportReferences, 'users'> }
