import { openTask } from '../navigation'
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import type { FollowupRequest } from '../../shared/collaboration'
import type { DigestItem, NotificationDigest } from '../../shared/collaboration-notifications'
import { api, ApiError, json, finishSaved, SavedResultError } from '../api'
import { LatestRead, StaleReadError } from '../latest-read'
import { captureMutationContext, MutationContextChangedError, subscribeMutationResponses } from '../mutation-response'
import { confirmMutation, type ConfirmedMutations } from '../workspace-response'
import { applyFollowupMutation, reconcileFollowupDashboard, type FollowupDashboard as Dashboard } from '../followup-response'
import { SavedRefresh, type SavedRefreshState } from '../saved-refresh'
import { assignmentAttempt, notificationNavigation, type SubmissionAttempt } from '../notification-navigation'
import type { Navigate } from '../navigation'
import { Badge, Empty, Field, Form, Modal, PageHeader, dateTime, nameOf, type PageProps } from '../ui'
import WorkTaskPanel from '../components/WorkTaskPanel'
import TaskProgressSummary from '../components/TaskProgressSummary'
import { PriorityBadge, WorkTypeBadge, TaskLegend, ContextHelp } from '../components/TaskSignals'
import { taskPriority, workKind } from '../task-presentation'
import '../collaboration.css'

