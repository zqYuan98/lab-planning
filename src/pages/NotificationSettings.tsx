import { useEffect, useState } from 'react'
import { Bell, RefreshCw, ShieldCheck } from 'lucide-react'
import type { NotificationSettingsView } from '../../shared/notifications'
import { api, json } from '../api'
import { useWorkspaceQuery } from '../workspace-query'
import { useDirectoryReferences } from '../directory-references'
import DirectoryAccountPicker, { directoryAccountName } from '../components/DirectoryAccountPicker'
import { deliveryLabels } from '../notification-navigation'
import { Badge, Empty, Field, Form, PageHeader, dateTime, type PageProps } from '../ui'
import NotificationPreview, { type NotificationPreviewRequest } from '../components/NotificationPreview'
import CollaborationSettingsPanel from '../components/CollaborationSettingsPanel'
import NativeCapabilities from '../components/NativeCapabilities'
import NotificationDiagnostics from '../components/NotificationDiagnostics'
import UsageAnalyticsPanel from '../components/UsageAnalyticsPanel'
import '../collaboration.css'
import '../notification-settings.css'

export default function NotificationSettings({ data, notify, refresh }: PageProps) {
  const scope = `${data.user.id}:${data.user.role}:${data.operationEpoch}:${data.accessScopeVersion}`
  const query = useWorkspaceQuery<NotificationSettingsView>('/notification-settings', scope, (current, receipt) => receipt && typeof receipt === 'object' && 'settings' in receipt && 'deliveries' in receipt ? receipt as NotificationSettingsView : current)
  const view = query.value
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [readRecovery, setReadRecovery] = useState(false)
  const [preview, setPreview] = useState<NotificationPreviewRequest | null>(null)
  const load = async () => { await query.reload(); setReadRecovery(false) }
  useEffect(() => { setPreview(null); setError(''); setReadRecovery(false) }, [scope])
  const people = useDirectoryReferences(view?.deliveries.map(row => row.recipientId) ?? [], scope)
  async function retry(id: string) {
    if (busy || readRecovery) return
    setBusy(true); setError('')
    try { await api(`/notification-deliveries/${encodeURIComponent(id)}/retry`, json({})); setReadRecovery(true); notify('已重新排队，将在发送前再次核对权限与身份'); try { await load() } catch { setError('已重新排队，状态刷新失败。请刷新状态查看，无需再次重试投递。') } }
    catch (error) { setError(error instanceof Error ? error.message : '重试失败') }
    finally { setBusy(false) }
  }
  async function remind(id: string) {
    if (busy || readRecovery) return
    setBusy(true); setError('')
    try { await api(`/notifications/${encodeURIComponent(id)}/remind`, json({})); setReadRecovery(true); notify('提醒已记录，同一事项、同一成员每天最多一次'); try { await load() } catch { setError('提醒已记录，状态刷新失败。请刷新状态查看，无需再次发送提醒。') } }
    finally { setBusy(false) }
  }
  return <div className="notifications-page">
    <PageHeader eyebrow="TEAM / NOTIFICATIONS" title="钉钉通知设置" description="按试点成员启用个人工作通知，分别查看投递、查看与确认情况。"
      actions={<button className="button secondary" disabled={busy} onClick={() => { setError(''); void load().catch(error => setError(error.message)) }}><RefreshCw size={16} />刷新状态</button>} />
    {error && <div className="error" role="alert">{error}</div>}
    {query.error && <div className="error" role="alert">状态读取失败：{query.error}。已确认的保存结果仍保留，请刷新状态。</div>}
    {!view ? <p role="status">正在读取通知设置…</p> : <>
      <div className="notification-config-status"><ShieldCheck size={22} /><div><strong>{view.configured ? '企业应用凭据已配置' : '企业应用尚未配置'}</strong>
        <p>{view.environmentEnabled ? '服务端允许外发；保存设置并选定试点成员后可启用。' : '服务端外发总开关未启用，当前仅记录站内消息。'}</p></div>
        <Badge tone={view.settings.externalEnabled && view.environmentEnabled && view.configured && !view.activationRequired ? 'green' : 'neutral'}>{view.activationRequired ? '新部署待确认' : view.settings.externalEnabled && view.environmentEnabled && view.configured ? '钉钉外发已启用' : '钉钉外发已暂停'}</Badge></div>
      {view.activationRequired && <p className="note">检测到新的部署环境。请核对试点成员，重新勾选启用并保存设置后开始外发。</p>}
      <section className="notification-settings-card"><div className="notification-section-heading"><Bell size={19} /><h2>发送范围与时段</h2></div>
        <Form key={`${view.settings.id}-${view.settings.version}`} submitLabel="保存通知设置" onSubmit={async event => {
          const form = new FormData(event.currentTarget)
          const pilotUserIds = form.getAll('pilotUserIds').map(String)
          const externalEnabled = form.has('externalEnabled')
          if (externalEnabled && !pilotUserIds.length) throw new Error('请至少选择一位试点成员。')
          await api('/notification-settings', json({ version: view.settings.version, externalEnabled, pilotUserIds,
            sendStartHour: Number(form.get('sendStartHour')), sendEndHour: Number(form.get('sendEndHour')) }, 'PUT'))
          notify('通知设置已保存')
        }}>
          <label className="checkbox-label"><input name="externalEnabled" type="checkbox" defaultChecked={view.settings.externalEnabled && !view.activationRequired} disabled={!view.configured || !view.environmentEnabled} />启用试点成员的钉钉个人工作通知</label>
          <p className="form-hint">开启后只通知生效范围内的新安排与有效提醒；关闭不影响站内消息、任务保存和周提报。</p>
          <div className="form-grid"><Field label="每日开始发送（北京时间）"><select name="sendStartHour" defaultValue={view.settings.sendStartHour}>{Array.from({ length: 24 }, (_, hour) => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></Field>
            <Field label="每日结束发送（北京时间）"><select name="sendEndHour" defaultValue={view.settings.sendEndHour}>{Array.from({ length: 24 }, (_, i) => i + 1).map(hour => <option key={hour} value={hour}>{String(hour).padStart(2, '0')}:00</option>)}</select></Field></div>
          <div className="field"><span>试点成员</span><DirectoryAccountPicker name="pilotUserIds" purpose="notification" multiple scope={`${scope}:notification:${view.settings.version}`} defaultSelectedIds={view.settings.pilotUserIds} renderAccount={user => {
            const bound = view.bindings.some(binding => binding.userId === user.id && binding.bound)
            return <Badge tone={bound ? 'green' : 'amber'}>{bound ? '已绑定' : '未绑定'}</Badge>
          }} /></div>
          <p className="form-hint">未绑定成员仍能查看站内消息；钉钉外发需其先完成本人身份绑定。平台凭据仅在服务端配置。</p>
        </Form>
      </section>
      <section className="notification-settings-card"><div className="notification-section-heading"><h2>最近投递记录</h2><span>{view.deliveries.length} 条</span></div>
        <p className="form-hint">“平台已受理”仍在等待发送结果。“结果未知”需先核实平台情况，不提供直接重发。</p>
        {view.deliveries.length ? <div className="notification-deliveries">{view.deliveries.map(delivery => <article key={delivery.id}>
          <div className="notification-delivery-title"><strong>{delivery.title}</strong><Badge tone={delivery.status === 'delivered' ? 'green' : ['failed', 'unknown'].includes(delivery.status) ? 'amber' : 'neutral'}>{deliveryLabels[delivery.status]}</Badge></div>
          <p>{directoryAccountName(people.get(delivery.recipientId))} · 已尝试 {delivery.attempts} 次 · {dateTime(delivery.updatedAt)}</p>
          <p>系统查看：{delivery.openedAt ? dateTime(delivery.openedAt) : '尚未查看'} · 确认接收：{delivery.acknowledgedAt ? dateTime(delivery.acknowledgedAt) : delivery.canAcknowledge ? '待本人确认' : '无需单独确认'}</p>
          {delivery.lastError && <p className="notification-delivery-error">{delivery.lastError}</p>}
          <div className="notification-status-actions">
            <button type="button" className="button secondary" disabled={busy} onClick={() => setPreview({ notificationId: delivery.notificationId, reminder: false })}>预览通知</button>
            {delivery.status === 'failed' && <button type="button" className="button secondary" disabled={busy || readRecovery} onClick={() => void retry(delivery.id)}>重试明确失败的投递</button>}
            {delivery.canAcknowledge && !delivery.acknowledgedAt && <button type="button" className="button secondary" disabled={busy || readRecovery} onClick={() => setPreview({ notificationId: delivery.notificationId, reminder: true })}>提醒本人确认</button>}
          </div>
          {delivery.status === 'unknown' && <small>平台是否受理尚不确定，请先核实，避免重复通知。</small>}
        </article>)}</div> : <Empty title="暂无钉钉投递记录" description="配置并启用试点后，可在这里核对发送结果。" />}
      </section>
    </>}
    <CollaborationSettingsPanel data={data} notify={notify} refresh={refresh} />
    <NativeCapabilities data={data} notify={notify} refresh={refresh} />
    <NotificationDiagnostics scope={scope} />
    <UsageAnalyticsPanel data={data} notify={notify} refresh={refresh} />
    {preview && <NotificationPreview key={`${preview.notificationId}-${preview.reminder}`} request={preview} onClose={() => setPreview(null)} onSend={remind} />}
  </div>
}
