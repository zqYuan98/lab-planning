import type { WorkProgress as WorkProgressModel } from '../../shared/work-progress'
import { dateTime } from '../ui'
export default function WorkProgress({progress,overallText}:{progress?:WorkProgressModel;overallText?:string}) {
  const overall=progress?.overallProgress,latest=progress?.latestExecution
  return <div className="work-progress-pair"><div><strong>总体说明</strong><p>{overall?.text || overallText || '尚未填写总体说明'}</p>{(overall?.text||overallText)&&<small>{overall?.changedAt?dateTime(overall.changedAt):'历史更新时间不明'}</small>}</div><div><strong>最新执行</strong><p>{latest?.text || '暂无有明确时间的执行记录'}</p>{latest && <small>{latest.weekStart?`${latest.weekStart} 当周 · `:''}{latest.occurredAt?dateTime(latest.occurredAt):'历史更新时间不明'}{latest.proxy?' · 代录':''}{latest.evidenceQuality==='audit_reconstructed'?' · 根据字段审计还原':''}</small>}</div>{!!progress?.historicalExecution.length && <details><summary>历史执行记录（时间不明）</summary>{progress.historicalExecution.map(row=><p key={`${row.sourceType}:${row.sourceId}`}>{row.weekStart?`${row.weekStart} · `:''}{row.text}</p>)}</details>}</div>
}
