import { useState } from 'react'
import {
  ArrowLeft,
  ArrowRight,
  Plus,
  Link2,
  ExternalLink,
  AlertTriangle,
  Search,
} from 'lucide-react'
import type { Task, WeeklyRecord } from '../../shared/types'
import { api, json } from '../api'
import WeeklySubmissionPanel from '../components/WeeklySubmissionPanel'
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
export default function Weekly({ data, refresh, notify, intent }: PageProps) {
  const manager = data.user.role === 'manager'
  const initialWeek = intent?.weekStart || monday()
  const initialRecord = data.weeklyRecords.find(
    (record) =>
      (record.taskId === intent?.id || record.id === intent?.id) &&
      record.weekStart === initialWeek,
  )
  const initialTask = data.tasks.find((task) => task.id === intent?.id)
  const initialOwner = manager
    ? ''
    : intent?.id
      ? initialRecord?.ownerId || initialTask?.ownerId || data.user.id
      : intent?.action !== 'create' && (intent?.weekStart || intent?.status)
        ? ''
        : data.user.id
  const [week, setWeek] = useState(initialWeek),
    [owner, setOwner] = useState(initialOwner),
    [filter, setFilter] = useState(intent?.status || 'all'),
    [search, setSearch] = useState(intent?.query || '')
  const [modal, setModal] = useState(
      intent?.action === 'create' ? 'create' : '',
    ),
    [selected, setSelected] = useState<WeeklyRecord | null>(null)
  const [creationTask, setCreationTask] = useState<Task | undefined>(
    intent?.action === 'create' ? initialTask : undefined,
  )
  function openCreate(temporary: boolean, task?: Task) {
    setCreationTask(task)
    setModal(temporary ? 'temporary' : 'create')
  }
  const action = useAction(refresh, notify)
  const weekRecords = data.weeklyRecords.filter(
    (record) =>
      record.weekStart === week && (!owner || record.ownerId === owner),
  )
  const records = weekRecords
    .filter((record) =>
      `${record.commitment} ${data.tasks.find((task) => task.id === record.taskId)?.title || ''} ${nameOf(data, record.ownerId)}`
        .toLocaleLowerCase()
        .includes(search.toLocaleLowerCase()),
    )
    .filter((record) =>
      filter === 'all' || filter === 'draft'
        ? filter !== 'draft' || !record.submitted
        : record.submitted && record.status === filter,
    )
  const official = weekRecords.filter((record) => record.submitted)
  const close = () => {
    setModal('')
    setSelected(null)
    setCreationTask(undefined)
  }
  const saved = async (message: string) => {
    await refresh()
    notify(message)
    close()
  }
  const selectedTask = data.tasks.find((task) => task.id === selected?.taskId)
  return (
    <>
      <PageHeader
        eyebrow="EXECUTION / WEEKLY"
        title={manager ? '每周执行' : '我的周计划'}
        description="同一任务可以持续跨周，每周承诺、实际结果和证据分别保存。"
        actions={
          <>
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
              安排周任务
            </button>
          </>
        }
      />
      <WeeklySubmissionPanel data={data} refresh={refresh} notify={notify} onSelectWeek={value => { setWeek(value); setOwner(manager ? owner : data.user.id); setFilter('all') }} />
      <div className="toolbar">
        <div className="week-switcher">
          <button
            className="icon-button"
            aria-label="上一周"
            onClick={() => setWeek(addDays(week, -7))}
          >
            <ArrowLeft size={17} />
          </button>
          <label>
            <span className="sr-only">选择周</span>
            <input
              type="date"
              value={week}
              onChange={(event) => {
                if (event.target.value)
                  setWeek(monday(new Date(`${event.target.value}T12:00:00`)))
              }}
            />
          </label>
          <span>— {addDays(week, 6).slice(5)}</span>
          <button
            className="icon-button"
            aria-label="下一周"
            onClick={() => setWeek(addDays(week, 7))}
          >
            <ArrowRight size={17} />
          </button>
          <button className="text-button" onClick={() => setWeek(monday())}>
            本周
          </button>
        </div>
        {manager && (
          <label className="inline-field">
            负责人
            <select
              value={owner}
              onChange={(event) => setOwner(event.target.value)}
            >
              <option value="">所有成员</option>
              {data.users.map((user) => (
                <option key={user.id} value={user.id}>
                  {user.name}
                </option>
              ))}
            </select>
          </label>
        )}
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
              setOwner(data.user.id)
              setSearch('')
              setFilter('all')
            }}
          >
            回到我的周计划
          </button>
        </div>
      )}
      <div className="weekly-summary">
        <span>
          已提交 <strong>{official.length}</strong> 项
        </span>
        <span>
          成员自报完成{' '}
          <strong>
            {official.filter((record) => record.status === 'done').length}
          </strong>{' '}
          项
        </span>
        <span>
          阻塞{' '}
          <strong>
            {official.filter((record) => record.status === 'blocked').length}
          </strong>{' '}
          项
        </span>
        <span>
          完成率{' '}
          <strong>
            {official.length
              ? `${Math.round((official.filter((record) => record.status === 'done').length / official.length) * 100)}%`
              : '—'}
          </strong>
        </span>
        <small>按全部已提交周记录统计，筛选不改变口径。</small>
      </div>
      <div className="tabs" role="group" aria-label="执行状态筛选">
        {[
          ['all', '全部记录'],
          ['draft', '草稿'],
          ...Object.entries(statusLabels),
        ].map(([value, label]) => (
          <button
            key={value}
            className={filter === value ? 'selected' : ''}
            onClick={() => setFilter(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="toolbar">
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="搜索周任务"
            placeholder="搜索任务、承诺或负责人"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      {initialTask && !initialRecord && (
        <div className="navigation-context">
          <span>找到任务「{initialTask.title}」，该周尚未安排执行记录。</span>
          {(manager || initialTask.ownerId === data.user.id) && (
            <button
              className="text-button"
              onClick={() => openCreate(initialTask.isTemporary, initialTask)}
            >
              为此任务安排本周
            </button>
          )}
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
            return (
              <article
                className={`weekly-card ${record.status === 'blocked' ? 'has-blocker' : ''} ${record.id === initialRecord?.id ? 'navigation-highlight' : ''}`}
                key={record.id}
              >
                <div className="weekly-card-top">
                  <div className="row-meta">
                    <span className="task-code">
                      #{record.taskId.slice(-6).toUpperCase()}
                    </span>
                    {record.submitted ? (
                      <Badge tone={statusTone[record.status]}>
                        {record.importSource && record.status === 'done'
                          ? '已完成'
                          : statusLabels[record.status]}
                      </Badge>
                    ) : (
                      <Badge>草稿 · 未提交</Badge>
                    )}
                    {record.importSource && (
                      <Badge tone="blue">已有计划导入</Badge>
                    )}
                    {record.importSource?.sourceStatus && (
                      <span>原文：{record.importSource.sourceStatus}</span>
                    )}
                    {!record.monthlyPlanId && (
                      <Badge tone="amber">
                        {record.importSource ? (
                          '未关联月度目标'
                        ) : (
                          <>
                            临时工作
                            {task?.monthlyPlanId ? ' · 原周记录' : ' · 待关联'}
                          </>
                        )}
                      </Badge>
                    )}
                  </div>
                  <span className="owner-chip">
                    {nameOf(data, record.ownerId)}
                  </span>
                </div>
                <h2>{record.commitment || task?.title || '已有周工作记录'}</h2>
                {record.importSource && !record.commitment && (
                  <p className="cell-description">本周承诺：原表未注明</p>
                )}
                <div className="linked-plan">
                  <Link2 size={14} />
                  {plan
                    ? `${plan.month} · ${plan.title}`
                    : record.importSource
                      ? '未关联月度目标，保留原资料归属'
                      : task?.monthlyPlanId
                        ? '本周按临时工作记录，任务后续已关联月度目标'
                        : '临时事项，尚未关联月度目标'}
                  {task && (
                    <span>
                      任务当前截止{' '}
                      {task.dueDate || (task.importSource ? '原表未注明' : '')}
                    </span>
                  )}
                </div>
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
                    {record.submitted
                      ? record.importSource
                        ? '已有周记录已导入生效'
                        : '已提交管理者查看'
                      : '草稿仅在提交后计入周统计'}{' '}
                    · 记录 V{record.version}
                  </small>
                  <div className="row-actions">
                    {canEdit && (
                      <>
                        <button
                          onClick={() => {
                            setSelected(record)
                            setModal('edit')
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
                                '周计划已提交',
                              )
                            }
                          >
                            提交周计划
                          </button>
                        )}
                        <button
                          onClick={() => {
                            setSelected(record)
                            setModal('carry')
                          }}
                        >
                          顺延一周
                        </button>
                      </>
                    )}
                    {manager && task && (
                      <button
                        onClick={() => {
                          setSelected(record)
                          setModal('relink')
                        }}
                      >
                        调整月度关联
                      </button>
                    )}
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
      {(modal === 'create' || modal === 'temporary') && (
        <WeeklyCreate
          data={data}
          week={week}
          temporary={modal === 'temporary'}
          initialTask={creationTask}
          onClose={close}
          onSaved={saved}
        />
      )}
      {modal === 'edit' && selected && (
        <Modal title="更新本周实际进展" onClose={close} wide>
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
          </div>
          <Form
            onCancel={close}
            submitLabel="保存本周进展"
            onSubmit={async (event) => {
              const form = new FormData(event.currentTarget)
              await api(
                `/weekly-records/${selected.id}`,
                json(
                  {
                    ...Object.fromEntries(form),
                    submitted: form.has('submitted'),
                    version: selected.version,
                  },
                  'PATCH',
                ),
              )
              await saved('本周进展已保存')
            }}
          >
            <Field label="本周承诺">
              <textarea
                name="commitment"
                defaultValue={selected.commitment}
                required={!selected.importSource}
                rows={2}
              />
            </Field>
            <Field label="执行状态">
              <select name="status" defaultValue={selected.status}>
                {Object.entries(statusLabels).map(([value, label]) => (
                  <option value={value} key={value}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <Field
              label="实际成果"
              hint={
                selected.importSource
                  ? '已有成果保留原文；原表未注明时可留空。'
                  : '选择完成时必填；按事实描述已经交付的结果。'
              }
            >
              <textarea
                name="actualOutcome"
                rows={3}
                defaultValue={selected.actualOutcome}
              />
            </Field>
            <Field label="证据链接">
              <input
                name="evidenceUrl"
                type="url"
                placeholder="https://…"
                defaultValue={selected.evidenceUrl}
              />
            </Field>
            <div className="form-grid">
              <Field
                label="阻塞 / 未完成原因"
                hint={
                  selected.importSource
                    ? '原表未注明时可留空。'
                    : '受阻或未完成时必填。'
                }
              >
                <textarea
                  name="blocker"
                  rows={3}
                  defaultValue={selected.blocker}
                />
              </Field>
              <Field label="下一步">
                <textarea
                  name="nextAction"
                  rows={3}
                  defaultValue={selected.nextAction}
                />
              </Field>
            </div>
            <label className="checkbox-label">
              <input
                type="checkbox"
                name="submitted"
                defaultChecked={selected.submitted}
              />
              {selected.importSource
                ? '保留为生效记录，纳入对应周统计'
                : '提交管理者查看，纳入本周统计'}
            </label>
          </Form>
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
              await api(
                `/weekly-records/${selected.id}/carry`,
                json(Object.fromEntries(new FormData(event.currentTarget))),
              )
              await saved('新周草稿已创建，原周记录已保留')
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
      {modal === 'relink' && selectedTask && (
        <Modal title="调整任务的月度归属" onClose={close}>
          <p className="modal-intro">
            任务编号保持不变；以前的周记录继续引用当时的月度目标，新周记录采用新的关联。
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
function WeeklyCreate({
  data,
  week,
  temporary,
  initialTask,
  onClose,
  onSaved,
}: {
  data: PageProps['data']
  week: string
  temporary: boolean
  initialTask?: Task
  onClose: () => void
  onSaved: (message: string) => Promise<void>
}) {
  const accessibleTask =
    initialTask &&
    initialTask.isTemporary === temporary &&
    (data.user.role === 'manager' || initialTask.ownerId === data.user.id)
      ? initialTask
      : undefined
  const [taskId, setTaskId] = useState(accessibleTask?.id || ''),
    [planId, setPlanId] = useState(accessibleTask?.monthlyPlanId || ''),
    [ownerId, setOwnerId] = useState(accessibleTask?.ownerId || data.user.id),
    [createdTask, setCreatedTask] = useState<Task | null>(null)
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
  return (
    <Modal
      title={temporary ? '记录临时工作' : '安排个人周任务'}
      onClose={onClose}
      wide
    >
      <Form
        onCancel={onClose}
        submitLabel="保存周计划"
        onSubmit={async (event) => {
          const form = new FormData(event.currentTarget),
            values = Object.fromEntries(form)
          let task =
            createdTask || data.tasks.find((item) => item.id === taskId)
          if (!task) {
            task = await api<Task>(
              '/tasks',
              json({
                title: values.title,
                monthlyPlanId: temporary ? null : planId,
                ownerId,
                description: values.description || '',
                dueDate: values.dueDate,
                isTemporary: temporary,
                temporaryReason: values.temporaryReason || '',
              }),
            )
            setCreatedTask(task)
          }
          await api(
            '/weekly-records',
            json({
              taskId: task.id,
              weekStart: values.weekStart,
              commitment: values.commitment,
              status: 'planned',
              submitted: form.has('submitted'),
            }),
          )
          await onSaved('周任务已保存')
        }}
      >
        <div className="form-grid">
          <Field label="所属周">
            <input name="weekStart" type="date" defaultValue={week} required />
          </Field>
          <Field label="任务负责人">
            <select
              value={ownerId}
              onChange={(event) => {
                setOwnerId(event.target.value)
                setTaskId('')
                setPlanId('')
              }}
              disabled={data.user.role !== 'manager' || !!createdTask}
            >
              {data.users
                .filter((user) => user.active)
                .map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        <Field label="任务来源">
          <select
            value={taskId}
            onChange={(event) => setTaskId(event.target.value)}
            disabled={!!createdTask}
          >
            <option value="">创建新的个人任务</option>
            {existing.map((task) => (
              <option key={task.id} value={task.id}>
                沿用任务 · {task.title}
              </option>
            ))}
          </select>
        </Field>
        {!taskId && !createdTask && (
          <>
            {!temporary && (
              <Field
                label="关联月度成果"
                hint="未发布事项可先拟周草稿，发布后再正式提交。"
              >
                <select
                  value={planId}
                  onChange={(event) => setPlanId(event.target.value)}
                  required
                >
                  <option value="">选择本人负责或参与的月度目标</option>
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
                maxLength={200}
                placeholder="本人具体负责的交付内容"
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
        {createdTask && (
          <div className="note">
            个人任务已创建；请修正周记录后重试，将继续使用同一个任务。
          </div>
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
            defaultChecked={temporary || plan?.status === 'published'}
          />
          立即提交管理者查看
        </label>
        <p className="form-hint">
          未发布月度目标下的记录请先保存草稿。完成周工作后，月度成果仍需单独验收。
        </p>
      </Form>
    </Modal>
  )
}
