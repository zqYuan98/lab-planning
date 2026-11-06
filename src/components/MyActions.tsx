import { useState } from 'react'
import type { ActionKind, MyActions as MyActionsModel } from '../../shared/my-actions'
import { openTask, type Navigate } from '../navigation'
import { useBusinessResource } from '../use-business-resource'
import { Badge, dateTime, type PageProps } from '../ui'
import { MinimalSupportPanel } from './TaskSupport'
import { actionLabels as labels, actionButtonLabels, actionNavigation } from '../my-actions-flow'
export default function MyActions({navigate,...props}:PageProps&{navigate:Navigate}) {
  const [kind,setKind]=useState(''),[cursors,setCursors]=useState<string[]>([]),[blockerId,setBlockerId]=useState<string|null>(null)
  const cursor=cursors.at(-1),query=new URLSearchParams({limit:'30',...(kind?{kind}:{}),...(cursor?{cursor}:{})})
  const resource=useBusinessResource<MyActionsModel>(`/my-actions?${query}`,`${props.data.user.id}:${props.data.operationEpoch}:${props.data.accessScopeVersion||''}`),view=resource.value
  return <section className="panel my-actions"><div className="section-heading"><h2>待我处理 <Badge>{view?.totalCount??'…'}</Badge></h2><button type="button" className="text-button" onClick={()=>{if(cursors.length)setCursors([]);else void resource.refresh().catch(()=>{})}}>刷新</button></div><p className="form-hint">从当前业务状态生成。查看消息不会减少待办，处理完成后自动更新。</p>
    <div className="action-kind-filters" aria-label="待办分类"><button type="button" className={!kind?'selected':''} onClick={()=>{setKind('');setCursors([])}}>全部 {view?.totalCount??0}</button>{Object.entries(labels).filter(([id]) => id === kind || (view?.counts[id as ActionKind] ?? 0) > 0).map(([id,label])=><button type="button" key={id} className={kind===id?'selected':''} onClick={()=>{setKind(id);setCursors([])}}>{label} {view?.counts[id as ActionKind]??0}</button>)}</div>
    {resource.error&&<p className="error">{resource.error}</p>}{resource.loading&&<p>正在读取待办…</p>}{view&&!view.items.length&&<p>此类别暂无需要处理的事项。</p>}
    {view?.items.map(item=><article className="action-item" key={item.key}><div><strong>{item.title}</strong> <Badge>{labels[item.kind]}</Badge>{item.sharedQueue&&<Badge>管理队列</Badge>}<p>{item.requiredAction}{item.dueAt?` · 期限 ${dateTime(item.dueAt)}`:''}</p>{item.blockedReason&&<p className="form-hint">{item.blockedReason}</p>}</div><button className="button secondary" onClick={()=>{const target=item.actionTarget;if(target.page==='task')openTask({taskId:target.id,section:target.section});else if(target.page==='support')setBlockerId(target.id);else { const next = actionNavigation(target); navigate(next.page, next.intent) }}}>{item.blockedReason ? '查看处理要求' : actionButtonLabels[item.kind]}</button></article>)}
    <div className="form-footer">{cursors.length>0&&<button className="button secondary" onClick={()=>setCursors(old=>old.slice(0,-1))}>上一页</button>}{view?.nextCursor&&<button className="button secondary" onClick={()=>setCursors(old=>[...old,view.nextCursor!])}>下一页</button>}{view&&<small>当前筛选 {view.filteredCount} 项 · 更新于 {dateTime(view.asOf)}</small>}</div>
    {blockerId&&<MinimalSupportPanel key={blockerId} {...props} blockerId={blockerId} onClose={()=>setBlockerId(null)}/>}
  </section>
}
