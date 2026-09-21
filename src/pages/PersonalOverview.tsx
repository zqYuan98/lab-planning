import { Activity, AlertCircle, CalendarDays, ChevronRight, Target } from 'lucide-react'
import { ContextHelp, PriorityBadge, TaskLegend, WorkTypeBadge } from '../components/TaskSignals'
import { taskPriority } from '../task-presentation'
import Button from '@arco-design/web-react/es/Button'
import type { MonthlyPlan, WeeklyRecord } from '../../shared/types'
import { isEffectiveWeeklyRecord } from '../../shared/weekly-record-state'
import { weeklyRecordState } from '../weekly-submission-flow'
import type { Navigate } from '../navigation'
import { buildOverview } from '../overview-data'
import { nameOf, type PageProps } from '../ui'
import '../overview.css'

const planLabels: Record<MonthlyPlan['status'], string> = {
  draft: '草稿',
  submitted: '待审核',
  returned: '待修改',
  approved: '待发布',
  published: '已发布',
  merged: '已合并',
}
const weekLabels: Record<WeeklyRecord['status'], string> = {
  planned: '未开始',
  doing: '推进中',
  blocked: '阻塞',
  done: '自报完成',
  not_done: '未完成',
}
const dateLabel = (value: string) =>
  Number(value.slice(5, 7)) + '.' + Number(value.slice(8, 10))
function changeLabel(value: number | null, period: string) {
  return value === null
    ? '暂无对比'
    : value === 0
      ? '与' + period + '持平'
      : '较' + period + (value > 0 ? '增加' : '减少') + ' ' + Math.abs(value)
}