interface BatchPreview { previewToken: string; dueAt: string; recipients: { recipientId: string; recipientName: string; externalQuotaAvailable: boolean; items: { taskId: string; title: string; taskDueDate: string; enrollRequired: boolean; existingRequest: FollowupRequest | null }[] }[] }
export default function WorkFollowups(props: PageProps & { navigate: Navigate }) {
  const { data, intent, notify, navigate } = props
  const [view, setView] = useState<Dashboard | null>(null), [error, setError] = useState(''), [selected, setSelected] = useState<string[]>([])
  const [taskId, setTaskId] = useState<string | null>(null), [filter, setFilter] = useState('all'), [query, setQuery] = useState('')
  const [batch, setBatch] = useState(false), [preview, setPreview] = useState<BatchPreview | null>(null), [payload, setPayload] = useState<Record<string, unknown> | null>(null)
  const [digest, setDigest] = useState<(NotificationDigest & { items: DigestItem[] }) | null>(null)
  const [loading, setLoading] = useState(false)
  const [saveState, setSaveState] = useState<SavedRefreshState>('idle')
  const savedRefresh = useRef<SavedRefresh | null>(null)
  if (!savedRefresh.current) savedRefresh.current = new SavedRefresh(setSaveState)
  const currentView = useRef<Dashboard | null>(null), mounted = useRef(true)
  const confirmedMutations = useRef<ConfirmedMutations>({})
  const dashboardRead = useRef<LatestRead<Dashboard> | null>(null)
  if (!dashboardRead.current) dashboardRead.current = new LatestRead({
    load: signal => api<Dashboard>('/collaboration', { signal }),
    accept: next => {
      const result = reconcileFollowupDashboard(currentView.current, next, confirmedMutations.current)
      const value = result.value
      currentView.current = value; setView(value)
      const ids = new Set(value.tasks.map(row => row.task.id))
      setSelected(old => old.filter(id => ids.has(id)))
      setTaskId(old => old && ids.has(old) ? old : null)
      if (result.stale) throw new StaleReadError()
    },
    error: failure => {
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) {
        currentView.current = null; confirmedMutations.current = {}; setView(null)
        if (failure.status === 401) window.dispatchEvent(new Event('workspace-login-expired'))
      }
      setError(failure instanceof Error ? failure.message : failure ? '工作事项读取失败' : '')
    },
    loading: setLoading,
  })
  const attempt = useRef<SubmissionAttempt | null>(null), previewSequence = useRef(0), digestSequence = useRef(0), manager = data.user.role === 'manager'
  async function openDigest(id: string) {
    const sequence = ++digestSequence.current, context = captureMutationContext()
    const current = () => mounted.current && context === captureMutationContext() && sequence === digestSequence.current
    try { const row = await api<NotificationDigest & { items: DigestItem[] }>(`/digests/${encodeURIComponent(id)}`); if (current()) setDigest(row) }
    catch (e) { if (current()) setError(e instanceof Error ? e.message : '摘要读取失败') }
  }
  const load = useCallback(() => mounted.current ? dashboardRead.current!.read() : Promise.reject(new MutationContextChangedError()), [])
  useEffect(() => {
    mounted.current = true
    currentView.current = null; confirmedMutations.current = {}; setView(null)
    void load().catch(() => {})
    const unsubscribe = subscribeMutationResponses(event => {
      if (!mounted.current || event.context !== captureMutationContext()) return
      dashboardRead.current!.invalidate()
      confirmedMutations.current = confirmMutation(confirmedMutations.current, event.value)
      const previous = currentView.current
      if (previous) {
        const next = applyFollowupMutation(previous, event.path, event.value)
        currentView.current = next; setView(next)
      }
      void load().catch(() => {})
    }, () => {
      dashboardRead.current!.reset(); savedRefresh.current!.reset(mounted.current); currentView.current = null; confirmedMutations.current = {}
      previewSequence.current++; digestSequence.current++
      if (mounted.current) { setView(null); setDigest(null); setPreview(null); setPayload(null); setSelected([]); setTaskId(null); setBatch(false); setError(''); setLoading(false) }
    })
    return () => { mounted.current = false; unsubscribe(); dashboardRead.current!.reset(); savedRefresh.current!.reset(false); previewSequence.current++; digestSequence.current++ }
  }, [load, data.user.id, data.user.role, data.operationEpoch])
  useEffect(() => {
    if (!intent?.id) return
    let live = true
    const context = captureMutationContext()
    if (intent.targetType === 'digest') void openDigest(intent.id)
    else void api<{ taskId: string }>(`/collaboration/resolve/${intent.targetType || 'task'}/${encodeURIComponent(intent.id)}`).then(row => { if (live && context === captureMutationContext()) ('blockerId' in row && 'minimalContext' in row && row.minimalContext ? window.dispatchEvent(new CustomEvent('workspace-open-support',{detail:row.blockerId})) : openTask({taskId:row.taskId,section:intent.targetType==='blocker'||intent.targetType==='decisionRequest'?'support':'followups'})) }).catch(e => { if (live && context === captureMutationContext()) setError(e.message) })
    return () => { live = false; digestSequence.current++ }
  }, [intent?.id, intent?.targetType, data.user.id])
  async function saveDashboard(path: string, body: Record<string, unknown>, message: string, method = 'POST', onSaved?: () => void) {
    const context = captureMutationContext()
    attempt.current = assignmentAttempt(attempt.current, body)
    try { await savedRefresh.current!.run(async () => {
      await api(path, json({ ...body, requestId: attempt.current!.requestId }, method))
      attempt.current = null; onSaved?.()
    }, () => finishSaved(async () => {
      if (!mounted.current || context !== captureMutationContext()) throw new MutationContextChangedError()
      await load()
      if (!mounted.current || context !== captureMutationContext()) throw new MutationContextChangedError()
      notify(message)
    })) } catch (failure) {
      // The page keeps the receipt even after the submitting Form is replaced or closed.
      if (!(failure instanceof SavedResultError)) throw failure
    }
  }
  const rows = (view?.tasks || []).filter(row => (!query || row.task.title.toLowerCase().includes(query.toLowerCase())) && (filter === 'all' || filter === 'unfinished' && row.task.status !== 'done' || filter === 'done' && row.task.status === 'done' || filter === 'risk' && view!.risks.some(r => r.taskId === row.task.id) || filter === 'followup' && row.openFollowup || filter === row.tracking?.state))
  return <div className="collaboration-page">
    <PageHeader eyebrow="WORK / FOLLOW-UP" title={manager ? '进展与催办' : '我的进展与回应'} description={manager ? '聚焦关键任务，及时回应风险与阻塞。' : '更新任务进展，集中处理待回应事项。'} actions={<><button className="button secondary" aria-busy={loading} onClick={() => { void load().catch(() => {}) }}><RefreshCw size={16} />刷新</button>{manager && <button className="button secondary" onClick={() => navigate('notification-settings')}>协作设置</button>}</>} />
    {saveState !== 'idle' && <div className="note" role="status"><p>{saveState === 'saving' ? '正在保存，请稍候。' : saveState === 'failed' ? '内容已经保存，但刷新失败。无需重复提交，请重新加载已保存结果。' : '内容已保存，正在重新读取结果。'}</p>{saveState === 'failed' && <button className="button primary" type="button" onClick={() => { void savedRefresh.current!.retry().catch(() => {}) }}>重新加载已保存结果</button>}</div>}
    <fieldset className="form-fields" disabled={saveState !== 'idle'}>
    {error && <div className="error" role="alert">{error}</div>}
    {!view ? !error && <p role="status">正在读取工作事项…</p> : <>
      {!view.settings.enabled && <p className="note">进展与催办尚未启用。管理员可在通知设置中选择试点成员、管理接收人和提醒规则。</p>}
      {!manager && view.settings.memberActionsEnabled && <details className="notification-settings-card"><summary>可选行动摘要</summary><Form key={view.preference.version} submitLabel="保存我的摘要偏好" onSubmit={async e => { const f = new FormData(e.currentTarget), body = { version: view.preference.version, memberActionsEnabled: f.has('memberActionsEnabled') }; await saveDashboard('/collaboration/preferences', body, '摘要偏好已保存', 'PUT') }}><label className="checkbox-label"><input name="memberActionsEnabled" type="checkbox" defaultChecked={view.preference.memberActionsEnabled} />接收我的下一步行动摘要</label><p className="form-hint">此偏好只影响可选摘要。工作安排、本人待回应的催办和正式提报要求仍可在系统查看。</p></Form></details>}
      <div className="collaboration-summary"><span><strong>{view.risks.length}</strong>项风险</span><span><strong>{view.tasks.filter(r => r.openFollowup).length}</strong>项待回应</span><span><strong>{view.tasks.filter(r => r.tracking?.state === 'active').length}</strong>项督办中</span><span><strong>{view.tasks.filter(r => r.tracking?.state === 'paused').length}</strong>项已暂停</span></div>
      <p className="collaboration-scope-note">全部周期 · {view.tasks.length} 项任务 · {view.tasks.filter(row => row.task.status !== 'done').length} 项整体未完成</p>
      <ContextHelp title="任务范围与完成状态说明">
        <p>{manager ? '全体成员' : '本人'}的跨周期任务总台账，包含历史任务和已完成任务，不限本周或本月。</p>
        <p>周执行完成代表当周安排完成，不会自动把整个任务标为完成。</p>
      </ContextHelp>
      <div className="collaboration-toolbar"><Field label="搜索工作事项"><input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="输入任务标题" /></Field><Field label="筛选范围"><select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">全部周期（含已完成）</option><option value="unfinished">整个任务未完成</option><option value="done">整个任务已自报完成</option><option value="risk">有当前风险</option><option value="followup">待回应催办</option><option value="active">督办中</option><option value="paused">督办已暂停</option></select></Field>{manager && <button className="button primary" disabled={!selected.length || !view.settings.enabled} onClick={() => { setPreview(null); setBatch(true) }}>催办所选 {selected.length ? `(${selected.length})` : ''}</button>}</div>
      <TaskLegend />
      {rows.length ? <div className="collaboration-list">{rows.map(row => {
        const plan = data.plans.find(item => item.id === row.task.monthlyPlanId)
        const priority = taskPriority(row.task, plan)
        const isTemporary = !!(row.task.isTemporary || row.task.temporaryReason?.trim() || plan?.isTemporary)
        const kind = workKind({ isTemporary, monthlyPlanId: row.task.monthlyPlanId })
        return <article key={row.task.id} className={`collaboration-row task-priority-${priority || 'none'} task-kind-${kind}`}>
          <div className="row-meta">
            <PriorityBadge priority={priority} />
            <WorkTypeBadge isTemporary={isTemporary} monthlyPlanId={row.task.monthlyPlanId} />
            <Badge tone={row.tracking?.state === 'active' ? 'blue' : 'neutral'}>{row.tracking ? ({ active: '督办中', paused: '已暂停', closed: '已结束' })[row.tracking.state] : '未纳入督办'}</Badge>
          </div>
          <div className="collaboration-row-heading">
            {manager && <input aria-label={`选择 ${row.task.title}`} type="checkbox" checked={selected.includes(row.task.id)} onChange={e => setSelected(old => e.target.checked ? [...old, row.task.id] : old.filter(id => id !== row.task.id))} />}
            <button className="text-button" onClick={() => openTask({taskId:row.task.id,section:'followups'})}>{row.task.title}</button>
          </div>
          <p>{nameOf(data, row.task.ownerId)} · 截止 {row.task.dueDate || '未设置'}</p>
          <TaskProgressSummary task={row.task} weeklySummary={row.weeklySummary} overallStatusNeedsConfirmation={row.overallStatusNeedsConfirmation} />
          {row.openFollowup && <p>待回应：{row.openFollowup.requirement} · 回应期限 {dateTime(row.openFollowup.dueAt)}</p>}
          <div className="collaboration-risk-tags">{view.risks.filter(risk => risk.taskId === row.task.id).map(risk => <Badge key={risk.key} tone="amber">{risk.detail}</Badge>)}</div>
          <button className="button secondary" onClick={() => openTask({taskId:row.task.id,section:'followups'})}>{row.openFollowup && row.task.ownerId === data.user.id ? '更新进展并回应' : '查看进展与处理'}</button>
        </article>
      })}</div> : <Empty title="没有符合筛选的工作事项" description="任务发布或纳入督办后，可在这里更新进展和处理催办。" />}
      <section className="notification-settings-card"><h2>我的工作摘要</h2>{view.digests.length ? <div className="collaboration-digests">{view.digests.map(row => <button className="button secondary" key={row.id} onClick={() => { void openDigest(row.id) }}>{dateTime(row.generatedAt)} · {({ risk_member: '工作风险提醒', risk_manager: '管理风险摘要', critical_manager: '重要变化', approval_manager: '待办审批', daily_manager: '每日摘要', weekly_manager: '每周摘要', member_actions: '我的行动摘要', manual_followup: '工作催办' })[row.type]} · {row.itemIds.length} 项</button>)}</div> : <p>暂无摘要。启用相应规则后，摘要将按工作日生成。</p>}</section>
    </>}

    {batch && <Modal wide title="预览批量催办" onClose={() => { previewSequence.current++; setBatch(false) }}><Form submitLabel="生成预览" onSubmit={async e => { const sequence = ++previewSequence.current, context = captureMutationContext(); const f = new FormData(e.currentTarget), next = { taskIds: selected, requirement: String(f.get('requirement')), ...(f.get('dueAt') ? { dueAt: new Date(`${f.get('dueAt')}:00+08:00`).toISOString() } : {}), enroll: f.has('enroll') }; const result = await api<BatchPreview>('/followups/preview', json(next)); if (!mounted.current || context !== captureMutationContext() || sequence !== previewSequence.current) return; setPayload({ ...next, dueAt: result.dueAt }); setPreview(result) }}><div onChange={() => { previewSequence.current++; setPreview(null); setPayload(null) }}><Field label="希望负责人更新什么"><textarea name="requirement" required rows={3} /></Field><Field label="回应期限（北京时间，留空则下一个工作日 17:00）"><input type="datetime-local" name="dueAt" /></Field><label className="checkbox-label"><input name="enroll" type="checkbox" />将所选未跟踪任务明确纳入督办</label></div></Form>
      {preview && payload && <div className="collaboration-preview"><p>本次更新要求：{String(payload.requirement)}</p><p>将按 {preview.recipients.length} 位接收人合并通知，回应期限 {dateTime(preview.dueAt)}。</p>{preview.recipients.map(recipient => <article key={recipient.recipientId}><h3>{recipient.recipientName}</h3><p>{recipient.externalQuotaAvailable ? '按当前外发设置投递' : '今日提醒已达额度，保留站内事项'}</p>{recipient.items.map(item => <p key={item.taskId}>{item.title} · 原截止 {item.taskDueDate}{item.existingRequest ? ' · 已有待回应催办，将复用' : ''}{item.enrollRequired ? ' · 需纳入督办' : ''}</p>)}</article>)}<Form submitLabel="确认发起催办" onSubmit={async () => { const body = { ...payload, previewToken: preview.previewToken }; await saveDashboard('/followups/batch', body, '催办已保存，按接收人合并通知', 'POST', () => { setBatch(false); setSelected([]) }) }}><p className="form-hint">不会改写任务截止时间。已有催办不会重复新建；收到回应后会结束该催办。</p></Form></div>}
    </Modal>}
    {digest && <Modal wide title="工作摘要详情" onClose={() => { digestSequence.current++; setDigest(null) }}><p>{dateTime(digest.generatedAt)} · 内容按当前权限展示</p>{manager && digest.statistics?.length ? <p>周期统计（含本期已回告事实）：{digest.statistics.map(item => `${item.label} ${item.value}`).join("；")}</p> : null}{digest.items.length ? digest.items.map(item => <article className="collaboration-history" key={item.id}><h3>{item.title}</h3>{item.lines.map((line, index) => <p key={index}>{line}</p>)}<button className="button secondary" onClick={() => { const destination = notificationNavigation(item.target); setDigest(null); if (item.taskId) openTask({taskId:item.taskId,section:'overview'}); else navigate(destination.page, destination.intent) }}>查看当前事项</button></article>) : <p>摘要所含事项已删除、转交或当前无权访问。</p>}</Modal>}
    </fieldset>
  </div>
}
