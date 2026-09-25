import { effortInput } from '../../shared/effort'
import { useState } from 'react'
import type { Bootstrap, Task, WeeklyRecord } from '../../shared/types'
import type { EditableObject } from '../../shared/task-view'
import { api, finishSaved, json } from '../api'
import { draftText, draftChecked } from '../draft-recovery'
import { Field, Form } from '../ui'
import { currentRelatedTask } from '../form-editing'
const statusLabels: Record<string,string>={planned:'未开始',doing:'进行中',blocked:'受阻',done:'当周阶段完成',not_done:'本周未完成'}

export async function saveWeeklyProgress(recordId:string, body:Record<string,unknown>, onSaved:(record:WeeklyRecord)=>Promise<void>) {
  const updated=await api<WeeklyRecord>(`/weekly-records/${recordId}`,json(body,'PATCH'))
  await finishSaved(()=>onSaved(updated),updated.version)
  return updated.version
}

/** Shared by the weekly page and the unified task detail; one submission path. */
export default function WeeklyProgressForm({data,selected,selectedTask,onSaved,onClose}:{data:Bootstrap;selected:WeeklyRecord;selectedTask?:Task;onSaved:(message:string,record:WeeklyRecord)=>Promise<void>;onClose?:()=>void}) {
 const manager=data.user.role==='manager'
 const [progressStatus,setProgressStatus]=useState(selected.status),[completeTask,setCompleteTask]=useState(false),[progressSubmitted,setProgressSubmitted]=useState(selected.submitted)
 const [relatedTask,setRelatedTask]=useState<EditableObject['relatedTask']>()
 const [savedVersion,setSavedVersion]=useState(selected.version)
 const currentTask=currentRelatedTask<Task | NonNullable<EditableObject['relatedTask']>>(selectedTask,relatedTask)
 return (          <Form
            onCancel={onClose}
            submitLabel="保存本周进展"
            draftKey={`weekly-progress:${data.user.id}:${selected.id}:v${selected.version}`}
            draftContext={{ __completeTask: completeTask ? 'yes' : '', __taskStatus:currentTask?.status||'', __taskCompletionNote:currentTask?.completionNote||'' }}
            onDraftRestore={values => {
              const status = draftText(values, 'status')
              if (['planned', 'doing', 'blocked', 'done', 'not_done'].includes(status)) setProgressStatus(status as WeeklyRecord['status'])
              setCompleteTask(draftText(values, '__completeTask') === 'yes')
              setProgressSubmitted(draftChecked(values, 'submitted'))
            }}
            editablePath={`/weekly-records/${selected.id}/editable`}
            editVersion={Math.max(selected.version,savedVersion)}
            onConflictResolved={current=>setRelatedTask(current.relatedTask)}
            onSubmit={async (event, version) => {
              const form = new FormData(event.currentTarget)
              const completesTask = completeTask && form.get('status') === 'done' && currentTask && currentTask.status !== 'done'
              return saveWeeklyProgress(selected.id,
                  {
                    ...Object.fromEntries(form),
                    plannedEffortDays: effortInput(form.get('plannedEffortDays')),
                    actualEffortDays: effortInput(form.get('actualEffortDays')),
                    submitted: form.has('submitted'),
                    version: version ?? Math.max(selected.version,savedVersion),
                    ...(completesTask ? { completeTask: true, taskVersion: currentTask.version } : {}),
                  },
                async updated=>{
                  setSavedVersion(updated.version)
                  await onSaved(completesTask ? '本周进展与整个任务均已保存为完成，请返回核对整份提报' : '该周进展已保存，请返回核对整份提报', updated)
                },
              )
            }}
          >
            <Field label="本周承诺">
              <textarea
                name="commitment"
                defaultValue={selected.commitment}
                required={!selected.importSource}
                rows={2}
              />
            </Field>
            <div className="form-grid"><Field label="本周预计投入（人日）"><input name="plannedEffortDays" type="number" min="0" step="0.5" defaultValue={selected.plannedEffortDays ?? ''} /></Field><Field label="本周实际投入（人日）" hint="以 0.5 人日填写，未填写与 0 分开统计。"><input name="actualEffortDays" type="number" min="0" step="0.5" defaultValue={selected.actualEffortDays ?? ''} /></Field></div>
            <Field label="执行状态">
              <select name="status"  defaultValue={selected.status} onChange={event => {
                const nextStatus = event.target.value as WeeklyRecord['status']
                setProgressStatus(nextStatus)
                if (nextStatus !== 'done') setCompleteTask(false)
              }}>
                {Object.entries(statusLabels).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            {currentTask?.status === 'done' ? <p className="form-hint">整个任务已自报完成。本次仍可更新对应周的实际进展。</p> : currentTask && <>
              <label className="checkbox-label">
                <input type="checkbox" checked={progressStatus === 'done' && completeTask} disabled={progressStatus !== 'done'} onChange={event => setCompleteTask(event.target.checked)} />
                同时完成整个任务
              </label>
              <p className="form-hint">本周完成仅表示当周阶段完成。若整件工作也已结束，请勾选此项；下方实际成果将同时作为任务完成说明。</p>
            </>}
            <Field
              label="实际成果"
              hint={
                selected.importSource
                  ? '已有成果保留原文；本次报告完成时须补充实际成果。'
                  : '选择完成时必填；按事实描述已经交付的结果。'
              }
            >
              <textarea
                name="actualOutcome"
                rows={3}
                defaultValue={selected.actualOutcome}
                required={progressStatus === 'done'}
              />
            </Field>
            <Field label="证据链接">
              <input
                name="evidenceUrl"
                type="url"
                placeholder="https://…"
                defaultValue={selected.evidenceUrl}
              />
            </Field>
            <div className="form-grid">
              <Field
                label="阻塞 / 未完成原因"
                hint={
                  selected.importSource
                    ? '历史缺失如实保留；本次报告受阻或未完成时请补充原因。'
                    : '受阻或未完成时必填。'
                }
              >
                <textarea
                  name="blocker"
                  required={progressStatus === 'blocked' || progressStatus === 'not_done'}
                  rows={3}
                  defaultValue={selected.blocker}
                />
              </Field>
              <Field label="下一步">
                <textarea
                  name="nextAction"
                  rows={3}
                  defaultValue={selected.nextAction}
                />
              </Field>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                name="submitted"
                defaultChecked={selected.submitted}
                onChange={event => setProgressSubmitted(event.target.checked)}
              />
              {selected.importSource
                ? '保留为生效记录，纳入对应周统计'
                : selected.planApproval?.required && !selected.planApproval.suspended ? '正式保存该条计划（审核通过后纳入周统计）' : '将该条纳入周统计（不代表已提交整份提报）'}
            </label>
            <div className="form-grid"><Field label="阻塞影响范围" hint="正式保存受阻记录时必填，与协作开关无关。"><textarea name="blockerImpact" required={progressStatus === 'blocked' && progressSubmitted} rows={2} defaultValue={selected.blockerImpact || ''} /></Field><Field label="需要的支持" hint="暂不需要支持时请明确说明。"><textarea name="supportNeeded" required={progressStatus === 'blocked' && progressSubmitted} rows={2} defaultValue={selected.supportNeeded || ''} /></Field></div>
            {manager && selected.ownerId !== data.user.id && <Field label="管理者代录原因" hint="替成员修改进展时，记录核实依据和原因；同时完成整个任务时必填。"><textarea name="proxyReason" rows={2} required={completeTask && progressStatus === 'done'} /></Field>}
          </Form>)
}
