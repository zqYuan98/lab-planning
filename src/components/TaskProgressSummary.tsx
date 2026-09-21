import type { CollaborationTaskStatusSummary } from '../../shared/collaboration'
import type { Task } from '../../shared/types'
import { Badge } from '../ui'

const taskStatusNames = { todo: '未开始', doing: '进行中', blocked: '受阻', done: '成员自报完成' }
const weeklyStatusNames = { planned: '已计划', doing: '进行中', blocked: '受阻', done: '成员自报完成', not_done: '本周未完成' }

export default function TaskProgressSummary({ task, weeklySummary, overallStatusNeedsConfirmation }: { task: Task } & CollaborationTaskStatusSummary) {
  return <div className="collaboration-task-status">
    <div className="collaboration-status-line"><span>整个任务</span><Badge>{taskStatusNames[task.status]}</Badge></div>
    {weeklySummary ? <>
      <div className="collaboration-status-line"><span>{weeklySummary.isCurrentWeek ? '本周执行' : '最近周记录'}（{weeklySummary.weekStart} 起）</span><Badge>{weeklySummary.isImported && weeklySummary.status === 'done' ? '原记录标记完成' : weeklyStatusNames[weeklySummary.status]}</Badge>{weeklySummary.planReviewPending ? <Badge tone="amber">计划待审核 · 未纳入周统计</Badge> : !weeklySummary.submitted && <Badge>草稿</Badge>}</div>
      {weeklySummary.actualOutcome && <p className="collaboration-weekly-outcome">该周成果：{weeklySummary.actualOutcome}</p>}
      {overallStatusNeedsConfirmation && <p className="collaboration-status-explanation">{weeklySummary.isImported ? '该周原记录标记完成' : '该周已自报完成'}，整个任务仍未标记完成。若全部工作已结束，请在周进展中勾选“同时完成整个任务”，或更新整个任务的状态。</p>}
    </> : <p className="collaboration-weekly-outcome">暂无可展示的本周或历史周执行记录。</p>}
  </div>
}
