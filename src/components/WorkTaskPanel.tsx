import { useEffect, useRef, useState } from 'react'
import type { TaskView } from '../../shared/task-view'
import { taskSections, type TaskSection } from '../navigation'
import WorkRegisterEditor from './WorkRegisterEditor'
import WeeklyProgressForm from './WeeklyProgressForm'
import TaskDeliveries from './TaskDeliveries'
import TaskSupport from './TaskSupport'
import WorkProgress from './WorkProgress'
import TaskHistory from './TaskHistory'
import TaskProgressHistory from './TaskProgressHistory'
import { monday } from '../ui'
import { isActiveWeeklyRecord } from '../../shared/weekly-record-state'
import { api, ApiError, json, finishSaved, SavedResultError } from '../api'
import { LatestRead, StaleReadError } from '../latest-read'
import { captureMutationContext, MutationContextChangedError, subscribeMutationResponses } from '../mutation-response'
import { applyTaskViewMutation, reconcileTaskView } from '../task-view-response'
import { SavedRefresh, type SavedRefreshState } from '../saved-refresh'
import { allowDraftLeave, draftText } from '../draft-recovery'
import { assignmentAttempt, type SubmissionAttempt } from '../notification-navigation'
import { Badge, Field, Form, Modal, dateTime, nameOf, type PageProps } from '../ui'
import TaskProgressSummary from './TaskProgressSummary'
import ManagerRecipients from './ManagerRecipients'

const statusNames: Record<string, string> = { todo: '未开始', doing: '进行中', blocked: '受阻', done: '成员自报完成' }
const requestNames: Record<string, string> = { open: '待处理', responded: '已回应', cancelled: '已关闭', superseded: '已被新安排替代', approved: '已批准', returned: '已退回' }
const fieldNames: Record<string, string> = { status: '执行状态', completionNote: '完成说明', evidenceUrl: '成果链接', blockerReason: '任务阻塞原因', blocker: '本周阻塞原因', blockerImpact: '阻塞影响', supportNeeded: '需要支持', nextAction: '下一步', actualOutcome: '本周成果', currentProgress: '当前实际进展' }
const fieldLabel = (field: string) => `${field.startsWith('weeklyRecord.') ? '本周·' : '任务·'}${fieldNames[field.split('.').at(-1)!] || '进展内容'}`
const fieldValue = (field: string, value: string) => field.endsWith('.status') ? ({ ...statusNames, planned: '未开始', not_done: '本周未完成' })[value] || value : value || '未填写'
const localTime = (value: string) => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 16)
const utc = (value: FormDataEntryValue | null) => value ? new Date(`${value}:00+08:00`).toISOString() : undefined

