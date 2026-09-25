import { useEffect, useRef, useState } from 'react'
import type { DeliveryCursor, NotificationDiagnostics as View } from '../../shared/notification-diagnostics'
import DirectoryAccountPicker from './DirectoryAccountPicker'
import { api, json } from '../api'
import { deliveryLabels } from '../notification-navigation'
import { dateTime } from '../ui'

export default function NotificationDiagnostics({ scope }: { scope: string }) {
  const [view, setView] = useState<View>(), [error, setError] = useState(''), [busy, setBusy] = useState(false)
  const [status, setStatus] = useState(''), [recipient, setRecipient] = useState(''), [kind, setKind] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState('')
  const [cursor, setCursor] = useState<DeliveryCursor>(), [revision, setRevision] = useState(0)
  const [sentRetries, setSentRetries] = useState<string[]>([])
  const sequence = useRef(0)
  useEffect(() => {
    const current = ++sequence.current, controller = new AbortController()
    setBusy(true); setError('')
    const params = new URLSearchParams({ limit: '50' })
    for (const [key, value] of [['status', status], ['recipientId', recipient], ['kind', kind]]) if (value.trim()) params.set(key, value.trim())
    if (from) params.set('from', new Date(`${from}T00:00:00+08:00`).toISOString())
    if (to) params.set('to', new Date(`${to}T23:59:59.999+08:00`).toISOString())
    if (cursor) { params.set('cursorCreatedAt', cursor.createdAt); params.set('cursorId', cursor.id) }
    void api<View>(`/notification-diagnostics?${params}`, { signal: controller.signal }).then(result => { if (current === sequence.current) { setView(result); setSentRetries([]) } }).catch(error => {
      if (current === sequence.current && !controller.signal.aborted) setError(error instanceof Error ? error.message : '诊断读取失败')
    }).finally(() => { if (current === sequence.current) setBusy(false) })
    return () => { controller.abort(); sequence.current++ }
  }, [status, recipient, kind, from, to, cursor, revision, scope])
  useEffect(() => { setView(undefined); setCursor(undefined); setRecipient(''); setSentRetries([]); setError('') }, [scope])
  function filter(setter: (value: string) => void, value: string) { setCursor(undefined); setView(undefined); setter(value) }
  async function retry(id: string) {
    if (busy || sentRetries.includes(id)) return
    setBusy(true); setError('')
    try { await api(`/notification-deliveries/${encodeURIComponent(id)}/retry`, json({})); setSentRetries(old => [...old, id]); setRevision(value => value + 1) }
    catch (error) { setError(error instanceof Error ? error.message : '重试失败'); setBusy(false) }
  }
  return <section className="notification-settings-card" aria-label="通知运行诊断">
    <div className="notification-section-heading"><h2>通知运行诊断</h2><button className="button secondary" disabled={busy} onClick={() => setRevision(value => value + 1)}>刷新诊断</button></div>
    <p className="form-hint">可查询全部历史投递。计数覆盖当前筛选结果；结果未知仅供核查，不提供重发。</p>
    <div className="form-grid">
      <label className="field"><span>投递状态</span><select value={status} onChange={event => filter(setStatus, event.target.value)}><option value="">全部状态</option>{Object.entries(deliveryLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <DirectoryAccountPicker name="diagnosticRecipient" purpose="diagnostics" scope={scope} allowEmpty label="筛选成员" onChange={ids => filter(setRecipient, ids[0] ?? '')} />
      <label className="field"><span>通知类型</span><input value={kind} placeholder="如 work_assigned" maxLength={100} onChange={event => filter(setKind, event.target.value)} /></label>
      <label className="field"><span>开始日期</span><input type="date" value={from} onChange={event => filter(setFrom, event.target.value)} /></label>
      <label className="field"><span>结束日期</span><input type="date" value={to} onChange={event => filter(setTo, event.target.value)} /></label>
    </div>
    {error && <p className="error" role="alert">{error}</p>}
    {!!sentRetries.length && <p className="note">重试已提交，正在等待最新状态。读取失败时请刷新诊断，无需再次提交。</p>}
    {busy && <p role="status">正在读取诊断…</p>}
    {view && <>
      <p>匹配 {view.total} 条 · {Object.entries(view.counts).map(([key, value]) => `${deliveryLabels[key as keyof typeof deliveryLabels] ?? key} ${value}`).join(' · ')}</p>
      <details><summary>运行健康与备份</summary>
        <p>投递进程最近完成：{view.health.worker.completedAt ? dateTime(view.health.worker.completedAt) : '尚无记录'}；调度最近完成：{view.health.scheduler.completedAt ? dateTime(view.health.scheduler.completedAt) : '尚无记录'}</p>
        <p>有效成员绑定：{view.health.bindings.boundMembers} / {view.health.bindings.usableMembers}；数据盘使用：{view.health.diskUsedPercent === null ? '无法读取' : `${view.health.diskUsedPercent}%`}；回调待处理：{view.health.callbackBacklog}</p>
        <p>本地备份校验：{view.health.backup.verifiedAt ? dateTime(view.health.backup.verifiedAt) : '待配置或校验'}；异机副本校验：{view.health.backup.offsiteVerifiedAt ? dateTime(view.health.backup.offsiteVerifiedAt) : '待配置或校验'}；隔离恢复演练：{view.health.backup.restoredAt ? dateTime(view.health.backup.restoredAt) : '尚未完成'}</p>
        {view.health.alerts.length ? <ul>{view.health.alerts.map(alert => <li key={alert}>{alert}</li>)}</ul> : <p>当前未触发诊断阈值。</p>}
      </details>
      <div className="notification-deliveries">{view.items.map(item => <article key={item.id}><div className="notification-delivery-title"><strong>{item.recipientName} · {deliveryLabels[item.status]}</strong><small>{item.kind}</small></div>
        <p>{dateTime(item.createdAt)} · 尝试 {item.attempts} 次</p><p>{item.reason}{item.nextAttemptAt ? ` · 下一处理时间：${dateTime(item.nextAttemptAt)}` : ''}</p>
        <small>记录：{item.id}</small>
        {item.status === 'failed' && <button className="button secondary" disabled={busy || sentRetries.includes(item.id)} onClick={() => void retry(item.id)}>重试明确失败的投递</button>}
      </article>)}</div>
      {!view.items.length && <p>当前筛选没有投递记录。</p>}
      <div className="notification-status-actions"><button className="button secondary" disabled={busy || !cursor} onClick={() => setCursor(undefined)}>返回第一页</button><button className="button secondary" disabled={busy || !view.nextCursor} onClick={() => { if (view.nextCursor) setCursor(view.nextCursor) }}>下一页</button></div>
    </>}
  </section>
}
