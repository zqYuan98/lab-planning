import type { AnnualGoal, MonthlyPlan, Project, User } from './types'
import type { WorkspacePage } from './workspace-query'

export type DirectoryAccount = Pick<User, 'id' | 'name' | 'role' | 'position' | 'active' | 'registrationStatus'>
export type DirectoryAccountPurpose = 'assignment' | 'notification' | 'diagnostics' | 'usage'
export interface DirectoryAccountsPage extends WorkspacePage<DirectoryAccount> { selected: DirectoryAccount[] }
export interface TeamCounts { active: number; inactive: number; all: number; activeManagers: number; pending: number; rejected: number }
export interface TeamPage extends WorkspacePage<User> { counts: TeamCounts; focus: User | null }
export interface RegistrationPage extends WorkspacePage<User> { counts: Pick<TeamCounts, 'pending' | 'rejected'> }
export interface DirectoryProject extends Project { publishedPlanCount: number; owner: DirectoryAccount | null }
export interface ProjectsPage extends WorkspacePage<DirectoryProject> { counts: { active: number; archived: number; all: number }; focus: DirectoryProject | null }
export interface DirectoryGoal extends AnnualGoal { owner: DirectoryAccount | null; progressSummary: import('./annual-goals').AnnualGoalProgress }
export interface AnnualGoalDetail extends WorkspacePage<MonthlyPlan> { goal: DirectoryGoal }
export interface GoalsPage extends WorkspacePage<DirectoryGoal> { counts: { active: number; completed: number; all: number }; year: number }
