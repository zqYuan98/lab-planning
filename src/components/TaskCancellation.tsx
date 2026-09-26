import { LIMITS } from '../../shared/entity-rules'
import type { Bootstrap, Task } from '../../shared/types'
import { isActiveTask } from '../../shared/task-state'
import { isActiveWeeklyRecord } from '../../shared/weekly-record-state'
import { api, finishSaved, json } from '../api'
import { Field, Form, Modal, nameOf } from '../ui'

export function canCancelTask(data: Bootstrap, task: Task | undefined): task is Task {
  return data.user.role === 'manager' && !!task && isActiveTask(task) &&
    data.tasks.some(item => item.id === task.id && isActiveTask(item)) &&
    !data.weeklyRecords.some(record => record.taskId === task.id && isActiveWeeklyRecord(record))
}

export function TaskCancellationAction({ data, task, onCancel, label = '作废任务' }: {
  data: Bootstrap
  task: Task | undefined
  onCancel: (task: Task) => void
  label?: string
}) {
  if (!canCancelTask(data, task)) return null
  return <button type="button" className="button secondary" onClick={() => onCancel(task)}>{label}</button>
}

export async function submitTaskCancellation(data: Bootstrap, task: Task, reason: string, onSaved: () => Promise<void>) {
  if (!canCancelTask(data, task)) throw new Error('仅管理员可作废没有未删除周安排的任务，请刷新后核对。')
  const trimmedReason = reason.trim()
  if (!trimmedReason) throw new Error('请填写作废原因')
  await api<Task>(`/tasks/${task.id}/cancel`, json({ version: task.version, reason: trimmedReason }))
  await finishSaved(onSaved)
}

export function TaskCancellationModal({ data, task, onClose, onSaved }: {
  data: Bootstrap
  task: Task
  onClose: () => void
  onSaved: () => Promise<void>
}) {
  const plan = data.plans.find(item => item.id === task.monthlyPlanId)
  return <Modal title="作废这项任务" onClose={onClose}>
    <div className="context-box">
      <strong>{task.title}</strong>
      <p>负责人：{nameOf(data, task.ownerId)} · 任务 #{task.id.slice(-6).toUpperCase()}</p>
      <p>月度归属：{plan ? `${plan.month} · ${plan.title}` : task.monthlyPlanId ? `目标 #${task.monthlyPlanId.slice(-6).toUpperCase()}` : '未关联月度目标'}</p>
    </div>
    <p className="modal-intro">确认这项任务已不再使用。作废后，该任务退出任务总数、未排周列表及待办，不能再安排周工作；已有周记录、提交和报告历史保留，月度目标保持不变。</p>
    <p className="form-hint">此操作只作废上方原任务。若仍需继续工作，请取消后补充月度关联或重新安排周工作。作废原因将留痕。</p>
    <Form onCancel={onClose} submitLabel="确认作废任务" onSubmit={async event => {
      const reason = String(new FormData(event.currentTarget).get('reason') || '')
      await submitTaskCancellation(data, task, reason, onSaved)
    }}>
      <Field label="作废原因" hint="例如：这项旧任务已不再使用，调整后的工作已另行安排。"><textarea name="reason" required rows={3} maxLength={LIMITS.text} /></Field>
    </Form>
  </Modal>
}
