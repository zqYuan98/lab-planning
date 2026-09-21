import { useRef, useState, type FormEvent } from 'react'
import { LoaderCircle } from 'lucide-react'
import type { Task } from '../../shared/types'
import { workRegisterNeedsCompletionReview } from '../../shared/work-register'
import { api, json } from '../api'
import { Field, Modal } from '../ui'
import { useFormDraft } from '../use-form-draft'
import { allowDraftLeave, draftText } from '../draft-recovery'

interface EditorProps {
  userId: string
  task: Task
  onClose: () => void
  onSaved: (task: Task) => void
}

export default function WorkRegisterEditor({ userId, task, onClose, onSaved }: EditorProps) {
  const [status, setStatus] = useState<Task['status']>(task.status)
  const [source, setSource] = useState(task.workSource || '')
  const [priority, setPriority] = useState(task.priority || '')
  const [waiting, setWaiting] = useState(task.waitingForFeedback || false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const sending = useRef(false)
  const saved = useRef(false)
  const draft = useFormDraft(`work-item:${userId}:${task.id}:v${task.version}`, {
    __status: status, __source: source, __priority: priority, __waiting: waiting ? 'yes' : '',
  }, values => {
    const restoredStatus = draftText(values, '__status'), restoredSource = draftText(values, '__source'), restoredPriority = draftText(values, '__priority')
    if (['todo', 'doing', 'blocked', 'done'].includes(restoredStatus)) setStatus(restoredStatus as Task['status'])
    if (['', 'leader', 'self', 'coordination'].includes(restoredSource)) setSource(restoredSource as typeof source)
    if (['', 'high', 'medium', 'low'].includes(restoredPriority)) setPriority(restoredPriority as typeof priority)
    setWaiting(draftText(values, '__waiting') === 'yes')
  }, busy)
  const close = () => { if (!sending.current) onClose() }
  const completionReview = workRegisterNeedsCompletionReview(task)

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending.current || saved.current) return
    const form = new FormData(event.currentTarget)
    const body: Record<string, unknown> = {
      version: task.version,
      status,
      waitingForFeedback: status === 'done' ? false : waiting,
      ...(source ? { workSource: source } : {}),
      ...(priority ? { priority } : {}),
    }
    for (const field of ['title', 'description', 'assignedBy', 'assignedOn', 'dueDate', 'requestedOutcome', 'estimatedEffort', 'currentProgress', 'nextAction', 'decisionNeeded', 'completionNote', 'evidenceUrl', 'blockerReason', 'blockerImpact', 'supportNeeded']) {
      if (form.has(field)) body[field] = String(form.get(field) || '').trim()
    }
    if (status === 'done' && !body.completionNote) { setError('请填写完成说明，记录这件事最终交付了什么。'); return }
    if (status === 'blocked' && !body.blockerReason) { setError('请填写受阻原因。'); return }
    sending.current = true
    setBusy(true)
    setError('')
    try {
      const result = await api<Task>(`/tasks/${encodeURIComponent(task.id)}`, json(body, 'PATCH'))
      saved.current = true
      draft.clearDraft()
      onSaved(result)
    } catch (e) {
      setError(saved.current ? '修改已经保存，请关闭窗口后刷新清单。' : e instanceof Error ? e.message : '保存失败，已保留填写内容。')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  return <Modal wide title="编辑工作事项" onClose={close}>
    <form ref={draft.formRef} className="wr-editor" onSubmit={submit} onInput={draft.rememberDraft} onChange={draft.rememberDraft}>
      {draft.notice && <p className="form-hint" role="status">{draft.notice}</p>}
      <p className="wr-modal-intro">维护整件工作的交付与进展。每周的具体承诺在周计划中安排。</p>
      {completionReview && <div className="wr-refresh-note"><p>旧导入将此任务标为已完成，但没有整体完成说明。若仍需推进，请改为进行中；若已全部完成，请保留已完成并补充最终交付说明。</p><button type="button" className="button secondary" disabled={busy} onClick={() => setStatus('doing')}>仍需推进</button></div>}
      <fieldset className="form-fields" disabled={busy || saved.current}>
        <Field label="事项名称"><input name="title" defaultValue={task.title} required maxLength={300} /></Field>
        <div className="wr-form-grid">
          <Field label="事项来源"><select value={source} onChange={event => setSource(event.target.value as typeof source)}>
            {!task.workSource && <option value="">未注明</option>}
            <option value="leader">领导交办</option><option value="self">自主安排</option><option value="coordination">协同事项</option>
          </select></Field>
          <Field label="交办人 / 对接人"><input name="assignedBy" defaultValue={task.assignedBy || ''} maxLength={100} /></Field>
          <Field label="交办日期"><input type="date" name="assignedOn" defaultValue={task.assignedOn || ''} /></Field>
          <Field label="截止日期" hint="尚未明确时留空，清单显示待确认。"><input type="date" name="dueDate" defaultValue={task.dueDate} /></Field>
        </div>
        <Field label="预期交付"><textarea name="requestedOutcome" defaultValue={task.requestedOutcome || ''} rows={2} maxLength={12000} placeholder="例如：一份可供评审的三年规划初稿，含方向、预算与实施步骤" /></Field>
        <details className="wr-details"><summary>补充背景与原始要求</summary><Field label="背景说明"><textarea name="description" defaultValue={task.description} rows={3} maxLength={task.importSource ? 20000 : 12000} /></Field></details>
        <div className="wr-form-grid">
          <Field label="总体状态"><select value={status} onChange={event => setStatus(event.target.value as Task['status'])}>
            <option value="todo">未开始</option><option value="doing">进行中</option><option value="blocked">受阻</option><option value="done">已完成</option>
          </select></Field>
          <Field label="优先级"><select value={priority} onChange={event => setPriority(event.target.value as typeof priority)}>
            {!task.priority && <option value="">未注明</option>}<option value="high">高</option><option value="medium">中</option><option value="low">低</option>
          </select></Field>
        </div>
        {status !== 'done' && <label className="checkbox-label wr-waiting-toggle"><input type="checkbox" checked={waiting} onChange={event => setWaiting(event.target.checked)} />正在等待反馈或确认</label>}
        <Field label="当前进展"><textarea name="currentProgress" defaultValue={task.currentProgress || ''} rows={3} maxLength={12000} placeholder="已经完成什么，现在推进到哪一步" /></Field>
        <Field label="下一步行动"><textarea name="nextAction" defaultValue={task.nextAction || ''} rows={2} maxLength={12000} placeholder="写清楚接下来要推进的具体一步" /></Field>
        <div className="wr-form-grid">
          <Field label="预计剩余投入" hint="按实际判断填写，用于协调工作顺序。"><input name="estimatedEffort" defaultValue={task.estimatedEffort || ''} maxLength={300} placeholder="例如：约 2 个工作日，或还需 3 次讨论" /></Field>
          <Field label="需领导决策 / 协调"><textarea name="decisionNeeded" defaultValue={task.decisionNeeded || ''} rows={2} maxLength={12000} placeholder="例如：确认 A 与 B 的先后顺序，或确定预算范围" /></Field>
        </div>
        <Field label="需要的支持"><textarea name="supportNeeded" defaultValue={task.supportNeeded || ''} rows={2} maxLength={12000} placeholder="需要谁提供什么支持；已解决的请求可清空" /></Field>
        {status === 'done' && <section className="wr-editor-state"><h3>记录完成结果</h3><Field label="完成说明"><textarea required name="completionNote" defaultValue={task.completionNote || ''} rows={3} maxLength={12000} /></Field><Field label="成果链接（选填）"><input type="url" name="evidenceUrl" defaultValue={task.evidenceUrl || ''} maxLength={2000} placeholder="https://" /></Field></section>}
        {status === 'blocked' && <section className="wr-editor-state"><h3>说明受阻情况</h3><Field label="受阻原因"><textarea required name="blockerReason" defaultValue={task.blockerReason || ''} rows={2} maxLength={12000} /></Field><Field label="影响范围"><textarea name="blockerImpact" defaultValue={task.blockerImpact || ''} rows={2} maxLength={12000} /></Field><p className="form-hint">已启用督办的任务，首次受阻还需填写影响范围和上方的支持请求。</p></section>}
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="form-footer"><button type="button" className="button secondary" disabled={busy} onClick={() => { if (allowDraftLeave(draft.formRef.current)) close() }}>取消</button><button type="submit" className="button primary" disabled={busy || saved.current}>{busy && <LoaderCircle size={16} className="spin" />}{busy ? '正在保存…' : '保存事项'}</button></footer>
    </form>
  </Modal>
}
