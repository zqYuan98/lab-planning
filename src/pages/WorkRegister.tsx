import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, CalendarDays, FileText, Plus, RefreshCw, Search, ListTodo, SignalHigh, Clock3, LifeBuoy, SlidersHorizontal, X } from 'lucide-react'
import type { Task } from '../../shared/types'
import { isEffectiveWeeklyRecord } from '../../shared/weekly-record-state'
import {
  buildWorkRegister,
  createWorkRegisterSnapshot,
  workRegisterToday,
  workRegisterViewLabels,
  type WorkRegisterView,
} from '../../shared/work-register'
import type { Navigate } from '../navigation'
import { Badge, Empty, type PageProps } from '../ui'
import WorkRegisterCapture from '../components/WorkRegisterCapture'
import WorkRegisterEditor from '../components/WorkRegisterEditor'
import WorkRegisterReport from '../components/WorkRegisterReport'
import { ContextHelp, PriorityBadge, TaskLegend, WorkTypeBadge } from '../components/TaskSignals'
import { priorityLabels, priorityRank, taskPriority, workKind, workKindLabels, type TaskPriority, type WorkKind } from '../task-presentation'
import '../work-register.css'

type RegisterSnapshot = ReturnType<typeof createWorkRegisterSnapshot>
const statusTones = { todo: 'neutral', doing: 'blue', blocked: 'amber', done: 'green' }

