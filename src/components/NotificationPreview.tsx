import { useEffect, useRef, useState } from 'react'
import type { NotificationPreview as Preview } from '../../shared/notifications'
import { api } from '../api'
import { Badge, Modal, dateTime } from '../ui'

export interface NotificationPreviewRequest { notificationId: string; reminder: boolean }

/** Display the server-rendered recipient view as text; preview URLs never navigate. */
export function NotificationPreviewContent({ preview }: { preview: Preview }) {
  return <>
    <dl className="notification-preview-facts">
      <div><dt>接收人</dt><dd>{preview.recipientName} · 1 人</dd></div>
      <div><dt>预计发送时段</dt><dd>{preview.sendWindow}</dd></div>
      <div><dt>内容生成于</dt><dd>{dateTime(preview.renderedAt)}</dd></div>
    </dl>
    <article className="notification-preview-card" aria-label="接收人所见通知">
      <h3>{preview.title}</h3>
      <p className="notification-body">{preview.body}</p>
      <span className="notification-preview-button" aria-label={`通知按钮：${preview.buttonText}`}>{preview.buttonText}</span>
    </article>
    {preview.truncated && <p className="note">通知已按发送长度限制节选；接收人可通过通知按钮查看完整事项。</p>}
    <p className="notification-preview-eligibility"><Badge tone={preview.eligible ? 'green' : 'amber'}>{preview.eligible ? '安排当前有效' : '当前不可发送'}</Badge>{preview.reason && <span>{preview.reason}</span>}</p>
    <p className="form-hint">这是当前接收人可见内容的只读预览，不发送、不标记查看，也不占用提醒次数。实际发送前会再次核对权限、安排版本和发送条件；预览中的按钮仅展示文字。</p>
  </>
}

export default function NotificationPreview({ request, onClose, onSend }: {
  request: NotificationPreviewRequest; onClose: () => void; onSend: (id: string) => Promise<void>
}) {
  const [preview, setPreview] = useState<Preview | null>(null)
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  useEffect(() => {
    let live = true
    setPreview(null); setError('')
    const mode = request.reminder ? '?mode=reminder' : ''
    void api<Preview>(`/notifications/${encodeURIComponent(request.notificationId)}/preview${mode}`)
      .then(value => { if (live) setPreview(value) })
      .catch(error => { if (live) setError(error instanceof Error ? error.message : '预览读取失败') })
    return () => { live = false }
  }, [request.notificationId, request.reminder])
  async function send() {
    if (!request.reminder || !preview?.eligible || sendingRef.current) return
    sendingRef.current = true; setSending(true); setError('')
    try { await onSend(request.notificationId); onClose() }
    catch (error) { setError(error instanceof Error ? error.message : '提醒发送失败，请核对当前状态') }
    finally { sendingRef.current = false; setSending(false) }
  }
  return <Modal title={request.reminder ? '预览催确认通知' : '预览通知'} onClose={() => { if (!sendingRef.current) onClose() }}>
    <div className="notification-preview">
      {error && <p className="error" role="alert">{error}</p>}
      {preview ? <NotificationPreviewContent preview={preview} /> : !error && <p role="status">正在生成接收人所见预览…</p>}
      {sending && <p role="status">正在提交提醒，请等待结果…</p>}
      <div className="notification-preview-actions">
        <button type="button" className="button secondary" disabled={sending} onClick={onClose}>{request.reminder ? '取消' : '关闭预览'}</button>
        {request.reminder && <button type="button" className="button primary" disabled={sending || !preview?.eligible} onClick={() => void send()}>{sending ? '正在提交…' : '发送提醒'}</button>}
      </div>
    </div>
  </Modal>
}
