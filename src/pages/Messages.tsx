import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowRight, Bell, CheckCheck, CheckCircle2, RefreshCw, Settings2 } from 'lucide-react'
import type { NotificationTarget, NotificationView } from '../../shared/notifications'
import type { Navigate } from '../navigation'
import { api, ApiError, json } from '../api'
import { deliveryLabels, notificationNavigation } from '../notification-navigation'
import DingTalkBinding from '../components/DingTalkBinding'
import { Badge, Empty, PageHeader, dateTime, monday, type PageProps } from '../ui'

function sameTarget(left: NotificationTarget, right: NotificationTarget) {
  return left.type === right.type && left.id === right.id && left.kind === right.kind
}

const acknowledgementLabels = {
  pending: { text: '待本人确认', tone: 'amber' },
  acknowledged: { text: '已确认', tone: 'green' },
  superseded: { text: '安排已有更新', tone: 'amber' },
  not_required: { text: '仅供查看，无需确认', tone: 'neutral' },
} as const

type MessageFilter = 'all' | 'unread' | 'pending'
interface MessageQuery { filter: MessageFilter; cursor: string | null; previousCursors: (string | null)[] }
interface MessagePage {
  items: NotificationView[]; unreadCount: number; pendingCount: number; totalCount: number
  filteredCount: number; nextCursor: string | null
}

