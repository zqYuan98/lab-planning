import { useEffect, useRef, useState } from 'react'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import type { Bootstrap } from '../../shared/types'
import type { FeedbackAction, FeedbackActionInput, FeedbackAttachment, FeedbackAttachmentInput, FeedbackDetailResponse, FeedbackEvent, FeedbackMetaResponse, FeedbackMutationResponse } from '../../shared/feedback'
import { feedbackStatusLabels } from '../../shared/feedback'
import { ApiError, api, json } from '../api'
import { feedbackAttempt, feedbackError, type FeedbackAttempt } from '../feedback-draft'
import { setActiveDraft } from '../draft-recovery'
import { Badge, Field, dateTime } from '../ui'
import FeedbackAttachments from './FeedbackAttachments'
import { FeedbackContextPreview } from './FeedbackComposer'
import { useFeedbackDraft } from './useFeedbackDraft'

export const feedbackActionLabels: Record<FeedbackEvent['action'], string> = {
  created: '提交反馈', comment: '补充说明', assign: '调整受理人', start: '开始处理', request_info: '请提报人补充', defer: '暂缓处理',
  ready: '已上线，请验证', confirm: '确认已解决', reopen: '仍有问题，重新处理', close: '说明原因并结案', duplicate: '关联重复问题', duplicate_update: '关联问题进度更新',
}
const tones = { new: 'amber', in_progress: 'neutral', verification: 'amber', closed: 'green' }

function FeedbackStoredImage({ attachment }: { attachment: FeedbackAttachment }) {
  const [failed, setFailed] = useState(false), [loaded, setLoaded] = useState(false), [attempt, setAttempt] = useState(0)
  const url = `/api/feedback/${encodeURIComponent(attachment.feedbackId)}/attachments/${encodeURIComponent(attachment.id)}`
  return <figure><a href={url} target="_blank" rel="noreferrer" aria-label={`查看截图：${attachment.name}`}>
    {failed ? <span className="feedback-image-error">截图暂时无法显示</span> : <img key={attempt} loading="lazy" src={url} alt={attachment.name} onLoad={() => setLoaded(true)} onError={() => { setFailed(true); setLoaded(false) }} />}
  </a><figcaption>{attachment.name}</figcaption>
    {failed ? <div className="feedback-image-recovery" role="status"><p>图片未能加载，请重试或打开原图查看。</p><button type="button" className="text-button" onClick={() => { setFailed(false); setLoaded(false); setAttempt(value => value + 1) }}>重试截图</button><a href={url} target="_blank" rel="noreferrer">打开原图</a></div>
      : !loaded && <span className="feedback-image-loading" role="status">正在加载截图…</span>}
  </figure>
}

export function FeedbackTimeline({ detail }: { detail: FeedbackDetailResponse }) {
  return <section className="feedback-timeline" aria-label="反馈处理记录"><h2>处理记录</h2>
    <ol>{detail.events.map(event => <li key={event.id}><div className="feedback-event-heading"><strong>{feedbackActionLabels[event.action]}</strong><span>{event.actorName}</span><time dateTime={event.createdAt}>{dateTime(event.createdAt)}</time></div>
      {event.text && <p className="feedback-preserve-lines">{event.text}</p>}
      {event.assigneeName && <p>受理人：{event.assigneeName}</p>}
      {event.releaseVersion && <p>可验证版本：{event.releaseVersion}</p>}
      {event.reviewAt && <p>复查时间：{dateTime(event.reviewAt)}</p>}
      {event.closureKind && <p className="form-hint">{event.closureKind === 'confirmed' ? '提报人已确认解决。' : '管理者说明原因结案，未记录为提报人确认解决。'}</p>}
      {event.attachmentIds.length > 0 && <div className="feedback-image-grid">{event.attachmentIds.map(id => {
        const attachment = detail.attachments.find(item => item.id === id)
        if (!attachment) return null
        return <FeedbackStoredImage key={id} attachment={attachment} />
      })}</div>}
    </li>)}</ol>
  </section>
}