export default function WorkRegister({ data, refresh, notify, navigate }: PageProps & { navigate: Navigate }) {
  const [view, setView] = useState<WorkRegisterView>('active')
  const [query, setQuery] = useState('')
  const [priority, setPriority] = useState<TaskPriority | ''>('')
  const [kind, setKind] = useState<WorkKind | ''>('')
  const [capture, setCapture] = useState(false)
  const [editing, setEditing] = useState<Task | null>(null)
  const [report, setReport] = useState<RegisterSnapshot | null>(null)
  const [savedTasks, setSavedTasks] = useState<Task[]>([])
  const [refreshError, setRefreshError] = useState('')
  const [refreshing, setRefreshing] = useState(false)
  const [today, setToday] = useState(workRegisterToday)
  useEffect(() => {
    const updateDate = () => setToday(workRegisterToday())
    const onVisibility = () => { if (document.visibilityState === 'visible') updateDate() }
    const timer = window.setInterval(updateDate, 60_000)
    window.addEventListener('focus', updateDate)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('focus', updateDate)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [])
  const currentData = useMemo(() => {
    const tasks = new Map(data.tasks.map(task => [task.id, task]))
    for (const task of savedTasks) if (!tasks.has(task.id) || tasks.get(task.id)!.version < task.version) tasks.set(task.id, task)
    return { ...data, tasks: [...tasks.values()] }
  }, [data, savedTasks])
  const result = useMemo(() => buildWorkRegister(currentData, { view, query, today }), [currentData, view, query, today])
  const plansById = useMemo(() => new Map(currentData.plans.map(plan => [plan.id, plan])), [currentData.plans])
  function signals(row: typeof result.rows[number]) {
    const plan = row.kind === 'plan' ? row.plan : plansById.get(row.task.monthlyPlanId ?? '')
    const task = row.kind === 'task' ? row.task : undefined
    const type = { isTemporary: !!(task?.isTemporary || task?.temporaryReason?.trim() || plan?.isTemporary), monthlyPlanId: task?.monthlyPlanId, isMonthly: row.kind === 'plan' }
    return { priority: taskPriority(task, plan), kind: workKind(type), type }
  }
  const visibleRows = result.rows.filter(row => {
    const signal = signals(row)
    return (!priority || signal.priority === priority) && (!kind || signal.kind === kind)
  }).sort((a, b) => priorityRank[signals(a).priority ?? 'none'] - priorityRank[signals(b).priority ?? 'none'] || (a.dueDate || '9999').localeCompare(b.dueDate || '9999'))
  const activeRows = useMemo(() => buildWorkRegister(currentData, { view: 'active', today }).rows, [currentData, today])
  const highCount = activeRows.filter(row => signals(row).priority === 'high').length
  function selectView(next: WorkRegisterView) { setView(next); setQuery(''); setPriority(''); setKind('') }
  function previewReport() {
    const snapshot = createWorkRegisterSnapshot({ ...result, rows: visibleRows })
    // Preview/export must describe exactly the same subset and inherited priority as the list.
    setReport({ ...snapshot, rangeLabel: [snapshot.rangeLabel, priority && priorityLabels[priority], kind && workKindLabels[kind]].filter(Boolean).join(' · '),
      rows: snapshot.rows.map((row, index) => ({ ...row, priority: signals(visibleRows[index]).priority ? priorityLabels[signals(visibleRows[index]).priority!] : '未注明' })) })
  }

  async function reload() {
    setRefreshing(true)
    try {
      await refresh()
      setRefreshError('')
    } catch (e) {
      setRefreshError(`事项已经保存；完整清单刷新失败，可稍后重试。${e instanceof Error ? ` ${e.message}` : ''}`)
    } finally {
      setRefreshing(false)
    }
  }

  function receiveSaved(tasks: Task[]) {
    setSavedTasks(previous => {
      const map = new Map(previous.map(task => [task.id, task]))
      for (const task of tasks) map.set(task.id, task)
      return [...map.values()]
    })
    setCapture(false)
    setEditing(null)
    notify(tasks.length === 1 ? '工作事项已保存' : `已记录 ${tasks.length} 件工作事项`)
    void reload()
  }

  return <div className="wr-page">
    <header className="wr-hero">
      <div className="wr-hero-main">
        <span className="wr-hero-mark" aria-hidden="true"><ListTodo size={27} /></span>
        <div className="wr-hero-copy">
          <h1>我的工作清单</h1>
          <p>看清优先级，专注下一步。</p>
        </div>
      </div>
      <div className="wr-hero-actions">
        <button type="button" className="button secondary wr-report-action" onClick={previewReport}><FileText size={17} />汇报进度</button>
        <button type="button" className="button primary wr-create-action" onClick={() => setCapture(true)}><Plus size={18} />新建任务</button>
      </div>
    </header>

    <section className="wr-summary" aria-label="本人工作概况">
      <button type="button" data-tone="blue" aria-pressed={view === 'active' && !priority && !kind} className={view === 'active' && !priority && !kind ? 'is-selected' : ''} onClick={() => selectView('active')}>
        <span className="wr-summary-heading"><span className="wr-summary-icon"><ListTodo size={18} /></span><span>在手事项</span><ArrowRight className="wr-summary-arrow" size={16} /></span>
        <strong>{result.counts.active}<small>件</small></strong><p>持续推进的工作</p>
      </button>
      <button type="button" data-tone="red" aria-pressed={view === 'active' && priority === 'high'} className={view === 'active' && priority === 'high' ? 'is-selected' : ''} onClick={() => { selectView('active'); setPriority('high') }}>
        <span className="wr-summary-heading"><span className="wr-summary-icon"><SignalHigh size={18} /></span><span>高优先级</span><ArrowRight className="wr-summary-arrow" size={16} /></span>
        <strong>{highCount}<small>件</small></strong><p>优先关注与处理</p>
      </button>
      <button type="button" data-tone="amber" aria-pressed={view === 'unscheduled'} className={view === 'unscheduled' ? 'is-selected' : ''} onClick={() => selectView('unscheduled')}>
        <span className="wr-summary-heading"><span className="wr-summary-icon"><Clock3 size={18} /></span><span>待安排</span><ArrowRight className="wr-summary-arrow" size={16} /></span>
        <strong>{result.counts.unscheduled}<small>件</small></strong><p>尚无后续周安排</p>
      </button>
      <div data-tone="purple" className="wr-summary-coordination">
        <span className="wr-summary-heading"><span className="wr-summary-icon"><LifeBuoy size={18} /></span><span>待协调</span></span>
        <strong>{result.counts.coordination}<small>件</small></strong><p>反馈、决策与支持</p>
      </div>
    </section>

    {refreshError && <div className="wr-refresh-note" role="status"><p>{refreshError}</p><button className="button secondary" disabled={refreshing} onClick={() => { void reload() }}><RefreshCw size={15} className={refreshing ? 'spin' : ''} />{refreshing ? '刷新中…' : '重试刷新'}</button></div>}
    {result.counts['completion-review'] > 0 && <div className="wr-refresh-note"><p>有 {result.counts['completion-review']} 件旧导入事项缺少整件任务完成说明，已保留在在手清单中，请核对是否仍需推进。</p><button className="button secondary" onClick={() => selectView('completion-review')}>核对整体完成</button></div>}

    <section className="wr-workspace" aria-label="工作事项">
      <div className="wr-toolbar">
        <div className="wr-view-tabs" role="group" aria-label="查看范围">{(Object.keys(workRegisterViewLabels) as WorkRegisterView[]).map(key => <button key={key} aria-pressed={view === key} className={view === key ? 'is-selected' : ''} onClick={() => setView(key)}>{workRegisterViewLabels[key]}<span>{result.counts[key]}</span></button>)}</div>
        <label className="wr-search"><Search size={16} /><span className="wr-sr-only">搜索我的工作事项</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索事项、交办人或进展" /></label>
      </div>
      <div className="wr-signal-filters"><SlidersHorizontal size={14} aria-hidden="true" /><label><span className="wr-sr-only">筛选优先级</span><select aria-label="筛选优先级" value={priority} onChange={event => setPriority(event.target.value as typeof priority)}><option value="">全部优先级</option><option value="high">高优先级</option><option value="medium">中优先级</option><option value="low">低优先级</option></select></label><label><span className="wr-sr-only">筛选工作类型</span><select aria-label="筛选工作类型" value={kind} onChange={event => setKind(event.target.value as typeof kind)}><option value="">全部类型</option><option value="monthly">月度计划</option><option value="temporary">临时任务</option><option value="routine">日常任务</option></select></label>{(priority || kind) && <button className="wr-filter-clear" onClick={() => { setPriority(''); setKind('') }}><X size={13} />清除筛选</button>}<TaskLegend /></div>
      <div className="wr-list-caption"><span>{data.user.name}的{workRegisterViewLabels[view]}<b aria-live="polite">{visibleRows.length} 件</b>{query.trim() && <small>含关键词「{query.trim()}」</small>}</span><span>优先级 → 截止日期</span></div>
      {visibleRows.length ? <div className="wr-list">{visibleRows.map(row => {
        const signal = signals(row)
        if (row.kind === 'plan') {
          const plan = row.plan
          const archived = !!plan.projectId && data.projects.some(project => project.id === plan.projectId && project.status === 'archived')
          return <article className={`wr-item wr-plan-item task-priority-${signal.priority ?? 'none'} task-kind-${signal.kind}${row.isOverdue ? ' is-overdue' : ''}`} key={`plan:${row.id}`}>
            <div className="wr-item-main">
              <div className="wr-item-badges"><PriorityBadge priority={signal.priority} /><WorkTypeBadge {...signal.type} /><Badge tone={plan.status === 'published' ? 'green' : 'amber'}>{row.displayStatus}</Badge>{row.isOverdue && <span className="wr-overdue">已逾期</span>}</div>
              <button className="wr-item-title" onClick={() => navigate('monthly', { id: plan.id, month: plan.month })}>{plan.title}</button>
              <div className="wr-item-meta"><span>{plan.month}</span><span>{row.sourceLabel}{row.assignedBy ? ` · ${row.assignedBy}` : ''}</span><span>截止 {plan.dueDate || '待确认'}</span></div>
              {plan.expectedOutcome && <ContextHelp title="预期交付"><p>{plan.expectedOutcome}</p>{plan.importSource && <p>已有计划导入</p>}</ContextHelp>}
            </div>
            <div className="wr-item-progress">
              <p><span>下一步</span>建立个人任务，安排本周执行。</p>
              {plan.actualOutcome && <p><span>目标成果进展</span>{plan.actualOutcome}</p>}
              {plan.status !== 'published' && <p className="wr-decision">目标尚未发布。可先建立任务、保存周草稿，发布后才能正式排周。</p>}
              {plan.temporaryReason && <ContextHelp title="临时说明"><p>{plan.temporaryReason}</p></ContextHelp>}
              {archived && <p className="wr-decision">所属项目已归档，请先协调恢复项目再建立任务。</p>}
            </div>
            <div className="wr-item-actions"><span className="wr-schedule">待建立个人任务</span><button className="button secondary" disabled={archived} onClick={() => navigate('monthly', { action: 'create-task', id: plan.id, month: plan.month, weekStart: result.weekStart })}><CalendarDays size={15} />建立任务并安排</button><button className="wr-edit-button" onClick={() => navigate('monthly', { id: plan.id, month: plan.month })}>查看月度目标<ArrowRight size={14} /></button></div>
          </article>
        }
        const task = row.task
        const synchronized = data.tasks.some(item => item.id === task.id)
        return <article className={`wr-item task-priority-${signal.priority ?? 'none'} task-kind-${signal.kind}${row.isOverdue ? ' is-overdue' : ''}`} key={`task:${task.id}`}>
          <div className="wr-item-main">
            <div className="wr-item-badges"><PriorityBadge priority={signal.priority} /><WorkTypeBadge {...signal.type} /><Badge tone={row.needsCompletionReview ? 'amber' : statusTones[task.status]}>{row.displayStatus}</Badge>{task.waitingForFeedback && task.status !== 'done' && <Badge tone="amber">待反馈</Badge>}{row.isOverdue && <span className="wr-overdue">已逾期</span>}</div>
            <button className="wr-item-title" onClick={() => setEditing(task)}>{task.title}</button>
            <div className="wr-item-meta"><span>{row.sourceLabel}{row.assignedBy ? ` · ${row.assignedBy}` : ''}</span><span className={row.isOverdue ? 'wr-overdue' : ''}>截止 {task.dueDate || '待确认'}</span>{task.estimatedEffort && <span>剩余 {task.estimatedEffort}</span>}</div>
            {(task.requestedOutcome || task.assignedOn) && <ContextHelp title="交付与来源"><p>{task.requestedOutcome || '预期交付待补充'}</p>{task.assignedOn && <p>交办于 {task.assignedOn}</p>}</ContextHelp>}
          </div>
          <div className="wr-item-progress">
            {row.needsCompletionReview && <p className="wr-decision">原导入标为已完成，但缺少整体完成说明。请确认整件工作已结束，或恢复为进行中继续推进。</p>}
            <p><span>当前进展{row.progressSource === 'weekly' ? ` · 参考 ${row.progressWeekStart} 当周` : ''}</span>{row.progress || '待补充当前进展'}</p>
            {task.nextAction && <p><span>下一步</span>{task.nextAction}</p>}
            {task.decisionNeeded && <p className="wr-decision"><span>需决策 / 协调</span>{task.decisionNeeded}</p>}
            {task.supportNeeded && <p className="wr-decision"><span>需要的支持</span>{task.supportNeeded}</p>}
            {!task.decisionNeeded && task.status === 'blocked' && task.blockerReason && <p className="wr-decision"><span>受阻原因</span>{task.blockerReason}</p>}
          </div>
          <div className="wr-item-actions">
            <span className="wr-schedule">{row.needsCompletionReview ? '请先核对整体完成情况' : task.status === 'done' ? '任务已结束' : !synchronized ? '刷新清单后可安排' : row.currentWeekRecord ? isEffectiveWeeklyRecord(row.currentWeekRecord) ? '已安排本周' : row.currentWeekRecord.submitted ? '本周计划待审核' : '本周草稿' : row.isUnscheduled ? '尚未安排周计划' : '已安排其他周'}</span>
            {task.status !== 'done' && <button className="button secondary" disabled={!synchronized} aria-label={`${row.currentWeekRecord ? '查看本周安排' : '安排本周'}：${task.title}`} onClick={() => { if (synchronized) navigate('weekly', row.currentWeekRecord ? { id: row.currentWeekRecord.id, ownerId: task.ownerId, weekStart: result.weekStart } : { action: 'create', id: task.id, ownerId: task.ownerId, weekStart: result.weekStart }) }}><CalendarDays size={15} />{row.currentWeekRecord ? '查看本周安排' : '安排本周'}</button>}
            <button className="wr-edit-button" aria-label={`${row.needsCompletionReview ? '核对整体完成' : '编辑事项'}：${task.title}`} onClick={() => setEditing(task)}>{row.needsCompletionReview ? '核对整体完成' : '编辑事项'}<ArrowRight size={14} /></button>
          </div>
        </article>
      })}</div> : <Empty title={query.trim() || priority || kind ? '没有找到匹配的工作事项' : view === 'active' ? '从第一件工作开始' : `暂无${workRegisterViewLabels[view]}事项`} description={query.trim() || priority || kind ? '调整筛选条件，查看其他工作。' : '先记录，再安排具体时间。'} action={<button className="button secondary" onClick={() => query.trim() || priority || kind ? (setQuery(''), setPriority(''), setKind('')) : setCapture(true)}>{query.trim() || priority || kind ? '清除筛选与搜索' : '快速记录事项'}</button>} />}
    </section>
    <ContextHelp title="清单范围与状态说明"><p>清单展示本人的任务，以及本人负责、未验收且尚未拆成本人任务的月度目标；未完成工作跨周保留。来源待核对不等于领导交办。任务总体状态与每周完成情况分别记录。个人任务未设置优先级时，展示关联月度目标的优先级。</p></ContextHelp>
    {capture && <WorkRegisterCapture onClose={() => setCapture(false)} onSaved={receiveSaved} />}
    {editing && <WorkRegisterEditor key={`${editing.id}-${editing.version}`} userId={data.user.id} task={editing} onClose={() => setEditing(null)} onSaved={task => receiveSaved([task])} />}
    {report && <WorkRegisterReport snapshot={report} onClose={() => setReport(null)} />}
  </div>
}
