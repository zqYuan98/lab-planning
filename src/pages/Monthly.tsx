import { useState } from 'react'
import WorkflowGuide from '../components/WorkflowGuide'
import {
  Plus,
  Send,
  History,
  Search,
  GitBranch,
  CheckCircle2,
} from 'lucide-react'
import type { AuditEvent, MonthlyPlan } from '../../shared/types'
import { api, json } from '../api'
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
export default function Monthly({ data, refresh, notify, intent }: PageProps) {
  const manager = data.user.role === 'manager'
  const archivedProjectIds = new Set(
    data.projects
      .filter((project) => project.status === 'archived')
      .map((project) => project.id),
  )
  const canPublish = (plan: MonthlyPlan) =>
    plan.status === 'approved' &&
    (!plan.projectId || !archivedProjectIds.has(plan.projectId))
  const initialMonth = intent?.month || currentMonth()
  const initialPlan = data.plans.find((plan) => plan.id === intent?.id)
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
        ? 'detail'
        : manager && intent?.action === 'create'
          ? 'create'
          : readyToPublish
            ? 'publish'
            : '',
    ),
    [selected, setSelected] = useState<MonthlyPlan | null>(initialPlan || null),
    [history, setHistory] = useState<AuditEvent[] | null>(null)
  const action = useAction(refresh, notify)
  const monthPlans = data.plans.filter((plan) => plan.month === month)
  const filtered = monthPlans.filter(
    (plan) =>
      (filter === 'all' || plan.status === filter) &&
      `${plan.title}${nameOf(data, plan.ownerId)}${projectOf(data, plan.projectId)}`.includes(
        search,
      ),
  )
  const approved = monthPlans.filter(canPublish)
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
  }
  const saved = async (message: string) => {
    await refresh()
    notify(message)
    close()
  }
  function open(type: string, plan: MonthlyPlan) {
    setSelected(plan)
    setModal(type)
  }
  return (
    <>
      <PageHeader
        eyebrow="PLANNING / MONTHLY"
        title={manager ? '月度目标' : '我参与的月度目标'}
        description={manager ? '定义团队大项、负责人和参与人员，发布目标后跟进个人任务与整体成果。' : '查看本人负责或参与的目标，关联目标建立自己的任务；个人进展在周计划中维护。'}
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
          <span>01 管理员定义目标</span>
          <i>→</i>
          <span>02 明确负责人与参与人员</span>
          <i>→</i>
          <span>03 发布承诺</span>
          <i>→</i>
          <span>04 每周执行</span>
          <i>→</i>
          <span>05 成果验收</span>
        </div>
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
              <div className="table-scroll">
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
                      <tr key={plan.id}>
                        <td>
                          <button
                            className="table-title"
                            onClick={() => open('detail', plan)}
                          >
                            {plan.title}
                          </button>
                          <p className="cell-description">
                            {plan.expectedOutcome ||
                              (plan.importSource ? '预期成果：原表未注明' : '')}
                          </p>
                          <div className="row-meta">
                            <span>{plan.category}</span>
                            {plan.importSource && (
                              <Badge tone="blue">已有计划导入</Badge>
                            )}
                            {plan.importSource?.sourceStatus && (
                              <span>
                                原文：{plan.importSource.sourceStatus}
                              </span>
                            )}
                            {plan.priority === 'high' && (
                              <Badge tone="amber">高优先级</Badge>
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
                            {plan.importSource && plan.status === 'published'
                              ? '已生效'
                              : statuses[plan.status]}
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
                            {plan.status !== 'merged' && manager && (
                                <button onClick={() => open('edit', plan)}>
                                  编辑
                                </button>
                              )}
                            {['draft', 'returned'].includes(plan.status) &&
                              (!plan.projectId ||
                                !archivedProjectIds.has(plan.projectId)) &&
                              manager && (
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
                            {!manager && !plan.visibility && plan.status !== 'merged' && (plan.ownerId === data.user.id || plan.collaboratorIds.includes(data.user.id)) && <button onClick={() => open('task', plan)}>关联个人任务</button>}
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
            description={manager ? '指定负责人和参与人员，明确预期成果与验收标准。' : '管理员发布目标并将你加入参与人员后，即可关联个人任务。'}
            action={
              manager && <button
                className="button secondary"
                onClick={() => setModal('create')}
              >
                <Plus size={16} />
                新增月度目标
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
      {manager && (modal === 'create' || modal === 'edit') && (
        <PlanEditor
          data={data}
          month={month}
          plan={selected}
          onClose={close}
          onSaved={saved}
        />
      )}
      {modal === 'task' && selected && !selected.visibility && <Modal title="关联目标，建立个人任务" onClose={close}>
        <p className="modal-intro">月度目标：{selected.title}<br />月份：{selected.month} · 项目：{projectOf(data, selected.projectId)}<br />任务负责人：{data.user.name}</p>
        <Form onCancel={close} submitLabel="保存个人任务" onSubmit={async event => {
          await api('/tasks', json({ ...Object.fromEntries(new FormData(event.currentTarget)), monthlyPlanId: selected.id }))
          await saved('个人任务已建立，可在周计划中安排每周工作')
        }}>
          <Field label="个人任务名称"><input name="title" required maxLength={300} /></Field>
          <Field label="个人交付说明"><textarea name="description" rows={3} /></Field>
          <Field label="截止日期"><input name="dueDate" type="date" defaultValue={selected.dueDate} required /></Field>
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
          {selected.importSource && (
            <p className="modal-intro">
              已有计划已导入生效，无需重新提报。原文状态：
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
                {selected.importSource && selected.status === 'published'
                  ? '已生效'
                  : statuses[selected.status]}
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
  onClose,
  onSaved,
}: {
  data: PageProps['data']
  month: string
  plan: MonthlyPlan | null
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
            : '编辑月度目标'
          : '新增月度目标'
      }
      onClose={onClose}
      wide
    >
      <Form
        onCancel={onClose}
        submitLabel={plan ? '保存计划' : '保存为草稿'}
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
                ownerId: manager ? values.ownerId : data.user.id,
                ...(plan ? { version: plan.version } : {}),
              },
              plan ? 'PATCH' : 'POST',
            ),
          )
          await onSaved(
            plan?.status === 'published'
              ? '修订已生效，发布版本和历史记录已保存'
              : '月度提报已保存',
          )
        }}
      >
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
        <Field label="本月成果名称">
          <input
            name="title"
            defaultValue={plan?.title}
            required
            maxLength={200}
            placeholder="例如：完成模型评测平台首版交付"
          />
        </Field>
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
              {data.users
                .filter((user) => user.active || user.id === plan?.ownerId)
                .map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name}
                    {user.position ? ` · ${user.position}` : ''}
                  </option>
                ))}
            </select>
          </Field>
        </div>
        {imported && (
          <p className="modal-intro">
            这条已有计划已生效。原表未注明的预期成果、验收标准和截止日期可继续留空；修订保留原因和历史版本。
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
          <Field label="截止日期">
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
            {data.users
              .filter(
                (user) =>
                  user.active ||
                  plan?.collaboratorIds.includes(user.id) ||
                  plan?.ownerId === user.id,
              )
              .map((user) => (
                <label className="checkbox-label" key={user.id}>
                  <input
                    type="checkbox"
                    name="collaboratorIds"
                    value={user.id}
                    defaultChecked={plan?.collaboratorIds.includes(user.id)}
                  />
                  {user.name}
                  {!user.active && <small>已停用 · 保留已有责任</small>}
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