interface ActionDraft {
  action: FeedbackAction; text: string; reason: string; assigneeId: string; reviewAt: string; resolution: string; releaseVersion: string; released: boolean
  duplicateOfId: string; attachments: FeedbackAttachmentInput[]; attempt: FeedbackAttempt | null; baseVersion: number
}
const newActionDraft = (version: number): ActionDraft => ({ action: 'comment', text: '', reason: '', assigneeId: '', reviewAt: '', resolution: '', releaseVersion: '', released: false, duplicateOfId: '', attachments: [], attempt: null, baseVersion: version })
const actionDraftHasContent = (value: ActionDraft) => !!value.text.trim() || !!value.reason.trim() || !!value.resolution.trim() || !!value.releaseVersion.trim() || value.attachments.length > 0 || !!value.attempt || value.action !== 'comment'

export function feedbackActionPayload(value: ActionDraft, feedbackId?: string): Omit<FeedbackActionInput, 'requestId'> {
  const payload: Omit<FeedbackActionInput, 'requestId'> = { version: value.baseVersion, action: value.action }
  if (value.action === 'comment') { payload.text = value.text.trim(); payload.attachments = value.attachments }
  if (['request_info', 'defer', 'reopen', 'close', 'duplicate'].includes(value.action)) payload.reason = value.reason.trim()
  if (value.action === 'assign') payload.assigneeId = value.assigneeId
  if (value.action === 'defer') payload.reviewAt = value.reviewAt ? new Date(`${value.reviewAt}:00+08:00`).toISOString() : ''
  if (value.action === 'ready') { payload.resolution = value.resolution.trim(); payload.releaseVersion = value.releaseVersion.trim(); payload.released = value.released }
  if (value.action === 'duplicate') {
    payload.duplicateOfId = value.duplicateOfId.trim()
    if (payload.duplicateOfId === feedbackId) throw new Error('不能将本条反馈关联到自己。')
  }
  return payload
}

