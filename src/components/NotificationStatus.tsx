import { useEffect, useState } from 'react'
import type { NotificationView } from '../../shared/notifications'
import type { Bootstrap } from '../../shared/types'
import { api, json } from '../api'
import { deliveryLabels } from '../notification-navigation'
import { dateTime, nameOf } from '../ui'
import NotificationPreview, { type NotificationPreviewRequest } from './NotificationPreview'

/** Manager diagnostic only: no acknowledgement or read receipts are mutated here. */
export default function NotificationStatus({ type, id, data }: { type: 'plan' | 'task' | 'weeklyRecord'; id: string; data: Bootstrap }) {
  const [items, setItems] = useState<NotificationView[]>([])
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState('')
  const [preview, setPreview] = useState<NotificationPreviewRequest | null>(null)
  async function remind(notificationId: string) {
    if (busy) return
    setBusy(true); setError(''); setResult('')
    try { await api(`/notifications/${encodeURIComponent(notificationId)}/remind`, json({})); setResult('提醒已记录。同一事项、同一成员每天最多手动提醒一次。') }
    finally { setBusy(false) }
  }
  useEffect(() => {
    let live = true
    setLoading(true); setError(''); setItems([]); setPreview(null); setResult('')
    void api<{ items: NotificationView[] }>(`/notification-status?type=${type}&id=${encodeURIComponent(id)}`)
      .then(result => { if (live) setItems(result.items) })
      .catch(error => { if (live) setError(error.message) })
      .finally(() => { if (live) setLoading(false) })
    return () => { live = false }
  }, [type, id])
  return <><section className="notification-object-status" aria-label="安排通知状态"><h3>通知与接收</h3>
    {error && <p role="alert">{error}</p>}{result && <p role="status">{result}</p>}
    {loading ? <p role="status">正在读取通知状态…</p> : items.length ? items.map(item => <div key={item.id}>
      <strong>{nameOf(data, item.recipientId)}</strong>
      <dl><div><dt>钉钉投递</dt><dd>{item.deliveryStatus ? deliveryLabels[item.deliveryStatus] : '仅站内消息'}</dd></div>
        <div><dt>系统查看</dt><dd>{item.openedAt ? dateTime(item.openedAt) : '尚未查看'}</dd></div>
        <div><dt>确认接收</dt><dd>{item.acknowledgedAt ? dateTime(item.acknowledgedAt) : item.canAcknowledge ? '待本人确认' : item.supersededAt ? '安排已有更新' : '无需单独确认'}</dd></div></dl>
      <div className="notification-status-actions">
        <button type="button" className="button secondary" disabled={busy} onClick={() => setPreview({ notificationId: item.id, reminder: false })}>预览通知</button>
        {item.canAcknowledge && !item.acknowledgedAt && <button type="button" className="button secondary" disabled={busy} onClick={() => setPreview({ notificationId: item.id, reminder: true })}>提醒本人确认</button>}
      </div>
    </div>) : <p>暂无该事项的通知记录。</p>}
    <small>通知状态独立于执行进展、成果验收与正式周提报。</small>
  </section>
    {preview && <NotificationPreview key={`${preview.notificationId}-${preview.reminder}`} request={preview} onClose={() => setPreview(null)} onSend={remind} />}
  </>
}
