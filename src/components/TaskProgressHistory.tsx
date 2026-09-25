import { useState } from 'react'
import type { ProgressEvent } from '../../shared/collaboration'
import type { WorkspacePage } from '../../shared/workspace-query'
import { useWorkspaceQuery } from '../workspace-query'
import { dateTime } from '../ui'

export default function TaskProgressHistory({ taskId, scope }: { taskId: string; scope: string }) {
  const [cursors, setCursors] = useState<string[]>([])
  const resource = useWorkspaceQuery<WorkspacePage<ProgressEvent>>(`/workspace/progress?taskId=${encodeURIComponent(taskId)}&limit=30${cursors.length ? `&cursor=${encodeURIComponent(cursors.at(-1)!)}` : ''}`, scope, undefined, { onCursorStale: () => { setCursors([]); return `/workspace/progress?taskId=${encodeURIComponent(taskId)}&limit=30` } })
  return <section className="task-section"><h3>进展记录</h3>
    {resource.error&&<p role="alert" className="error">{resource.error}<button className="text-button" onClick={()=>{setCursors([]);void resource.reload().catch(()=>{})}}>刷新进展</button></p>}
    {resource.loading&&<p role="status">正在读取进展…</p>}
    {resource.value&&<p>共 {resource.value.total} 条 · 本页 {resource.value.items.length} 条</p>}
    {resource.value?.items.map(row=><article className="collaboration-history" key={row.id}><strong>{row.noteType==='no_change'?'暂无新进展':'进展更新'}</strong><p>{row.note || row.noChangeReason || row.changes.map(change=>`${change.field}：${change.after}`).join('；')}</p>{row.nextAction&&<p>下一步：{row.nextAction}</p>}<small>发生于 {dateTime(row.occurredAt)} · 记录于 {dateTime(row.createdAt)}</small></article>)}
    <div className="form-footer"><button className="button secondary" disabled={!cursors.length||resource.loading} onClick={()=>setCursors(value=>value.slice(0,-1))}>上一页</button><button className="button secondary" disabled={!resource.value?.nextCursor||resource.loading} onClick={()=>setCursors(value=>[...value,resource.value!.nextCursor!])}>更早进展</button></div>
  </section>
}