function FeedbackActionForm({ data, detail, onChanged, onConflict }: {
  data: Bootstrap; detail: FeedbackDetailResponse; onChanged: (result: FeedbackMutationResponse) => Promise<void>; onConflict: () => Promise<FeedbackDetailResponse>
}) {
  const draft = useFeedbackDraft<ActionDraft>(data.user.id, `action:${detail.feedback.id}`, () => newActionDraft(detail.feedback.version), actionDraftHasContent)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [reading, setReading] = useState(false), [success, setSuccess] = useState('')
  const [meta, setMeta] = useState<FeedbackMetaResponse | null>(null)
  const [duplicatePreview, setDuplicatePreview] = useState<FeedbackDetailResponse | null>(null), [previewBusy, setPreviewBusy] = useState(false)
  const requestBusy = useRef(false), previewSequence = useRef(0), previousVersion = useRef(detail.feedback.version)
  const formRef = useRef<HTMLFormElement>(null), draftToken = useRef(Symbol('feedback-action-draft'))
  const value = draft.value, action = value.action, allowed = detail.allowedActions.includes(action)
  useEffect(() => {
    const form = formRef.current, token = draftToken.current
    if (form) setActiveDraft(token, { form, dirty: actionDraftHasContent(value), busy: busy || reading, persisted: !draft.saving && !draft.storageError })
    return () => setActiveDraft(token, null)
  }, [draft.ready, value, busy, reading, draft.saving, draft.storageError])
  useEffect(() => {
    if (data.user.role !== 'manager') return
    let active = true
    void api<FeedbackMetaResponse>('/feedback/meta').then(result => { if (active) setMeta(result) }).catch(() => {})
    return () => { active = false; previewSequence.current++ }
  }, [data.user.id, data.user.role])
  useEffect(() => {
    if (previousVersion.current === detail.feedback.version) return
    previousVersion.current = detail.feedback.version
    if (!draft.ready) return
    // Preserve uncertain attempts; only a definitive 409 is allowed to replace their base version.
    if (!value.attempt) draft.update(previous => ({ ...previous, baseVersion: detail.feedback.version }))
  }, [detail.feedback.version, draft.ready])
  useEffect(() => {
    if (!actionDraftHasContent(value)) return
    const protect = (event: BeforeUnloadEvent) => { if (requestBusy.current || draft.saving || draft.storageError) { event.preventDefault(); event.returnValue = '' } }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [value, draft.saving, draft.storageError])
  function change<K extends keyof ActionDraft>(key: K, next: ActionDraft[K]) { draft.update(previous => ({ ...previous, [key]: next })); setSuccess('') }
  function choose(next: FeedbackAction) {
    draft.update(previous => ({ ...previous, action: next, baseVersion: detail.feedback.version, attempt: null }))
    setError(''); setSuccess('')
  }
  async function previewDuplicate() {
    const sequence = ++previewSequence.current
    setError(''); setDuplicatePreview(null); setPreviewBusy(true)
    try {
      if (!value.duplicateOfId.trim() || value.duplicateOfId.trim() === detail.feedback.id) throw new Error('请填写另一条反馈的编号。')
      const result = await api<FeedbackDetailResponse>(`/feedback/${encodeURIComponent(value.duplicateOfId.trim())}`)
      if (sequence === previewSequence.current) setDuplicatePreview(result)
    } catch (error) { if (sequence === previewSequence.current) setError(feedbackError(error)) }
    finally { if (sequence === previewSequence.current) setPreviewBusy(false) }
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (requestBusy.current || reading || !draft.ready || !allowed) return
    setError(''); setSuccess('')
    let payload: Omit<FeedbackActionInput, 'requestId'>
    try {
      payload = feedbackActionPayload(value, detail.feedback.id)
      if (action === 'comment' && !payload.text && !value.attachments.length) throw new Error('请补充说明或添加截图。')
      if (['request_info', 'defer', 'reopen', 'close', 'duplicate'].includes(action) && !payload.reason) throw new Error('请填写原因。')
      if (action === 'duplicate' && duplicatePreview?.feedback.id !== payload.duplicateOfId) throw new Error('请先核对要关联的反馈。')
      if (action === 'ready' && (!payload.resolution || !payload.releaseVersion || !payload.released)) throw new Error('请填写解决说明、可验证版本，并确认已实际上线。')
    } catch (error) { setError(feedbackError(error)); return }
    const attempt = feedbackAttempt(value.attempt, payload)
    requestBusy.current = true; setBusy(true)
    draft.update(previous => ({ ...previous, attempt }))
    await draft.flush()
    let result: FeedbackMutationResponse
    try { result = await api<FeedbackMutationResponse>(`/feedback/${encodeURIComponent(detail.feedback.id)}/actions`, json({ ...payload, requestId: attempt.requestId })) }
    catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        try {
          const latest = await onConflict()
          draft.update(previous => ({ ...previous, baseVersion: latest.feedback.version, attempt: null }))
          setError(`${feedbackError(error)} 已读取最新记录，您的填写和截图仍保留；请核对后再提交。`)
        } catch (refreshError) { setError(`${feedbackError(error)} 最新记录暂时读取失败，输入已保留，请刷新详情后重试。${feedbackError(refreshError)}`) }
      } else setError(feedbackError(error))
      requestBusy.current = false; setBusy(false); return
    }
    // A successful mutation is final even if a later list refresh fails.
    await draft.reset(newActionDraft(result.feedback.version))
    setDuplicatePreview(null)
    setSuccess(`${feedbackActionLabels[action]}已保存。`)
    try { await onChanged(result) } catch { setError('处理已保存，列表暂时刷新失败。请刷新查看，无需重复提交。') }
    requestBusy.current = false; setBusy(false)
  }
  if (!draft.ready) return <p role="status">正在恢复未提交的处理草稿…</p>
  return <section className="feedback-action-panel"><h2>{data.user.role === 'manager' ? '受理与处理' : '补充与确认'}</h2>
    {draft.restored && <p className="feedback-notice" role="status">已恢复未提交的填写和截图；请结合当前状态核对后提交。</p>}
    {success && <p className="feedback-notice" role="status">{success}</p>}
    <form ref={formRef} className="feedback-form" onSubmit={event => void submit(event)}>
      <fieldset disabled={busy} className="feedback-fields">
        <Field label="下一步操作"><select value={action} onChange={event => choose(event.target.value as FeedbackAction)}>
          {!allowed && <option value={action} disabled>{feedbackActionLabels[action]}（当前不可用，填写已保留）</option>}
          {detail.allowedActions.map(item => <option key={item} value={item}>{feedbackActionLabels[item]}</option>)}
        </select></Field>
        {!allowed && <p className="note">当前状态或权限已变化。请核对处理记录，选择可用操作；原填写仍保留。</p>}
        {action === 'comment' && <><Field label="补充说明（有截图时可留空）"><textarea rows={4} maxLength={10000} value={value.text} onChange={event => change('text', event.target.value)} placeholder="可以补充复现步骤、实际情况或验证结果。" /></Field>
          <FeedbackAttachments value={value.attachments} onChange={attachments => change('attachments', attachments)} disabled={busy} onBusyChange={setReading} /></>}
        {['request_info', 'defer', 'reopen', 'close', 'duplicate'].includes(action) && <Field label={action === 'request_info' ? '请提报人补充什么' : action === 'reopen' ? '仍存在的问题' : action === 'close' ? '结案原因' : action === 'duplicate' ? '关联说明' : '暂缓原因'}>
          <textarea required rows={3} maxLength={10000} value={value.reason} onChange={event => change('reason', event.target.value)} />
        </Field>}
        {action === 'assign' && <Field label="受理人"><select required value={value.assigneeId} onChange={event => change('assigneeId', event.target.value)}>
          <option value="">请选择可用管理者</option>{meta?.managers.map(manager => <option key={manager.id} value={manager.id}>{manager.name}</option>)}
        </select>{!meta && <small>受理人暂未读取成功，可刷新详情后再试。</small>}</Field>}
        {action === 'defer' && <Field label="复查时间（北京时间）" hint="到时重新查看此问题；暂缓不会被算作已解决。"><input required type="datetime-local" value={value.reviewAt} onChange={event => change('reviewAt', event.target.value)} /></Field>}
        {action === 'ready' && <><Field label="解决说明与验证方式"><textarea required rows={4} maxLength={10000} value={value.resolution} onChange={event => change('resolution', event.target.value)} placeholder="说明改了什么，提报人可以怎样验证。" /></Field>
          <Field label="实际可验证版本"><input required maxLength={160} value={value.releaseVersion} onChange={event => change('releaseVersion', event.target.value)} placeholder="例如：2026.09.21.1" /></Field>
          <label className="checkbox-label"><input required type="checkbox" checked={value.released} onChange={event => change('released', event.target.checked)} />我确认此修改已实际上线，提报人现在可以验证。</label></>}
        {action === 'duplicate' && <><Field label="要关联的主反馈编号" hint="先核对目标。关联不会向提报人开放主反馈的描述和截图。"><input required maxLength={200} value={value.duplicateOfId} onChange={event => { change('duplicateOfId', event.target.value); previewSequence.current++; setPreviewBusy(false); setDuplicatePreview(null) }} /></Field>
          <button type="button" className="button secondary" disabled={previewBusy || !value.duplicateOfId.trim()} onClick={() => void previewDuplicate()}>{previewBusy ? '正在核对…' : '核对主反馈'}</button>
          {duplicatePreview && <div className="feedback-duplicate-preview"><strong>{duplicatePreview.feedback.reporterName} · {feedbackStatusLabels[duplicatePreview.feedback.status]}</strong><p className="feedback-preserve-lines">{duplicatePreview.feedback.description}</p><span>受理人：{duplicatePreview.feedback.assigneeName}</span></div>}</>}
        {action === 'confirm' && <p className="note">请在实际验证后确认。这会将本条反馈记录为“提报人已确认解决”。</p>}
        {action === 'start' && <p className="note">开始处理后，提报人可以看到进度。修复实际上线后，再提交解决说明请提报人验证。</p>}
        {action === 'close' && <p className="note">此操作记录为管理者说明原因结案，不会显示为提报人确认解决。</p>}
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      {draft.storageError ? <p className="error" role="alert">{draft.storageError}</p> : actionDraftHasContent(value) && <p className="form-hint" role="status">{draft.saving ? '正在保存本地草稿…' : '未提交的填写和截图已保存在本浏览器。'}</p>}
      <div className="feedback-form-footer"><button type="submit" className="button primary" disabled={busy || reading || !allowed || previewBusy}>{busy ? '正在保存…' : feedbackActionLabels[action]}</button></div>
    </form>
  </section>
}

