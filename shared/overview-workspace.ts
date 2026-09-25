import type { MonthlyPlan, Task, User, WeeklyRecord } from './types'
import type { MonthWeek, TrendPoint } from './overview-data'
import type { WorkFilters, WorkRow, summarizeWorkRows } from './overview-workspace-data'
import type { WorkspacePage } from './workspace-query'

export type OverviewRow = Omit<WorkRow, 'task' | 'record' | 'records'> & { weeklyRecordId?: string }
export type OverviewSummary = ReturnType<typeof summarizeWorkRows> & { risk: number }
export type OverviewMember = Pick<User, 'id' | 'name' | 'role' | 'position' | 'active'> & { summary: OverviewSummary; preview: OverviewRow[]; projects: string[]; due: string }
export interface OverviewGroup { id: string; name: string; summary: OverviewSummary; ownerCount: number; planCount: number; ownerNames: string[] }
export interface DepartmentOverviewResponse extends WorkspacePage<OverviewRow> {
  operationEpoch: string; startDate: string; endDate: string; summary: OverviewSummary; members: OverviewMember[];
  memberOptions: Pick<User, 'id' | 'name' | 'active'>[]; projectOptions: { id: string; name: string }[];
  groups: { status: OverviewGroup[]; owner: OverviewGroup[]; project: OverviewGroup[] };
}
export type OverviewDrill = Pick<WorkFilters, 'ownerId' | 'projectId' | 'status' | 'riskOnly'>
export type PersonalPlan = Pick<MonthlyPlan, 'id' | 'title' | 'month' | 'ownerId' | 'priority' | 'status' | 'acceptanceStatus' | 'dueDate' | 'isTemporary'> & { ownerName: string }
export interface PersonalRecord {
  id: string; taskId: string; monthlyPlanId: string | null; ownerName: string; title: string; planTitle: string;
  priority?: Task['priority']; isTemporary: boolean; effective: boolean; pendingLabel: string; status: WeeklyRecord['status'];
}
export type PersonalCount = 'plans' | 'published' | 'pending' | 'approved' | 'reviewScope' | 'records' | 'submitted' | 'blocked' | 'notDone' | 'accepted' | 'awaitingAcceptance' | 'returned' | 'drafts' | 'missingMembers' | 'done'
export interface PersonalOverviewResponse {
  today: string; month: string; weekStart: string; counts: Record<PersonalCount, number>;
  monthChange: number | null; weekChange: number | null; monthTrend: TrendPoint[]; weekTrend: TrendPoint[]; weeks: MonthWeek[];
  focusPlans: PersonalPlan[]; focusRecords: PersonalRecord[]; firstAwaitingAcceptanceId?: string;
  revision: string; accessScopeVersion: string; operationEpoch: string;
}
