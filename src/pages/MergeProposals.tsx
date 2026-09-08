import { useState } from 'react'
import { api, json } from '../api'
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
  data,
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
  const candidates = data.plans.filter(
    (plan) =>
      plan.month === month &&
      ['submitted', 'approved'].includes(plan.status) &&
      !data.tasks.some((task) => task.monthlyPlanId === plan.id),
  )
  return (
    <Modal title="合并同一成果的提报" onClose={onClose} wide>
      <p className="modal-intro">
        仅合并同月、同项目（部门工作则同类别）且尚未拆分任务的提报。系统保留来源和原始责任，新事项以审核通过状态等待发布。
      </p>
      <Form
        onCancel={onClose}
        submitLabel="合并为一项月度成果"
        onSubmit={async (event) => {
          if (ids.length < 2) throw new Error('请至少选择两条提报。')
          const chosen = candidates.filter((plan) => ids.includes(plan.id))
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
