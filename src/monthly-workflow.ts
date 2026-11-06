import type { MonthlyPlan, User } from '../shared/types'
import { canUseAccount } from '../shared/auth-policy'
import { isActiveMonthlyPlan } from '../shared/monthly-plan-state'
import type { NavigationIntent } from './navigation'

export const monthlyStatusLabels: Record<MonthlyPlan['status'], string> = {
  draft: '草稿', submitted: '待审核', returned: '退回修改', approved: '审核通过，待发布', published: '已发布', merged: '已合并',
}
export type MonthlyWorkflowAction = 'submit' | 'review' | 'publish' | 'create-task' | 'result'

/** Presentation capabilities mirror the server workflow; API checks remain authoritative. */
export function monthlyWorkflow(plan: MonthlyPlan, actor: User, archived = false) {
  const manager = actor.role === 'manager'
  const live = canUseAccount(actor) && actor.role !== 'observer' && !plan.visibility && isActiveMonthlyPlan(plan) && plan.status !== 'merged'
  const editableDraft = ['draft', 'returned'].includes(plan.status)
  const participant = plan.ownerId === actor.id || plan.collaboratorIds.includes(actor.id)
  const canEdit = live && (manager || !!plan.isTemporary && plan.ownerId === actor.id && editableDraft)
  const canSubmit = canEdit && editableDraft && !archived
  const canReview = live && manager && plan.status === 'submitted'
  const canPublish = live && manager && plan.status === 'approved' && !archived
  const canCreateOwnTask = live && participant && !archived
  const canResult = live && plan.status === 'published' && (manager || plan.ownerId === actor.id && plan.acceptanceStatus !== 'accepted')
  // Members' legacy self-created ordinary proposals are checked against creation
  // audit on the server. Being an assignee alone never authorizes deletion.
  const canDelete = live && !plan.publishedVersion && ['draft', 'returned', 'submitted', 'approved'].includes(plan.status)
    && (manager || plan.ownerId === actor.id && editableDraft && (!!plan.isTemporary || !plan.importSource))
  let primary: { action: MonthlyWorkflowAction; label: string } | null = null
  let nextStep = ''
  if (!live) nextStep = plan.deletion ? '此目标已删除，仅保留历史，不再计入当前目标、统计和待办。' : plan.visibility ? '这是历史记录，仅供查看。' : plan.status === 'merged' ? '此目标已合并，请查看合并后的目标。' : '当前账号没有此目标的操作权限。'
  else if (editableDraft) {
    nextStep = canEdit ? '核对目标内容后提交审核；审核通过后仍需管理员发布，才可正式排周。' : '等待管理员核对并提交审核；审核通过、发布后才能正式排周。'
    if (canSubmit) primary = { action: 'submit', label: plan.status === 'returned' ? '重新提交审核' : '提交审核' }
  } else if (plan.status === 'submitted') {
    nextStep = manager ? '请审核目标。通过后还需发布，目标才会正式生效。' : '已提交，等待管理员审核并发布。'
    if (canReview) primary = { action: 'review', label: '审核目标' }
  } else if (plan.status === 'approved') {
    nextStep = manager ? '审核已通过。发布此目标后，成员可据此提交正式周计划。' : '审核已通过，等待管理员发布。'
    if (canPublish) primary = { action: 'publish', label: '发布此目标' }
  } else if (plan.status === 'published') {
    nextStep = '目标已发布，可建立个人任务并安排周工作；成果提交后由管理员验收。'
    if (canCreateOwnTask) primary = { action: 'create-task', label: '建立任务并安排' }
    else if (canResult) primary = { action: 'result', label: manager ? '成果验收' : '提交成果' }
  }
  if (live && archived) nextStep = '所属项目已归档，不能提交、发布或建立任务。请先由管理员恢复项目；已有记录仍可核对。'
  return { canEdit, canSubmit, canReview, canPublish, canCreateOwnTask, canResult, canDelete, primary, nextStep, stateLabel: plan.deletion ? '已删除' : monthlyStatusLabels[plan.status] }
}

export function monthlyIntentModal(plan: MonthlyPlan, actor: User, action?: NavigationIntent['action'], archived = false): string {
  const flow = monthlyWorkflow(plan, actor, archived)
  if (action === 'submit' && flow.canSubmit) return 'submit'
  if (action === 'review' && flow.canReview) return 'review'
  if (action === 'publish' && flow.canPublish) return 'publish-one'
  if (action === 'result' && flow.canResult) return 'result'
  if (action === 'create-task' && flow.canCreateOwnTask) return 'task'
  return 'detail'
}

export function monthlyPublishInput(plans: MonthlyPlan[], reason: unknown) {
  if (!plans.length || plans.some(plan => plan.visibility || !isActiveMonthlyPlan(plan) || plan.status !== 'approved') || new Set(plans.map(plan => plan.month)).size !== 1) throw new Error('请重新核对本次可发布目标。')
  return { planIds: plans.map(plan => plan.id), planVersions: Object.fromEntries(plans.map(plan => [plan.id, plan.version])), reason }
}
