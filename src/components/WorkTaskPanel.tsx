import { useEffect, useRef, useState } from 'react'
import type { CollaborationTaskView } from '../../shared/collaboration'
import { api, json, finishSaved } from '../api'
import { allowDraftLeave, draftText } from '../draft-recovery'
import { assignmentAttempt, type SubmissionAttempt } from '../notification-navigation'
import { Badge, Field, Form, Modal, dateTime, nameOf, type PageProps } from '../ui'
import TaskProgressSummary from './TaskProgressSummary'

const statusNames: Record<string, string> = { todo: '未开始', doing: '进行中', blocked: '受阻', done: '成员自报完成' }
const requestNames: Record<string, string> = { open: '待处理', responded: '已回应', cancelled: '已关闭', superseded: '已被新安排替代', approved: '已批准', returned: '已退回' }
const fieldNames: Record<string, string> = { status: '执行状态', completionNote: '完成说明', evidenceUrl: '成果链接', blockerReason: '任务阻塞原因', blocker: '本周阻塞原因', blockerImpact: '阻塞影响', supportNeeded: '需要支持', nextAction: '下一步', actualOutcome: '本周成果', currentProgress: '当前实际进展' }
const fieldLabel = (field: string) => `${field.startsWith('weeklyRecord.') ? '本周·' : '任务·'}${fieldNames[field.split('.').at(-1)!] || '进展内容'}`
const fieldValue = (field: string, value: string) => field.endsWith('.status') ? ({ ...statusNames, planned: '未开始', not_done: '本周未完成' })[value] || value : value || '未填写'
const localTime = (value: string) => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0, 16)
const utc = (value: FormDataEntryValue | null) => value ? new Date(`${value}:00+08:00`).toISOString() : undefined

