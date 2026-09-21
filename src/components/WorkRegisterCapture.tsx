import { useRef, useState, type FormEvent } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import type { Task } from '../../shared/types'
import { api, json } from '../api'
import { assignmentAttempt, type SubmissionAttempt } from '../notification-navigation'
import { Field, Modal } from '../ui'

interface CaptureProps {
  onClose: () => void
  onSaved: (tasks: Task[]) => void
}

export default function WorkRegisterCapture({ onClose, onSaved }: CaptureProps) {
  const [text, setText] = useState('')
  const [source, setSource] = useState<'leader' | 'self' | 'coordination'>('leader')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const attempt = useRef<SubmissionAttempt | null>(null)
  const sending = useRef(false)
  const saved = useRef(false)
  const titles = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  const invalid = titles.length > 50 || titles.some(title => title.length > 300)
  const close = () => { if (!sending.current) onClose() }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (sending.current || saved.current) return
    if (!titles.length || invalid) {
      setError('请填写 1–50 件事项，每行一件，每件不超过 300 字。')
      return
    }
    const form = new FormData(event.currentTarget)
    const body = {
      titles,
      workSource: source,
      assignedBy: String(form.get('assignedBy') || '').trim(),
      assignedOn: String(form.get('assignedOn') || ''),
      dueDate: String(form.get('dueDate') || ''),
    }
    sending.current = true
    setBusy(true)
    setError('')
    attempt.current = assignmentAttempt(attempt.current, body)
    try {
      const result = await api<{ tasks: Task[] }>('/work-register/capture', json({ ...body, requestId: attempt.current.requestId }))
      saved.current = true
      onSaved(result.tasks)
    } catch (e) {
      setError(saved.current ? '事项已经保存，请关闭窗口后刷新清单。' : e instanceof Error ? e.message : '录入失败，已保留填写内容，请重试。')
    } finally {
      sending.current = false
      setBusy(false)
    }
  }

  return <Modal wide title="快速记录工作事项" onClose={close}>
    <form className="wr-capture" onSubmit={submit}>
      <p className="wr-modal-intro">先把事情记下来，交付要求和具体排期可以逐项补充。</p>
      <fieldset className="form-fields" disabled={busy || saved.current}>
        <Field label="工作事项 · 一行一件" hint="支持一次录入 1–50 件；换行会拆为独立事项。">
          <textarea value={text} onChange={event => setText(event.target.value)} rows={6} required placeholder={'整理实验室下一年度发展规划\n补充产业合作方案中的预算测算\n协调下周评审会的参会安排'} />
        </Field>
        <div className="wr-form-grid">
          <Field label="事项来源"><select value={source} onChange={event => setSource(event.target.value as typeof source)}>
            <option value="leader">领导交办</option><option value="self">自主安排</option><option value="coordination">协同事项</option>
          </select></Field>
          <Field label="交办人 / 对接人（选填）"><input name="assignedBy" maxLength={100} placeholder="填写姓名或称呼" /></Field>
          <Field label="交办日期（选填）"><input type="date" name="assignedOn" /></Field>
          <Field label="共同截止日期（选填）" hint="留空表示待确认，可在清单中分别设置。"><input type="date" name="dueDate" /></Field>
        </div>
        {titles.length > 0 && <section className="wr-capture-preview" aria-label="录入前预览" aria-live="polite">
          <div className="wr-section-heading"><h3>将记录 {titles.length} 件事项</h3><span>请核对拆分结果</span></div>
          <ol>{titles.slice(0, 50).map((title, index) => <li key={index} className={title.length > 300 ? 'wr-invalid' : ''}><span>{title}</span>{title.length > 300 && <small>超过 300 字，请缩短标题</small>}</li>)}</ol>
          {titles.length > 50 && <p className="error">单次最多 50 件，请分批录入。</p>}
        </section>}
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      <footer className="form-footer">
        <button type="button" className="button secondary" disabled={busy} onClick={close}>取消</button>
        <button type="submit" className="button primary" disabled={busy || saved.current || !titles.length || invalid}>
          {busy ? <LoaderCircle size={16} className="spin" /> : <Check size={16} />}
          {busy ? '正在记录…' : `确认记录${titles.length ? ` ${titles.length} 件` : ''}`}
        </button>
      </footer>
    </form>
  </Modal>
}