export function NotificationDetailContent({ notification, busy, onVisit, onOpenSource, onAcknowledge }: {
  notification: NotificationView; busy: boolean; onVisit: (target: NotificationTarget) => void
  onOpenSource: (id: string) => void; onAcknowledge: () => void
}) {
  const content = notification.content
  const isReminder = notification.kind === 'manual_reminder'
  const isFeedback = notification.targets.some(target => target.type === 'feedback') || notification.kind.startsWith('feedback_')
  const hasCompleteItemStates = content && content.items.length > 0 && content.items.every(item => item.acknowledgement)
    && (content.totalCount === undefined || content.totalCount <= content.items.length)
  const pendingCount = hasCompleteItemStates ? content.items.filter(item => item.acknowledgement === 'pending').length : null
  const canConfirm = !isFeedback && !isReminder && notification.canAcknowledge && !notification.acknowledgedAt && !notification.unavailable && !notification.supersededAt && pendingCount !== 0
  return <>
    <div className="row-meta"><Badge tone={notification.acknowledgedAt ? 'green' : 'neutral'}>{isFeedback ? '问题反馈' : notification.acknowledgedAt ? '已确认接收' : canConfirm ? '待确认接收' : '工作通知'}</Badge>
      {(notification.supersededAt || notification.contentUpdated) && <Badge tone="amber">安排已有更新</Badge>}</div>
    <h2>{content?.heading || notification.title}</h2><time dateTime={notification.eventTime || notification.createdAt}>通知发生于 {dateTime(notification.eventTime || notification.createdAt)}</time>
    {(notification.contentUpdated || notification.supersededAt) && <p className="note">当前事项已更新，历史通知仅供参照。请核对下方当前可见的安排及确认状态。</p>}
    {content ? <div className="notification-content">
      {content.intro && <p className="notification-content-intro">{content.intro}</p>}
      {content.items.map((item, index) => <article className="notification-content-item" key={`${item.target.type}-${item.target.id}-${index}`}>
        <h3>{item.title}</h3>
        {item.acknowledgement && <div className="row-meta"><Badge tone={acknowledgementLabels[item.acknowledgement].tone}>{acknowledgementLabels[item.acknowledgement].text}</Badge></div>}
        <ul>{item.lines.map((line, lineIndex) => <li key={lineIndex}>{line}</li>)}</ul>
      </article>)}
      {content.totalCount !== undefined && content.totalCount > content.items.length && <p className="notification-content-more">共 {content.totalCount} 项，另有 {content.totalCount - content.items.length} 项可通过下方事项入口查看。</p>}
      {content.footer && <p className="notification-content-footer">{content.footer}</p>}
    </div> : <p className="notification-body">{notification.body}</p>}
    <dl className="notification-facts"><div><dt>钉钉投递</dt><dd>{notification.deliveryStatus ? deliveryLabels[notification.deliveryStatus] : '仅站内消息'}</dd></div>
      <div><dt>系统查看</dt><dd>{notification.openedAt ? dateTime(notification.openedAt) : '尚未记录查看'}</dd></div>
      {(notification.actionable || isReminder) && !isFeedback && <div><dt>确认接收</dt><dd>{notification.acknowledgedAt ? dateTime(notification.acknowledgedAt) : isReminder && notification.sourceCanAcknowledge ? '请在原安排中确认' : canConfirm ? '等待本人确认' : '无需确认'}</dd></div>}</dl>
    {notification.unavailable ? <p className="note">该事项已变更或当前不可访问，请联系管理者核对安排。</p> : <>
      {isReminder && notification.sourceNotificationId && <div className="notification-source-action">
        <p>{notification.sourceCanAcknowledge ? '本消息提醒您核对原安排；进入原安排后可确认知悉。' : '原安排当前无需重复确认，可进入查看最新状态。'}</p>
        <button type="button" className="button primary" disabled={busy} onClick={() => onOpenSource(notification.sourceNotificationId!)}>{notification.sourceCanAcknowledge ? '查看并确认原安排' : '查看原安排'}<ArrowRight size={16} /></button>
      </div>}
      <div className="notification-targets">
        {notification.targets.map((target, index) => {
          const title = content?.items.find(item => sameTarget(item.target, target))?.title
          const label = target.type === 'feedback' ? title ? `查看反馈：${title}` : '查看反馈' : title ? `查看：${title}` : target.type === 'digest' ? '查看工作摘要' : target.type === 'followup' ? '查看进展与回应' : target.type === 'deadlineRequest' ? '查看延期申请' : target.type === 'report' ? '查看定稿报告' : target.type === 'weeklySubmission' ? target.kind === 'plan' ? '核对下周计划' : '核对本周完成情况' : target.type === 'summary' ? '查看周期提报' : target.type === 'plan' ? '查看月目标' : target.type === 'weeklyRecord' ? '查看周安排' : '查看任务'
          return <button key={`${target.type}-${target.id}-${index}`} type="button" className="button secondary" disabled={busy} onClick={() => onVisit(target)}>{label}<ArrowRight size={16} /></button>
        })}
      </div>
    </>}
    {canConfirm && <div className="notification-acknowledgement">
      <p>{pendingCount === null ? '本次仅确认本消息中仍待本人确认的当前安排。' : `本次仅确认本消息中仍待本人确认的 ${pendingCount} 项安排。`}不包括已确认、安排已有更新或仅供查看的协作事项。</p>
      <p>确认接收表示您已知悉安排。执行进展、完成状态和整份周提报需分别填写与提交。</p>
      {!notification.confirmationToken && <p>请刷新消息，核对最新安排后再确认。</p>}
      <button type="button" className="button primary" disabled={busy || !notification.confirmationToken} onClick={onAcknowledge}><CheckCircle2 size={17} />{pendingCount !== null && content && content.items.length > 1 ? `确认知悉 ${pendingCount} 项当前安排` : '确认接收安排'}</button>
    </div>}
    {notification.actionable && !isFeedback && <p className="notification-footnote">平台发送成功仅代表钉钉报告的发送结果；成员查看与确认在本系统中分别记录。</p>}
  </>
}