export default function WorkTaskPanel({ taskId, data, refresh, notify, onClose, onChanged }: PageProps & { taskId: string; onClose: () => void; onChanged: () => Promise<void> }) {
  const [view, setView] = useState<CollaborationTaskView | null>(null), [error, setError] = useState('')
  const [tab, setTab] = useState('progress'), [noteType, setNoteType] = useState('progress'), [status, setStatus] = useState('')
  const attempts = useRef<Record<string, SubmissionAttempt>>({})
  useEffect(() => { let live = true; void api<CollaborationTaskView>(`/collaboration/tasks/${encodeURIComponent(taskId)}`).then(next => { if (live) { setView(next); setStatus(next.task.status) } }).catch(e => { if (live) setError(e.message) }); return () => { live = false } }, [taskId])
  async function submit(path: string, body: Record<string, unknown>, method = 'POST') {
    const attempt = assignmentAttempt(attempts.current[path] ?? null, body); attempts.current[path] = attempt
    await api(path, json({ ...body, requestId: attempt.requestId }, method))
    delete attempts.current[path]
    await finishSaved(async () => {
      const next = await api<CollaborationTaskView>(`/collaboration/tasks/${encodeURIComponent(taskId)}`)
      await Promise.all([refresh(), onChanged()])
      setView(next); setStatus(next.task.status)
      notify('已保存，消息和处理状态已同步更新')
    })
  }
  const manager = data.user.role === 'manager', task = view?.task, own = task?.ownerId === data.user.id
  const open = view?.followups.find(row => row.status === 'open')
  const linkedRecord = open?.weeklyRecordId ? data.weeklyRecords.find(row => row.id === open.weeklyRecordId) : undefined
  return <Modal wide title={task?.title || '工作详情'} onClose={onClose}>
    {error && <p className="error" role="alert">{error}</p>}
    {!view || !task ? <p role="status">正在读取工作详情…</p> : <div className="collaboration-task-panel">
      <p>{nameOf(data, task.ownerId)} · 任务截止 {task.dueDate || '未设置'} · {view.tracking ? { active: '督办中', paused: '督办已暂停', closed: '督办已结束' }[view.tracking.state] : '未纳入督办'}</p>
      <TaskProgressSummary task={task} weeklySummary={view.weeklySummary} overallStatusNeedsConfirmation={view.overallStatusNeedsConfirmation} />
      {open && <div className="collaboration-callout"><strong>待回应的催办</strong><p>{open.requirement}</p><p>回应期限：{dateTime(open.dueAt)} · 任务原截止：{task.dueDate}</p><small>保存进展时可选择同时回应；回应催办不会自动完成任务或正式提交周提报。</small></div>}
      {!view.enabled && <p className="note">此成员尚未启用进展与催办，管理者可在通知设置中配置试点范围。</p>}
      <div className="tabs" role="group" aria-label="工作详情栏目">{[['progress', '更新进展'], ['followup', '催办与督办'], ['deadline', '延期申请'], ['blocker', '支持与阻塞'], ['history', '处理记录']].map(([id, label]) => <button key={id} onClick={() => { if (allowDraftLeave()) setTab(id) }} className={tab === id ? 'selected' : ''}>{label}</button>)}</div>
      {tab === 'progress' && view.enabled && <Form key={`progress-${task.version}`} submitLabel="保存进展" draftKey={`task-progress:${data.user.id}:${task.id}:v${task.version}`} draftContext={{ __status: status, __noteType: noteType }} onDraftRestore={values => { const nextStatus = draftText(values, '__status'); if (Object.hasOwn(statusNames, nextStatus)) setStatus(nextStatus); setNoteType(draftText(values, '__noteType') === 'no_change' ? 'no_change' : 'progress') }} onSubmit={async event => {
        const form = new FormData(event.currentTarget), body: Record<string, unknown> = { version: task.version, taskStatus: form.get('taskStatus'), noteType: form.get('noteType'), note: form.get('note'), noChangeReason: form.get('noChangeReason') || '', nextAction: form.get('nextAction'), proxyReason: form.get('proxyReason') || '' }
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
      {tab === 'followup' && <>
        {manager && view.enabled && <details open><summary>督办状态与管理接收人</summary><Form key={`tracking-${view.tracking?.version || 0}`} submitLabel="保存督办设置" onSubmit={async e => { const f = new FormData(e.currentTarget); await submit(`/tasks/${task.id}/tracking`, { version: view.tracking?.version || 0, taskVersion: task.version, state: f.get('state'), reason: f.get('reason'), reviewAt: utc(f.get('reviewAt')), managerRecipientIds: f.getAll('managerRecipientIds') }, 'PUT') }}>
          <Field label="督办状态"><select name="state" defaultValue={view.tracking?.state || 'active'}><option value="active">纳入 / 恢复督办</option><option value="paused">暂停督办</option><option value="closed">结束督办</option></select></Field>
          <Field label="调整原因"><textarea required={!!view.tracking} name="reason" /></Field><Field label="暂停后的复查时间（北京时间）"><input name="reviewAt" type="datetime-local" /></Field>
          <fieldset><legend>管理通知接收人（不选则使用默认管理者）</legend>{data.users.filter(u => u.active && u.role === 'manager').map(u => <label className="checkbox-label" key={u.id}><input type="checkbox" name="managerRecipientIds" value={u.id} defaultChecked={view.tracking?.managerRecipientIds.includes(u.id)} />{u.name}</label>)}</fieldset>
          <p className="form-hint">当前接收人：{view.effectiveManagerIds.map(id => nameOf(data, id)).join('、') || '尚未配置'}。恢复督办以当前时间重新计算无进展提醒，原截止日期保留。</p>
        </Form></details>}
        {manager && open && <details open><summary>调整或核实关闭当前催办</summary><Form key={`followup-${open.version}`} submitLabel="保存催办修改" onSubmit={async e => { const f = new FormData(e.currentTarget); await submit(`/followups/${open.id}`, { version: open.version, requirement: f.get('requirement'), dueAt: utc(f.get('dueAt')), reason: f.get('reason') }, 'PUT') }}><Field label="更新要求"><textarea required name="requirement" defaultValue={open.requirement} /></Field><Field label="回应期限（北京时间）"><input required type="datetime-local" name="dueAt" defaultValue={localTime(open.dueAt)} /></Field><Field label="修改原因"><input required name="reason" /></Field></Form>
          <Form submitLabel="核实后关闭催办" onSubmit={async e => { const f = new FormData(e.currentTarget); await submit(`/followups/${open.id}/close`, { version: open.version, reason: f.get('reason') }) }}><Field label="核实关闭原因"><textarea required name="reason" /></Field><p className="form-hint">只关闭催办，不代替本人回应或修改任务状态。</p></Form></details>}
        {!open && <p className="note">当前没有待回应催办。管理者可在列表中勾选任务，预览内容后发起催办。</p>}
      </>}
      {tab === 'deadline' && <>
        {own && view.enabled && view.tracking?.state === 'active' && task.workOrigin?.kind === 'assigned' && !view.deadlineRequests.some(r => r.status === 'open') && <Form submitLabel="提交延期申请" onSubmit={async e => { const f = new FormData(e.currentTarget); await submit(`/tasks/${task.id}/deadline-requests`, { version: task.version, dueDateVersion: view.tracking!.dueDateVersion, requestedDueDate: f.get('requestedDueDate'), reason: f.get('reason') }) }}><Field label="申请截止日期"><input required type="date" name="requestedDueDate" min={task.dueDate} /></Field><Field label="延期原因"><textarea required name="reason" /></Field><p className="form-hint">需管理员启用延期审批。批准前仍按原截止日期计算；批准后会保留改期历史。</p></Form>}
        {!view.deadlineRequests.length && <p>暂无延期申请。</p>}
        {view.deadlineRequests.slice().reverse().map(row => <article className="collaboration-history" key={row.id}><strong>{row.originalDueDate} → {row.requestedDueDate}</strong> <Badge>{requestNames[row.status]}</Badge><p>{row.reason}</p>{row.decisionNote && <p>处理意见：{row.decisionNote}</p>}{manager && row.status === 'open' && <Form submitLabel="提交审批决定" onSubmit={async e => { const f = new FormData(e.currentTarget); await submit(`/deadline-requests/${row.id}/decide`, { version: row.version, dueDateVersion: row.dueDateVersion, decision: f.get('decision'), note: f.get('note') }) }}><Field label="审批决定"><select name="decision"><option value="approved">批准延期</option><option value="returned">退回申请</option></select></Field><Field label="处理意见"><textarea required name="note" /></Field></Form>}</article>)}
      </>}
      {tab === 'blocker' && <>{!view.blockerEpisodes.length && <p>暂无阻塞记录。</p>}{view.blockerEpisodes.slice().reverse().map(row => <article className="collaboration-history" key={row.id}><strong>{row.sourceType === 'task' ? '任务阻塞' : '周执行阻塞'}</strong><Badge>{row.resolvedAt ? '已解除' : row.managementClosedAt ? '支持事项已核实关闭' : '待支持'}</Badge><p>{row.reason}</p><p>影响：{row.impact || '未填写'} · 所需支持：{row.supportNeeded || '未填写'}</p><p>{dateTime(row.openedAt)}{row.reviewAt ? ` · 复查 ${dateTime(row.reviewAt)}` : ''}</p>{row.managementNote && <p>管理处理：{row.managementNote}</p>}{manager && !row.resolvedAt && <Form submitLabel="保存支持处理" onSubmit={async e => { const f = new FormData(e.currentTarget); await submit(`/blockers/${row.id}/handle`, { version: row.version, action: f.get('action'), note: f.get('note'), reviewAt: utc(f.get('reviewAt')) }) }}><Field label="处理方式"><select name="action"><option value="record">记录支持安排</option><option value="defer">延后复查</option><option value="close">核实关闭支持事项</option></select></Field><Field label="处理说明"><textarea required name="note" /></Field><Field label="复查时间（北京时间）"><input name="reviewAt" type="datetime-local" /></Field><p className="form-hint">支持事项关闭不会把任务或周记录改为完成；请由负责人更新实际执行状态。</p></Form>}</article>)}</>}
      {tab === 'history' && <><h3>进展与本人回应</h3>{!view.progressEvents.length && <p>暂无进展记录。</p>}{view.progressEvents.slice().reverse().map(row => <article key={row.id} className="collaboration-history"><strong>{nameOf(data, row.actorId)} · {row.noteType === 'no_change' ? '暂无变化' : '更新进展'}</strong><time>{dateTime(row.occurredAt)}</time><p>{row.note || row.noChangeReason}</p>{row.nextAction && <p>下一步：{row.nextAction}</p>}{row.proxyReason && <p>代录原因：{row.proxyReason}</p>}{row.changes.map(change => <p key={change.field}>{fieldLabel(change.field)}：{fieldValue(change.field, change.before)} → {fieldValue(change.field, change.after)}</p>)}{view.responses.some(response => response.progressEventId === row.id) && <Badge>已回应催办</Badge>}</article>)}<h3>催办记录</h3>{view.followups.slice().reverse().map(row => <article key={row.id} className="collaboration-history"><Badge>{requestNames[row.status]}</Badge><p>{row.requirement}</p><p>回应期限 {dateTime(row.dueAt)}{row.respondedAt ? ` · 回应于 ${dateTime(row.respondedAt)}` : ''}</p>{row.closeReason && <p>{row.closeReason}</p>}</article>)}</>}
    </div>}
  </Modal>
}