export default function WorkTaskPanel({ taskId, data, refresh, notify, onClose, onChanged, section = 'overview', weeklyRecordId }: PageProps & { taskId: string; onClose: () => void; onChanged: () => Promise<void>; section?: TaskSection; weeklyRecordId?: string }) {
  const [view, setView] = useState<TaskView | null>(null), [error, setError] = useState('')
  const [tab, setTab] = useState<TaskSection>(section), [editing,setEditing]=useState(false), [selectedWeeklyId,setSelectedWeeklyId]=useState(weeklyRecordId||''), [noteType, setNoteType] = useState('progress'), [status, setStatus] = useState('')
  const attempts = useRef<Record<string, SubmissionAttempt>>({})
  const [saveState, setSaveState] = useState<SavedRefreshState>('idle')
  const savedRefresh = useRef<SavedRefresh | null>(null)
  if (!savedRefresh.current) savedRefresh.current = new SavedRefresh(setSaveState)
  const mounted = useRef(true), currentView = useRef<TaskView | null>(null), currentTaskId = useRef(taskId)
  currentTaskId.current = taskId
  const detailRead = useRef<LatestRead<TaskView> | null>(null)
  if (!detailRead.current) detailRead.current = new LatestRead({
    load: signal => api<TaskView>(`/tasks/${encodeURIComponent(currentTaskId.current)}/view?section=${section}${weeklyRecordId?`&weeklyRecordId=${encodeURIComponent(weeklyRecordId)}`:''}`, { signal }),
    accept: next => {
      const result = reconcileTaskView(currentView.current, next)
      if (!currentView.current) setStatus(result.value.task.status)
      currentView.current = result.value; setView(result.value)
      if (result.stale) throw new StaleReadError()
    },
    error: failure => {
      if (failure instanceof ApiError && [401, 403, 404].includes(failure.status)) {
        currentView.current = null; setView(null); setStatus('')
        if (failure.status === 401) window.dispatchEvent(new Event('workspace-login-expired'))
      }
      setError(failure instanceof Error ? failure.message : failure ? '任务读取失败' : '')
    },
  })
  const load = () => mounted.current ? detailRead.current!.read() : Promise.reject(new MutationContextChangedError())
  useEffect(() => {
    mounted.current = true; currentView.current = null; setView(null)
    void load().catch(() => {})
    const refocus=()=>{detailRead.current!.invalidate();void load().catch(()=>{})};window.addEventListener('focus',refocus)
    const unsubscribe = subscribeMutationResponses(event => {
      if (!mounted.current || event.context !== captureMutationContext()) return
      detailRead.current!.invalidate()
      if (currentView.current) {
        const next = applyTaskViewMutation(currentView.current, event.value)
        currentView.current = next; setView(next)
      }
      void load().catch(() => {})
    }, () => { detailRead.current!.reset(); savedRefresh.current!.reset(mounted.current); currentView.current = null; if (mounted.current) { setView(null); setError(''); setStatus('') } })
    return () => { window.removeEventListener('focus',refocus); mounted.current = false; unsubscribe(); detailRead.current!.reset(); savedRefresh.current!.reset(false) }
  }, [taskId, data.user.id, data.user.role, data.operationEpoch,data.accessScopeVersion])
  async function submit(path: string, body: Record<string, unknown>, method = 'POST') {
    const context = captureMutationContext()
    const attempt = assignmentAttempt(attempts.current[path] ?? null, body); attempts.current[path] = attempt
    try { await savedRefresh.current!.run(async () => {
      await api(path, json({ ...body, requestId: attempt.requestId }, method))
      delete attempts.current[path]
    }, () => finishSaved(async () => {
      if (!mounted.current || context !== captureMutationContext()) throw new MutationContextChangedError()
      await Promise.all([load(), refresh(), onChanged()])
      if (!mounted.current || context !== captureMutationContext()) throw new MutationContextChangedError()
      notify('已保存，消息和处理状态已同步更新')
    })) } catch (failure) {
      // The panel owns read-only recovery across Form remounts; do not store a second receipt in Form.
      if (!(failure instanceof SavedResultError)) throw failure
    }
  }
  const readOnly=!!view?.readOnlyReason || data.user.role==='observer'
  const manager = data.user.role === 'manager' && !readOnly, task = view?.task, own = task?.ownerId === data.user.id && !readOnly
  const selectedWeekly=view?.weeklyRecords.find(row=>row.id===selectedWeeklyId) || view?.weeklyRecords.find(row=>isActiveWeeklyRecord(row)&&row.weekStart===monday()) || view?.weeklyRecords.find(isActiveWeeklyRecord) || view?.weeklyRecords[0]
  const canEdit=!!view?.allowedActions.includes('edit_task') && !readOnly
  const open = view?.followups.find(row => row.status === 'open')
  const linkedRecord = open?.weeklyRecordId ? data.weeklyRecords.find(row => row.id === open.weeklyRecordId) : undefined
  return <Modal wide title={task?.title || '工作详情'} onClose={onClose}>
    {saveState !== 'idle' && <div className="note" role="status"><p>{saveState === 'saving' ? '正在保存，请稍候。' : saveState === 'failed' ? '内容已经保存，但刷新失败。无需重复提交，请重新加载已保存结果。' : '内容已保存，正在重新读取结果。'}</p>{saveState === 'failed' && <button className="button primary" type="button" onClick={() => { void savedRefresh.current!.retry().catch(() => {}) }}>重新加载已保存结果</button>}</div>}
    <fieldset className="form-fields" disabled={saveState !== 'idle'}>
    {error && <p className="error" role="alert">{error}</p>}
    {!view || !task ? !error && <p role="status">正在读取工作详情…</p> : <div className="collaboration-task-panel">
      <p>编号 {task.id} · {view.ownerName || nameOf(data, task.ownerId)} · 任务截止 {task.dueDate || '未设置'} · {view.tracking ? { active: '督办中', paused: '督办已暂停', closed: '督办已结束' }[view.tracking.state] : '未纳入督办'}</p>
      {view.monthlyPlan&&<p>当前月目标：{view.monthlyPlan.month} · {view.monthlyPlan.title}</p>}
      <p>来源：{task.workSource==='leader'?'领导交办':task.workSource==='coordination'?'协同事项':task.workSource==='self'?'自主安排':'待核对'}</p>
      {task.cancellation&&<p className="note">作废于 {dateTime(task.cancellation.cancelledAt)} · 原因：{task.cancellation.reason}</p>}
      {view.readOnlyReason&&<p className="note" role="status">{view.readOnlyReason}</p>}
      {data.user.role==='observer'?<p>整个任务：<Badge>{statusNames[task.status]}</Badge></p>:<TaskProgressSummary task={task} weeklySummary={view.weeklySummary} overallStatusNeedsConfirmation={view.overallStatusNeedsConfirmation} />}
      {open && <div className="collaboration-callout"><strong>待回应的催办</strong><p>{open.requirement}</p><p>回应期限：{dateTime(open.dueAt)} · 任务原截止：{task.dueDate}</p><small>保存进展时可选择同时回应；回应催办不会自动完成任务或正式提交周提报。</small></div>}
      {!view.enabled && !readOnly && <p className="note">进展与催办功能当前未启用。基础任务编辑、周执行和成果支持流程仍可按权限使用。</p>}
      <div className="tabs" role="group" aria-label="工作详情栏目">{taskSections.map(id => <button type="button" key={id} onClick={() => { if (allowDraftLeave()) setTab(id) }} className={tab === id ? 'selected' : ''}>{{overview:'概要',weekly:'周执行',deliveries:'交付验收',support:'支持与决策',followups:'催办与延期',history:'历史'}[id]}</button>)}</div>
      {tab === 'overview' && <section className="task-section"><h3>预期交付</h3><p>{task.requestedOutcome || '待补充'}</p><WorkProgress progress={view.progress} overallText={task.currentProgress}/><p>下一步：{task.nextAction||'待明确'}</p>{task.status==='done'&&<p>任务自报完成说明：{task.completionNote||'历史记录未填写'}</p>}{canEdit&&<button className="button primary" onClick={()=>setEditing(true)}>编辑总体信息</button>}</section>}
      {tab==='weekly'&&<section className="task-section"><h3>周执行</h3><p className="form-hint">{data.user.role==='observer'?'仅展示授权范围内的周执行记录；周记录独立于任务总体状态。':'选择的周记录独立于任务总体状态。正式整份提报与审核仍在每周执行页面处理。'}</p>{view.weeklyRecords.length?<><Field label="选择周记录"><select value={selectedWeekly?.id||''} onChange={e=>{if(allowDraftLeave())setSelectedWeeklyId(e.target.value)}}>{view.weeklyRecords.map(row=><option value={row.id} key={row.id}>{row.weekStart} · {row.commitment || '未填承诺'}{!isActiveWeeklyRecord(row)?' · 已删除（历史）':row.submitted?' · 已生效/待审核':' · 草稿'}</option>)}</select></Field>{selectedWeekly&&<><p>{selectedWeekly.commitment}</p><p>本周成果：{selectedWeekly.actualOutcome||'尚未填写'}</p><p>正式记录：{selectedWeekly.submitted?'已正式保存该条':'尚未正式保存'} · 周计划审核：{selectedWeekly.planApproval?.suspended?'已暂停审核':selectedWeekly.planApproval?.approvedSubmissionId?'已批准':selectedWeekly.planApproval?.required?'待整份周计划审核':'无需审核'}</p>{selectedWeekly.deletion&&<p className="note">此周安排已删除，仅保留历史。原因：{selectedWeekly.deletion.reason}</p>}{view.allowedActions.includes('update_weekly')&&!readOnly&&isActiveWeeklyRecord(selectedWeekly)&&<WeeklyProgressForm key={selectedWeekly.id} data={data} selected={selectedWeekly} selectedTask={task} onSaved={async(message)=>{await Promise.all([load(),refresh(),onChanged()]);notify(message)}}/>}</>}</>:<p>暂无可查看的周安排。</p>}</section>}
      {tab==='deliveries'&&data.user.role==='observer'&&<section className="task-section"><h3>授权范围内的成果</h3>{view.authorizedDeliverySummary&&<p>当前交付状态：待验收 {view.authorizedDeliverySummary.pending_review} · 已通过 {view.authorizedDeliverySummary.accepted} · 已退回 {view.authorizedDeliverySummary.returned} · 已撤回 {view.authorizedDeliverySummary.withdrawn}</p>}{view.authorizedDeliveries?.length?view.authorizedDeliveries.map(row=><article key={row.id} className="collaboration-history"><strong>v{row.revision} · {{pending_review:'待验收',accepted:'已通过',returned:'已退回',withdrawn:'已撤回'}[row.status]}</strong><p>{row.actualOutcome}</p><p>验收标准：{row.acceptanceCriteriaSnapshot}</p><p>提交于 {dateTime(row.submittedAt)}</p>{row.evidenceRefs.map((value,index)=><p key={index}>{String(value)}</p>)}</article>):<p>暂无可查看的独立成果记录。</p>}</section>}
      {tab==='deliveries'&&data.user.role!=='observer'&&<TaskDeliveries data={data} refresh={refresh} notify={notify} task={task} readOnly={readOnly}/>}
      {tab==='support'&&data.user.role==='observer'&&<section className="task-section"><h3>授权范围内的支持摘要</h3><p>阻塞：{task.blockerReason||'无公开阻塞'}</p><p>需要支持：{task.supportNeeded||'未填写'}</p><p>需要决策：{task.decisionNeeded||'未填写'}</p></section>}
      {tab==='support'&&data.user.role!=='observer'&&<TaskSupport data={data} refresh={refresh} notify={notify} task={task} readOnly={readOnly}/>}
      {(tab === 'overview'||tab==='followups'&&!!open) && view.enabled && canEdit && <Form key={`progress-${task.id}`} editablePath={`/tasks/${task.id}/editable`} editVersion={task.version} submitLabel={tab==='followups'?'保存进展并按选择回应':'保存进展'} draftKey={`task-progress:${data.user.id}:${task.id}:v${task.version}`} draftContext={{ __status: status, __noteType: noteType }} onDraftRestore={values => { const nextStatus = draftText(values, '__status'); if (Object.hasOwn(statusNames, nextStatus)) setStatus(nextStatus); setNoteType(draftText(values, '__noteType') === 'no_change' ? 'no_change' : 'progress') }} onSubmit={async (event,version) => {
        const form = new FormData(event.currentTarget), body: Record<string, unknown> = { version: version ?? task.version, taskStatus: form.get('taskStatus'), noteType: form.get('noteType'), note: form.get('note'), noChangeReason: form.get('noChangeReason') || '', nextAction: form.get('nextAction'), proxyReason: form.get('proxyReason') || '' }
        for (const field of ['completionNote', 'evidenceUrl', 'blockerReason', 'blockerImpact', 'supportNeeded']) if (form.has(field)) body[field] = form.get(field)
        if (form.has('respond') && open) { body.respondTo = { id: open.id, version: open.version }; if (linkedRecord) { body.weeklyRecordId = linkedRecord.id; body.weeklyRecordVersion = linkedRecord.version } }
        await submit(`/tasks/${task.id}/progress`, body)
      }}>
        <div className="form-grid"><Field label="本次更新"><select name="noteType" value={noteType} onChange={e => setNoteType(e.target.value)}><option value="progress">有新进展</option><option value="no_change">暂无变化</option></select></Field><Field label="整个任务的状态"><select name="taskStatus" value={status} onChange={e => setStatus(e.target.value)}>{Object.entries(statusNames).map(([id, label]) => <option value={id} key={id}>{label}</option>)}</select></Field></div>
        {noteType === 'progress' ? <Field key="progress-note" label="进展说明"><textarea name="note" rows={3} placeholder="本次完成了什么，有哪些可核对的结果" /></Field> : <Field key="no-change-note" label="暂无变化的原因"><textarea name="noChangeReason" required rows={3} /></Field>}
        <Field label="下一步行动"><textarea name="nextAction" required={noteType === 'no_change'} defaultValue={task.nextAction || ''} rows={2} /></Field>
        {status === 'done' && <><Field label="完成说明"><textarea required name="completionNote" defaultValue={task.completionNote || ''} /></Field><Field label="成果链接（选填）"><input type="url" name="evidenceUrl" defaultValue={task.evidenceUrl || ''} /></Field></>}
        {status === 'blocked' && <><Field label="阻塞原因"><textarea required name="blockerReason" defaultValue={task.blockerReason || ''} /></Field><Field label="影响范围"><textarea required name="blockerImpact" defaultValue={task.blockerImpact || ''} /></Field><Field label="需要的支持"><textarea required name="supportNeeded" defaultValue={task.supportNeeded || ''} /></Field></>}
        {!own && <Field label="管理者代录原因"><textarea required name="proxyReason" placeholder="写明核实对象、依据及代录原因" /></Field>}
        {open && own && <label className="checkbox-label"><input name="respond" type="checkbox" />同时回应这条催办{linkedRecord ? '（关联原周安排）' : ''}</label>}
        <p className="form-hint">进展保存不替代每周完成情况和下周计划的正式提报。管理者代录不算成员本人的进展更新。</p>
      </Form>}
      {tab === 'followups' && <>
        {manager && view.enabled && <details open><summary>督办状态与管理接收人</summary><Form key={`tracking-${view.tracking?.version || 0}`} submitLabel="保存督办设置" onSubmit={async e => { const f = new FormData(e.currentTarget); await submit(`/tasks/${task.id}/tracking`, { version: view.tracking?.version || 0, taskVersion: task.version, state: f.get('state'), reason: f.get('reason'), reviewAt: utc(f.get('reviewAt')), managerRecipientIds: f.getAll('managerRecipientIds') }, 'PUT') }}>
          <Field label="督办状态"><select name="state" defaultValue={view.tracking?.state || 'active'}><option value="active">纳入 / 恢复督办</option><option value="paused">暂停督办</option><option value="closed">结束督办</option></select></Field>
          <Field label="调整原因"><textarea required={!!view.tracking} name="reason" /></Field><Field label="暂停后的复查时间（北京时间）"><input name="reviewAt" type="datetime-local" /></Field>
          <ManagerRecipients initialIds={view.tracking?.managerRecipientIds || []} scope={`${data.user.id}:${data.operationEpoch}:${data.accessScopeVersion}:${task.id}`} />
          <p className="form-hint">当前接收人：{view.effectiveManagerIds.map(id => nameOf(data, id)).join('、') || '尚未配置'}。恢复督办以当前时间重新计算无进展提醒，原截止日期保留。</p>
        </Form></details>}
        {manager && open && <details open><summary>调整或核实关闭当前催办</summary><Form key={`followup-${open.version}`} submitLabel="保存催办修改" onSubmit={async e => { const f = new FormData(e.currentTarget); await submit(`/followups/${open.id}`, { version: open.version, requirement: f.get('requirement'), dueAt: utc(f.get('dueAt')), reason: f.get('reason') }, 'PUT') }}><Field label="更新要求"><textarea required name="requirement" defaultValue={open.requirement} /></Field><Field label="回应期限（北京时间）"><input required type="datetime-local" name="dueAt" defaultValue={localTime(open.dueAt)} /></Field><Field label="修改原因"><input required name="reason" /></Field></Form>
          <Form submitLabel="核实后关闭催办" onSubmit={async e => { const f = new FormData(e.currentTarget); await submit(`/followups/${open.id}/close`, { version: open.version, reason: f.get('reason') }) }}><Field label="核实关闭原因"><textarea required name="reason" /></Field><p className="form-hint">只关闭催办，不代替本人回应或修改任务状态。</p></Form></details>}
        {!open && <p className="note">当前没有待回应催办。管理者可在列表中勾选任务，预览内容后发起催办。</p>}
      </>}
      {tab === 'followups' && <>
        {own && view.enabled && view.tracking?.state === 'active' && task.workOrigin?.kind === 'assigned' && !view.deadlineRequests.some(r => r.status === 'open') && <Form submitLabel="提交延期申请" onSubmit={async e => { const f = new FormData(e.currentTarget); await submit(`/tasks/${task.id}/deadline-requests`, { version: task.version, dueDateVersion: view.tracking!.dueDateVersion, requestedDueDate: f.get('requestedDueDate'), reason: f.get('reason') }) }}><Field label="申请截止日期"><input required type="date" name="requestedDueDate" min={task.dueDate} /></Field><Field label="延期原因"><textarea required name="reason" /></Field><p className="form-hint">需管理员启用延期审批。批准前仍按原截止日期计算；批准后会保留改期历史。</p></Form>}
        {!view.deadlineRequests.length && <p>暂无延期申请。</p>}
        {view.deadlineRequests.slice().reverse().map(row => <article className="collaboration-history" key={row.id}><strong>{row.originalDueDate} → {row.requestedDueDate}</strong> <Badge>{requestNames[row.status]}</Badge><p>{row.reason}</p>{row.decisionNote && <p>处理意见：{row.decisionNote}</p>}{manager && row.status === 'open' && <Form submitLabel="提交审批决定" onSubmit={async e => { const f = new FormData(e.currentTarget); await submit(`/deadline-requests/${row.id}/decide`, { version: row.version, dueDateVersion: row.dueDateVersion, decision: f.get('decision'), note: f.get('note') }) }}><Field label="审批决定"><select name="decision"><option value="approved">批准延期</option><option value="returned">退回申请</option></select></Field><Field label="处理意见"><textarea required name="note" /></Field></Form>}</article>)}
      </>}
      {tab === 'history' && <>{data.user.role!=='observer'&&<TaskProgressHistory taskId={task.id} scope={`${data.user.id}:${data.operationEpoch}:${data.accessScopeVersion||''}`}/>}<TaskHistory taskId={task.id} scope={`${data.user.id}:${data.operationEpoch}:${data.accessScopeVersion||''}`}/></>}
    </div>}
    </fieldset>
    {editing&&task&&canEdit&&<WorkRegisterEditor userId={data.user.id} task={task} onClose={()=>setEditing(false)} onSaved={()=>{setEditing(false);void Promise.all([load(),refresh(),onChanged()]).then(()=>notify('总体信息已保存')).catch(()=>setError('内容已保存，请刷新任务详情。'))}}/>}
  </Modal>
}