export default function FeedbackDetail({ data, detail, onBack, onRefresh, onChanged }: {
  data: Bootstrap; detail: FeedbackDetailResponse; onBack: () => void; onRefresh: () => Promise<FeedbackDetailResponse>; onChanged: (result: FeedbackMutationResponse) => Promise<void>
}) {
  const [error, setError] = useState(''), [refreshing, setRefreshing] = useState(false)
  const row = detail.feedback
  return <article className="feedback-detail"><div className="feedback-detail-toolbar"><button className="button secondary" onClick={onBack}><ArrowLeft size={16} />返回反馈列表</button>
    <button className="button secondary" disabled={refreshing} onClick={() => { setRefreshing(true); setError(''); void onRefresh().catch(error => setError(feedbackError(error))).finally(() => setRefreshing(false)) }}><RefreshCw size={16} />刷新详情</button></div>
    {error && <p className="error" role="alert">{error}</p>}
    <section className="feedback-detail-summary"><div className="feedback-row-meta"><Badge tone={tones[row.status]}>{feedbackStatusLabels[row.status]}</Badge><span>{({ bug: '遇到故障', usability: '使用体验', suggestion: '改进建议' })[row.kind]}</span>{row.impact === 'blocking' && <Badge tone="red">已影响正常使用</Badge>}</div>
      <h2>反馈详情</h2><p className="feedback-description">{row.description}</p>
      <dl className="feedback-detail-facts"><div><dt>提报人</dt><dd>{row.reporterName}</dd></div><div><dt>受理人</dt><dd>{row.assigneeName}</dd></div><div><dt>提交时间</dt><dd>{dateTime(row.createdAt)}</dd></div><div><dt>最近更新</dt><dd>{dateTime(row.updatedAt)}</dd></div></dl>
      <p className="feedback-record-id">反馈编号：{row.id}</p>
      {row.waiting && <div className="feedback-state-note"><strong>{row.waiting.kind === 'request_info' ? '等待提报人补充' : '已暂缓，等待复查'}</strong><p className="feedback-preserve-lines">{row.waiting.reason}</p>{row.waiting.reviewAt && <p>复查时间：{dateTime(row.waiting.reviewAt)}{Date.parse(row.waiting.reviewAt) <= Date.now() && ' · 已到复查时间'}</p>}</div>}
      {row.resolution && <div className="feedback-state-note"><strong>解决说明 · {row.releaseVersion}</strong><p className="feedback-preserve-lines">{row.resolution}</p>{row.status === 'verification' && <p>请提报人实际验证，确认解决或说明仍存在的问题。</p>}</div>}
      {row.closure && <div className="feedback-state-note"><strong>{row.closure.kind === 'confirmed' ? '提报人已确认解决' : '管理者已说明原因结案'}</strong>{row.closure.reason && <p className="feedback-preserve-lines">{row.closure.reason}</p>}<p>{dateTime(row.closure.closedAt)}</p></div>}
      {row.duplicateLinked && <p className="note">此反馈已关联到相同问题，关键处理结果会回告到这里。{data.user.role === 'manager' && row.duplicateOfId ? `主反馈编号：${row.duplicateOfId}` : '您可以继续在本条反馈中补充、验证和查看进度。'}</p>}
      <FeedbackContextPreview context={row.context} />
    </section>
    <div className="feedback-detail-columns"><FeedbackTimeline detail={detail} /><FeedbackActionForm key={`${data.user.id}:${row.id}`} data={data} detail={detail} onChanged={onChanged} onConflict={onRefresh} /></div>
  </article>
}
