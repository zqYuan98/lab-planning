import type { CommitmentValue, PeriodReviewContent, PeriodReviewDisplayReferences, PeriodReviewSnapshot } from '../../shared/period-reviews'
import { periodReviewLabel, reviewStatusLabels } from '../../shared/period-reviews'
import type { Bootstrap } from '../../shared/types'
import { dateTime } from '../ui'

export default function PeriodReviewDetail({ review, data, references }: { review: PeriodReviewContent & { differences?: PeriodReviewSnapshot['differences'] }; data: Bootstrap; references: PeriodReviewDisplayReferences | null }) {
  const count = review.evidenceCoverage
  const ownerName = (id: string) => references?.users.find(row => row.id === id)?.name || data.users.find(row => row.id === id)?.name || (id === data.user.id ? data.user.name : id)
  const commitmentFields: [keyof CommitmentValue, string][] = [['title', '交付名称'], ['ownerId', '责任人'], ['monthlyPlanId', '月目标'], ['projectId', '项目'], ['dueDate', '承诺期限'], ['scope', '交付范围'], ['cancelled', '作废状态']]
  const commitmentText = (field: keyof CommitmentValue, value: CommitmentValue | null) => {
    if (!value) return '无原承诺'
    const item = value[field]
    if (field === 'cancelled') return item ? '已作废' : '有效'
    if (!item) return '未关联或未知'
    if (field === 'ownerId') return ownerName(String(item))
    if (field === 'monthlyPlanId') return references?.plans.find(row => row.id === item)?.title || String(item)
    if (field === 'projectId') return references?.projects.find(row => row.id === item)?.name || String(item)
    return String(item)
  }
  return <section className="period-review-detail" aria-label="历史复盘明细">
    <p className="period-review-label">{periodReviewLabel(review)}</p>
    <div className="period-review-metrics"><div><strong>{count.known}/{count.total}</strong><span>证据覆盖</span></div><div><strong>{count.unknown}</strong><span>未知项</span></div><div><strong>{count.unfinished}</strong><span>期末未通过</span></div><div><strong>{count.rate === null ? '暂无可判定数据' : `${Math.round(count.rate * 100)}%`}</strong><span>按时达标交付（{count.onTimeAccepted}/{count.acceptedKnown}）</span></div></div>
    <p className="form-hint">未知项不进入已知分母。验收等待与成员迟交分别记录；人工补证不计为正式提报回执。</p>
    {!review.entries.length && <p>此周期没有可展示的任务历史。</p>}
    {review.entries.map(row => <article className="period-review-entry" key={`${row.taskId}:${row.deliverableKey}`}>
      <h3>{row.title} <span className="badge">{reviewStatusLabels[row.statusAtCutoff]}</span></h3>
      <p>期末责任人：{row.ownerId ? ownerName(row.ownerId) : '待核实'} · 期末月目标：{row.monthlyPlanId ? references?.plans.find(plan => plan.id === row.monthlyPlanId)?.title || row.monthlyPlanId : '未关联或待核实'} · 项目：{row.projectId ? references?.projects.find(project => project.id === row.projectId)?.name || row.projectId : '未关联或待核实'}</p>
      <dl className="period-review-facts"><div><dt>原承诺日期</dt><dd>{row.originalDueDate || '未知'}</dd></div><div><dt>期末有效期限</dt><dd>{row.effectiveDueDate || '未知'}</dd></div><div><dt>首次有效提交</dt><dd>{row.firstSubmittedAt ? dateTime(row.firstSubmittedAt) : '无正式回执'}</dd></div><div><dt>通过版本提交</dt><dd>{row.acceptedSubmittedAt ? dateTime(row.acceptedSubmittedAt) : '待确认'}</dd></div><div><dt>验收时间</dt><dd>{row.acceptedAt ? dateTime(row.acceptedAt) : '待确认'}</dd></div></dl>
      {row.unknowns.map(message => <p className="period-review-unknown" key={message}>待核实：{message}</p>)}
      <details><summary>承诺时间线与正式提交（{row.commitments.length} 次承诺事实）</summary>
        {row.commitments.map(item => <div className="period-review-commitment" key={item.id}><p>{dateTime(item.effectiveAt)} · {item.kind === 'initial' ? '首次有效承诺' : '批准或直接变更'} · {item.reason}<br/><small>录入：{dateTime(item.recordedAt)} · 来源：{item.sourceId}</small></p>{commitmentFields.filter(([field]) => !item.oldValue || item.oldValue[field] !== item.newValue[field]).map(([field, label]) => <p key={field}><strong>{label}：</strong>{commitmentText(field, item.oldValue)} → {commitmentText(field, item.newValue)}</p>)}</div>)}
        {row.submissions.map(item => <p key={item.id}>提交 v{item.revision}：{dateTime(item.submittedAt)} · {item.timely === null ? '及时性待核实' : item.timely ? '按当时承诺及时提交' : '晚于当时承诺'} · {reviewStatusLabels[item.decision]}{item.acceptanceWaitMs !== null ? ` · 验收等待 ${(item.acceptanceWaitMs / 3600000).toFixed(1)} 小时` : ''}</p>)}
      </details>
      {row.overdueIntervals.length > 0 && <div className="period-review-unknown"><strong>保留的历史逾期区间</strong>{row.overdueIntervals.map((item, index) => <p key={index}>{dateTime(item.from)} — {dateTime(item.through)}（承诺 {item.dueDate}）</p>)}</div>}
      {row.laterStatus && <div className="period-review-later"><strong>事后核实：{reviewStatusLabels[row.laterStatus]}</strong><p>原期末结论仍为“{reviewStatusLabels[row.statusAtCutoff]}”。</p>{row.laterSubmissions.filter(item => item.decision === 'accepted').map(item => <p key={item.id}>事后确认通过版本 v{item.revision}：提交 {dateTime(item.submittedAt)}，验收 {dateTime(item.decidedAt!)}，验收等待 {((item.acceptanceWaitMs || 0) / 3600000).toFixed(1)} 小时。</p>)}</div>}
      {row.evidence.map(item => <div className="period-review-evidence" key={item.id}><strong>人工补证 · 非正式提交回执</strong><p>声称发生：{dateTime(item.claimedAt)} · 实际录入：{dateTime(item.recordedAt)}</p><p>{item.statement}</p><p>{item.evidence.join('；')}</p><small>补证原因：{item.reason}</small></div>)}
    </article>)}
    <h3>周提报合规</h3><p className="form-hint">依据周期名单、提报义务、整份回执、截止未交及调整记录；任务完成不等于整份提报。</p>
    <div className="period-review-table"><table><thead><tr><th>周期 / 成员</th><th>类别</th><th>期末结论</th><th>正式首交</th><th>事后补交</th></tr></thead><tbody>{review.weeklyCompliance.map(row => <tr key={row.dutyId}><td>{row.cycleWeek} / {ownerName(row.ownerId)}</td><td>{row.kind === 'plan' ? '下周计划' : '本周成果'}</td><td>{reviewStatusLabels[row.statusAtCutoff]}{row.missingAtDeadline ? '（保留截止未交事实）' : ''}</td><td>{row.firstSubmittedAt ? dateTime(row.firstSubmittedAt) : '无正式回执'}</td><td>{row.laterSubmittedAt ? dateTime(row.laterSubmittedAt) : '—'}</td></tr>)}</tbody></table></div>
    {!review.weeklyCompliance.length && <p>此周期没有可判定的整份提报记录。</p>}
    {review.unknownItems.length > 0 && <details><summary>全部未知与证据缺口（{review.unknownItems.length}）</summary>{review.unknownItems.map((row, index) => <p key={index}>{row.message}</p>)}</details>}
    {!!review.differences?.length && <details><summary>与原定稿的差异（{review.differences.length}）</summary>{review.differences.map(row => <div className="period-review-diff" key={row.key}><strong>{row.key}</strong><p>旧版</p><pre>{row.before}</pre><p>本修订</p><pre>{row.after}</pre></div>)}</details>}
  </section>
}
