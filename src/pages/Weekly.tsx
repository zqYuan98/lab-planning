import { LIMITS } from '../../shared/entity-rules'
import { effortInput, summarizeEffort } from '../../shared/effort'
import WeeklyProgressForm from '../components/WeeklyProgressForm'
import { openTask } from '../navigation'
import { useEffect, useRef, useState } from 'react'
import type { WeeklyWorkspace } from '../../shared/period-workspace'
import { useWorkspaceQuery } from '../workspace-query'
import { captureMutationContext } from '../mutation-response'
import { mergePeriod, periodScope, PeriodPager, PeriodEditorDirectory, usePeriodCandidates } from '../period-workspace'
import DirectoryAccountPicker from '../components/DirectoryAccountPicker'
import {
  ArrowLeft,
  ArrowRight,
  Plus,
  Link2,
  ExternalLink,
  AlertTriangle,
  Search,
  Trash2,
} from 'lucide-react'
import type { Task, WeeklyRecord } from '../../shared/types'
import type { WeeklySubmissionView } from '../../shared/weekly-submissions'
import { isActiveWeeklyRecord, isEffectiveWeeklyRecord } from '../../shared/weekly-record-state'
import type { Navigate } from '../navigation'
import { canUseAccount, registrationApproved } from '../../shared/auth-policy'
import { accountDisplayName, visibleAccounts } from '../account-options'
import { api, json, finishSaved } from '../api'
import { draftText, draftChecked } from '../draft-recovery'
import { assignmentAttempt, type SubmissionAttempt } from '../notification-navigation'
import WorkOriginLabel, { workSource } from '../components/WorkOriginLabel'
import WeeklySubmissionPanel from '../components/WeeklySubmissionPanel'
import NotificationStatus from '../components/NotificationStatus'
import { TaskCancellationAction, TaskCancellationModal } from '../components/TaskCancellation'
import { PriorityBadge, WorkTypeBadge, TaskLegend, ContextHelp } from '../components/TaskSignals'
import { taskPriority, workKind } from '../task-presentation'
import { recordTarget, advanceWeek, weeklyRecordState, type WorkTarget, type ReviewRequest } from '../weekly-submission-flow'
import { weeklyPageQuery } from '../period-query'
import { useDebouncedSearch } from '../use-debounced-search'
import {
  Badge,
  Empty,
  Field,
  Form,
  Modal,
  PageHeader,
  addDays,
  currentMonth,
  monday,
  nameOf,
  useAction,
  type PageProps,
} from '../ui'
const statusLabels: Record<string, string> = {
  planned: '未开始',
  doing: '进行中',
  blocked: '受阻',
  done: '成员自报完成',
  not_done: '本周未完成',
}
const statusTone: Record<string, string> = {
  planned: 'neutral',
  doing: 'blue',
  blocked: 'amber',
  done: 'green',
  not_done: 'red',
}
type WeeklyProps = PageProps & { navigate?: Navigate }
interface WeeklyControls { value: WeeklyWorkspace | null; setQuery: (query: string) => void }
export default function Weekly(props: WeeklyProps) {
  // Matches WeeklyBody's first query so entering the page issues a single read.
  const initial = weeklyPageQuery({ weekStart: props.intent?.weekStart || monday(), ownerId: props.intent?.ownerId || (props.data.user.role === 'manager' ? '' : props.data.user.id), status: props.intent?.status || 'all', q: props.intent?.query || '', source: 'all', includeInactive: false, id: props.intent?.id })
  const [query, setQuery] = useState(initial), [cursors, setCursors] = useState<string[]>([])
  const firstPath = `/workspace/weekly?${query}`, resource = useWorkspaceQuery<WeeklyWorkspace>(firstPath + (cursors.length ? `&cursor=${encodeURIComponent(cursors.at(-1)!)}` : ''), periodScope(props.data), undefined, { onCursorStale: () => { setCursors([]); return firstPath } })
  const [initialized, setInitialized] = useState(!props.intent?.id)
  useEffect(() => { if (resource.value) setInitialized(true) }, [resource.value])
  const data = { ...props.data, users: resource.value?.references.users ?? [props.data.user], projects: resource.value?.references.projects ?? [], plans: resource.value?.references.plans ?? [], tasks: resource.value?.references.tasks ?? [], weeklyRecords: resource.value?.items ?? [], publications: [] }
  const reload = async () => { setCursors([]); await resource.reload(firstPath) }
  if (!initialized) return resource.error ? <div className="error" role="alert">{resource.error}<button onClick={() => void reload().catch(() => {})}>重新读取指定任务</button></div> : <p role="status">正在读取指定任务…</p>
  return <>{resource.error && <div className="error" role="alert">{resource.error}<button onClick={() => void reload().catch(() => {})}>重新读取本周</button></div>}{resource.loading && <p role="status">正在读取周工作…</p>}<WeeklyBody {...props} data={data} refresh={reload} period={{ value: resource.value, setQuery: next => setQuery(old => { if (old !== next) setCursors([]); return next }) }} /><PeriodPager total={resource.value?.total ?? 0} next={!!resource.value?.nextCursor} previous={!!cursors.length} loading={resource.loading} onNext={() => setCursors(old => [...old, resource.value!.nextCursor!])} onPrevious={() => setCursors(old => old.slice(0, -1))} /></>
}
export function WeeklyBody({ data, refresh, notify, intent, navigate, period }: WeeklyProps & { period?: WeeklyControls }) {
  const manager = data.user.role === 'manager'
  const initialWeek = intent?.weekStart || monday()
  const initialRecord = data.weeklyRecords.find(
    (record) =>
      isActiveWeeklyRecord(record) &&
      (record.taskId === intent?.id || record.id === intent?.id) &&
      record.weekStart === initialWeek,
  )
  const initialTask = data.tasks.find((task) => task.id === intent?.id)
  const initialOwner = initialRecord?.ownerId || initialTask?.ownerId || intent?.ownerId || (manager ? '' : data.user.id)
  const [includeInactive, setIncludeInactive] = useState(data.users.some(user => user.id === initialOwner && registrationApproved(user) && !user.active))
  const visibleOwners = visibleAccounts(data.users, includeInactive)
  const availableOwner = (id: string) => data.users.some(user => user.id === id && canUseAccount(user))
  function showOwner(id: string) {
    if (data.users.some(user => user.id === id && registrationApproved(user) && !user.active)) setIncludeInactive(true)
    setOwner(id)
  }
  const [week, setWeek] = useState(initialWeek),
    [owner, setOwner] = useState(initialOwner),
    [filter, setFilter] = useState(intent?.status || 'all'),
    [search, setSearch] = useState(intent?.query || '')
  const [sourceFilter, setSourceFilter] = useState('all')
  const handledIntent = useRef(false)
  const detailSequence = useRef(0)
  useEffect(() => () => { detailSequence.current++ }, [])
  // The current page filters locally at once; the server read waits for a typing pause.
  const querySearch = useDebouncedSearch(search)
  useEffect(() => {
    if (!period) return
    period.setQuery(weeklyPageQuery({ weekStart: week, ownerId: owner, status: filter, q: querySearch, source: sourceFilter, includeInactive, id: intent?.id && !handledIntent.current ? intent.id : undefined }))
  }, [week, owner, filter, querySearch, sourceFilter, includeInactive])
  const [cycleWeek, setCycleWeek] = useState(intent?.cycleWeek || initialWeek)
  const [submissionView, setSubmissionView] = useState<WeeklySubmissionView | null>(null)
  const noSubmissionDuty = submissionView?.week === cycleWeek && submissionView.deadlineAt === null
  const [workContext, setWorkContext] = useState<WorkTarget | null>(null)
  const [reviewRequest, setReviewRequest] = useState<ReviewRequest | null>(() => intent?.kind ? {
    cycleWeek: intent.cycleWeek || initialWeek,
    contentWeek: intent.kind === 'plan' ? advanceWeek(intent.cycleWeek || initialWeek, 7) : intent.cycleWeek || initialWeek,
    ownerId: manager && intent.ownerId ? intent.ownerId : data.user.id, kind: intent.kind, token: 1,
  } : null)
  const reviewSequence = useRef(1)
  const submissionSection = useRef<HTMLDivElement>(null)
  const recordSection = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!initialRecord) return
    const frame = requestAnimationFrame(() => document.getElementById(`weekly-record-${initialRecord.id}`)?.scrollIntoView({ block: 'center' }))
    return () => cancelAnimationFrame(frame)
  }, [initialRecord?.id])
  function selectRecordWeek(value: string) {
    detailSequence.current++
    setWeek(value); setCycleWeek(value); setWorkContext(null); setReviewRequest(null)
    setFilter('all'); setSearch(''); setSourceFilter('all')
  }
  async function selectWork(target: WorkTarget) {
    const sequence = ++detailSequence.current, context = captureMutationContext()
    setWorkContext(target); setWeek(target.contentWeek); showOwner(target.ownerId); setFilter('all'); setSearch(''); setSourceFilter('all')
    const record = target.recordId ? data.weeklyRecords.find(row => isActiveWeeklyRecord(row) && row.id === target.recordId && row.ownerId === target.ownerId && row.weekStart === target.contentWeek) : undefined
    if (record) { openTask({taskId:record.taskId,section:'weekly',weeklyRecordId:record.id}) }
    else if (target.recordId && period) {
      try { const result = await api<{ record: WeeklyRecord; references: import('../../shared/period-workspace').PeriodReferences }>(`/workspace/weekly/records/${encodeURIComponent(target.recordId)}`); if (sequence !== detailSequence.current || context !== captureMutationContext()) return; if (result.references.users.some(user => user.id === target.ownerId && !user.active)) setIncludeInactive(true); openTask({ taskId: result.record.taskId, section: 'weekly', weeklyRecordId: result.record.id }) }
      catch (failure) { if (sequence === detailSequence.current) notify(failure instanceof Error ? failure.message : '记录读取失败') }
    }
    else if (target.create) openCreate(false)
    else requestAnimationFrame(() => { recordSection.current?.scrollIntoView({block:'start'}); recordSection.current?.focus({preventScroll:true}) })
  }
  function reviewWork(target: WorkTarget) {
    detailSequence.current++
    setCycleWeek(target.cycleWeek)
    setReviewRequest({...target, token:++reviewSequence.current})
    requestAnimationFrame(() => { submissionSection.current?.scrollIntoView({block:'start'}); submissionSection.current?.focus({preventScroll:true}) })
  }
  const [modal, setModal] = useState(
      intent?.action === 'create' ? initialTask?.isTemporary ? 'temporary' : 'create' : '',
    ),
    [selected, setSelected] = useState<WeeklyRecord | null>(null)
  const [deletedRecord, setDeletedRecord] = useState<WeeklyRecord | null>(null)
  const [cancellationTaskId, setCancellationTaskId] = useState<string | null>(null)
  const [creationTask, setCreationTask] = useState<Task | undefined>(
    intent?.action === 'create' ? initialTask : undefined,
  )
  const [progressStatus, setProgressStatus] = useState<WeeklyRecord['status']>('planned')
  const [completeTask, setCompleteTask] = useState(false)
  useEffect(() => {
    const detail = period?.value?.detail
    if (!detail || handledIntent.current) return
    handledIntent.current = true
    const detailOwner = detail.record?.ownerId || detail.task?.ownerId
    if (detailOwner) { setOwner(detailOwner); if (data.users.some(user => user.id === detailOwner && !user.active)) setIncludeInactive(true) }
    if (intent?.action === 'create' && detail.task) { setCreationTask(detail.task); setModal(detail.task.isTemporary ? 'temporary' : 'create') }
    else if (detail.record) {
      if (!period?.value?.items.some(row => row.id === detail.record!.id)) openTask({ taskId: detail.record.taskId, section: 'weekly', weeklyRecordId: detail.record.id })
      else requestAnimationFrame(() => document.getElementById(`weekly-record-${detail.record!.id}`)?.scrollIntoView({ block: 'center' }))
    }
  }, [period?.value?.detail])
  const [progressSubmitted, setProgressSubmitted] = useState(false)
  const progressStatusRef = useRef<HTMLSelectElement>(null)
  const progressSubmittedRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (modal !== 'edit' || !selected) return
    // Form restores a saved draft directly into its controls after mounting.
    const frame = requestAnimationFrame(() => {
      setProgressStatus((progressStatusRef.current?.value || selected.status) as WeeklyRecord['status'])
      setProgressSubmitted(progressSubmittedRef.current?.checked ?? selected.submitted)
    })
    return () => cancelAnimationFrame(frame)
  }, [modal, selected?.id, selected?.version])
  function openCreate(temporary: boolean, task?: Task) {
    detailSequence.current++
    setCreationTask(task)
    setModal(temporary ? 'temporary' : 'create')
  }
  const action = useAction(refresh, notify)
  const weekRecords = data.weeklyRecords.filter(
    (record) =>
      isActiveWeeklyRecord(record) && record.weekStart === week && (!owner || record.ownerId === owner) && visibleOwners.some(user => user.id === record.ownerId),
  )
  const records = weekRecords
    .filter(record => sourceFilter === 'all' || workSource(record) === sourceFilter)
    .filter((record) =>
      `${record.commitment} ${data.tasks.find((task) => task.id === record.taskId)?.title || ''} ${nameOf(data, record.ownerId)}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
    )
    .filter((record) =>
      filter === 'pending' ? record.submitted && !isEffectiveWeeklyRecord(record) : filter === 'all' || filter === 'draft'
        ? filter !== 'draft' || !record.submitted
        : record.submitted && record.status === filter,
    )
  const official = weekRecords.filter(isEffectiveWeeklyRecord)
  const pending = weekRecords.filter(record => record.submitted && !isEffectiveWeeklyRecord(record))
  const effort = period?.value?.effortSummary ?? summarizeEffort(weekRecords, data.plans, data.projects)
  const summary = period?.value?.summary ?? { official: official.length, pending: pending.length, done: official.filter(record => record.status === 'done').length, blocked: official.filter(record => record.status === 'blocked').length }
  async function openRecord(type: string, record: WeeklyRecord) {
    if (!period) { setSelected(record); setModal(type); return }
    const sequence = ++detailSequence.current, context = captureMutationContext()
    try { const result = await api<{ record: WeeklyRecord }>(`/workspace/weekly/records/${encodeURIComponent(record.id)}`); if (sequence !== detailSequence.current || context !== captureMutationContext()) return; setSelected(result.record); setModal(type) } catch (failure) { if (sequence === detailSequence.current) notify(failure instanceof Error ? failure.message : '记录读取失败') }
  }
  const close = () => {
    detailSequence.current++
    setCompleteTask(false)
    setModal('')
    setSelected(null)
    setCreationTask(undefined)
  }
  const saved = async (message: string, record?: WeeklyRecord) => finishSaved(async () => {
    await refresh()
    if (record) {
      setWorkContext(recordTarget(record, cycleWeek)); setWeek(record.weekStart); setOwner(record.ownerId); setFilter('all'); setSearch(''); setSourceFilter('all')
    }
    notify(message)
    close()
  })
  const selectedTask = data.tasks.find((task) => task.id === selected?.taskId)
  const cancellationTask = data.tasks.find(task => task.id === cancellationTaskId)
  return (
    <>
      <PageHeader
        eyebrow="EXECUTION / WEEKLY"
        title={manager ? '每周执行' : '我的周计划'}
        description="看清本周重点，记录进展与交付。"
        actions={
          <>
            {navigate && <button className="button secondary" onClick={() => navigate('collaboration')}>进展与催办</button>}
            <button
              className="button secondary"
              onClick={() => openCreate(true)}
            >
              <AlertTriangle size={16} />
              记录临时工作
            </button>
            <button
              className="button primary"
              onClick={() => openCreate(false)}
            >
              <Plus size={17} />
              {manager ? '下发 / 安排周任务' : '安排周任务'}
            </button>
          </>
        }
      />
      <div ref={submissionSection} tabIndex={-1}>
        <WeeklySubmissionPanel data={data} refresh={refresh} notify={notify} week={cycleWeek} onChangeCycle={selectRecordWeek} onSelectWork={selectWork} reviewRequest={reviewRequest} onViewChange={setSubmissionView} />
      </div>
      <div ref={recordSection} tabIndex={-1} className="weekly-record-context">
        <h2>周工作记录 · {week} ～ {advanceWeek(week,6)}</h2>
        <WeeklyRecordSubmissionGuidance noSubmissionDuty={noSubmissionDuty} />
        {workContext && <div className="navigation-context"><span>正在处理{nameOf(data,workContext.ownerId)}的{workContext.kind === 'results' ? '完成情况' : '下周计划'}（记录周 {workContext.contentWeek}，提报周期 {workContext.cycleWeek}）。</span>{!(noSubmissionDuty && workContext.cycleWeek === cycleWeek) && <button className="button primary" onClick={() => reviewWork(workContext)}>返回核对并提交整份提报</button>}</div>}
      </div>
      {deletedRecord && <DeletedWeeklyRecordNotice data={data} record={deletedRecord} onRelink={() => { detailSequence.current++; setSelected(deletedRecord); setModal('relink') }} onRecreate={task => {
        setWeek(deletedRecord.weekStart); showOwner(deletedRecord.ownerId); setWorkContext(recordTarget(deletedRecord, cycleWeek)); setFilter('all'); setSearch(''); setSourceFilter('all'); setDeletedRecord(null); openCreate(task.isTemporary, task)
      }} onCancelTask={task => { detailSequence.current++; setCancellationTaskId(task.id) }} onDismiss={() => setDeletedRecord(null)} />}
      <div className="toolbar">
        <div className="week-switcher">
          <button
            className="icon-button"
            aria-label="上一周"
            onClick={() => selectRecordWeek(addDays(week, -7))}
          >
            <ArrowLeft size={17} />
          </button>
          <label>
            <span className="sr-only">选择周</span>
            <input
              aria-label="周记录所属周"
              type="date"
              value={week}
              onChange={(event) => {
                if (event.target.value)
                  selectRecordWeek(monday(new Date(`${event.target.value}T12:00:00`)))
              }}
            />
          </label>
          <span>— {addDays(week, 6).slice(5)}</span>
          <button
            className="icon-button"
            aria-label="下一周"
            onClick={() => selectRecordWeek(addDays(week, 7))}
          >
            <ArrowRight size={17} />
          </button>
          <button className="text-button" onClick={() => selectRecordWeek(monday())}>
            本周
          </button>
        </div>
        {manager && period && <DirectoryAccountPicker key={owner} name="weekly-owner-filter" purpose="diagnostics" role="business" scope={periodScope(data)} defaultSelectedIds={owner ? [owner] : []} allowEmpty label="筛选负责人" onChange={ids => { detailSequence.current++; setOwner(ids[0] || ''); setWorkContext(null) }} />}
        {manager && !period && (
          <label className="inline-field">
            负责人
            <select
              value={owner}
              onChange={(event) => { detailSequence.current++; setOwner(event.target.value); setWorkContext(null) }}
            >
              <option value="">{includeInactive ? '所有成员（含停用）' : '在用成员'}</option>
              {visibleOwners.map((user) => (
                <option key={user.id} value={user.id}>
                  {accountDisplayName(user)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="checkbox-label">
          <input type="checkbox" checked={includeInactive} onChange={event => {
            detailSequence.current++
            setIncludeInactive(event.target.checked)
            if (!event.target.checked && owner && !availableOwner(owner)) { setOwner(manager ? '' : data.user.id); setWorkContext(null) }
          }} />
          包含停用成员
        </label>
      </div>
      {!manager && owner !== data.user.id && (
        <div className="navigation-context">
          <span>
            {owner
              ? `正在查看${nameOf(data, owner)}的协作记录`
              : '正在查看当前账号可访问的全部协作记录'}
            ，可更新自己负责的任务。
          </span>
          <button
            className="text-button"
            onClick={() => {
              detailSequence.current++
              setOwner(data.user.id)
              setSearch('')
              setFilter('all')
            }}
          >
            回到我的周计划
          </button>
        </div>
      )}
      <section className="context-box" aria-label="本周投入汇总"><p>本周投入：预计 {effort.plannedEffortDays} 人日 · 实际 {effort.actualEffortDays} 人日 · 未填预计 {effort.missingPlannedCount} 项 / 实际 {effort.missingActualCount} 项</p>{effort.byOwnerWeek.filter(item => item.overCapacity).map(item => <p key={`${item.ownerId}:${item.weekStart}`} role="status">容量提示：{nameOf(data, item.ownerId)}本周预计或实际投入超过 5 人日，请核对安排。</p>)}<details><summary>按项目查看投入</summary>{effort.byProject.map(item => <p key={item.projectId ?? 'none'}>{item.projectName}：预计 {item.plannedEffortDays} / 实际 {item.actualEffortDays} 人日（未填 {item.missingPlannedCount} / {item.missingActualCount} 项）</p>)}</details><small>覆盖当前成员筛选的全部有效周记录，不受列表分页、关键词和状态筛选影响。</small></section>
      <div className="weekly-summary">
        <span>
          已纳入周统计 <strong>{summary.official}</strong> 项
        </span>
        {summary.pending > 0 && <span>待审核生效 <strong>{summary.pending}</strong> 项</span>}
        <span>
          成员自报完成{' '}
          <strong>
            {summary.done}
          </strong>{' '}
          项
        </span>
        <span>
          阻塞{' '}
          <strong>
            {summary.blocked}
          </strong>{' '}
          项
        </span>
        <span>
          完成率{' '}
          <strong>
            {summary.official
              ? `${Math.round((summary.done / summary.official) * 100)}%`
              : '—'}
          </strong>
        </span>
        <small>按全部已纳入周统计的记录计算，筛选不改变口径。</small>
      </div>
      <div className="tabs" role="group" aria-label="执行状态筛选">
        {[
          ['all', '全部记录'],
          ['draft', '草稿'],
          ['pending', '待审核生效'],
          ...Object.entries(statusLabels),
        ].map(([value, label]) => (
          <button
            key={value}
            className={filter === value ? 'selected' : ''}
            onClick={() => { detailSequence.current++; setFilter(value) }}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <label className="inline-field">计划来源<select value={sourceFilter} onChange={event => { detailSequence.current++; setSourceFilter(event.target.value) }}><option value="all">全部来源</option><option value="assigned">管理员下发</option><option value="self">自行安排</option><option value="proxy">管理员代录</option><option value="imported">已有计划导入</option><option value="unknown">来源未记录</option></select></label>
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="搜索周任务"
            placeholder="搜索任务、承诺或负责人"
            value={search}
            onChange={(event) => { detailSequence.current++; setSearch(event.target.value) }}
          />
        </label>
      </div>
      <TaskLegend />
      {initialTask && !initialRecord && (
        <div className="navigation-context">
          <div>
            <strong>{initialTask.title}</strong>
            <p>{initialTask.description || '该任务暂未填写补充说明。'}</p>
            <p>负责人：{nameOf(data, initialTask.ownerId)} · 截止日期：{initialTask.dueDate || '未设置'}</p>
            <span>该周尚未安排执行记录，可将任务纳入对应周的工作。</span>
          </div>
          {(manager || initialTask.ownerId === data.user.id) && availableOwner(initialTask.ownerId) && (
            <button
              className="text-button"
              onClick={() => openCreate(initialTask.isTemporary, initialTask)}
            >
              为此任务安排本周
            </button>
          )}
          {manager && <NotificationStatus type="task" id={initialTask.id} data={data} />}
          {navigate && <button className="button secondary" onClick={() => navigate('collaboration', { id: initialTask.id, targetType: 'task' })}>查看进展与催办</button>}
        </div>
      )}
      {action.error && (
        <div className="error" role="alert">
          {action.error}
        </div>
      )}
      {records.length ? (
        <div className="weekly-list">
          {records.map((record) => {
            const task = data.tasks.find((task) => task.id === record.taskId),
              plan = data.plans.find(
                (plan) => plan.id === record.monthlyPlanId,
              ),
              canEdit = manager || record.ownerId === data.user.id
            const temporaryReason = task?.temporaryReason?.trim() || ''
            const temporaryRecord = !record.monthlyPlanId && !!(task?.isTemporary || temporaryReason)
            const priority = taskPriority(task, plan)
            const isTemporary = !!(task?.isTemporary || temporaryReason || plan?.isTemporary)
            const kind = workKind({ isTemporary, monthlyPlanId: record.monthlyPlanId })
            const recordState = weeklyRecordState(record)
            return (
              <article
                className={`weekly-card task-priority-${priority || 'none'} task-kind-${kind} ${record.status === 'blocked' ? 'has-blocker' : ''} ${record.id === initialRecord?.id ? 'navigation-highlight' : ''}`}
                key={record.id}
                id={`weekly-record-${record.id}`}
              >
                <div className="weekly-card-top">
                  <div className="row-meta">
                    <PriorityBadge priority={priority} />
                    <WorkTypeBadge isTemporary={isTemporary} monthlyPlanId={record.monthlyPlanId} />
                    <span className="task-code">
                      #{record.taskId.slice(-6).toUpperCase()}
                    </span>
                    <WorkOriginLabel row={record} data={data} />
                    {record.submitted && (record.planApproval?.required || record.workOrigin?.kind === 'assigned') && <Badge tone={recordState.tone}>{recordState.label}</Badge>}
                    {record.submitted ? (
                      <Badge tone={statusTone[record.status]}>
                        {record.importSource && record.status === 'done'
                          ? '已完成'
                          : statusLabels[record.status]}
                      </Badge>
                    ) : (
                      <Badge>草稿 · 未纳入周统计</Badge>
                    )}
                    {record.importSource && (
                      <Badge tone="blue">已有计划导入</Badge>
                    )}
                    {record.importSource?.sourceStatus && (
                      <span>原文：{record.importSource.sourceStatus}</span>
                    )}
                    {temporaryRecord && task?.monthlyPlanId ? (
                      <Badge tone="amber">临时交办 · 原周记录</Badge>
                    ) : !temporaryRecord && !record.monthlyPlanId && (
                      <Badge tone="amber">未关联月度目标</Badge>
                    )}
                  </div>
                  <span className="owner-chip">
                    {nameOf(data, record.ownerId)}
                  </span>
                </div>
                <h2><button type="button" className="text-button" onClick={()=>openTask({taskId:record.taskId,section:'weekly',weeklyRecordId:record.id})}>{record.commitment || task?.title || '已有周工作记录'}</button></h2>
                {task?.title && record.commitment && task.title.trim() !== record.commitment.trim() && (
                  <p className="cell-description">任务：{task.title}</p>
                )}
                {record.importSource && !record.commitment && (
                  <p className="cell-description">本周承诺：原表未注明</p>
                )}
                <div className="linked-plan">
                  <Link2 size={14} />
                  {plan
                    ? `${plan.month} · ${plan.title}`
                    : temporaryRecord
                      ? task?.monthlyPlanId
                        ? '本周按临时工作记录，任务后续已关联月度目标'
                        : '临时交办，直接纳入本周计划'
                      : record.importSource
                        ? '未关联月度目标，保留原资料归属'
                        : '未关联月度目标'}
                  {task && (
                    <span>
                      任务当前截止{' '}
                      {task.dueDate || (task.importSource ? '原表未注明' : '')}
                    </span>
                  )}
                </div>
                {temporaryReason && (
                  <p className="cell-description">
                    {temporaryRecord ? '交办说明' : '原临时交办说明'}：{temporaryReason}
                  </p>
                )}
                <div className="weekly-facts">
                  <div>
                    <span>实际成果</span>
                    <p>
                      {record.actualOutcome ||
                        (record.importSource
                          ? '原表未注明'
                          : '尚未填写实际进展')}
                    </p>
                  </div>
                  <div>
                    <span>
                      {record.blocker ? '阻塞 / 未完成原因' : '下一步'}
                    </span>
                    <p className={record.blocker ? 'amber-text' : ''}>
                      {record.blocker ||
                        record.nextAction ||
                        (record.importSource ? '原表未注明' : '尚未填写')}
                    </p>
                    {record.blocker && record.nextAction && (
                      <small>下一步：{record.nextAction}</small>
                    )}
                  </div>
                </div>
                {record.evidenceUrl &&
                  /^https?:\/\//i.test(record.evidenceUrl) && (
                    <a
                      className="evidence-link"
                      href={record.evidenceUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink size={14} />
                      查看交付证据
                    </a>
                  )}
                <footer className="weekly-card-footer">
                  <small>
                    {recordState.label} · 整份提报另行确认{' '}
                    · 记录 V{record.version}
                  </small>
                  <div className="row-actions">
                    {canEdit && (
                      <>
                        <button
                          onClick={() => {
                            openTask({taskId:record.taskId,section:'weekly',weeklyRecordId:record.id})
                          }}
                        >
                          更新进展
                        </button>
                        {!record.submitted && (
                          <button
                            disabled={action.busy}
                            onClick={() =>
                              void action.run(
                                () =>
                                  api(
                                    `/weekly-records/${record.id}`,
                                    json(
                                      {
                                        version: record.version,
                                        submitted: true,
                                      },
                                      'PATCH',
                                    ),
                                  ),
                                '该条记录已正式保存；适用审核的计划通过后纳入周统计，请核对整份提报',
                              )
                            }
                          >
                            正式保存该条计划
                          </button>
                        )}
                        <button onClick={() => reviewWork(recordTarget(record, cycleWeek))}>核对关联整份提报</button>
                        <button
                          disabled={!availableOwner(record.ownerId)}
                          title={!availableOwner(record.ownerId) ? '责任人账号已停用，无法新安排任务' : undefined}
                          onClick={() => {
                            void openRecord('carry', record)
                          }}
                        >
                          顺延一周
                        </button>
                      </>
                    )}
                    {manager && task && (
                      <button
                        onClick={() => {
                          void openRecord('relink', record)
                        }}
                      >
                        调整月度关联
                      </button>
                    )}
                    {manager && <button className="weekly-delete-action" onClick={() => void openRecord('delete', record)}><Trash2 size={14} />删除周安排</button>}
                  </div>
                </footer>
              </article>
            )
          })}
        </div>
      ) : (
        <div className="panel">
          <Empty
            title="当前没有周计划记录"
            description="从本人负责或参与的月度目标拆分任务，也可以提前保存草稿。"
            action={
              <button
                className="button secondary"
                onClick={() => openCreate(false)}
              >
                <Plus size={16} />
                安排第一项周任务
              </button>
            }
          />
        </div>
      )}
      {cancellationTask && manager && <TaskCancellationModal data={data} task={cancellationTask} onClose={() => setCancellationTaskId(null)} onSaved={async () => {
        await refresh()
        setCancellationTaskId(null)
        setDeletedRecord(null)
        notify('原任务已作废，已退出任务总数和待办，历史记录保留')
      }} />}
      {modal === 'delete' && selected && manager && <Modal title="删除这条周安排" onClose={close}>
        <div className="context-box"><strong>{nameOf(data, selected.ownerId)} · {selected.weekStart} ～ {advanceWeek(selected.weekStart, 6)}</strong><p>{selected.commitment || selectedTask?.title || '未填写本周承诺'}</p><p>任务：{selectedTask?.title || selected.taskId}</p></div>
        <p className="modal-intro">删除后，该条安排退出当前列表与统计；原任务、其他周安排和已有提交、报告快照保留。已提交的整份计划需要重新核对，删除原因会留痕。</p>
        <Form onCancel={close} submitLabel="确认删除周安排" onSubmit={async event => {
          const reason = String(new FormData(event.currentTarget).get('reason') || '').trim()
          if (!reason) throw new Error('请填写删除原因')
          const deleted = await api<WeeklyRecord>(`/weekly-records/${selected.id}`, json({ version:selected.version, reason }, 'DELETE'))
          await saved('该周安排已删除，原任务和历史记录保留')
          setDeletedRecord(deleted)
        }}><Field label="删除原因" hint="例如：早期录入未关联月度临时计划，现需调整后重建。"><textarea name="reason" required rows={3} maxLength={LIMITS.text} /></Field></Form>
      </Modal>}
      {(modal === 'create' || modal === 'temporary') && (
        period ? <PeriodEditorDirectory data={data} onCancel={close}>{editorData => <WeeklyCreate data={editorData} week={week} temporary={modal === 'temporary'} initialOwnerId={workContext?.ownerId || owner || (manager ? '' : data.user.id)} initialTask={creationTask} onClose={close} onSaved={saved} live />}</PeriodEditorDirectory> : <WeeklyCreate
          data={data}
          week={week}
          temporary={modal === 'temporary'}
          initialOwnerId={workContext?.ownerId || owner || (manager ? '' : data.user.id)}
          initialTask={creationTask}
          onClose={close}
          onSaved={saved}
        />
      )}
      {modal === 'edit' && selected && (
        <Modal title="更新本周实际进展" onClose={close} wide>
          {navigate && <button className="button secondary" onClick={() => openTask({ taskId:selected.taskId, section:'overview' })}>任务进展、催办回应与延期申请</button>}
          {manager && <NotificationStatus type="weeklyRecord" id={selected.id} data={data} />}
          <div className="context-box">
            <strong>{selectedTask?.title}</strong>
            <p>
              当前周 {selected.weekStart} ·{' '}
              {data.plans.find((plan) => plan.id === selected.monthlyPlanId)
                ?.acceptanceCriteria ||
                (selected.importSource ||
                data.plans.find((plan) => plan.id === selected.monthlyPlanId)
                  ?.importSource
                  ? '验收标准：原表未注明，可继续保留为空。'
                  : '临时工作，请记录真实结果与证据。')}
            </p>
            {selectedTask?.temporaryReason && (
              <p>
                {!selected.monthlyPlanId ? '临时交办说明' : '原临时交办说明'}：{selectedTask.temporaryReason}
              </p>
            )}
          </div>
          <WeeklyProgressForm data={data} selected={selected} selectedTask={selectedTask} onClose={close} onSaved={saved} />
        </Modal>
      )}
      {modal === 'carry' && selected && (
        <Modal title="顺延周承诺" onClose={close}>
          <p className="modal-intro">
            沿用同一个任务编号，保留本周记录。新周从未开始状态重新安排。
          </p>
          <Form
            onCancel={close}
            submitLabel="创建下一周记录"
            onSubmit={async (event) => {
              const carried = await api<WeeklyRecord>(
                `/weekly-records/${selected.id}/carry`,
                json(Object.fromEntries(new FormData(event.currentTarget))),
              )
              await saved('新周草稿已创建，原周记录已保留', carried)
            }}
          >
            <Field label="新一周日期">
              <input
                name="weekStart"
                type="date"
                min={addDays(selected.weekStart, 7)}
                defaultValue={addDays(selected.weekStart, 7)}
                required
              />
            </Field>
            <Field label="新一周承诺">
              <textarea
                name="commitment"
                defaultValue={selected.commitment}
                required
                rows={3}
              />
            </Field>
          </Form>
        </Modal>
      )}
      {modal === 'relink' && selectedTask && period && <WeeklyRelink data={data} task={selectedTask} onClose={close} onSaved={saved} />}
      {modal === 'relink' && selectedTask && !period && (
        <Modal title="调整任务的月度归属" onClose={close}>
          <p className="modal-intro">
            任务编号保持不变；曾纳入周统计的记录保留原月度归属，从未提交且覆盖目标月份的草稿会同步调整，新周记录采用新的关联。
          </p>
          <Form
            onCancel={close}
            submitLabel="保存关联变更"
            onSubmit={async (event) => {
              await api(
                `/tasks/${selectedTask.id}/relink`,
                json({
                  ...Object.fromEntries(new FormData(event.currentTarget)),
                  version: selectedTask.version,
                }),
              )
              await saved('任务月度关联已调整')
            }}
          >
            <Field label="关联已发布月度目标">
              <select
                name="monthlyPlanId"
                required
                defaultValue={selectedTask.monthlyPlanId || ''}
              >
                <option value="" disabled>
                  选择任务负责人参与的月度目标
                </option>
                {data.plans
                  .filter(
                    (plan) =>
                      plan.status === 'published' &&
                      (!plan.projectId ||
                        data.projects.some(
                          (project) =>
                            project.id === plan.projectId &&
                            project.status === 'active',
                        )) &&
                      (plan.ownerId === selectedTask.ownerId ||
                        plan.collaboratorIds.includes(selectedTask.ownerId)),
                  )
                  .map((plan) => (
                    <option value={plan.id} key={plan.id}>
                      {plan.month} · {plan.title}
                    </option>
                  ))}
              </select>
            </Field>
            <Field label="调整原因">
              <textarea name="reason" required rows={3} />
            </Field>
          </Form>
        </Modal>
      )}
    </>
  )
}
export function WeeklyRecordSubmissionGuidance({ noSubmissionDuty }: { noSubmissionDuty: boolean }) {
  return <>
    <p>{noSubmissionDuty ? '本提报周期整周休息，无须提交整份提报；仍可保存周工作记录。' : '完成记录后，请核对并提交整份提报。'}</p>
    <ContextHelp title="周记录与整份提报有什么区别">
      <p>{noSubmissionDuty ? '保存单条记录用于更新工作。本提报周期整周休息，无须正式提报，也不计缺交。' : '保存单条记录用于更新工作；适用审核的计划通过后纳入周统计。完成填写后，请核对并提交整份提报。'}</p>
      <p>同一任务可以持续跨周，每周承诺、实际结果和证据分别保存。</p>
    </ContextHelp>
  </>
}

export function DeletedWeeklyRecordNotice({ data, record, onRelink, onRecreate, onCancelTask, onDismiss }: {
  data: PageProps['data']; record: WeeklyRecord; onRelink: () => void; onRecreate: (task: Task) => void; onCancelTask?: (task: Task) => void; onDismiss: () => void
}) {
  // Resolve from refreshed data, so relinking after deletion cannot recreate from stale task ownership.
  const task = data.tasks.find(item => item.id === record.taskId)
  const plan = task?.monthlyPlanId ? data.plans.find(item => item.id === task.monthlyPlanId) : undefined
  return <div className="navigation-context weekly-deletion-result" role="status">
    <div><strong>已删除{nameOf(data, record.ownerId)}在 {record.weekStart} 当周的安排</strong><p>原任务及历史提交、报告仍保留。调整完成后请重新核对整份提报。</p>{task && <p>原任务当前月度关联：{plan ? `${plan.month} · ${plan.title}` : task.monthlyPlanId ? `目标 #${task.monthlyPlanId.slice(-6).toUpperCase()}` : '未关联月度目标'}</p>}</div>
    {data.user.role === 'manager' && task && <button className="button secondary" onClick={onRelink}>调整原任务月度关联</button>}
    {task && data.users.some(user => user.id === record.ownerId && canUseAccount(user)) && <button className="button secondary" onClick={() => onRecreate(task)}>沿用原任务重新安排该周</button>}
    {onCancelTask && <TaskCancellationAction data={data} task={task} onCancel={onCancelTask} label="作废原任务" />}
    <button className="text-button" aria-label="关闭删除结果提示" onClick={onDismiss}>关闭</button>
  </div>
}
function WeeklyRelink({ data, task, onClose, onSaved }: { data: PageProps['data']; task: Task; onClose: () => void; onSaved: (message: string) => Promise<void> }) {
  const candidates = usePeriodCandidates(data, task.ownerId, 'relink')
  return <Modal title="调整任务的月度归属" onClose={onClose}>
    <p className="modal-intro">任务编号保持不变；已纳入周统计的记录保留原月度归属，符合条件的草稿同步调整。</p>
    {candidates.error ? <div className="error" role="alert">{candidates.error}<button onClick={candidates.retry}>重新读取目标</button></div> : !candidates.value ? <p role="status">正在读取责任人参与的已发布目标…</p> : <Form onCancel={onClose} onSubmit={async event => { await api(`/tasks/${task.id}/relink`, json({ ...Object.fromEntries(new FormData(event.currentTarget)), version: task.version })); await onSaved('任务月度关联已调整') }}><Field label="关联已发布月度目标"><select name="monthlyPlanId" required defaultValue={task.monthlyPlanId || ''}><option value="" disabled>请选择目标</option>{candidates.value.plans.map(plan => <option key={plan.id} value={plan.id}>{plan.month} · {plan.title}</option>)}</select></Field><Field label="调整原因"><textarea name="reason" rows={3} required /></Field></Form>}
  </Modal>
}
function WeeklyCreate({
  data: initialData,
  week,
  temporary,
  initialTask,
  initialOwnerId,
  onClose,
  onSaved,
  live = false,
}: {
  data: PageProps['data']
  week: string
  temporary: boolean
  initialTask?: Task
  initialOwnerId: string
  onClose: () => void
  onSaved: (message: string, record?: WeeklyRecord) => Promise<void>
  live?: boolean
}) {
  let data = initialData
  const accessibleTask =
    initialTask &&
    initialTask.isTemporary === temporary &&
    data.users.some(user => user.id === initialTask.ownerId && canUseAccount(user)) &&
    (data.user.role === 'manager' || initialTask.ownerId === data.user.id)
      ? initialTask
      : undefined
  const [taskId, setTaskId] = useState(accessibleTask?.id || ''),
    [planId, setPlanId] = useState(accessibleTask?.monthlyPlanId || ''),
    [ownerId, setOwnerId] = useState(accessibleTask?.ownerId || (data.users.some(user => user.id === initialOwnerId && canUseAccount(user)) ? initialOwnerId : ''))
  const attempt = useRef<SubmissionAttempt | null>(null)
  const [arrangement, setArrangement] = useState('assigned')
  const candidates = usePeriodCandidates(initialData, ownerId || initialData.user.id, 'weekly')
  if (live) data = candidates.value ?? { ...initialData, plans: [], tasks: [] }
  const creationKind = ownerId === data.user.id ? 'self' : arrangement
  const assigning = creationKind === 'assigned' && !!ownerId
  const plans = data.plans.filter(
    (plan) =>
      !plan.visibility &&
      (!plan.projectId ||
        data.projects.some(
          (project) =>
            project.id === plan.projectId && project.status === 'active',
        )) &&
      (plan.ownerId === ownerId || plan.collaboratorIds.includes(ownerId)) &&
      (plan.status === 'published' ||
        ['draft', 'returned', 'submitted', 'approved'].includes(plan.status)),
  )
  const existing = data.tasks.filter(
    (task) =>
      task.ownerId === ownerId &&
      (!task.monthlyPlanId ||
        plans.some((plan) => plan.id === task.monthlyPlanId)) &&
      (temporary ? task.isTemporary : !task.isTemporary),
  )
  const plan = plans.find((plan) => plan.id === planId)
  const [includeInStatistics, setIncludeInStatistics] = useState(temporary || plan?.status === 'published')
  return (
    <Modal
      title={temporary ? '记录临时工作' : data.user.role === 'manager' ? '下发 / 安排周任务' : '安排个人周任务'}
      onClose={onClose}
      wide
    >
      {live && candidates.error && <div className="error" role="alert">{candidates.error}<button onClick={candidates.retry}>重新读取候选</button></div>}
      {live && !candidates.value && !candidates.error && <p role="status">正在读取责任人的目标与任务…</p>}
      <Form
        onCancel={onClose}
        submitLabel={assigning ? includeInStatistics ? '下发给责任人' : '保存周草稿' : creationKind === 'proxy' ? '保存代录记录' : '保存周工作记录'}
        draftKey={`weekly-create:${data.user.id}:${week}:${temporary ? 'temporary' : 'regular'}:${accessibleTask?.id || 'new'}:${initialOwnerId}`}
        draftContext={{ __ownerId: ownerId, __taskId: taskId, __planId: planId, __arrangement: arrangement, __submitted: includeInStatistics ? 'yes' : '' }}
        onDraftRestore={values => {
          const requestedOwner = draftText(values, '__ownerId')
          const restoredOwner = data.user.role === 'manager' ? data.users.some(user => user.id === requestedOwner && canUseAccount(user)) ? requestedOwner : '' : data.user.id
          // Candidate reads follow the restored owner asynchronously. Keep the saved
          // identifiers until that read completes; never turn an existing-task draft into a new task.
          setOwnerId(restoredOwner); setTaskId(draftText(values, '__taskId')); setPlanId(draftText(values, '__planId'))
          setArrangement(draftText(values, '__arrangement') === 'proxy' ? 'proxy' : 'assigned')
          setIncludeInStatistics(draftText(values, '__submitted') === 'yes' || draftChecked(values, 'submitted'))
        }}
        onSubmit={async (event) => {
          if (live && !candidates.value) throw new Error('请等待责任人候选读取完成')
          if (taskId && !existing.some(task => task.id === taskId)) throw new Error('草稿中关联的任务当前不可选，请重新选择任务；尚未建立新任务。')
          if (!taskId && !temporary && !plans.some(plan => plan.id === planId)) throw new Error('请重新选择当前可访问的月度目标')
          const form = new FormData(event.currentTarget),
            values = Object.fromEntries(form)
          const origin = { creationKind, creationReason: values.creationReason || '' }
          const payload = {
            ...(taskId ? { taskId } : { task: {
              ...origin, title: values.title, monthlyPlanId: temporary ? null : planId,
              ownerId, description: values.description || '', dueDate: values.dueDate,
              isTemporary: temporary, temporaryReason: values.temporaryReason || '',
            } }),
            record: { ...origin, weekStart: values.weekStart, commitment: values.commitment, plannedEffortDays: effortInput(form.get('plannedEffortDays')), actualEffortDays: null,
              status: 'planned', submitted: form.has('submitted') },
          }
          attempt.current = assignmentAttempt(attempt.current, payload)
          const { record } = await api<{ task: Task; record: WeeklyRecord }>('/weekly-assignments',
            json({ requestId: attempt.current.requestId, ...payload }))
          await onSaved(assigning ? record.submitted
            ? `已下发给${nameOf(data, record.ownerId)}，通知已记录；请成员更新并核对整份提报`
            : '周安排草稿已保存，尚未发送下发通知'
            : '周工作记录已保存，请核对整份提报', record)
        }}
      >
        <div className="form-grid">
          <Field label="所属周">
            <input name="weekStart" type="date" defaultValue={week} required />
          </Field>
          <Field label="任务责任人" hint="保存后进入该责任人的我的周计划，填写人单独留痕。">
            <select
              aria-label="任务责任人"
              required
              value={ownerId}
              onChange={(event) => {
                setOwnerId(event.target.value)
                setTaskId('')
                setPlanId('')
                setIncludeInStatistics(temporary)
              }}
              disabled={data.user.role !== 'manager'}
            >
              <option value="" disabled>请选择责任人</option>
              {ownerId && !data.users.some(user => user.id === ownerId && canUseAccount(user)) && <option value={ownerId} disabled>草稿责任人暂不可选，请重新核对</option>}
              {data.users
                .filter(canUseAccount)
                .map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        {data.user.role === 'manager' && ownerId && ownerId !== data.user.id && <>
          <Field label="安排方式"><select aria-label="安排方式" value={arrangement} onChange={event => setArrangement(event.target.value)}><option value="assigned">下发任务</option><option value="proxy">代成员录入</option></select></Field>
          {creationKind === 'proxy' && <Field label="代录原因"><textarea name="creationReason" required rows={2} maxLength={LIMITS.text} /></Field>}
          <p className="form-hint">{assigning ? '纳入周统计后才正式下发；草稿不发送下发通知。下发后成员可直接更新。' : '保留管理员代录来源及原因。'}此操作不会生成成员的整份提报回执。</p>
        </>}
        <Field label="本周预计投入（人日）" hint="以 0.5 人日填写；留空表示尚未估算。任务剩余投入不会自动计入本周。"><input name="plannedEffortDays" type="number" min="0" step="0.5" /></Field>
        <Field label="关联个人任务">
          <select
            value={taskId}
            onChange={(event) => {
              setTaskId(event.target.value)
              const task = existing.find(item => item.id === event.target.value)
              setIncludeInStatistics(temporary || plans.some(plan => plan.id === (task?.monthlyPlanId || planId) && plan.status === 'published'))
            }}
          >
            <option value="">创建新的个人任务</option>
            {taskId && !existing.some(task => task.id === taskId) && <option value={taskId} disabled>{candidates.value ? '草稿关联任务暂不可选，请重新核对' : '正在读取草稿关联任务…'}</option>}
            {existing.map((task) => (
              <option key={task.id} value={task.id}>
                沿用任务 · {task.title}
              </option>
            ))}
          </select>
        </Field>
        {!taskId && (
          <>
            {!temporary && (
              <Field
                label="关联月度成果"
                hint="未发布事项可先拟周草稿，发布后再正式提交。"
              >
                <select
                  value={planId}
                  onChange={(event) => {
                    setPlanId(event.target.value)
                    setIncludeInStatistics(plans.some(plan => plan.id === event.target.value && plan.status === 'published'))
                  }}
                  required
                >
                  <option value="">选择责任人负责或参与的月度目标</option>
                  {planId && !plans.some(plan => plan.id === planId) && <option value={planId} disabled>{candidates.value ? '草稿关联目标暂不可选，请重新核对' : '正在读取草稿关联目标…'}</option>}
                  {plans
                    .sort((a, b) => b.month.localeCompare(a.month))
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.month} · {item.title}
                        {item.status !== 'published' ? '（未发布）' : ''}
                      </option>
                    ))}
                </select>
              </Field>
            )}
            {plan && (
              <div className="context-box">
                <strong>
                  预期成果：
                  {plan.expectedOutcome ||
                    (plan.importSource ? '原表未注明' : '')}
                </strong>
                <p>
                  验收要求：
                  {plan.acceptanceCriteria ||
                    (plan.importSource ? '原表未注明' : '')}
                </p>
                <small>
                  月度截止：
                  {plan.dueDate || (plan.importSource ? '原表未注明' : '')}
                </small>
              </div>
            )}
            <Field label="个人任务名称">
              <input
                name="title"
                required
                maxLength={LIMITS.title}
                placeholder="责任人具体负责的交付内容"
              />
            </Field>
            <Field label="任务说明">
              <textarea name="description" rows={2} />
            </Field>
            <Field label="任务截止日期">
              <input
                name="dueDate"
                type="date"
                defaultValue={plan?.dueDate || addDays(week, 4)}
                required
              />
            </Field>
            {temporary && (
              <Field label="临时工作原因">
                <textarea
                  name="temporaryReason"
                  required
                  rows={3}
                  placeholder="说明来源、紧急性及为什么尚未列入月度目标"
                />
              </Field>
            )}
          </>
        )}
        <Field label="本周承诺">
          <textarea
            name="commitment"
            rows={3}
            required
            placeholder="描述本周预计推进到的程度和交付结果"
          />
        </Field>
        <label className="checkbox-label">
          <input
            type="checkbox"
            name="submitted"
            checked={includeInStatistics}
            onChange={event => setIncludeInStatistics(event.target.checked)}
          />
          正式保存该条计划（适用审核时，通过后纳入周统计）
        </label>
        <p className="form-hint">
          未发布月度目标下的记录请先保存草稿。成员自行安排或管理员代录的计划按生效规则提交审核；管理员正式下发视为已确认。完成周工作后，月度成果仍需单独验收。
        </p>
      </Form>
    </Modal>
  )
}
