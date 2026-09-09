import type { ImportRow } from './import-types'

export function importedMonthlyResult(row: Pick<ImportRow, 'monthlyResult' | 'actualOutcome' | 'sourceStatus'>): NonNullable<ImportRow['monthlyResult']> {
  if (row.monthlyResult) return row.monthlyResult
  if (['未完成', '未达成', 'not_done', 'not completed'].includes(row.sourceStatus.trim().toLowerCase())) return 'not_completed'
  return row.actualOutcome.trim() ? 'submitted' : 'pending'
}

export function importedWeeklyStatus(row: Pick<ImportRow, 'weeklyStatus' | 'sourceStatus'>): NonNullable<ImportRow['weeklyStatus']> {
  if (row.weeklyStatus) return row.weeklyStatus
  const status = row.sourceStatus.trim().toLowerCase()
  if (['未完成', '未达成', 'not_done', 'not completed'].includes(status)) return 'not_done'
  if (['阻塞', '受阻', '已阻塞', 'blocked'].includes(status)) return 'blocked'
  if (['完成', '已完成', '已结束', 'done', 'completed', '100%'].includes(status)) return 'done'
  if (['进行中', '执行中', '正在进行', 'doing', 'in progress'].includes(status)) return 'doing'
  return 'planned'
}
