import { useState } from 'react'
import type { DraftValues } from '../draft-recovery'
import { compareDraft, mergeDraft } from '../draft-v3'

const fieldNames:Record<string,string>={title:'事项名称',description:'背景说明',currentProgress:'总体说明',nextAction:'下一步',status:'执行状态',taskStatus:'任务状态',__status:'任务状态',completionNote:'完成说明',evidenceUrl:'证据链接',actualOutcome:'本周成果',__completeTask:'同时完成任务',__taskStatus:'关联任务状态',__taskCompletionNote:'关联任务完成说明',blocker:'本周阻塞',blockerReason:'阻塞原因',blockerImpact:'阻塞影响',supportNeeded:'所需支持',ownerId:'负责人',collaboratorIds:'协作人',collaborators:'协作人',participantIds:'参与人',workSource:'来源',__source:'来源',priority:'优先级',__priority:'优先级',waitingForFeedback:'待反馈',__waiting:'待反馈',dueDate:'截止日期',assignedBy:'交办人',assignedOn:'交办日期',requestedOutcome:'预期交付',estimatedEffort:'预计剩余投入',decisionNeeded:'需决策',commitment:'本周承诺',submitted:'正式保存',__noteType:'更新类型',noteType:'更新类型',note:'进展说明',noChangeReason:'暂无变化原因'}
export default function DraftComparison({base,server,local,onMerge,onCancel}:{base:DraftValues|null;server:DraftValues;local:DraftValues;onMerge:(values:DraftValues)=>void;onCancel:()=>void}) {
  const groups=compareDraft(base,server,local),[choices,setChoices]=useState<Record<string,'server'|'local'>>({})
  const complete=groups.every(group=>choices[group.id]||group.choice)
  const show=(values:DraftValues)=>Object.entries(values).map(([key,value])=>{
    const text=Array.isArray(value)?value.join('、'):value
    const statusLabels:Record<string,string>={todo:'未开始',planned:'未开始',doing:'进行中',blocked:'受阻',done:'自报完成',not_done:'本周未完成'}
    const display=['status','taskStatus','__status','__taskStatus'].includes(key)?statusLabels[text]||text:key==='__completeTask'?(text==='yes'?'是':'否'):text
    return `${fieldNames[key]||key}：${display||'（空）'}`
  }).join('\n')
  return <section className="draft-comparison" aria-label="比较并恢复草稿" data-draft-ignore>
    <h3>{base?'版本已变化，请比较修改':'旧版草稿：请核对当前内容与本地草稿'}</h3>
    <p>{base?'未冲突的字段已给出建议；状态、完成说明和人员等关联字段一起选择。':'此草稿没有原始基线，所有不同字段都需要明确选择。'}</p>
    {groups.filter(group=>JSON.stringify(group.server)!==JSON.stringify(group.local)).map(group=><fieldset key={group.id} className="draft-group"><legend>{[...new Set(group.fields.map(field=>fieldNames[field]||field))].join(' / ')}</legend><div className="draft-columns">
      {group.base && <div><strong>开始编辑时</strong><pre>{show(group.base)}</pre></div>}
      <label><input type="radio" name={`merge-${group.id}`} checked={(choices[group.id]||group.choice)==='server'} onChange={()=>setChoices({...choices,[group.id]:'server'})}/>采用服务器当前内容<pre>{show(group.server)}</pre></label>
      <label><input type="radio" name={`merge-${group.id}`} checked={(choices[group.id]||group.choice)==='local'} onChange={()=>setChoices({...choices,[group.id]:'local'})}/>保留我的内容<pre>{show(group.local)}</pre></label>
    </div></fieldset>)}
    <div className="form-footer"><button type="button" className="button secondary" onClick={onCancel}>取消比较，保留输入</button><button type="button" className="button secondary" onClick={()=>void navigator.clipboard.writeText(show(local))}>复制我的输入</button><button type="button" className="button primary" disabled={!complete} onClick={()=>onMerge(mergeDraft(groups,choices))}>确认合并，返回表单核对</button></div>
    <p className="form-hint">确认合并不会直接保存。再次提交仍会校验版本和业务规则。</p>
  </section>
}
