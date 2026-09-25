import { useState } from 'react'
import type { GoalOwnerProgress, GoalOwnerTasks } from '../../shared/goal-owner'
import { useWorkspaceQuery } from '../workspace-query'
import { Badge } from '../ui'

const statuses: Record<string, string> = { todo: '待开始', planned: '待开始', doing: '进行中', blocked: '受阻', done: '已完成', not_done: '未完成' }

/** This view uses only the goal-owner DTO; general task detail/edit APIs stay separate. */
export default function GoalOwnerWork({ planId, scope }: { planId: string; scope: string }) {
  return <OwnerTasks key={`${scope}:${planId}`} planId={planId} scope={scope} />
}
function OwnerTasks({ planId, scope }: { planId: string; scope: string }) {
  const [q, setQuery] = useState(''), [cursor, setCursor] = useState(''), [taskId, setTaskId] = useState('')
  const firstPath = `/workspace/goal-owner/plans/${encodeURIComponent(planId)}/tasks?limit=10&q=${encodeURIComponent(q)}`
  const query = useWorkspaceQuery<GoalOwnerTasks>(`${firstPath}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, scope, undefined, { onCursorStale: () => { setCursor(''); return firstPath } })
  const refresh = () => { setCursor(''); setTaskId(''); void query.reload(firstPath).catch(() => {}) }
  return <section className="submission-card" aria-label="目标关联任务与周进展">
    <div className="submission-card-top"><h3>关联任务与周进展</h3><Badge>负责人只读</Badge></div>
    <p className="form-hint">查看当前关联任务及已提交的周记录；提交状态不代表计划已审核通过。</p>
    <label>查找关联任务 <input value={q} maxLength={120} onChange={event => { setQuery(event.target.value); setCursor(''); setTaskId('') }} placeholder="输入任务名称" /></label>
    <button type="button" className="text-button" disabled={query.loading} onClick={refresh}>刷新关联任务</button>
    {query.error && <p role="alert">{query.error}</p>}
    {query.loading && !query.value && <p>正在读取关联任务…</p>}
    {query.value && <>
      <p className="form-hint">共 {query.value.total} 项关联任务</p>
      {!query.value.items.length && <p>暂无匹配的关联任务。</p>}
      {query.value.items.map(task => <article className="submission-card" key={task.id}>
        <div className="submission-card-top"><strong>{task.title}</strong><Badge>{statuses[task.status] || task.status}</Badge></div>
        <p>{task.ownerName}{task.dueDate ? ` · 截止 ${task.dueDate}` : ''}</p>
        <button type="button" className="text-button" onClick={() => setTaskId(taskId === task.id ? '' : task.id)}>{taskId === task.id ? '收起周进展' : '查看已提交周进展'}</button>
        {taskId === task.id && <OwnerProgress key={task.id} planId={planId} taskId={task.id} scope={scope} />}
      </article>)}
      <div className="submission-actions">
        {cursor && <button type="button" className="text-button" onClick={() => { setCursor(''); setTaskId('') }}>返回第一页</button>}
        {query.value.nextCursor && <button type="button" className="text-button" onClick={() => { setCursor(query.value!.nextCursor!); setTaskId('') }}>下一页关联任务</button>}
      </div>
    </>}
  </section>
}
function OwnerProgress({ planId, taskId, scope }: { planId: string; taskId: string; scope: string }) {
  const [cursor, setCursor] = useState('')
  const firstPath = `/workspace/goal-owner/plans/${encodeURIComponent(planId)}/tasks/${encodeURIComponent(taskId)}/weekly?limit=10`
  const query = useWorkspaceQuery<GoalOwnerProgress>(`${firstPath}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, scope, undefined, { onCursorStale: () => { setCursor(''); return firstPath } })
  return <div className="submission-preview">
    {query.error && <p role="alert">{query.error}<button type="button" className="text-button" onClick={() => { setCursor(''); void query.reload(firstPath).catch(() => {}) }}>重新读取周进展</button></p>}
    {query.loading && !query.value && <p>正在读取周进展…</p>}
    {query.value && !query.value.items.length && <p>当前关联下暂无已提交的周记录。</p>}
    {query.value?.items.map(record => <article key={record.id}>
      <strong>{record.weekStart} 当周</strong> <Badge>{statuses[record.status] || record.status}</Badge>
      <p>承诺：{record.commitment || '未填写'}</p><p>实际成果：{record.actualOutcome || '未填写'}</p>
      {record.blocker && <p>阻塞：{record.blocker}</p>}{record.nextAction && <p>下一步：{record.nextAction}</p>}
    </article>)}
    {cursor && <button type="button" className="text-button" onClick={() => setCursor('')}>返回最新周记录</button>}
    {query.value?.nextCursor && <button type="button" className="text-button" onClick={() => setCursor(query.value!.nextCursor!)}>更多周记录</button>}
  </div>
}
