import { useEffect, useRef, useState } from 'react'
import type { WeeklyReviewDelegationView, WeeklyReviewQueue as Queue } from '../../shared/weekly-review-delegation'
import { api, json, finishSaved, ApiError } from '../api'
import { useWorkspaceQuery } from '../workspace-query'
import { periodScope } from '../period-workspace'
import { Badge, Field, Form, Modal, type PageProps } from '../ui'
import { createSubmissionRequestId } from '../weekly-submission-flow'

const changeLabels = { new: '新增', changed: '变化', 'already-approved': '已有批准' }
export default function WeeklyReviewQueue({ data, week, onUpdated }: Pick<PageProps, 'data'> & { week: string; onUpdated: (message: string) => Promise<void> }) {
  const [cursor, setCursor] = useState(''), [selectedId, setSelectedId] = useState(''), [configure, setConfigure] = useState(false)
  const [decision, setDecision] = useState<'approved' | 'returned'>('approved')
  const [actionError, setActionError] = useState('')
  const attempt = useRef<{ payload: string; requestId: string } | null>(null)
  const scope = periodScope(data)
  const queue = useWorkspaceQuery<Queue>(`/weekly-review-queue?week=${week}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, scope)
  useEffect(() => { setCursor(''); setSelectedId(''); setConfigure(false); setActionError(''); attempt.current = null }, [week, scope])
  const visibleQueue = actionError ? null : queue.value
  const selected = visibleQueue?.items.find(item => item.dutyId === selectedId)
  return <section className="submission-card" aria-label="整份计划审核队列">
    <div className="submission-card-top"><h3>{data.user.role === 'manager' ? '整份计划审核队列' : '委托给我的计划审核'}</h3><div className="submission-actions">
      <button className="text-button" disabled={queue.loading} onClick={() => void queue.reload().then(() => setActionError('')).catch(() => {})}>刷新审核队列</button>
      {data.user.role === 'manager' && <button className="button secondary" onClick={() => setConfigure(true)}>配置审核委托</button>}
    </div></div>
    <p>同一目标的整份计划可由目标负责人审核；管理者可随时处理。日常执行进展不触发重审。</p>
    {queue.error && <p role="alert">{queue.error}</p>}
    {actionError && <p role="alert">{actionError}</p>}
    {queue.loading && !queue.value && <p>正在读取待审计划…</p>}
    {visibleQueue && !visibleQueue.items.length && <p>本页暂无可审核的整份计划。</p>}
    {visibleQueue?.items.map(item => <article className="submission-card" key={item.dutyId}>
      <div className="submission-card-top"><strong>{item.ownerName} · {item.contentWeek} 当周计划</strong><Badge>{item.reviewer.kind === 'goal_owner' ? '目标负责人受托审核' : '管理者审核'}</Badge></div>
      <p>{item.items.length} 项正式安排{item.retainedDraftCount ? ` · ${item.retainedDraftCount} 项保留草稿（不纳入本次批准）` : ''}</p>
      <p>{Object.entries(changeLabels).map(([change, label]) => `${label} ${item.items.filter(row => row.change === change).length}`).join(' · ')}</p>
      <button className="button secondary" onClick={() => { setSelectedId(item.dutyId); setDecision('approved'); setActionError(''); attempt.current = null }}>审核整份计划</button>
    </article>)}
    <div className="submission-actions">{cursor && <button className="text-button" onClick={() => { setCursor(''); setSelectedId('') }}>返回第一页</button>}{visibleQueue?.nextCursor && <button className="text-button" onClick={() => { setCursor(visibleQueue.nextCursor!); setSelectedId('') }}>下一页</button>}</div>
    {selected && <Modal title={`审核 ${selected.ownerName} 的整份计划`} onClose={() => setSelectedId('')} wide>
      <p>{selected.contentWeek} 当周 · 本次结论对应整份提交，未变化条目继续保留批准。</p>
      <div className="submission-preview">{selected.items.map(row => <article key={row.recordId}><strong>{row.taskTitle}</strong> <Badge tone={row.change === 'already-approved' ? 'green' : 'amber'}>{changeLabels[row.change]}</Badge><p>目标：{row.goalTitle}</p><p>计划承诺：{row.commitment}</p></article>)}</div>
      {!selected.items.length && <p>本次没有正式工作安排。</p>}
      {!!selected.retainedDraftCount && <p>{selected.retainedDraftCount} 项草稿继续保留，不纳入本次批准。</p>}
      <Form key={`${selected.submissionId}-${selected.version}`} onCancel={() => setSelectedId('')} submitLabel={decision === 'approved' ? '确认整份通过' : '退回整份修改'} onSubmit={async event => {
        const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim()
        const input = { dutyId: selected.dutyId, version: selected.version, submissionId: selected.submissionId, decision, reason }
        const payload = JSON.stringify(input)
        if (!attempt.current || attempt.current.payload !== payload) attempt.current = { payload, requestId: createSubmissionRequestId() }
        try { await api('/weekly-submissions/review', json({ ...input, requestId: attempt.current.requestId })) }
        catch (error) {
          if (error instanceof ApiError && [401, 403, 404].includes(error.status)) {
            setSelectedId(''); setActionError(error.message)
            await queue.reload().catch(() => {})
          }
          throw error
        }
        await finishSaved(async () => { setSelectedId(''); await onUpdated(decision === 'approved' ? '整份计划已审核通过' : '整份计划已退回修改'); await queue.reload() })
      }}>
        <Field label="审核结果"><select value={decision} onChange={event => setDecision(event.target.value as 'approved' | 'returned')}><option value="approved">审核通过</option><option value="returned">退回修改</option></select></Field>
        <Field label={decision === 'returned' ? '退回意见' : '审核意见（选填）'}><textarea name="reason" rows={3} maxLength={12000} required={decision === 'returned'} /></Field>
      </Form>
    </Modal>}
    {configure && data.user.role === 'manager' && <DelegationSettings scope={scope} onClose={() => setConfigure(false)} onUpdated={onUpdated} />}
  </section>
}

function DelegationSettings({ scope, onClose, onUpdated }: { scope: string; onClose: () => void; onUpdated: (message: string) => Promise<void> }) {
  const query = useWorkspaceQuery<WeeklyReviewDelegationView>('/weekly-review-delegation', scope)
  return <Modal title="按提交成员配置审核委托" onClose={onClose}>
    <p>默认关闭。勾选成员后，其全部安排和保留草稿同属一个目标、目标负责人有效且不是本人时，由目标负责人受托审核；其他情况交由管理者。</p>
    {query.error && <p role="alert">{query.error}<button className="text-button" onClick={() => void query.reload().catch(() => {})}>重新读取</button></p>}
    {query.value ? <Form key={query.value.settings.version} onCancel={onClose} submitLabel="保存审核委托" onSubmit={async event => {
      const enabledOwnerIds = new FormData(event.currentTarget).getAll('enabledOwnerIds')
      await api('/weekly-review-delegation', json({ version: query.value!.settings.version, enabledOwnerIds }, 'PUT'))
      await finishSaved(async () => { onClose(); await onUpdated('审核委托已更新') })
    }}>
      {query.value.members.map(member => <label className="check-field" key={member.id}><input type="checkbox" name="enabledOwnerIds" value={member.id} disabled={!member.available} defaultChecked={member.available && query.value!.settings.enabledOwnerIds.includes(member.id)} />{member.name}{!member.available && '（当前不可用，保存时移除委托）'}</label>)}
      {!query.value.members.length && <p>当前没有可配置的提交成员。</p>}
    </Form> : query.loading && <p>正在读取审核委托配置…</p>}
  </Modal>
}
