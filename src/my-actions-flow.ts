import type { ActionItem, ActionKind } from '../shared/my-actions'
import type { NavigationIntent, PageId } from './navigation'

export const actionLabels: Record<ActionKind, string> = {
  monthly_submit: '月目标待提交', monthly_review: '月目标待审核', monthly_publish: '月目标待发布', monthly_acceptance: '月成果待验收',
  weekly_review: '周计划待审核', delivery_review: '个人成果待验收', deadline_review: '延期审批', followup_response: '催办待回应',
  support: '支持协调', decision: '决策', assignment: '待分派 / 需恢复', revisit: '待复查',
}
export const actionButtonLabels: Record<ActionKind, string> = {
  monthly_submit: '核对并提交', monthly_review: '审核目标', monthly_publish: '核对并发布', monthly_acceptance: '验收成果',
  weekly_review: '审核整份计划', delivery_review: '验收个人成果', deadline_review: '处理延期申请', followup_response: '回应催办',
  support: '处理支持事项', decision: '记录决策', assignment: '查看并处理', revisit: '查看复查事项',
}

/** Delegated review opens only the minimal review queue, never another member's personal workspace. */
export function actionNavigation(target: ActionItem['actionTarget']): { page: PageId; intent: NavigationIntent } {
  if (target.page === 'weekly' && target.action === 'review-queue') return {
    page: 'weekly', intent: { action: 'review-queue', cycleWeek: target.cycleWeek, weekStart: target.cycleWeek, reviewDutyId: target.id },
  }
  const action = target.action === 'submit' || target.action === 'review' || target.action === 'publish' || target.action === 'result' ? target.action : undefined
  return { page: target.page === 'task' || target.page === 'support' ? 'weekly' : target.page,
    intent: { id: target.id, month: target.month, cycleWeek: target.cycleWeek, weekStart: target.cycleWeek, ownerId: target.ownerId, kind: target.kind, action } }
}
