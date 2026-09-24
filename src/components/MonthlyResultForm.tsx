import { useState } from 'react'
import type { MonthlyPlan } from '../../shared/types'
import { api, json } from '../api'
import { draftText } from '../draft-recovery'
import { Field, Form } from '../ui'

interface Props { plan: MonthlyPlan; manager: boolean; userId: string; onSaved: () => Promise<void>; onCancel: () => void }

export default function MonthlyResultForm({ plan, manager, userId, onSaved, onCancel }: Props) {
  const [status, setStatus] = useState(manager && plan.acceptanceStatus === 'not_completed' ? 'not_completed' : manager ? 'accepted' : 'submitted')
  const incomplete = status === 'not_completed'
  return <>
    <div className="context-box"><strong>{plan.title}</strong><p>验收标准：{plan.acceptanceCriteria || (plan.importSource ? '原表未注明' : '')}</p></div>
    {plan.acceptanceStatus === 'not_completed' && !plan.acceptanceNote.trim() && <p className="form-hint">历史未完成说明缺失，本次确认时请补充原因。</p>}
    <Form onCancel={onCancel} submitLabel={manager ? '保存验收结论' : '提交管理者验收'}
      draftKey={`monthly-result:${userId}:${plan.id}:v${plan.version}`}
      draftContext={{ acceptanceStatus: status }}
      onDraftRestore={values => {
        const restored = draftText(values, 'acceptanceStatus')
        if (manager && ['accepted', 'not_completed'].includes(restored)) setStatus(restored)
      }}
      onSubmit={async event => {
        const values = Object.fromEntries(new FormData(event.currentTarget))
        if (incomplete && !String(values.acceptanceNote || '').trim()) throw new Error('请填写未完成原因。')
        await api(`/plans/${plan.id}/result`, json({ ...values, version: plan.version, acceptanceStatus: status }))
        await onSaved()
      }}>
      <Field label="实际交付成果"><textarea name="actualOutcome" defaultValue={plan.actualOutcome} required={!incomplete} rows={4} placeholder="描述已经交付的事实，避免重复计划内容" /></Field>
      {manager && <Field label="验收结论"><select name="acceptanceStatus" value={status} onChange={event => setStatus(event.target.value)}>
        <option value="accepted">达到验收标准，确认完成</option><option value="not_completed">未完成，保留本月结果</option>
      </select></Field>}
      <Field label={incomplete ? '未完成原因（必填）' : manager ? '验收说明' : '补充说明'}><textarea name="acceptanceNote" defaultValue={plan.acceptanceNote} required={incomplete} maxLength={12000} rows={3} /></Field>
    </Form>
  </>
}