export default function Messages({ data, notify, intent, navigate, onUnreadChange, onSessionChanged }: PageProps & {
  navigate: Navigate; onUnreadChange: (count: number) => void; onSessionChanged: () => Promise<void>
}) {
  const [items, setItems] = useState<NotificationView[]>([])
  const [selected, setSelected] = useState<NotificationView | null>(null)
  const [query, setQuery] = useState<MessageQuery>({ filter: 'all', cursor: null, previousCursors: [] })
  const filter = query.filter
  const [counts, setCounts] = useState({ totalCount: 0, unreadCount: 0, pendingCount: 0, filteredCount: 0 })
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [displayedSequence, setDisplayedSequence] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const busyRef = useRef(false)
  const listSequence = useRef(0)
  const selectedSequence = useRef(0)
  const detailRequest = useRef(0)
  const detail = useRef<HTMLElement>(null)
  const inbox = useRef<HTMLElement>(null)
  const detailFocusRequested = useRef(false)
  const queryRef = useRef(query)
  queryRef.current = query
  const load = useCallback(async () => {
    const sequence = ++listSequence.current
    const currentQuery = queryRef.current
    const params = new URLSearchParams({ filter: currentQuery.filter, limit: '50' })
    if (currentQuery.cursor) params.set('cursor', currentQuery.cursor)
    setLoading(true)
    try {
      const result = await api<MessagePage>(`/notifications?${params}`)
      if (sequence !== listSequence.current) return
      setItems(result.items); setNextCursor(result.nextCursor)
      setCounts({ totalCount: result.totalCount, unreadCount: result.unreadCount, pendingCount: result.pendingCount, filteredCount: result.filteredCount })
      onUnreadChange(result.unreadCount)
    } catch (error) {
      if (sequence === listSequence.current) throw error
    } finally { if (sequence === listSequence.current) setLoading(false) }
  }, [onUnreadChange])
  useEffect(() => {
    let live = true
    setItems([]); setNextCursor(null); setError('')
    void load().catch(error => {
      if (!live) return
      if (error instanceof ApiError && error.status === 401) void onSessionChanged()
      else setError(error instanceof Error ? error.message : '消息读取失败，请刷新重试')
    })
    return () => { live = false; listSequence.current++ }
  }, [query, load, onSessionChanged])
  useEffect(() => () => { selectedSequence.current++; detailRequest.current++ }, [])
  useEffect(() => {
    if (intent?.id) void openMessage(intent.id, false)
    return () => { selectedSequence.current++ }
  }, [intent?.id])
  useEffect(() => {
    if (!selected) return
    const sequence = displayedSequence, id = selected.id, request = ++detailRequest.current
    // This runs after the selected detail has committed. GETs alone remain read-only.
    const frame = requestAnimationFrame(() => {
      if (sequence !== selectedSequence.current || request !== detailRequest.current) return
      if (detailFocusRequested.current) {
        detail.current?.scrollIntoView({ block: window.matchMedia('(max-width: 700px)').matches ? 'start' : 'nearest' })
        detail.current?.focus({ preventScroll: true })
      }
      void api<NotificationView>(`/notifications/${encodeURIComponent(id)}/open`, json({})).then(async opened => {
        if (sequence !== selectedSequence.current || request !== detailRequest.current) return
        setSelected(opened); await load()
      }).catch(error => {
        if (sequence !== selectedSequence.current || request !== detailRequest.current) return
        if (error instanceof ApiError && error.status === 401) void onSessionChanged()
        else setError(error instanceof Error ? error.message : '查看状态记录失败，请刷新后重试')
      })
    })
    return () => { cancelAnimationFrame(frame) }
  }, [selected?.id, displayedSequence, load])
  async function run(action: () => Promise<void>) {
    if (busyRef.current) return
    const sequence = selectedSequence.current
    busyRef.current = true; setBusy(true); setError('')
    try { await action() } catch (error) {
      if (sequence !== selectedSequence.current) return
      if (error instanceof ApiError && error.status === 401) await onSessionChanged()
      else setError(error instanceof Error ? error.message : '操作失败')
    }
    finally { busyRef.current = false; setBusy(false) }
  }
  async function openMessage(id: string, updateLocation = true) {
    const sequence = ++selectedSequence.current
    detailFocusRequested.current = true
    setSelected(null); setDetailLoading(true); setError('')
    try {
      const value = await api<NotificationView>(`/notifications/${encodeURIComponent(id)}`)
      if (sequence !== selectedSequence.current) return
      setSelected(value); setDisplayedSequence(sequence)
      const path = `/entry?notificationId=${encodeURIComponent(id)}`
      if (updateLocation && `${window.location.pathname}${window.location.search}` !== path) window.history.pushState(null, '', path)
    } catch (error) {
      if (sequence !== selectedSequence.current) return
      if (error instanceof ApiError && error.status === 401) await onSessionChanged()
      else setError(error instanceof Error ? error.message : '消息读取失败')
    } finally { if (sequence === selectedSequence.current) setDetailLoading(false) }
  }
  async function refreshSelected() {
    const sequence = selectedSequence.current, id = selected?.id
    const request = ++detailRequest.current
    await load()
    if (!id || sequence !== selectedSequence.current || request !== detailRequest.current) return
    const current = await api<NotificationView>(`/notifications/${encodeURIComponent(id)}`)
    if (sequence === selectedSequence.current && request === detailRequest.current) setSelected(current)
  }
  async function visit(target: NotificationTarget) {
    if (!selected || selected.unavailable) return
    const sequence = selectedSequence.current
    const request = ++detailRequest.current
    const opened = await api<NotificationView>(`/notifications/${encodeURIComponent(selected.id)}/open`, json({}))
    if (sequence !== selectedSequence.current || request !== detailRequest.current) return
    setSelected(opened); await load()
    if (sequence !== selectedSequence.current || request !== detailRequest.current) return
    // Recheck the latest permission-projected target before leaving this message.
    const current = opened.targets.find(item => item.type === target.type && item.id === target.id && item.kind === target.kind)
    if (!current || opened.unavailable) throw new Error('该事项当前不可访问，请刷新消息查看最新状态。')
    const destination = notificationNavigation(current)
    navigate(destination.page, destination.intent)
  }
  async function acknowledge() {
    if (!selected || selected.kind === 'manual_reminder' || !selected.confirmationToken) return
    const sequence = selectedSequence.current, id = selected.id
    const request = ++detailRequest.current
    try {
      const confirmed = await api<NotificationView>(`/notifications/${encodeURIComponent(id)}/acknowledge`, json({ confirmationToken: selected.confirmationToken }))
      if (sequence !== selectedSequence.current || request !== detailRequest.current) return
      setSelected(confirmed); await load()
      if (sequence === selectedSequence.current && request === detailRequest.current) notify('已确认接收安排，请继续处理业务事项')
    } catch (error) {
      if (sequence !== selectedSequence.current || request !== detailRequest.current) return
      if (!(error instanceof ApiError) || error.status !== 409) throw error
      setSelected(current => current?.id === id ? { ...current, confirmationToken: undefined } : current)
      setError('安排已更新或确认状态已变化，正在重新读取详情。请核对后再决定是否确认。')
      let current: NotificationView
      try { current = await api<NotificationView>(`/notifications/${encodeURIComponent(id)}`) }
      catch (refreshError) {
        if (refreshError instanceof ApiError && refreshError.status === 401) throw refreshError
        throw new Error('安排已更新，但最新详情暂时读取失败。请刷新消息后核对并重新确认。')
      }
      if (sequence !== selectedSequence.current || request !== detailRequest.current) return
      setError('安排已更新或确认状态已变化，已重新读取详情。请核对后再决定是否确认。')
      setSelected(current); await load()
    }
  }
  function changeQuery(next: MessageQuery) {
    listSequence.current++
    queryRef.current = next
    setQuery(next)
  }
  return <div className="notifications-page">
    <PageHeader eyebrow="WORK / MESSAGES" title="我的工作与消息" description="查看新安排、确认接收，继续处理周计划与正式提报。"
      actions={<><button className="button secondary" disabled={busy} onClick={() => void run(refreshSelected)}><RefreshCw size={16} />刷新</button>
        {data.user.role === 'manager' && <button className="button secondary" onClick={() => navigate('notification-settings')}><Settings2 size={16} />通知设置</button>}</>} />
    <div className="notification-shortcuts"><button onClick={() => navigate('weekly', { weekStart: monday(), ownerId: data.user.id })}><span>我的周计划</span><ArrowRight size={18} /></button>
      <button onClick={() => navigate('weekly', { action: 'review', cycleWeek: monday(), weekStart: monday(), kind: 'results' })}><span>核对本周完成情况</span><ArrowRight size={18} /></button>
      <button onClick={() => navigate('weekly', { action: 'review', cycleWeek: monday(), weekStart: monday(), kind: 'plan' })}><span>核对下周计划</span><ArrowRight size={18} /></button></div>
    {error && !selected && !detailLoading && <div className="error" role="alert">{error}</div>}
    <div className={`notification-workspace${selected || detailLoading ? ' has-selection' : ''}`}>
      <section ref={inbox} id="notification-inbox" tabIndex={-1} className="notification-inbox" aria-label="个人消息">
        <div className="notification-inbox-heading"><h2><Bell size={19} />消息</h2><button className="text-button" disabled={busy || loading || !counts.unreadCount} onClick={() => void run(async () => {
          await api('/notifications/open-all', json({})); await refreshSelected()
        })}><CheckCheck size={15} />全部标为已查看</button></div>
        <div className="tabs" role="group" aria-label="消息筛选">
          {([['all', '全部', counts.totalCount], ['unread', '未查看', counts.unreadCount], ['pending', '待确认', counts.pendingCount]] as const).map(([key, label, count]) =>
            <button key={key} className={filter === key ? 'selected' : ''} disabled={busy} onClick={() => changeQuery({ filter: key, cursor: null, previousCursors: [] })}>{label}<span>{count}</span></button>)}
        </div>
        {loading ? <p role="status" className="notification-loading">正在读取消息…</p> : items.length ? <div className="notification-list">
          {items.map(item => <button className={`notification-item ${!item.openedAt ? 'is-unread' : ''} ${selected?.id === item.id ? 'is-selected' : ''}`}
            key={item.id} disabled={busy} onClick={() => void openMessage(item.id)} aria-pressed={selected?.id === item.id}>
            <span className="notification-item-heading"><strong>{item.title}</strong>{!item.openedAt && <span className="notification-unread-dot" aria-label="未查看" />}</span>
            <span className="notification-excerpt">{item.body}</span>
            <span className="notification-item-meta"><time dateTime={item.createdAt}>{dateTime(item.createdAt)}</time><span>{item.acknowledgedAt ? '已确认接收' : item.canAcknowledge ? '待确认接收' : item.unavailable ? '事项不可访问' : item.openedAt ? '已查看' : '未查看'}</span></span>
          </button>)}</div> : !error && <Empty title={query.cursor ? '当前页没有匹配消息' : filter === 'pending' ? '没有待确认的安排' : filter === 'unread' ? '消息都已查看' : '暂无消息'} description={query.cursor ? '消息状态可能已变化，可返回上一页或重新选择筛选。' : '新安排、提报提醒和问题反馈会保存在这里。'} />}
        <div className="notification-targets" aria-label="消息分页" style={{ padding: '0 20px', alignItems: 'center' }}>
          <button type="button" className="button secondary" disabled={busy || loading || !query.previousCursors.length} onClick={() => changeQuery({ ...query, cursor: query.previousCursors.at(-1) ?? null, previousCursors: query.previousCursors.slice(0, -1) })}><ArrowLeft size={16} />上一页</button>
          <span role="status">第 {query.previousCursors.length + 1} 页 · 共 {counts.filteredCount} 条</span>
          <button type="button" className="button secondary" disabled={busy || loading || !nextCursor} onClick={() => nextCursor && changeQuery({ ...query, cursor: nextCursor, previousCursors: [...query.previousCursors, query.cursor] })}>下一页<ArrowRight size={16} /></button>
        </div>
      </section>
      <section ref={detail} tabIndex={-1} className="notification-detail" aria-label="消息详情" aria-busy={detailLoading}>
        {(selected || detailLoading) && <button type="button" className="button secondary notification-back-to-list" aria-controls="notification-inbox" onClick={() => {
          detailFocusRequested.current = false
          inbox.current?.scrollIntoView({ block: 'start' })
          inbox.current?.focus({ preventScroll: true })
        }}><ArrowLeft size={16} />返回消息列表</button>}
        {error && (selected || detailLoading) && <div className="error" role="alert">{error}</div>}
        {detailLoading ? <p role="status">正在读取消息详情…</p> : selected ? <NotificationDetailContent notification={selected} busy={busy}
          onVisit={target => void run(() => visit(target))} onOpenSource={id => void openMessage(id)} onAcknowledge={() => void run(acknowledge)} />
          : <Empty title="选择一条消息" description="查看安排详情、投递情况与本人确认记录。" />}
      </section>
    </div>
    <DingTalkBinding user={data.user} onSessionChanged={onSessionChanged} notify={notify} />
  </div>
}
