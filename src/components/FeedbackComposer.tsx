import { useEffect, useRef, useState } from 'react'
import Drawer from '@arco-design/web-react/es/Drawer'
import { CheckCircle2, Send, X } from 'lucide-react'
import type { Bootstrap } from '../../shared/types'
import type { FeedbackAttachmentInput, FeedbackContext, FeedbackKind, FeedbackImpact, FeedbackMetaResponse, FeedbackMutationResponse } from '../../shared/feedback'
import { api, json } from '../api'
import { feedbackAttempt, feedbackError, type FeedbackAttempt } from '../feedback-draft'
import { Field } from '../ui'
import FeedbackAttachments from './FeedbackAttachments'
import { useFeedbackDraft } from './useFeedbackDraft'
import '../feedback.css'

interface ComposerDraft {
  description: string; kind: FeedbackKind; impact: FeedbackImpact; context: FeedbackContext
  attachments: FeedbackAttachmentInput[]; attempt: FeedbackAttempt | null
}
const hasContent = (draft: ComposerDraft) => !!draft.description.trim() || draft.attachments.length > 0 || !!draft.attempt

export function FeedbackContextPreview({ context }: { context: FeedbackContext }) {
  const fields = [
    ['反馈所在页面', context.path], ['应用版本', context.appVersion], ['浏览器 / 设备', context.userAgent],
    ['窗口尺寸', context.viewport], ['最近错误编号', context.errorRequestId],
  ].filter(([, value]) => !!value)
  return <details className="feedback-context"><summary>查看随反馈提交的定位信息</summary>
    {fields.length ? <dl>{fields.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p>没有附加定位信息。</p>}
    <p className="form-hint">只附上方信息及您选择的截图。截图中的敏感内容可先遮挡后再上传。</p>
  </details>
}

export default function FeedbackComposer({ data, onClose, onCreated, context }: {
  data: Bootstrap; onClose: () => void; onCreated: (id: string) => void; context: FeedbackContext
}) {
  const draft = useFeedbackDraft<ComposerDraft>(data.user.id, 'create', () => ({ description: '', kind: 'bug', impact: 'normal', context: { ...context }, attachments: [], attempt: null }), hasContent)
  const [meta, setMeta] = useState<FeedbackMetaResponse | null>(null), [metaError, setMetaError] = useState('')
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [reading, setReading] = useState(false)
  const [closeRequested, setCloseRequested] = useState(false), [closeFailed, setCloseFailed] = useState(false)
  const [created, setCreated] = useState<{ id: string; assigneeName: string } | null>(null)
  const busyRef = useRef(false), completed = useRef(false)
  const closePrompt = useRef<HTMLDivElement>(null), createdPanel = useRef<HTMLElement>(null)
  async function loadMeta() {
    setMetaError('')
    try { setMeta(await api<FeedbackMetaResponse>('/feedback/meta')) }
    catch (error) { setMetaError(feedbackError(error, '暂时无法读取受理人，请刷新后重试。')) }
  }
  useEffect(() => { void loadMeta() }, [])
  useEffect(() => {
    if (!closeRequested) return
    const frame = requestAnimationFrame(() => {
      closePrompt.current?.scrollIntoView({ block: 'nearest' })
      closePrompt.current?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true })
    })
    return () => cancelAnimationFrame(frame)
  }, [closeRequested])
  useEffect(() => {
    if (!created) return
    const frame = requestAnimationFrame(() => createdPanel.current?.focus({ preventScroll: true }))
    return () => cancelAnimationFrame(frame)
  }, [created])
  useEffect(() => {
    if (!hasContent(draft.value) || created) return
    const protect = (event: BeforeUnloadEvent) => { if (busyRef.current || draft.saving || draft.storageError) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [draft.value, draft.saving, draft.storageError, created])
  function requestClose() {
    if (busyRef.current || reading) return
    if (created || !hasContent(draft.value)) onClose()
    else setCloseRequested(true)
  }
  async function saveAndClose() {
    if (await draft.flush()) onClose()
    else setCloseFailed(true)
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (busyRef.current || completed.current || reading || !draft.ready) return
    const description = draft.value.description.trim()
    if (!description) { setError('请描述发生的问题或希望调整的地方。'); return }
    busyRef.current = true; setBusy(true); setError(''); setCloseRequested(false)
    const payload = { description, kind: draft.value.kind, impact: draft.value.impact, context: draft.value.context, attachments: draft.value.attachments }
    const attempt = feedbackAttempt(draft.value.attempt, payload)
    draft.update(previous => ({ ...previous, attempt }))
    // Persist the attempt before the request so a reload can replay an uncertain result.
    await draft.flush()
    let result: FeedbackMutationResponse
    try { result = await api<FeedbackMutationResponse>('/feedback', json({ ...payload, requestId: attempt.requestId })) }
    catch (error) { setError(feedbackError(error)); busyRef.current = false; setBusy(false); return }
    completed.current = true
    setCreated({ id: result.feedback.id, assigneeName: result.feedback.assigneeName })
    await draft.reset()
    busyRef.current = false; setBusy(false)
  }
  const assignee = meta?.managers.find(manager => manager.id === meta.defaultAssigneeId)
  return <Drawer visible title={<div className="feedback-composer-heading"><span>问题与建议</span><button type="button" className="icon-button" aria-label="关闭问题与建议" disabled={busy || reading} onClick={requestClose}><X size={19} /></button></div>}
    {...{ role: 'dialog', 'aria-modal': true, 'aria-label': '问题与建议' }} closable={false}
    width="min(680px, 100vw)" className="feedback-composer shell-light" footer={null} onCancel={requestClose}
    maskClosable={!busy && !reading} escToExit={!busy && !reading} focusLock autoFocus>
    {created ? <section ref={createdPanel} tabIndex={-1} className="feedback-created" aria-live="polite"><CheckCircle2 size={36} /><h2>反馈已提交</h2>
      <p>由 <strong>{created.assigneeName}</strong> 受理。需要补充或可以验证时，您会收到站内消息。</p>
      <p className="feedback-record-id">反馈编号：{created.id}</p>
      {draft.storageError && <p className="error" role="alert">{draft.storageError}</p>}
      <div className="feedback-actions"><button className="button primary" onClick={() => onCreated(created.id)}>查看这条反馈</button><button className="button secondary" onClick={onClose}>继续工作</button></div>
    </section> : !draft.ready ? <p role="status">正在恢复本账号的反馈草稿…</p> : <form className="feedback-form" onSubmit={event => void submit(event)}>
      <p className="feedback-intro">遇到小问题，或觉得哪一步可以更顺手，直接记在这里。您可以随时查看处理进度。</p>
      {draft.restored && <p className="feedback-notice" role="status">已恢复本账号未提交的反馈及截图，请核对后继续。定位信息保留为开始填写时的页面。</p>}
      <fieldset className="feedback-fields" disabled={busy}>
        <Field label="问题或建议" hint="可以描述：在哪一步、发生了什么、希望怎样。"><textarea required autoFocus name="description" rows={5} maxLength={10000} value={draft.value.description} onChange={event => draft.update(previous => ({ ...previous, description: event.target.value }))} placeholder="例如：填写本周进展后点保存，一直显示处理中……" /></Field>
        <div className="feedback-field-pair"><Field label="反馈类型"><select value={draft.value.kind} onChange={event => draft.update(previous => ({ ...previous, kind: event.target.value as FeedbackKind }))}>
          <option value="bug">遇到故障</option><option value="usability">用起来不顺手</option><option value="suggestion">改进建议</option>
        </select></Field><Field label="对工作的影响"><select value={draft.value.impact} onChange={event => draft.update(previous => ({ ...previous, impact: event.target.value as FeedbackImpact }))}>
          <option value="normal">可以继续工作</option><option value="blocking">已影响正常使用</option>
        </select></Field></div>
        <FeedbackAttachments value={draft.value.attachments} onChange={attachments => draft.update(previous => ({ ...previous, attachments }))} disabled={busy} onBusyChange={setReading} />
        <FeedbackContextPreview context={draft.value.context} />
      </fieldset>
      {metaError ? <p className="error" role="alert">{metaError} <button type="button" className="text-button" onClick={() => void loadMeta()}>重新读取</button></p>
        : <p className="form-hint">受理人：{assignee?.name || (meta ? '暂无可用管理者，请联系部门管理员。' : '正在读取…')} · 反馈仅本人和管理者可见。</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {draft.storageError ? <p className="error" role="alert">{draft.storageError}</p> : hasContent(draft.value) && <p className="form-hint" role="status">{draft.saving ? '正在保存本地草稿…' : '文字和截图已保存为本地草稿，14 天内可在本浏览器继续填写。'}</p>}
      {closeRequested && <div ref={closePrompt} className="feedback-close-prompt" role="alert"><p>{closeFailed ? '本地草稿未保存成功，关闭可能丢失内容。请先复制描述或继续提交。' : '这条反馈尚未提交，保存草稿后可以稍后继续。'}</p>
        <div className="feedback-actions"><button type="button" className="button secondary" onClick={() => { setCloseRequested(false); setCloseFailed(false) }}>继续填写</button>
          {closeFailed ? <button type="button" className="button secondary" onClick={onClose}>仍要关闭</button> : <button type="button" className="button secondary" onClick={() => void saveAndClose()}>保存草稿并关闭</button>}</div>
      </div>}
      <footer className="feedback-form-footer"><button type="button" className="button secondary" disabled={busy || reading} onClick={requestClose}>稍后再写</button>
        <button type="submit" className="button primary" disabled={busy || reading || !draft.value.description.trim() || !meta?.defaultAssigneeId}><Send size={16} />{busy ? '正在提交…' : '提交反馈'}</button></footer>
    </form>}
  </Drawer>
}
