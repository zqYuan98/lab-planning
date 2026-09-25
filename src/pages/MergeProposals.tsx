import AnnualGoalPicker from '../components/AnnualGoalPicker'
import { periodScope } from '../period-workspace'
import { useState } from 'react'
import { api, json } from '../api'
import { usePeriodCandidates } from '../period-workspace'
import {
  Empty,
  Field,
  Form,
  Modal,
  nameOf,
  projectOf,
  type PageProps,
} from '../ui'
export default function MergeProposals({
  data: initialData,
  month,
  onClose,
  onSaved,
}: {
  data: PageProps['data']
  month: string
  onClose: () => void
  onSaved: (message: string) => Promise<void>
}) {
  const [ids, setIds] = useState<string[]>([])
  const [annualGoalId, setAnnualGoalId] = useState(''), [explicitAnnualLink, setExplicitAnnualLink] = useState(false)
  const resource = usePeriodCandidates(initialData, initialData.user.id, 'merge', month)
  const data = resource.value ?? { ...initialData, plans: [] }
  const candidates = data.plans.filter(
    (plan) =>
      plan.month === month &&
      ['submitted', 'approved'].includes(plan.status) &&
      (!plan.projectId ||
        data.projects.some(
          (project) =>
            project.id === plan.projectId && project.status === 'active',
        )) &&
      !data.tasks.some((task) => task.monthlyPlanId === plan.id),
  )
  return (
    <Modal title="合并同一成果的提报" onClose={onClose} wide>
      {resource.error && <div role="alert" className="error">{resource.error}<button onClick={resource.retry}>重新读取可合并提报</button></div>}
      {!resource.value && !resource.error && <p role="status">正在核对整月可合并范围…</p>}
      <p className="modal-intro">
        仅合并同月、同项目（部门工作则同类别）且尚未拆分任务的提报。系统保留来源和原始责任，新事项以审核通过状态等待发布。
      </p>
      <Form
        onCancel={onClose}
        submitLabel="合并为一项月度成果"
        onSubmit={async (event) => {
          if (!resource.value || resource.error) throw new Error('请先完整读取当前可合并提报')
          if (ids.length < 2) throw new Error('请至少选择两条提报。')
          const chosen = candidates.filter((plan) => ids.includes(plan.id))
          if (chosen.length !== ids.length) throw new Error('所选提报已变化，请重新核对选择范围')
          if (
            new Set(
              chosen.map(
                (plan) => plan.projectId || `category:${plan.category}`,
              ),
            ).size > 1
          )
            throw new Error('请选择同一项目或同一部门工作类别的提报。')
          await api(
            '/plans/merge',
            json({
              ...Object.fromEntries(new FormData(event.currentTarget)),
              planIds: ids,
              ...(explicitAnnualLink ? { annualGoalId: annualGoalId || null } : {}),
            }),
          )
          await onSaved('提报已合并，原始来源和责任记录已保留')
        }}
      >
        <div className="merge-options">
          {candidates.length ? (
            candidates.map((plan) => (
              <label key={plan.id} className="merge-option">
                <input
                  type="checkbox"
                  checked={ids.includes(plan.id)}
                  onChange={(event) =>
                    setIds(
                      event.target.checked
                        ? [...ids, plan.id]
                        : ids.filter((id) => id !== plan.id),
                    )
                  }
                />
                <span>
                  <strong>{plan.title}</strong>
                  <small>
                    {projectOf(data, plan.projectId)} ·{' '}
                    {nameOf(data, plan.ownerId)} · {plan.dueDate}
                  </small>
                  <p>{plan.expectedOutcome}</p>
                </span>
              </label>
            ))
          ) : (
            <Empty
              title="暂无可合并提报"
              description="需要至少两项同月待审核或审核通过、且未拆任务的事项。"
            />
          )}
        </div>
        <label className="checkbox-label"><input type="checkbox" checked={explicitAnnualLink} onChange={event => setExplicitAnnualLink(event.target.checked)} />明确选择合并后的年度关联（不同关联时必选）</label>
        {explicitAnnualLink && <AnnualGoalPicker year={Number(month.slice(0,4))} value={annualGoalId} onChange={setAnnualGoalId} scope={periodScope(data)} />}
        <Field label="合并后的成果名称">
          <input name="title" required maxLength={200} />
        </Field>
        <Field label="合并原因">
          <textarea
            name="reason"
            required
            rows={3}
            placeholder="说明为什么这些提报是同一成果，以及如何保留各自责任"
          />
        </Field>
      </Form>
    </Modal>
  )
}
