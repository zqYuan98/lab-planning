import { useState } from 'react'
import type { ActionKind, MyActions as MyActionsModel } from '../../shared/my-actions'
import { openTask, type Navigate } from '../navigation'
import { useBusinessResource } from '../use-business-resource'
import { Badge, dateTime, type PageProps } from '../ui'
import { MinimalSupportPanel } from './TaskSupport'
const labels:Record<ActionKind,string>={monthly_review:'月目标待审核',monthly_acceptance:'月成果待验收',weekly_review:'周计划待审核',delivery_review:'个人成果待验收',deadline_review:'延期审批',followup_response:'催办待回应',support:'支持协调',decision:'决策',assignment:'待分派 / 需恢复',revisit:'待复查'}
export default function MyActions({navigate,...props}:PageProps&{navigate:Navigate}) {
  const [kind,setKind]=useState(''),[cursors,setCursors]=useState<string[]>([]),[blockerId,setBlockerId]=useState<string|null>(null)
  const cursor=cursors.at(-1),query=new URLSearchParams({limit:'30',...(kind?{kind}:{}),...(cursor?{cursor}:{})})
  const resource=useBusinessResource<MyActionsModel>(`/my-actions?${query}`,`${props.data.user.id}:${props.data.operationEpoch}:${props.data.accessScopeVersion||''}`),view=resource.value
  return <section className="panel my-actions"><div className="section-heading"><h2>待我处理 <Badge>{view?.totalCount??'…'}</Badge></h2><button type="button" className="text-button" onClick={()=>{if(cursors.length)setCursors([]);else void resource.refresh().catch(()=>{})}}>刷新</button></div><p className="form-hint">从当前业务状态生成。查看消息不会减少待办，处理完成后自动更新。</p>
    <div className="action-kind-filters" aria-label="待办分类"><button type="button" className={!kind?'selected':''} onClick={()=>{setKind('');setCursors([])}}>全部 {view?.totalCount??0}</button>{Object.entries(labels).map(([id,label])=><button type="button" key={id} className={kind===id?'selected':''} onClick={()=>{setKind(id);setCursors([])}}>{label} {view?.counts[id as ActionKind]??0}</button>)}</div>
    {resource.error&&<p className="error">{resource.error}</p>}{resource.loading&&<p>正在读取待办…</p>}{view&&!view.items.length&&<p>此类别暂无需要处理的事项。</p>}
    {view?.items.map(item=><article className="action-item" key={item.key}><div><strong>{item.title}</strong> <Badge>{labels[item.kind]}</Badge>{item.sharedQueue&&<Badge>管理队列</Badge>}<p>{item.requiredAction}{item.dueAt?` · 期限 ${dateTime(item.dueAt)}`:''}</p>{item.blockedReason&&<p className="form-hint">{item.blockedReason}</p>}</div><button className="button secondary" onClick={()=>{const target=item.actionTarget;if(target.page==='task')openTask({taskId:target.id,section:target.section});else if(target.page==='support')setBlockerId(target.id);else navigate(target.page,{id:target.id,month:target.month,cycleWeek:target.cycleWeek,weekStart:target.cycleWeek,ownerId:target.ownerId,kind:target.kind,action:target.action==='review'?'review':target.action==='result'?'result':undefined})}}>处理</button></article>)}
    <div className="form-footer">{cursors.length>0&&<button className="button secondary" onClick={()=>setCursors(old=>old.slice(0,-1))}>上一页</button>}{view?.nextCursor&&<button className="button secondary" onClick={()=>setCursors(old=>[...old,view.nextCursor!])}>下一页</button>}{view&&<small>当前筛选 {view.filteredCount} 项 · 更新于 {dateTime(view.asOf)}</small>}</div>
    {blockerId&&<MinimalSupportPanel key={blockerId} {...props} blockerId={blockerId} onClose={()=>setBlockerId(null)}/>}
  </section>
}