export default function Overview({
  data,
  navigate,
}: PageProps & { navigate: Navigate }) {
  const manager = data.user.role === 'manager'
  const view = buildOverview(data)
  const currentWeek = view.weeks.find((week) => week.isCurrent)?.index ?? 1
  const planAction = () =>
    navigate('monthly', {
      month: view.month,
      ...(manager ? { action: 'publish' as const } : {}),
    })
  const weeklyAction = () =>
    navigate('weekly', { action: 'create', weekStart: view.weekStart })
  const reviewAction = () =>
    navigate('monthly', {
      month: view.month,
      ...(manager ? { action: 'review' as const } : { status: 'submitted' }),
    })
  const rankRecord = (record: WeeklyRecord) =>
    !isEffectiveWeeklyRecord(record)
      ? 2
      : record.status === 'blocked'
        ? 0
        : record.status === 'not_done'
          ? 1
          : record.status === 'doing'
            ? 3
            : 4
  const focusRecords = [...view.records]
    .sort((a, b) => rankRecord(a) - rankRecord(b))
    .slice(0, 3)
  function openPlan(plan: MonthlyPlan) {
    navigate('monthly', {
      month: view.month,
      id: plan.id,
      ...(manager && plan.status === 'submitted'
        ? { action: 'review' as const }
        : manager && plan.status === 'approved'
          ? { action: 'publish' as const }
          : {}),
    })
  }
  const reminders = [
    {
      count: view.drafts.length,
      title: '条周安排尚未生效',
      note: '草稿待核对，适用审核的计划通过后纳入统计',
      action: () =>
        navigate('weekly', { weekStart: view.weekStart }),
    },
    {
      count: view.pending.length,
      title: '项月度目标等待审核',
      note: manager ? '审核通过后可发布' : '查看当前审核状态',
      action: reviewAction,
    },
    {
      count: view.returned.length,
      title: '项目标待管理员调整',
      note: manager
        ? '查看退回说明，完善目标后发布'
        : '发布后可继续安排个人任务',
      action: () =>
        navigate('monthly', { month: view.month, status: 'returned' }),
    },
    {
      count: view.blocked.length,
      title: '条阻塞需要协调',
      note: '查看成员填写的阻塞原因',
      action: () =>
        navigate('weekly', { weekStart: view.weekStart, status: 'blocked' }),
      urgent: true,
    },
    {
      count: view.notDone.length,
      title: '条周记录未完成',
      note: '查看原因和后续安排',
      action: () =>
        navigate('weekly', { weekStart: view.weekStart, status: 'not_done' }),
    },
    {
      count: manager ? view.awaitingAcceptance.length : 0,
      title: '项月度成果待验收',
      note: '按已发布的验收标准确认',
      action: () =>
        navigate('monthly', {
          month: view.month,
          id: view.awaitingAcceptance[0]?.id,
        }),
    },
    {
      count: manager ? view.missingMembers.length : 0,
      title: '位成员尚未关联本月目标',
      note: '查看目标与成员分工',
      action: () => navigate('monthly', { month: view.month }),
    },
  ].filter((item) => item.count > 0)

  return (
    <div className="overview-page">
      <header className="ov-page-heading">
        <div>
          <h1>{manager ? '部门概览' : '我的工作台'}</h1>
          <p>
            {manager
              ? '本月目标与本周进展'
              : '聚焦本周，推进重要的工作'}
          </p>
        </div>
        <div className="ov-period">
          <strong>
            {view.month.slice(0, 4)} 年 {Number(view.month.slice(5))} 月
          </strong>
          <span>
            第 {currentWeek} 周 · {dateLabel(view.weekStart)} 起
          </span>
        </div>
      </header>

      <section className="ov-metrics" aria-label="当前可见范围的工作指标">
        <button
          className="ov-stat"
          data-tone="blue"
          aria-describedby="ov-metric-1-value ov-metric-1-detail ov-metric-1-context"
          aria-label="查看本月已发布计划"
          onClick={() =>
            navigate('monthly', { month: view.month, status: 'published' })
          }
        >
          <span className="ov-stat-label">
            本月已发布目标 <Target size={17} />
          </span>
          <strong id="ov-metric-1-value">
            {view.published.length}
            <small>项</small>
          </strong>
          <span id="ov-metric-1-detail" className="ov-stat-detail">
            {view.accepted.length} 项已验收
          </span>
          <span id="ov-metric-1-context" className="ov-stat-context">
            {changeLabel(view.monthChange, '上月')}
          </span>
        </button>
        <button
          className="ov-stat"
          data-tone="green"
          aria-describedby="ov-metric-2-value ov-metric-2-detail ov-metric-2-context"
          aria-label="查看本周执行记录"
          onClick={() => navigate('weekly', { weekStart: view.weekStart })}
        >
          <span className="ov-stat-label">
            本周执行 <Activity size={17} />
          </span>
          <strong id="ov-metric-2-value">
            {view.submitted.length}
            <small>条</small>
          </strong>
          <span id="ov-metric-2-detail" className="ov-stat-detail">
            {view.submitted.filter((record) => record.status === 'done').length}{' '}
            条自报完成
          </span>
          <span id="ov-metric-2-context" className="ov-stat-context">
            {changeLabel(view.weekChange, '上周')}
          </span>
        </button>
        <button
          className="ov-stat"
          data-tone="amber"
          aria-describedby="ov-metric-3-value ov-metric-3-detail ov-metric-3-context"
          aria-label={manager ? '审核待处理月度目标' : '查看等待审核的月度目标'}
          onClick={reviewAction}
        >
          <span className="ov-stat-label">
            {manager ? '待我审核' : '等待审核'} <CalendarDays size={17} />
          </span>
          <strong id="ov-metric-3-value">
            {view.pending.length}
            <small>项</small>
          </strong>
          <span id="ov-metric-3-detail" className="ov-stat-detail">
            本月共 {view.reviewScope.length} 项提交审核
          </span>
          <span id="ov-metric-3-context" className="ov-stat-context">
            月度目标审核
          </span>
        </button>
        <button
          className={'ov-stat' + (view.blocked.length ? ' has-blocker' : '')}
          data-tone="red"
          aria-describedby="ov-metric-4-value ov-metric-4-detail ov-metric-4-context"
          aria-label="查看本周阻塞记录"
          onClick={() =>
            navigate('weekly', { weekStart: view.weekStart, status: 'blocked' })
          }
        >
          <span className="ov-stat-label">
            待解除阻塞 <AlertCircle size={17} />
          </span>
          <strong id="ov-metric-4-value">
            {view.blocked.length}
            <small>条</small>
          </strong>
          <span id="ov-metric-4-detail" className="ov-stat-detail">
            本周共 {view.submitted.length} 条已纳入周统计
          </span>
          <span id="ov-metric-4-context" className="ov-stat-context">
            {view.notDone.length
              ? '另 ' + view.notDone.length + ' 条未完成'
              : '根据成员提交的状态统计'}
          </span>
        </button>
      </section>
      <TaskLegend />

      <div className="ov-workspace">
        <div className="ov-work-lists">
          <section className="ov-section" aria-labelledby="ov-monthly-title">
            <div className="ov-section-heading">
              <h2 id="ov-monthly-title">
                <Target size={18} aria-hidden="true" /> 月度目标<span>{view.plans.length}</span>
              </h2>
              <Button
                type="text"
                onClick={() => navigate('monthly', { month: view.month })}
              >
                查看全部
                <ChevronRight size={14} />
              </Button>
            </div>
            {view.plans.length ? (
              view.focusPlans.slice(0, 3).map((plan) => (
                <button
                  key={plan.id}
                  className={`ov-work-item task-priority-${plan.priority} task-kind-${plan.isTemporary ? 'temporary' : 'monthly'}`}
                  onClick={() => openPlan(plan)}
                >
                  <span className="ov-item-copy">
                    <span className="task-signals">
                      <PriorityBadge priority={plan.priority} />
                      <WorkTypeBadge isTemporary={plan.isTemporary} isMonthly />
                    </span>
                    <strong>{plan.title}</strong>
                    <small>
                      {nameOf(data, plan.ownerId)} · {dateLabel(plan.dueDate)}{' '}
                      截止
                    </small>
                  </span>
                  <span
                    className={
                      'ov-state' +
                      (['submitted', 'returned', 'approved'].includes(
                        plan.status,
                      )
                        ? ' is-pending'
                        : '')
                    }
                  >
                    {planLabels[plan.status]}
                    {plan.acceptanceStatus === 'accepted' ? ' · 已验收' : ''}
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))
            ) : (
              <div className="ov-empty">
                <strong>本月暂无目标</strong>
                <p>
                  {manager
                    ? '发布月度目标，明确交付内容、责任人和截止日期。'
                    : '月度目标发布后，可关联本人参与的目标。'}
                </p>
              </div>
            )}
            {!view.published.length && (
              <div className="ov-section-action">
                <Button type="primary" onClick={planAction}>
                  {manager ? '去发布月度目标' : '查看我参与的目标'}
                </Button>
              </div>
            )}
          </section>

          <section className="ov-section" aria-labelledby="ov-weekly-title">
            <div className="ov-section-heading">
              <h2 id="ov-weekly-title">
                <Activity size={18} aria-hidden="true" /> 本周执行<span>{view.records.length}</span>
              </h2>
              <Button
                type="text"
                onClick={() =>
                  navigate('weekly', { weekStart: view.weekStart })
                }
              >
                查看全部
                <ChevronRight size={14} />
              </Button>
            </div>
            {focusRecords.length ? (
              focusRecords.map((record) => {
                const task = data.tasks.find((item) => item.id === record.taskId)
                const plan = data.plans.find((item) => item.id === record.monthlyPlanId)
                const priority = taskPriority(task, plan)
                const isTemporary = Boolean(task?.isTemporary || task?.temporaryReason?.trim() || plan?.isTemporary)
                return (
                <button
                  key={record.id}
                  className={`ov-work-item task-priority-${priority || 'none'} task-kind-${isTemporary ? 'temporary' : record.monthlyPlanId ? 'monthly' : 'routine'}`}
                  onClick={() =>
                    navigate('weekly', {
                      id: record.id,
                      weekStart: view.weekStart,
                    })
                  }
                >
                  <span className="ov-item-copy">
                    <span className="task-signals">
                      <PriorityBadge priority={priority} />
                      <WorkTypeBadge isTemporary={isTemporary} monthlyPlanId={record.monthlyPlanId} />
                    </span>
                    <strong>
                      {task?.title || record.commitment}
                    </strong>
                    <small>
                      {nameOf(data, record.ownerId)} ·{' '}
                      {record.monthlyPlanId
                        ? data.plans.find(
                            (plan) => plan.id === record.monthlyPlanId,
                          )?.title || '关联月度目标'
                        : '未关联目标'}
                    </small>
                  </span>
                  <span
                    className={
                      'ov-state' +
                      (isEffectiveWeeklyRecord(record) &&
                      ['blocked', 'not_done'].includes(record.status)
                        ? ' is-blocked'
                        : '')
                    }
                  >
                    {isEffectiveWeeklyRecord(record)
                      ? weekLabels[record.status]
                      : weeklyRecordState(record).label}
                  </span>
                  <ChevronRight size={14} />
                </button>
              )})
            ) : (
              <div className="ov-empty">
                <strong>本周暂无执行记录</strong>
                <p>
                  {view.published.length
                    ? '关联月度目标，填写本周任务和预期交付。'
                    : '可先记录本周安排，月度目标发布后再关联。'}
                </p>
              </div>
            )}
            <div className="ov-section-action">
              <Button
                type={view.published.length ? 'primary' : 'secondary'}
                onClick={weeklyAction}
              >
                安排本周工作
              </Button>
              <span>阻塞与待处理优先</span>
            </div>
          </section>
        </div>

        <aside className="ov-side">
          <section
            className="ov-section ov-reminders"
            aria-labelledby="ov-reminders-title"
          >
            <div className="ov-section-heading">
              <h2 id="ov-reminders-title">待处理事项</h2>
            </div>
            {reminders.length ? (
              reminders.map((item) => (
                <button
                  key={item.title}
                  className="ov-reminder"
                  onClick={item.action}
                >
                  <span>
                    <strong className={item.urgent ? 'is-blocked' : ''}>
                      {item.count} {item.title}
                    </strong>
                    <small>{item.note}</small>
                  </span>
                  <ChevronRight size={14} />
                </button>
              ))
            ) : (
              <p className="ov-empty-note">当前没有待处理事项。</p>
            )}
          </section>
          <section
            className="ov-section ov-rhythm"
            aria-labelledby="ov-rhythm-title"
          >
            <div className="ov-section-heading">
              <h2 id="ov-rhythm-title">本月周次</h2>
              <Button
                type="text"
                aria-label="查看本周计划"
                onClick={() =>
                  navigate('weekly', { weekStart: view.weekStart })
                }
              >
                本周
                <ChevronRight size={14} />
              </Button>
            </div>
            <div className="ov-week-list">
              {view.weeks.map((week) => (
                <button
                  key={week.weekStart}
                  className={
                    'ov-week-row' + (week.isCurrent ? ' is-current' : '')
                  }
                  onClick={() =>
                    navigate('weekly', { weekStart: week.weekStart })
                  }
                  aria-label={
                    '第 ' +
                    week.index +
                    ' 周，' +
                    week.startDate +
                    ' 至 ' +
                    week.endDate +
                    '，' +
                    (week.state === 'empty'
                      ? '暂无记录'
                      : week.submitted +
                        ' 条已纳入周统计，' +
                        week.done +
                        ' 条自报完成，' +
                        week.drafts +
                        ' 条草稿或待审计划')
                  }
                >
                  <span className="ov-week-number">
                    第 {week.index} 周{week.isCurrent && <small>本周</small>}
                  </span>
                  <span className="ov-week-dates">
                    {dateLabel(week.startDate)} 至 {dateLabel(week.endDate)}
                  </span>
                  <span className="ov-week-status">
                    {week.state === 'empty'
                      ? '暂无记录'
                      : week.state === 'draft'
                        ? week.drafts + ' 条草稿 / 待审'
                        : week.done + '/' + week.submitted + ' 自报完成'}
                  </span>
                </button>
              ))}
            </div>
          </section>
        </aside>
      </div>

      <nav className="ov-shortcuts" aria-label="快捷入口">
        <span>快捷入口</span>
        <Button
          type="text"
          onClick={() =>
            manager
              ? navigate('reports', {
                  action: 'write-weekly',
                  weekStart: view.weekStart,
                })
              : weeklyAction()
          }
        >
          {manager ? '写周报' : '安排本周'}
        </Button>
        <Button
          type="text"
          onClick={() =>
            manager
              ? navigate('projects', { action: 'create' })
              : navigate('monthly', { month: view.month })
          }
        >
          {manager ? '建项目' : '查看月度目标'}
        </Button>
        <Button
          type="text"
          onClick={() => navigate(manager ? 'reports' : 'projects')}
        >
          {manager ? '看报告' : '查看项目'}
        </Button>
      </nav>
      <ContextHelp title="统计口径与说明">
        统计范围为当前账号可访问的本月目标与本周记录。草稿和待审核计划不计入正式执行；历史记录不足时不作趋势对比。周执行由成员自报，月度成果由管理者独立验收。
      </ContextHelp>
    </div>
  )
}
