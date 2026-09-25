/** Deliberately closed vocabulary. Never put route paths, query strings or content here. */
export const usagePages = ['overview', 'monthly', 'weekly', 'goals', 'projects', 'imports', 'messages', 'collaboration', 'work-register', 'feedback', 'authorized-work', 'period-reviews'] as const
export const usageActions = ['task_saved', 'work_captured', 'weekly_record_saved', 'weekly_submitted', 'plan_saved', 'plan_submitted', 'progress_recorded', 'delivery_submitted', 'feedback_submitted'] as const
export type UsagePage = typeof usagePages[number]
export type UsageAction = typeof usageActions[number]
export const usagePageLabels: Record<UsagePage, string> = { overview: '工作概览', monthly: '月度目标', weekly: '周记录', goals: '年度目标', projects: '项目', imports: '导入', messages: '消息', collaboration: '协作', 'work-register': '工作清单', feedback: '反馈', 'authorized-work': '授权工作', 'period-reviews': '周期复盘' }
export const usageActionLabels: Record<UsageAction, string> = { task_saved: '保存任务', work_captured: '批量收件', weekly_record_saved: '保存周记录', weekly_submitted: '正式周提报', plan_saved: '保存月度目标', plan_submitted: '提交月度目标', progress_recorded: '记录进展', delivery_submitted: '提交交付', feedback_submitted: '提交反馈' }
export interface UsagePolicy { enabled: boolean; version: string }
export interface UsageSettings { version: number; enabled: boolean; retentionDays: 30 | 90; excludedUserIds: string[] }
export interface UsageSettingsView { settings: UsageSettings; effectiveEnabled: boolean; activationRequired: boolean; buildVersion: string; storageUnavailable?: boolean }
export interface UsageAggregateRow { name: UsagePage | UsageAction; count: number; members: number; memberRate: number }
export interface UsageSummary {
  from: string; to: string; version: string; retentionDays: 30 | 90; eligibleMembers: number; activeMembers: number; observedDays: number; observationDays: number
  denominator: 'active_members_in_period'; insufficientData: boolean; pages: UsageAggregateRow[]; actions: UsageAggregateRow[]
}
