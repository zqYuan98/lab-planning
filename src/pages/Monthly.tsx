import { useState } from 'react'
import { canUseAccount } from '../../shared/auth-policy'
import { accountDisplayName, assignmentAccounts, visibleMonthlyPlan } from '../account-options'
import WorkflowGuide from '../components/WorkflowGuide'
import NotificationStatus from '../components/NotificationStatus'
import { PriorityBadge, WorkTypeBadge, TaskLegend, ContextHelp } from '../components/TaskSignals'
import { taskPriority, workKind } from '../task-presentation'
import {
  Plus,
  Send,
  History,
  Search,
  GitBranch,
  CheckCircle2,
} from 'lucide-react'
import type { AuditEvent, MonthlyPlan, Task } from '../../shared/types'
import type { Navigate } from '../navigation'
import { api, json, finishSaved } from '../api'
import MergeProposals from './MergeProposals'
import {
  Badge,
  Empty,
  Field,
  Form,
  Modal,
  PageHeader,
  currentMonth,
  nameOf,
  projectOf,
  dateTime,
  useAction,
  type PageProps,
} from '../ui'

const statuses: Record<string, string> = {
  draft: '草稿',
  submitted: '待审核',
  returned: '退回修改',
  approved: '审核通过',
  published: '已发布',
  merged: '已合并',
}
const results: Record<string, string> = {
  pending: '待交付',
  submitted: '待验收',
  accepted: '已验收',
  not_completed: '未完成',
}
const tones: Record<string, string> = {
  draft: 'neutral',
  submitted: 'amber',
  returned: 'red',
  approved: 'blue',
  published: 'green',
  merged: 'neutral',
}
export default function Monthly({ data, refresh, notify, intent, navigate }: PageProps & { navigate?: Navigate }) {
  const manager = data.user.role === 'manager'
  const archivedProjectIds = new Set(
    data.projects
      .filter((project) => project.status === 'archived')
      .map((project) => project.id),
  )
  const canPublish = (plan: MonthlyPlan) =>
    plan.status === 'approved' &&
    (!plan.projectId || !archivedProjectIds.has(plan.projectId))
  const canEdit = (plan: MonthlyPlan) => !plan.visibility && plan.status !== 'merged' &&
    (manager || (plan.isTemporary && plan.ownerId === data.user.id && ['draft', 'returned'].includes(plan.status)))
  const canCreateOwnTask = (plan: MonthlyPlan) => !plan.visibility && plan.status !== 'merged' &&
    (!plan.projectId || !archivedProjectIds.has(plan.projectId)) &&
    (plan.ownerId === data.user.id || plan.collaboratorIds.includes(data.user.id))
  const initialMonth = intent?.month || currentMonth()
  const initialPlan = data.plans.find((plan) => plan.id === intent?.id)
  const [includeInactive, setIncludeInactive] = useState(!!initialPlan && !visibleMonthlyPlan(initialPlan, data.users))
  const readyToPublish =
    manager &&
    intent?.action === 'publish' &&
    data.plans.some((plan) => plan.month === initialMonth && canPublish(plan))
  const [month, setMonth] = useState(initialPlan?.month || initialMonth),
    [filter, setFilter] = useState(
      intent?.action === 'review' ? 'submitted' : intent?.status || 'all',
    ),
    [search, setSearch] = useState(intent?.query || '')
  const [modal, setModal] = useState(
      initialPlan
        ? intent?.action === 'create-task' && canCreateOwnTask(initialPlan) ? 'task' : 'detail'
        : manager && intent?.action === 'create'
          ? 'create'
          : readyToPublish
            ? 'publish'
            : '',
    ),
    [selected, setSelected] = useState<MonthlyPlan | null>(initialPlan || null),
    [history, setHistory] = useState<AuditEvent[] | null>(null)
  const action = useAction(refresh, notify)
  const [createdPersonalTask, setCreatedPersonalTask] = useState<Task | null>(null)
  const monthPlans = data.plans.filter((plan) => plan.month === month && visibleMonthlyPlan(plan, data.users, includeInactive))
  const filtered = monthPlans.filter(
    (plan) =>
      (filter === 'all' || plan.status === filter) &&
      `${plan.title}${nameOf(data, plan.ownerId)}${projectOf(data, plan.projectId)}`.includes(
        search,
      ),
  )
  const approved = data.plans.filter(plan => plan.month === month && canPublish(plan))
  const publications = data.publications
    .filter((value) => value.month === month)
    .sort((a, b) => b.revision - a.revision)
  const groups = new Map<string, MonthlyPlan[]>()
  for (const plan of filtered) {
    const group = projectOf(data, plan.projectId)
    groups.set(group, [...(groups.get(group) || []), plan])
  }
  const close = () => {
    setModal('')
    setSelected(null)
    setHistory(null)
    setCreatedPersonalTask(null)
  }
  const saved = async (message: string) => finishSaved(async () => {
    await refresh()
    notify(message)
    close()
  })
  function open(type: string, plan: MonthlyPlan) {
    setCreatedPersonalTask(null)
    setSelected(plan)
    setModal(type)
  }
  return (
    <>
      <PageHeader
        eyebrow="PLANNING / MONTHLY"
        title={manager ? '月度目标' : '我参与的月度目标'}
        description={manager ? '聚焦月度交付，让团队优先级清晰可见。' : '追踪参与目标，将月度成果拆成每周行动。'}
        actions={
          <>
            {manager && (
              <button
                className="button secondary"
                onClick={() => setModal('merge')}
              >
                合并提报
              </button>
            )}
            <button
              className="button secondary"
              onClick={() => setModal('versions')}
            >
              <GitBranch size={16} />
              发布版本{publications.length > 0 && ` ${publications.length}`}
            </button>
            <button
              className={manager ? 'button secondary' : 'button primary'}
              onClick={() => setModal('temporary')}
            >
              <Plus size={17} />
              新增临时目标
            </button>
            {manager && <button
              className="button primary"
              onClick={() => setModal('create')}
            >
              <Plus size={17} />
              新增月度目标
            </button>}
          </>
        }
      />
      <WorkflowGuide title="月度目标流转说明">
        <div className="workflow-strip">
          <span>01 定义目标 / 提报临时目标</span>
          <i>→</i>
          <span>02 明确负责人与参与人员</span>
          <i>→</i>
          <span>03 审核并发布承诺</span>
          <i>→</i>
          <span>04 每周执行</span>
          <i>→</i>
          <span>05 成果验收</span>
        </div>
        <p className="muted">临时目标可持续多周。长期事项按月记录阶段成果，未完成时由管理者跨月承接，保留各月结果。</p>
      </WorkflowGuide>
      <div className="toolbar">
        <div className="toolbar-left">
          <Field label="计划月份">
            <input
              type="month"
              value={month}
              onChange={(event) => setMonth(event.target.value)}
              required
            />
          </Field>
          <label className="search-input">
            <Search size={17} />
            <input
              aria-label="搜索计划、项目或负责人"
              placeholder="搜索计划、项目或负责人"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
          <label className="checkbox-label">
            <input type="checkbox" checked={includeInactive} onChange={event => setIncludeInactive(event.target.checked)} />
            包含停用成员
          </label>
        </div>
        {manager && (
          <button
            className="button primary"
            disabled={!approved.length || action.busy}
            onClick={() => setModal('publish')}
          >
            <Send size={16} />
            发布已审核计划{approved.length ? `（${approved.length}）` : ''}
          </button>
        )}
      </div>
      <div className="tabs" role="group" aria-label="计划状态筛选">
        {[['all', '全部'], ...Object.entries(statuses)].map(
          ([value, label]) => (
            <button
              className={filter === value ? 'selected' : ''}
              key={value}
              onClick={() => setFilter(value)}
            >
              {label}
              <span>
                {
                  monthPlans.filter(
                    (plan) => value === 'all' || plan.status === value,
                  ).length
                }
              </span>
            </button>
          ),
        )}
      </div>
      <TaskLegend />
      {action.error && (
        <div className="error" role="alert">
          {action.error}
        </div>
      )}
      {filtered.length ? (
        <div className="plan-groups">
          {Array.from(groups.entries()).map(([group, plans]) => (
            <section className="panel" key={group}>
              <div className="section-heading">
                <h2>{group}</h2>
                <span className="muted">{plans.length} 项成果</span>
              </div>
              <div className="table-scroll" role="region" aria-label={`${group}月度目标，可横向滚动`} tabIndex={0}>
                <table>
                  <thead>
                    <tr>
                      <th className="wide-cell">本月交付与验收要求</th>
                      <th>责任人 / 截止</th>
                      <th>计划状态</th>
                      <th>成果状态</th>
                      <th className="actions-cell">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {plans.map((plan) => (
                      <tr key={plan.id} className={`task-priority-${taskPriority(undefined, plan) || 'none'} task-kind-${workKind({ isTemporary: plan.isTemporary, isMonthly: true })}`}>
                        <td>
                          <button
                            className="table-title"
                            onClick={() => open('detail', plan)}
                          >
                            {plan.title}
                          </button>
                          <p className="cell-description task-preview" title={plan.expectedOutcome}>
                            {plan.expectedOutcome ||
                              (plan.importSource ? '预期成果：原表未注明' : '')}
                          </p>
                          <div className="row-meta">
                            <PriorityBadge priority={plan.priority} />
                            <WorkTypeBadge isTemporary={plan.isTemporary} isMonthly />
                            <span>{plan.category}</span>
                            {plan.importSource && (
                              <Badge tone="blue">已有计划导入</Badge>
                            )}
                            {plan.importSource?.sourceStatus && (
                              <span>
                                原文：{plan.importSource.sourceStatus}
                              </span>
                            )}
                            {plan.sourcePlanId && <Badge>跨月承接</Badge>}
                            {plan.projectId &&
                              archivedProjectIds.has(plan.projectId) && (
                                <Badge>项目已归档</Badge>
                              )}
                            {plan.publishedVersion && (
                              <span>发布 V{plan.publishedVersion}</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <strong>{nameOf(data, plan.ownerId)}</strong>
                          <small className="cell-date">
                            {plan.dueDate ||
                              (plan.importSource ? '截止日期：原表未注明' : '')}
                          </small>
                          {plan.collaboratorIds.length > 0 && (
                            <small className="cell-date">
                              协作：
                              {plan.collaboratorIds
                                .map((id) => nameOf(data, id))
                                .join('、')}
                            </small>
                          )}
                        </td>
                        <td>
                          <Badge tone={tones[plan.status]}>
                            {statuses[plan.status]}
                          </Badge>
                          {plan.reviewComment && (
                            <p className="cell-description review-comment">
                              {plan.reviewComment}
                            </p>
                          )}
                        </td>
                        <td>
                          <Badge
                            tone={
                              plan.acceptanceStatus === 'accepted'
                                ? 'green'
                                : plan.acceptanceStatus === 'submitted'
                                  ? 'amber'
                                  : 'neutral'
                            }
                          >
                            {results[plan.acceptanceStatus]}
                          </Badge>
                        </td>
                        <td>
                          <div className="row-actions">
                            {canEdit(plan) && (
                                <button onClick={() => open('edit', plan)}>
                                  编辑
                                </button>
                              )}
                            {['draft', 'returned'].includes(plan.status) &&
                              (!plan.projectId ||
                                !archivedProjectIds.has(plan.projectId)) &&
                              canEdit(plan) && (
                                <button
                                  disabled={action.busy}
                                  onClick={() =>
                                    void action.run(
                                      () =>
                                        api(
                                          `/plans/${plan.id}/submit`,
                                          json({ version: plan.version }),
                                        ),
                                      '月度目标已提交审核',
                                    )
                                  }
                                >
                                  提交
                                </button>
                              )}
                            {manager && plan.status === 'submitted' && (
                              <button onClick={() => open('review', plan)}>
                                审核
                              </button>
                            )}
                            {!plan.visibility && plan.status === 'published' &&
                              (manager ||
                                (plan.ownerId === data.user.id &&
                                  plan.acceptanceStatus !== 'accepted')) && (
                                <button onClick={() => open('result', plan)}>
                                  {manager ? '成果验收' : '提交成果'}
                                </button>
                              )}
                            {plan.status === 'published' &&
                              plan.acceptanceStatus !== 'accepted' &&
                              (!plan.projectId ||
                                !archivedProjectIds.has(plan.projectId)) &&
                              manager && (
                                <button onClick={() => open('carry', plan)}>
                                  跨月承接
                                </button>
                              )}
                            {canCreateOwnTask(plan) && <button onClick={() => open('task', plan)}>关联个人任务</button>}
                            <button
                              onClick={() => {
                                open('history', plan)
                                void api<AuditEvent[]>(
                                  `/plans/${plan.id}/history`,
                                )
                                  .then(setHistory)
                                  .catch((error) => {
                                    close()
                                    notify(error.message)
                                  })
                              }}
                            >
                              历史
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}
        </div>
      ) : (
        <div className="panel">
          <Empty
            title={
              search || filter !== 'all'
                ? '没有符合条件的计划'
                : manager ? '从第一个团队月度目标开始' : '本月暂无你参与的月度目标'
            }
            description={manager ? '指定负责人和参与人员，明确预期成果与验收标准。' : '可提报本人的临时月度目标，或参与管理者发布的团队目标。'}
            action={
              <button
                className="button secondary"
                onClick={() => setModal(manager ? 'create' : 'temporary')}
              >
                <Plus size={16} />
                {manager ? '新增月度目标' : '新增临时目标'}
              </button>
            }
          />
        </div>
      )}
      {manager && modal === 'merge' && (
        <MergeProposals
          data={data}
          month={month}
          onClose={close}
          onSaved={saved}
        />
      )}
      {(modal === 'temporary' || (manager && modal === 'create') || (modal === 'edit' && selected && canEdit(selected))) && (
        <PlanEditor
          data={data}
          month={month}
          plan={selected}
          temporary={modal === 'temporary' || !!selected?.isTemporary}
          onClose={close}
          onSaved={saved}
        />
      )}
      {modal === 'task' && selected && canCreateOwnTask(selected) && <Modal title="关联目标，建立个人任务" onClose={close}>
        <p className="modal-intro">月度目标：{selected.title}<br />月份：{selected.month} · 项目：{projectOf(data, selected.projectId)}<br />任务负责人：{data.user.name}</p>
        {selected.status !== 'published' && <p className="form-hint">目标当前为「{statuses[selected.status]}」，尚未发布。可先建立个人任务并保存周草稿，发布后才能正式排周。</p>}
        <Form onCancel={close} submitLabel={createdPersonalTask ? '重试加载已保存任务' : intent?.action === 'create-task' && navigate ? '建立任务并安排周工作' : '保存个人任务'} onSubmit={async event => {
          const values = Object.fromEntries(new FormData(event.currentTarget))
          const { workSource, ...fields } = values
          const task = createdPersonalTask ?? await api<Task>('/tasks', json({ ...fields, monthlyPlanId: selected.id,
            ...(workSource ? { workSource } : {}),
            requestedOutcome: selected.expectedOutcome || '',
          }))
          setCreatedPersonalTask(task)
          try { await saved('个人任务已建立，可在周计划中安排每周工作') }
          catch { throw new Error('个人任务已保存，但清单刷新失败。请重试加载已保存任务，无需重复建立。') }
          if (intent?.action === 'create-task' && navigate) navigate('weekly', { action: 'create', id: task.id, ownerId: task.ownerId, weekStart: intent.weekStart })
        }}>
          <fieldset className="form-fields" disabled={!!createdPersonalTask}>
          <Field label="个人任务名称"><input name="title" defaultValue={selected.title} required maxLength={300} /></Field>
          <Field label="个人交付说明"><textarea name="description" defaultValue={selected.expectedOutcome} rows={3} /></Field>
          <Field label="事项来源" hint="按明确交办背景填写，临时目标不会自动当作领导交办。"><select name="workSource" defaultValue={selected.workSource || ''}><option value="">来源待核对</option><option value="leader">领导交办</option><option value="self">自主安排</option><option value="coordination">协同事项</option></select></Field>
          <Field label="交办人 / 对接人"><input name="assignedBy" defaultValue={selected.assignedBy || ''} maxLength={100} /></Field>
          <Field label="交办日期"><input name="assignedOn" type="date" defaultValue={selected.assignedOn || ''} /></Field>
          <Field label="截止日期" hint="尚未确定时可留空，工作清单显示待确认。"><input name="dueDate" type="date" defaultValue={selected.dueDate} /></Field>
          </fieldset>
        </Form>
      </Modal>}
      {manager && modal === 'publish' && (
        <Modal title="发布部门月度目标" onClose={close}>
          <p className="modal-intro">
            将 {month} 有效项目及部门工作中已审核通过的 {approved.length}{' '}
            项成果发布为部门承诺。成员可据此提交正式周计划。
          </p>
          <div className="compact-list">
            {approved.map((plan) => (
              <div key={plan.id}>
                <CheckCircle2 size={16} />
                <span>{plan.title}</span>
                <small>{nameOf(data, plan.ownerId)}</small>
              </div>
            ))}
          </div>
          <Form
            onCancel={close}
            submitLabel="确认发布"
            onSubmit={async (event) => {
              const form = new FormData(event.currentTarget)
              await api(
                `/months/${month}/publish`,
                json({
                  planIds: approved.map((plan) => plan.id),
                  reason: form.get('reason'),
                }),
              )
              await saved('部门月度目标已发布')
            }}
          >
            <Field
              label="发布说明"
              hint={
                publications.length
                  ? '补充发布请说明新增范围。'
                  : '可选，记录本次月度安排的重点。'
              }
            >
              <textarea
                name="reason"
                rows={3}
                required={publications.length > 0}
              />
            </Field>
          </Form>
        </Modal>
      )}
      {modal === 'review' && selected && (
        <Modal title="审核月度提报" onClose={close}>
          <p className="modal-intro">
            <strong>{selected.title}</strong>
            <br />
            {selected.expectedOutcome}
          </p>
          <Form
            onCancel={close}
            submitLabel="提交审核意见"
            onSubmit={async (event) => {
              const values = Object.fromEntries(
                new FormData(event.currentTarget),
              )
              if (
                values.decision === 'return' &&
                !String(values.comment).trim()
              )
                throw new Error('退回时请填写修改意见。')
              await api(
                `/plans/${selected.id}/review`,
                json({ version: selected.version, ...values }),
              )
              await saved('审核意见已保存')
            }}
          >
            <Field label="审核结果">
              <select name="decision">
                <option value="approve">审核通过，等待发布</option>
                <option value="return">退回成员修改</option>
              </select>
            </Field>
            <Field label="审核意见">
              <textarea
                name="comment"
                rows={4}
                placeholder="说明通过的范围，或需要补充的内容"
              />
            </Field>
          </Form>
        </Modal>
      )}
      {modal === 'result' && selected && (
        <Modal
          title={manager ? '确认月度成果' : '提交本月成果'}
          onClose={close}
        >
          <div className="context-box">
            <strong>{selected.title}</strong>
            <p>
              验收标准：
              {selected.acceptanceCriteria ||
                (selected.importSource ? '原表未注明' : '')}
            </p>
          </div>
          <Form
            onCancel={close}
            submitLabel={manager ? '保存验收结论' : '提交管理者验收'}
            draftKey={`monthly-result:${data.user.id}:${selected.id}:v${selected.version}`}
            onSubmit={async (event) => {
              const values = Object.fromEntries(
                new FormData(event.currentTarget),
              )
              await api(
                `/plans/${selected.id}/result`,
                json({
                  ...values,
                  version: selected.version,
                  acceptanceStatus: manager
                    ? values.acceptanceStatus
                    : 'submitted',
                }),
              )
              await saved('月度成果已更新')
            }}
          >
            <Field label="实际交付成果">
              <textarea
                name="actualOutcome"
                defaultValue={selected.actualOutcome}
                rows={4}
                placeholder="描述已经交付的事实，避免重复计划内容"
              />
            </Field>
            {manager && (
              <Field label="验收结论">
                <select
                  name="acceptanceStatus"
                  defaultValue={
                    selected.acceptanceStatus === 'not_completed'
                      ? 'not_completed'
                      : 'accepted'
                  }
                >
                  <option value="accepted">达到验收标准，确认完成</option>
                  <option value="not_completed">未完成，保留本月结果</option>
                </select>
              </Field>
            )}
            <Field label={manager ? '验收说明 / 未完成原因' : '补充说明'}>
              <textarea
                name="acceptanceNote"
                defaultValue={selected.acceptanceNote}
                rows={3}
              />
            </Field>
          </Form>
        </Modal>
      )}
      {modal === 'carry' && selected && (
        <Modal title="承接到下月度目标" onClose={close}>
          <p className="modal-intro">
            保留 {selected.month} 的承诺和结果，新建有来源关系的月度草稿。
            {selected.isTemporary && '临时目标标记和原因将保留，请在承接草稿中调整新月份的阶段成果。'}
          </p>
          <Form
            onCancel={close}
            submitLabel="创建承接草稿"
            onSubmit={async (event) => {
              await api(
                `/plans/${selected.id}/carry`,
                json(Object.fromEntries(new FormData(event.currentTarget))),
              )
              await saved('跨月承接草稿已创建，审核发布后生效')
            }}
          >
            <div className="form-grid">
              <Field label="承接月份">
                <input type="month" name="month" required />
              </Field>
              <Field label="新的截止日期">
                <input type="date" name="dueDate" required />
              </Field>
            </div>
            <Field label="承接原因">
              <textarea name="reason" required rows={3} />
            </Field>
          </Form>
        </Modal>
      )}
      {modal === 'versions' && (
        <Modal title={`${month} 发布版本`} onClose={close} wide>
          {publications.length ? (
            <div className="timeline">
              {publications.map((publication) => (
                <div key={publication.id}>
                  <Badge tone="green">V{publication.revision}</Badge>
                  <h3>{publication.reason || '月度目标首次发布'}</h3>
                  <p>
                    {dateTime(publication.createdAt)} ·{' '}
                    {nameOf(data, publication.actorId)} ·{' '}
                    {publication.plans.length} 项已发布成果
                  </p>
                  <ul>
                    {publication.plans.map((plan) => (
                      <li key={plan.id}>
                        {plan.title} · {nameOf(data, plan.ownerId)} ·{' '}
                        {plan.dueDate}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          ) : (
            <Empty
              title="本月尚无发布版本"
              description="审核通过并发布后，系统会保存当时的完整承诺。"
            />
          )}
        </Modal>
      )}
      {modal === 'history' && selected && (
        <Modal title={`变更历史 · ${selected.title}`} onClose={close} wide>
          {history === null ? (
            <div className="loading-inline">正在读取历史记录…</div>
          ) : history.length ? (
            <div className="timeline">
              {history.map((event) => (
                <div key={event.id}>
                  <Badge>
                    {(
                      {
                        create: '创建',
                        submit: '提交审核',
                        review: '审核',
                        update: '修改',
                        publish: '发布',
                        result: '成果更新',
                        carry: '跨月承接',
                        approve: '审核通过',
                        return: '退回修改',
                        published_change: '发布后修订',
                        merge: '来源提报合并',
                        merge_create: '合并成果创建',
                      } as Record<string, string>
                    )[event.action] || event.action}
                  </Badge>
                  <h3>{event.reason || '计划状态已更新'}</h3>
                  <p>
                    {dateTime(event.createdAt)} · {nameOf(data, event.actorId)}
                  </p>
                  <HistoryDiff
                    before={event.before}
                    after={event.after}
                    data={data}
                  />
                </div>
              ))}
            </div>
          ) : (
            <Empty title="暂时没有历史记录" />
          )}
        </Modal>
      )}
      {modal === 'detail' && selected && (
        <Modal title={selected.title} onClose={close} wide>
          <div className="row-meta"><PriorityBadge priority={selected.priority} /><WorkTypeBadge isTemporary={selected.isTemporary} isMonthly /></div>
          {manager && <NotificationStatus type="plan" id={selected.id} data={data} />}
          {selected.isTemporary && (
            <div className="context-box">
              <Badge tone="amber">临时目标 · 本月阶段成果</Badge>
              <p>临时原因：{selected.temporaryReason}</p>
              <ContextHelp title="临时目标如何跨周与跨月">
                <p>可拆成多周执行；未完成时由管理者跨月承接，保留每月承诺和结果。</p>
              </ContextHelp>
            </div>
          )}
          {selected.importSource && (
            <p className="modal-intro">
              {selected.status === 'published' ? '已有计划导入，当前已发布，无需重新提报。' : `已有计划导入，当前状态为${statuses[selected.status]}。`}原文状态：
              {selected.importSource.sourceStatus || '原表未注明'}
              ；原有成果已保留，验收结论单独记录。
            </p>
          )}
          <div className="detail-grid">
            <div>
              <span>预期成果</span>
              <p>
                {selected.expectedOutcome ||
                  (selected.importSource ? '原表未注明' : '暂无')}
              </p>
            </div>
            <div>
              <span>验收标准</span>
              <p>
                {selected.acceptanceCriteria ||
                  (selected.importSource ? '原表未注明' : '暂无')}
              </p>
            </div>
            <div>
              <span>负责人 / 参与人员</span>
              <p>
                {nameOf(data, selected.ownerId)} /{' '}
                {selected.collaboratorIds
                  .map((id) => nameOf(data, id))
                  .join('、') || '暂无'}
              </p>
            </div>
            <div>
              <span>截止日期 / 状态</span>
              <p>
                {selected.dueDate ||
                  (selected.importSource ? '原表未注明' : '暂无')}{' '}
                ·{' '}
                {statuses[selected.status]}
              </p>
            </div>
            <div>
              <span>实际成果</span>
              <p>
                {selected.actualOutcome ||
                  (selected.importSource ? '原表未注明' : '尚未提交成果')}
              </p>
            </div>
            <div>
              <span>验收结论</span>
              <p>
                {results[selected.acceptanceStatus]} ·{' '}
                {selected.acceptanceNote ||
                  (selected.importSource
                    ? '原表未记录验收说明'
                    : '尚无验收说明')}
              </p>
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}
function PlanEditor({
  data,
  month,
  plan,
  temporary,
  onClose,
  onSaved,
}: {
  data: PageProps['data']
  month: string
  plan: MonthlyPlan | null
  temporary: boolean
  onClose: () => void
  onSaved: (message: string) => Promise<void>
}) {
  const manager = data.user.role === 'manager'
  const imported = !!plan?.importSource
  const categories = [
    '项目研发',
    '产品设计',
    '算法研究',
    '测试验证',
    '硬件研发',
    '运维保障',
    '培训分享',
    '申报管理',
    '部门管理',
    '其他工作',
  ]
  return (
    <Modal
      title={
        plan
          ? plan.status === 'published'
            ? '修订已发布计划'
            : temporary ? '编辑临时月度目标' : '编辑月度目标'
          : temporary ? '新增临时月度目标' : '新增月度目标'
      }
      onClose={onClose}
      wide
    >
      <Form
        onCancel={onClose}
        submitLabel={plan ? '保存计划' : '保存为草稿'}
        draftKey={`monthly-plan:${data.user.id}:${plan ? `${plan.id}:v${plan.version}` : `${month}:${temporary ? 'temporary' : 'regular'}:new`}`}
        onSubmit={async (event) => {
          const form = new FormData(event.currentTarget),
            values = Object.fromEntries(form)
          await api(
            plan ? `/plans/${plan.id}` : '/plans',
            json(
              {
                ...values,
                projectId: values.projectId || null,
                collaboratorIds: form.getAll('collaboratorIds'),
                ownerId: manager ? values.ownerId || plan?.ownerId : data.user.id,
                isTemporary: temporary,
                ...(plan ? { version: plan.version } : {}),
              },
              plan ? 'PATCH' : 'POST',
            ),
          )
          await onSaved(
            plan?.status === 'published'
              ? '修订已发布，发布版本和历史记录已保存'
              : '月度提报已保存',
          )
        }}
      >
        {temporary && <p className="modal-intro">按本月阶段填写成果和验收标准，可拆成多周推进。保存后提交管理者审核；未完成时可由管理者跨月承接。</p>}
        <div className="form-grid">
          <Field label="计划月份">
            <input
              name="month"
              type="month"
              defaultValue={plan?.month || month}
              required
              readOnly={!!plan}
            />
          </Field>
          <Field label="工作类别">
            <select
              name="category"
              defaultValue={plan ? plan.category : '项目研发'}
            >
              {imported && <option value="">原表未注明</option>}
              {plan?.category && !categories.includes(plan.category) && (
                <option value={plan.category}>{plan.category}</option>
              )}
              {categories.map((value) => (
                <option key={value}>{value}</option>
              ))}
            </select>
          </Field>
        </div>
        <Field label={temporary ? '本月阶段成果名称' : '本月成果名称'}>
          <input
            name="title"
            defaultValue={plan?.title}
            required
            maxLength={200}
            placeholder="例如：完成模型评测平台首版交付"
          />
        </Field>
        {temporary && <Field label="临时目标原因" hint="说明新增事项的背景；长期事项可同时描述整体目标及本月推进范围。">
          <textarea name="temporaryReason" defaultValue={plan?.temporaryReason} rows={3} required maxLength={12000} placeholder="例如：新增专项研究，预计持续三个月，本月完成方案验证" />
        </Field>}
        <div className="form-grid">
          <Field label="所属项目">
            <select name="projectId" defaultValue={plan?.projectId || ''}>
              <option value="">部门工作（无项目）</option>
              {data.projects
                .filter(
                  (project) =>
                    project.status === 'active' ||
                    project.id === plan?.projectId,
                )
                .map((project) => (
                  <option value={project.id} key={project.id}>
                    {project.name}
                    {project.status === 'archived' ? '（已归档）' : ''}
                  </option>
                ))}
            </select>
          </Field>
          <Field label="主要负责人">
            <select
              name="ownerId"
              defaultValue={plan?.ownerId || data.user.id}
              disabled={!manager}
            >
              {assignmentAccounts(data.users, plan ? [plan.ownerId] : [])
                .map((user) => (
                  <option key={user.id} value={user.id} disabled={!canUseAccount(user)}>
                    {accountDisplayName(user)}
                    {user.position ? ` · ${user.position}` : ''}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        {imported && (
          <p className="modal-intro">
            这条目标来自已有计划导入。原表未注明的预期成果、验收标准和截止日期可继续留空；修订保留原因和历史版本。
          </p>
        )}
        <Field label="预期交付成果">
          <textarea
            name="expectedOutcome"
            defaultValue={plan?.expectedOutcome}
            rows={3}
            required={!imported}
            placeholder="写清这个月结束时，将交付什么可核验的结果"
          />
        </Field>
        <Field label="验收标准">
          <textarea
            name="acceptanceCriteria"
            defaultValue={plan?.acceptanceCriteria}
            rows={3}
            required={!imported}
            placeholder="用质量标准、范围、指标或评审要求界定完成"
          />
        </Field>
        <div className="form-grid">
          <Field label={temporary ? '本月阶段截止日期' : '截止日期'} hint="截止日期须在所选月份内；未完成事项可跨月承接。">
            <input
              name="dueDate"
              type="date"
              defaultValue={plan?.dueDate}
              required={!imported}
            />
          </Field>
          <Field label="优先级">
            <select name="priority" defaultValue={plan?.priority || 'medium'}>
              <option value="high">高</option>
              <option value="medium">中</option>
              <option value="low">低</option>
            </select>
          </Field>
        </div>
        <div className="field">
          <span>协作成员</span>
          <div className="check-grid">
            {assignmentAccounts(data.users, plan?.collaboratorIds)
              .map((user) => (
                <label className="checkbox-label" key={user.id}>
                  <input
                    type="checkbox"
                    name="collaboratorIds"
                    value={user.id}
                    defaultChecked={plan?.collaboratorIds.includes(user.id)}
                  />
                  {accountDisplayName(user)}
                  {!canUseAccount(user) && <small>保留已有责任，可取消关联</small>}
                  <small>{user.position}</small>
                </label>
              ))}
          </div>
        </div>
        {plan?.status === 'published' && (
          <Field
            label="本次调整原因"
            hint="系统会保留修改前后的承诺，形成新的发布版本。"
          >
            <textarea name="reason" required rows={3} />
          </Field>
        )}
      </Form>
    </Modal>
  )
}
function HistoryDiff({
  before,
  after,
  data,
}: {
  before: unknown
  after: unknown
  data: PageProps['data']
}) {
  const labels: Record<string, string> = {
    title: '成果名称',
    expectedOutcome: '预期成果',
    acceptanceCriteria: '验收标准',
    dueDate: '截止日期',
    status: '计划状态',
    priority: '优先级',
    reviewComment: '审核意见',
    actualOutcome: '实际成果',
    acceptanceStatus: '验收状态',
    acceptanceNote: '验收说明',
    month: '月份',
    ownerId: '负责人',
    collaboratorIds: '参与人员',
    projectId: '所属项目',
    isTemporary: '临时目标',
    temporaryReason: '临时目标原因',
  }
  if (!after || typeof after !== 'object') return null
  const old =
      before && typeof before === 'object'
        ? (before as Record<string, unknown>)
        : {},
    next = after as Record<string, unknown>
  const keys = Object.keys(labels).filter(
    (key) =>
      key in next && JSON.stringify(next[key]) !== JSON.stringify(old[key]),
  )
  const display = (key: string, value: unknown) =>
    value === undefined || value === '' || value === null
      ? '未填写'
      : key === 'isTemporary'
        ? value ? '是' : '否'
      : key === 'ownerId'
        ? nameOf(data, String(value))
        : key === 'collaboratorIds'
          ? Array.isArray(value) && value.length
            ? value.map((id) => nameOf(data, String(id))).join('、')
            : '无参与人员'
          : key === 'projectId'
            ? projectOf(data, String(value))
            : key === 'status'
              ? statuses[String(value)] || String(value)
              : key === 'acceptanceStatus'
                ? results[String(value)] || String(value)
                : String(value)
  return (
    <div className="diff-list">
      {keys.map((key) => (
        <div key={key}>
          <strong>{labels[key]}</strong>
          {Boolean(before) && <del>{display(key, old[key])}</del>}
          <span>{display(key, next[key])}</span>
        </div>
      ))}
    </div>
  )
}
