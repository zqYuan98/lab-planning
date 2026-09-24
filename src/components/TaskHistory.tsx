import { useState } from 'react'
import type { TaskHistoryPage } from '../../shared/task-view'
import { useBusinessResource } from '../use-business-resource'
import { dateTime } from '../ui'
export default function TaskHistory({taskId,scope}:{taskId:string;scope:string}) {
  const [cursors,setCursors]=useState<string[]>([]),cursor=cursors.at(-1)
  const resource=useBusinessResource<TaskHistoryPage>(`/tasks/${taskId}/history?limit=30${cursor?`&cursor=${encodeURIComponent(cursor)}`:''}`,scope)
  return <section className="task-section"><h3>任务历史</h3>{resource.error&&<p className="error">{resource.error}<button type="button" className="text-button" onClick={()=>{setCursors([]);void resource.refresh().catch(()=>{})}}>重新读取当前历史</button></p>}{resource.loading&&<p>正在读取历史…</p>}{resource.value?.items.map(row=><article className="collaboration-history" key={row.id}><strong>{row.title}</strong><p>{row.detail}</p><small>{row.at?dateTime(row.at):'历史发生时间不明'}</small></article>)}{resource.value&&!resource.value.items.length&&<p>暂无当前权限可查看的历史。</p>}<div className="form-footer">{cursors.length>0&&<button className="button secondary" onClick={()=>setCursors(old=>old.slice(0,-1))}>上一页</button>}{resource.value?.nextCursor&&<button className="button secondary" onClick={()=>setCursors(old=>[...old,resource.value!.nextCursor!])}>更早记录</button>}</div></section>
}
