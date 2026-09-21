import { useEffect, useMemo, useState } from 'react'
import { ArrowRight, CalendarDays, FileText, Plus, RefreshCw, Search } from 'lucide-react'
import type { Task } from '../../shared/types'
import { isEffectiveWeeklyRecord } from '../../shared/weekly-record-state'
import {
  buildWorkRegister,
  createWorkRegisterSnapshot,
  workPriorityLabels,
  workRegisterToday,
  workRegisterViewLabels,
  type WorkRegisterView,
} from '../../shared/work-register'
import type { Navigate } from '../navigation'
import { Badge, Empty, PageHeader, type PageProps } from '../ui'
import WorkRegisterCapture from '../components/WorkRegisterCapture'
import WorkRegisterEditor from '../components/WorkRegisterEditor'
import WorkRegisterReport from '../components/WorkRegisterReport'
import '../work-register.css'

type RegisterSnapshot = ReturnType<typeof createWorkRegisterSnapshot>
const statusTones = { todo: 'neutral', doing: 'blue', blocked: 'amber', done: 'green' }

export default function WorkRegister({ data, refresh, notify, navigate }: PageProps & { navigate: Navigate }) {
  const [view, setView] = useState<WorkRegisterView>('active')
  const [query, setQuery] = useState('')
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
    <PageHeader eyebrow="MY WORK / 我的在手工作" title="我的工作清单" description="把交办、规划和日常协同放在一起，随时看清手里的事与下一步。" actions={<>
      <button className="button secondary" onClick={() => setReport(createWorkRegisterSnapshot(result))}><FileText size={16} />汇报预览</button>
      <button className="button primary" onClick={() => setCapture(true)}><Plus size={17} />快速记录</button>
    </>} />

    <section className="wr-summary" aria-label="本人工作概况">
      <button className={view === 'active' ? 'is-selected' : ''} onClick={() => { setView('active'); setQuery('') }}><span>在手事项</span><strong>{result.counts.active}<small>件</small></strong><p>全部未完成的工作</p></button>
      <button className={view === 'unscheduled' ? 'is-selected' : ''} onClick={() => { setView('unscheduled'); setQuery('') }}><span>待安排</span><strong>{result.counts.unscheduled}<small>件</small></strong><p>本周及以后尚无周安排</p></button>
      <div className="wr-summary-coordination"><span>待协调</span><strong>{result.counts.coordination}<small>件</small></strong><p>待反馈、受阻或需要决策与支持</p></div>
    </section>

    {refreshError && <div className="wr-refresh-note" role="status"><p>{refreshError}</p><button className="button secondary" disabled={refreshing} onClick={() => { void reload() }}><RefreshCw size={15} className={refreshing ? 'spin' : ''} />{refreshing ? '刷新中…' : '重试刷新'}</button></div>}
    {result.counts['completion-review'] > 0 && <div className="wr-refresh-note"><p>有 {result.counts['completion-review']} 件旧导入事项缺少整件任务完成说明，已保留在在手清单中，请核对是否仍需推进。</p><button className="button secondary" onClick={() => { setView('completion-review'); setQuery('') }}>核对整体完成</button></div>}

    <section className="wr-workspace" aria-label="工作事项">
      <div className="wr-toolbar">
        <div className="wr-view-tabs" role="group" aria-label="查看范围">{(Object.keys(workRegisterViewLabels) as WorkRegisterView[]).map(key => <button key={key} aria-pressed={view === key} className={view === key ? 'is-selected' : ''} onClick={() => setView(key)}>{workRegisterViewLabels[key]}<span>{result.counts[key]}</span></button>)}</div>
        <label className="wr-search"><Search size={16} /><span className="wr-sr-only">搜索我的工作事项</span><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="搜索事项、交办人或进展" /></label>
      </div>
      <div className="wr-list-caption"><span>{data.user.name}的{workRegisterViewLabels[view]}<b>{result.rows.length} 件</b>{query.trim() && <small>含关键词「{query.trim()}」</small>}</span><span>优先级优先 · 截止日期排序</span></div>
      {result.rows.length ? <div className="wr-list">{result.rows.map(row => {
        if (row.kind === 'plan') {
          const plan = row.plan
          const archived = !!plan.projectId && data.projects.some(project => project.id === plan.projectId && project.status === 'archived')
          return <article className={`wr-item wr-plan-item${row.isOverdue ? ' is-overdue' : ''}`} key={`plan:${row.id}`}>
            <div className="wr-item-main">
              <div className="wr-item-badges"><Badge tone="blue">月度目标</Badge><Badge tone={plan.status === 'published' ? 'green' : 'amber'}>{row.displayStatus}</Badge>{plan.importSource && <Badge>已有计划导入</Badge>}{plan.isTemporary && <Badge tone="amber">临时目标</Badge>}{row.isOverdue && <span className="wr-overdue">已逾期</span>}</div>
              <button className="wr-item-title" onClick={() => navigate('monthly', { id: plan.id, month: plan.month })}>{plan.title}</button>
              <div className="wr-item-meta"><span>{plan.month} 月度目标</span><span>{row.sourceLabel}{row.assignedBy ? ` · ${row.assignedBy}` : ''}</span><span>截止 {plan.dueDate || '待确认'}</span><span>{workPriorityLabels[plan.priority]}优先级</span></div>
              {plan.expectedOutcome && <p className="wr-item-outcome"><span>预期交付</span>{plan.expectedOutcome}</p>}
            </div>
            <div className="wr-item-progress">
              <p><span>待建立个人任务</span>你负责此目标，目前还没有关联到本人的个人任务。</p>
              {plan.actualOutcome && <p><span>目标成果进展</span>{plan.actualOutcome}</p>}
              {plan.status !== 'published' && <p className="wr-decision">目标尚未发布。可先建立任务、保存周草稿，发布后才能正式排周。</p>}
              {plan.temporaryReason && <p><span>原临时说明</span>{plan.temporaryReason}</p>}
              {archived && <p className="wr-decision">所属项目已归档，请先协调恢复项目再建立任务。</p>}
            </div>
            <div className="wr-item-actions"><span className="wr-schedule">待建立个人任务</span><button className="button secondary" disabled={archived} onClick={() => navigate('monthly', { action: 'create-task', id: plan.id, month: plan.month, weekStart: result.weekStart })}><CalendarDays size={15} />建立任务并安排</button><button className="wr-edit-button" onClick={() => navigate('monthly', { id: plan.id, month: plan.month })}>查看月度目标<ArrowRight size={14} /></button></div>
          </article>
        }
        const task = row.task
        const synchronized = data.tasks.some(item => item.id === task.id)
        return <article className={`wr-item${row.isOverdue ? ' is-overdue' : ''}`} key={`task:${task.id}`}>
          <div className="wr-item-main">
            <div className="wr-item-badges"><Badge tone={row.needsCompletionReview ? 'amber' : statusTones[task.status]}>{row.displayStatus}</Badge>{task.waitingForFeedback && task.status !== 'done' && <Badge tone="amber">待反馈</Badge>}{task.priority === 'high' && <span className="wr-priority-high">高优先级</span>}{row.isOverdue && <span className="wr-overdue">已逾期</span>}</div>
            <button className="wr-item-title" onClick={() => setEditing(task)}>{task.title}</button>
            <div className="wr-item-meta"><span>{row.sourceLabel}{row.assignedBy ? ` · ${row.assignedBy}` : ''}</span>{task.assignedOn && <span>交办于 {task.assignedOn}</span>}<span className={row.isOverdue ? 'wr-overdue' : ''}>截止 {task.dueDate || '待确认'}</span>{task.priority && task.priority !== 'high' && <span>{workPriorityLabels[task.priority]}优先级</span>}{task.estimatedEffort && <span>剩余投入：{task.estimatedEffort}</span>}</div>
            {task.requestedOutcome && <p className="wr-item-outcome"><span>预期交付</span>{task.requestedOutcome}</p>}
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
      })}</div> : <Empty title={query.trim() ? '没有找到匹配的工作事项' : view === 'active' ? '手里的事情，从这里开始记录' : `暂无${workRegisterViewLabels[view]}事项`} description={query.trim() ? '试试其他关键词，或切换查看范围。' : view === 'active' ? '领导刚交办的要求、需要推进的规划，都可以先记下来，再安排具体时间。' : '所有工作都保留在清单中，可切换其他范围查看。'} action={<button className="button secondary" onClick={() => query.trim() ? setQuery('') : setCapture(true)}>{query.trim() ? '清除搜索' : '快速记录事项'}</button>} />}
    </section>
    <p className="wr-scope-note">清单展示本人的任务，以及本人负责、未验收且尚未拆成本人任务的月度目标；未完成工作跨周保留。来源待核对不等于领导交办。任务总体状态与每周完成情况分别记录。</p>
    {capture && <WorkRegisterCapture onClose={() => setCapture(false)} onSaved={receiveSaved} />}
    {editing && <WorkRegisterEditor key={`${editing.id}-${editing.version}`} userId={data.user.id} task={editing} onClose={() => setEditing(null)} onSaved={task => receiveSaved([task])} />}
    {report && <WorkRegisterReport snapshot={report} onClose={() => setReport(null)} />}
  </div>
}
