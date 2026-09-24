import type { WorkRegisterReportRow, WorkRegisterReportSnapshot } from '../shared/work-register'

export const workRegisterReportColumns: readonly { key: keyof WorkRegisterReportRow; label: string }[] = [
  { key: 'title', label: '事项' }, { key: 'source', label: '来源' },
  { key: 'assignedBy', label: '交办人' }, { key: 'assignedOn', label: '交办日期' },
  { key: 'requestedOutcome', label: '预期交付' }, { key: 'status', label: '总体状态' },
  { key: 'overallProgress', label: '总体说明' }, { key: 'latestExecution', label: '最新执行' }, { key: 'nextAction', label: '下一步' },
  { key: 'progress', label: '完成、阻塞与历史补充' },
  { key: 'dueDate', label: '截止日期' }, { key: 'priority', label: '优先级' },
  { key: 'estimatedEffort', label: '预计剩余投入' }, { key: 'decisionNeeded', label: '需领导决策' },
  { key: 'waitingForFeedback', label: '待反馈' }, { key: 'schedule', label: '周安排' },
  { key: 'itemType', label: '事项类型' },
]

function cell(value: string | number): string {
  const text = String(value)
  // Spreadsheet apps may skip leading spaces or control characters before evaluating a formula.
  const safe = /^[\s\u0000-\u001f\u007f]*[=+@-]/u.test(text) || /^[\u0000-\u001f\u007f]/u.test(text) ? `'${text}` : text
  return `"${safe.replace(/"/g, '""')}"`
}

/** CSV is generated exclusively from the snapshot currently shown in the preview. */
export function workRegisterReportCsv(snapshot: WorkRegisterReportSnapshot): string {
  const rows: (string | number)[][] = [
    ['我的工作清单汇报'], ['本人', snapshot.owner.name], ['生成时间', snapshot.generatedAt],
    ['筛选范围', snapshot.rangeLabel], ['事项数', snapshot.totalCount],
    ['截止待确认数', snapshot.unknownDueDateCount], ['需要协调数', snapshot.coordinationCount], [],
    workRegisterReportColumns.map(column => column.label),
    ...snapshot.rows.map(row => workRegisterReportColumns.map(column => row[column.key])),
  ]
  return `\uFEFF${rows.map(row => row.map(cell).join(',')).join('\r\n')}\r\n`
}
