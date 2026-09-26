import { LIMITS } from '../../shared/entity-rules'
import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Clock3, RefreshCw } from 'lucide-react'
import type { WeeklyDutyView, WeeklySubmission, WeeklySubmissionView } from '../../shared/weekly-submissions'
import { canUseAccount } from '../../shared/auth-policy'
import { isActiveWeeklyRecord } from '../../shared/weekly-record-state'
import { accountDisplayName, historicalRosterAccounts } from '../account-options'
import WorkOriginLabel from './WorkOriginLabel'
import WeeklyDeadlineSettings from './WeeklyDeadlineSettings'
import WeeklyReviewQueue from './WeeklyReviewQueue'
import { weeklyDeadlineLabel } from '../weekly-deadline-flow'
import { api, json, finishSaved, ApiError } from '../api'
import { LatestRead } from '../latest-read'
import { captureMutationContext, MutationContextChangedError } from '../mutation-response'
import { useWorkspaceQuery } from '../workspace-query'
import { mergePeriod, periodScope, PeriodEditorDirectory } from '../period-workspace'
import type { PeriodReferences } from '../../shared/period-workspace'
import { Badge, Field, Form, Modal, nameOf, type PageProps } from '../ui'
import { createSubmissionRequestId, submissionProgress, submissionLabels as labels, advanceWeek, planReviewLabels, planReviewTones, weeklyRecordState, submissionChangeNotice, type WorkTarget, type ReviewRequest } from '../weekly-submission-flow'

const tones = { due: 'neutral', on_time: 'green', missing: 'red', late: 'amber', exempt: 'blue' }
const kindLabel = (kind: string) => kind === 'results' ? '本周完成情况' : '下周计划'
const dateTime = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '尚未提交'
const progressFieldLabel: Record<string, string> = { 'task.status': '任务状态', 'task.currentProgress': '当前实际进展', 'task.completionNote': '完成说明', 'task.evidenceUrl': '佐证链接', 'task.blockerReason': '任务阻塞原因', 'task.blockerImpact': '影响', 'task.supportNeeded': '所需支持', 'task.nextAction': '下一步', 'weeklyRecord.status': '本周状态', 'weeklyRecord.actualOutcome': '本周进展', 'weeklyRecord.evidenceUrl': '本周佐证', 'weeklyRecord.blocker': '本周阻塞原因', 'weeklyRecord.blockerImpact': '本周影响', 'weeklyRecord.supportNeeded': '本周所需支持', 'weeklyRecord.nextAction': '本周下一步' }
const progressValue: Record<string, string> = { todo: '未开始', planned: '已计划', doing: '进行中', done: '已完成', blocked: '阻塞', not_done: '未完成' }
interface Props extends PageProps {
  week: string
  onChangeCycle: (week: string) => void
  onSelectWork: (target: WorkTarget) => void
  reviewRequest: ReviewRequest | null
  onViewChange?: (view: WeeklySubmissionView | null) => void
}
export default function WeeklySubmissionPanel({ data: initialData, refresh, notify, week, onChangeCycle, onSelectWork, reviewRequest, onViewChange }: Props) {
  const references = useWorkspaceQuery<PeriodReferences>(`/workspace/weekly/submission-references?weekStart=${week}`, periodScope(initialData))
  const data = mergePeriod(initialData, references.value ?? {})
  const manager = data.user.role === 'manager'
  const [view, setView] = useState<WeeklySubmissionView | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<WeeklyDutyView | null>(null)
  const [mode, setMode] = useState<'submit' | 'detail' | 'review' | 'adjust' | 'roster' | 'rule' | ''>('')
  const [reviewDecision, setReviewDecision] = useState<'approved' | 'returned'>('approved')
  const [adjustAction, setAdjustAction] = useState('exempt')
  const [statusFilter, setStatusFilter] = useState('all')
  const [kindFilter, setKindFilter] = useState('all')
  const [reviewFilter, setReviewFilter] = useState('all')
  const reader = useRef<LatestRead<WeeklySubmissionView> | null>(null), latestView = useRef<WeeklySubmissionView | null>(null)
  const selectedAction = useRef(0)
  const requestId = useRef('')
  const handledReview = useRef(0)
  const previousWeek = useRef(week)
  const reviewAttempt = useRef<{ payload:string; requestId:string } | null>(null)
  useEffect(() => {
    latestView.current = null
    const current = new LatestRead<WeeklySubmissionView>({
      load: async signal => { const context = captureMutationContext(), result = await api<WeeklySubmissionView>(`/weekly-submissions?week=${week}`, { signal }); if (context !== captureMutationContext()) throw new MutationContextChangedError(); return result },
      accept: result => { latestView.current = result; setView(result); onViewChange?.(result) }, loading: setLoading,
      error: failure => { setError(failure instanceof Error ? failure.message : ''); if (failure instanceof ApiError && [401, 403].includes(failure.status)) { latestView.current = null; setView(null); setSelected(null); setMode(''); onViewChange?.(null) } },
    })
    reader.current = current
    return () => { selectedAction.current++; current.dispose(); if (reader.current === current) reader.current = null }
  }, [week, periodScope(initialData), onViewChange])
  const load = useCallback(async () => { if (!reader.current) throw new MutationContextChangedError(); await reader.current.read(); if (!latestView.current) throw new MutationContextChangedError(); return latestView.current }, [week, periodScope(initialData)])
  useEffect(() => {
    if (previousWeek.current !== week) { previousWeek.current = week; setMode(''); setSelected(null) }
    void load().then(result => {
      if (!result || !reviewRequest || reviewRequest.token === handledReview.current || reviewRequest.cycleWeek !== result.week) return
      const duty = result.duties.find(row => row.ownerId === reviewRequest.ownerId && row.kind === reviewRequest.kind)
      if (duty) { handledReview.current = reviewRequest.token; open(duty, 'submit') }
      else setError('该周期尚无对应应交项，请核对规则生效周和应交名单。')
    }).catch(() => {})
  }, [load, references.value, reviewRequest])
  function open(duty: WeeklyDutyView, nextMode: typeof mode) {
    selectedAction.current++
    if (nextMode === 'submit') requestId.current = createSubmissionRequestId()
    if (nextMode === 'review') { setReviewDecision('approved'); reviewAttempt.current = null }
    setSelected(duty); setMode(nextMode)
  }
  async function saved(message: string) {
    await finishSaved(async () => { await refresh(); await load(); setMode(''); setSelected(null); notify(message) })
  }
  async function ruleUpdated(message: string) {
    await finishSaved(async () => { await refresh(); await load(); notify(message) })
  }
  const currentView = view?.week === week ? view : null
  const duties = currentView?.duties ?? []
  const ownDuties = duties.filter(row => row.ownerId === data.user.id)
  const roster = currentView?.cycle?.rosterIds ?? []
  const filteredRoster = roster.filter(id => duties.some(duty => duty.ownerId === id && (statusFilter === 'all' || duty.status === statusFilter) && (kindFilter === 'all' || duty.kind === kindFilter)) && (reviewFilter === 'all' || duties.some(duty => duty.ownerId === id && duty.kind === 'plan' && (duty.planReviewStatus ?? 'not_required') === reviewFilter)))
  const requiredDuties = duties.filter(duty => duty.status !== 'exempt')
  const requiredPeople = new Set(requiredDuties.map(duty => duty.ownerId)).size
  const missing = duties.filter(row => row.status === 'missing')
  const people = new Set(missing.map(row => row.ownerId)).size
  const selectedDrafts = selected?.records.filter(row => isActiveWeeklyRecord(row) && !row.submitted) ?? []
  function selectWork(duty: WeeklyDutyView, recordId?: string, create = false) {
    selectedAction.current++
    setMode('')
    onSelectWork({ cycleWeek:duty.cycleWeek, contentWeek:duty.contentWeek, ownerId:duty.ownerId, kind:duty.kind, recordId, create })
  }
  async function refreshSelected(nextMode: typeof mode = 'submit') {
    const sequence = ++selectedAction.current
    const result = await load()
    const duty = result?.duties.find(row=>row.id===selected?.id)
    if (duty && sequence === selectedAction.current) open(duty, nextMode)
  }
  function closeMode() { selectedAction.current++; setMode('') }
  function progress(duty: WeeklyDutyView) {
    const value = submissionProgress(duty)
    return <><span>已保存 {value.total} 项 · 已填{duty.kind === 'results' ? '进展' : '计划'} {value.filled} 项 · 草稿 {value.drafts} 项</span>{value.lastUpdatedAt && <small>最近更新：{dateTime(value.lastUpdatedAt)}</small>}</>
  }
  function recordPreview(duty: WeeklyDutyView) {
    return <div className="submission-preview">{duty.records.filter(isActiveWeeklyRecord).map(row => <article key={row.id}>
      <strong>{data.tasks.find(t => t.id === row.taskId)?.title ?? '个人任务'}</strong><Badge tone={weeklyRecordState(row).tone}>{weeklyRecordState(row).label}</Badge>
      <WorkOriginLabel row={data.weeklyRecords.find(record => record.id === row.id) ?? row} data={data} />
      <p>{duty.kind === 'results' ? row.actualOutcome || '尚未填写实际进展' : row.commitment || '尚未填写计划'}</p>
      {duty.kind === 'plan' && <p className="submission-plan-link">月度目标：{row.monthlyPlanId ? data.plans.find(plan => plan.id === row.monthlyPlanId)?.title ?? `目标 #${row.monthlyPlanId.slice(-6).toUpperCase()}` : '未关联月度目标 / 临时工作'}</p>}
      {row.blocker && <p>阻塞 / 未完成原因：{row.blocker}</p>}
      {(duty.progressEvents ?? []).filter(event => event.taskId === row.taskId && (!event.weeklyRecordId || event.weeklyRecordId === row.id)).map(event => <details key={event.id} open={!!duty.latestSubmission && !(duty.latestSubmission.progressEventIds ?? []).includes(event.id)}>
        <summary>{dateTime(event.occurredAt)} · {nameOf(data, event.actorId)}{event.proxyReason ? '代录' : ''}的进展</summary>
        {event.note && <p>{event.note}</p>}
        {event.changes.map(change => <p key={change.field}>{progressFieldLabel[change.field] ?? '进展内容'}：{(progressValue[change.before] ?? change.before) || '未填写'} → {(progressValue[change.after] ?? change.after) || '未填写'}</p>)}
        {event.proxyReason && <p>代录原因：{event.proxyReason}</p>}
      </details>)}
      <button className="text-button" onClick={() => selectWork(duty, row.id)}>查看 / 编辑该记录</button>
    </article>)}{!duty.records.some(isActiveWeeklyRecord) && <p>该周尚无工作记录；请先安排任务，或在提交时说明无工作安排的原因。</p>}</div>
  }
  return (
    <section className="weekly-submission-panel" aria-label="周提报">
      <header className="submission-heading">
        <div><h2>周提报</h2><p>按本周期截止时间更新本周完成情况，并提交下周计划。北京时间。</p></div>
        <div className="submission-tools">
          <Field label="截止周期（周一）"><input aria-label="提报截止周期" type="date" step={7} value={week} onChange={e => {
            if (!e.target.value) return
            const date = new Date(`${e.target.value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7)
            onChangeCycle(date.toISOString().slice(0, 10)); setMode('')
          }} /></Field>
          <button className="button secondary" disabled={loading} onClick={() => void load().catch(() => {})} aria-label="刷新提报状态"><RefreshCw size={16} /></button>
          {manager && currentView && <button className="button secondary" onClick={() => setMode('rule')}>提报规则</button>}
        </div>
      </header>
      {references.error && <p role="alert" className="error">相关任务名称读取失败：{references.error}<button className="text-button" onClick={() => void references.reload().catch(() => {})}>重新读取关联信息</button></p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {loading && !currentView && <p role="status">正在读取提报状态…</p>}
      {currentView && view && <>
        <WeeklyDeadlineBanner view={view} />
        {view.deadlineAt !== null && <p className="submission-explanation">已保存周记录与整份提报分开显示：先填写，再核对整份内容并提交；下周计划按上方日期统计。</p>}
        {view.deadlineAt !== null && view.rule.planReviewEffectiveWeek && <p className="submission-explanation">周计划审核从 {view.rule.planReviewEffectiveWeek} 提报周期开始，覆盖 {advanceWeek(view.rule.planReviewEffectiveWeek, 7)} 起的下周计划。提交时效与审核结果分别记录，日常进展更新不重审。</p>}
        {!view.cycle && view.deadlineAt !== null && <p className="submission-notice">{week < view.rule.effectiveWeek ? `规则自 ${view.rule.effectiveWeek} 当周起生效，历史周期不记缺交。` : week > view.serverNow.slice(0,10) ? '此截止周期尚未开始，可以先填写周任务草稿。' : '此周期已暂停提报，不计缺交。'}</p>}
        {view.deadlineAt !== null && view.cycle?.needsReview && <div className="submission-notice"><p>本周期应交名单待管理员核对，暂不认定缺交。</p>{manager && <button className="button secondary" onClick={() => setMode('roster')}>核对应交名单</button>}</div>}
        {!manager && view.deadlineAt !== null && view.cycle && !view.cycle.needsReview && !ownDuties.length && <p className="submission-notice">你不在本周期应交名单中，无须补交。周中加入的成员从下一完整周开始计入。</p>}
        {!manager && ownDuties.length === 2 && ownDuties.every(duty => ['on_time', 'late', 'exempt'].includes(duty.status)) && <p className="submission-notice">本周期两项内容已整份提交或获豁免；计划审核结果请查看下方，历史补交记录仍保留。</p>}
        {!manager && ownDuties.length > 0 && <div className="submission-cards">{ownDuties.map(duty => <article key={duty.id} className="submission-card">
          <div className="submission-card-top"><h3>{kindLabel(duty.kind)}</h3><Badge tone={tones[duty.status]}>{submissionProgress(duty).label}</Badge></div>
          <PlanReviewStatus duty={duty} />
          <p>{duty.kind === 'results' ? '如实更新实际进展，仍在进行中的工作也可提交。' : '核对下周所有任务安排后，确认整份计划。'}</p>
          <div className="submission-facts"><span>记录周：{duty.contentWeek} ～ {advanceWeek(duty.contentWeek,6)}</span>{progress(duty)}<span>首次整份提交：{dateTime(duty.firstSubmittedAt)}</span></div>
          {submissionChangeNotice(duty) && <p className="submission-notice">{submissionChangeNotice(duty)}</p>}
          {duty.missingAtDeadline && <small>截止时未提交的记录已保留。</small>}
          {duty.exemptionReason && <small>豁免原因：{duty.exemptionReason}</small>}
          <div className="submission-actions"><button className="button secondary" onClick={() => selectWork(duty)}>{duty.kind === 'results' ? '填写本周进展' : '填写下周计划'}</button><button className="button primary" onClick={() => open(duty, 'submit')}><CheckCircle2 size={16} />{duty.latestSubmission ? '核对并提交修订' : '核对并正式提交'}</button><button className="button secondary" onClick={() => open(duty, 'detail')}>记录</button></div>
        </article>)}</div>}
        {manager && view.deadlineAt !== null && view.cycle && !view.cycle.needsReview && <>
          <div className="submission-summary"><strong>{requiredPeople} 人应交 · {requiredDuties.length} 项</strong><span>周期名单 {roster.length} 人（含豁免）</span><span>{people} 人有缺交 · 共 {missing.length} 项</span><span>{duties.filter(d => d.status === 'late').length} 项已补交</span><span>{duties.filter(duty => duty.planReviewStatus === 'pending').length} 份计划待审核</span><span>任务完成率、提交时效与审核分别统计</span></div>
          <div className="submission-tools"><Field label="按提报状态筛选成员"><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">全部成员</option>{Object.entries(labels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></Field><Field label="应交项"><select value={kindFilter} onChange={event => setKindFilter(event.target.value)}><option value="all">两项全部</option><option value="results">本周完成情况</option><option value="plan">下周计划</option></select></Field><Field label="计划审核"><select value={reviewFilter} onChange={event => setReviewFilter(event.target.value)}><option value="all">全部审核状态</option>{Object.entries(planReviewLabels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></Field></div>
          <div className="table-wrap"><table><thead><tr><th>成员</th><th>本周完成情况<small className="submission-column-week">{view.week} ～ {advanceWeek(view.week,6)}</small></th><th>下周计划<small className="submission-column-week">{view.nextWeek} ～ {advanceWeek(view.nextWeek,6)}</small></th></tr></thead><tbody>{filteredRoster.map(id => <tr key={id}><td>{nameOf(data, id)}</td>{(['results', 'plan'] as const).map(kind => {
            const duty = duties.find(d => d.ownerId === id && d.kind === kind)
            return <td key={kind}>{duty && <div className="submission-cell"><Badge tone={tones[duty.status]}>{submissionProgress(duty).label}</Badge><PlanReviewStatus duty={duty} />{progress(duty)}<small>首次整份提交：{dateTime(duty.firstSubmittedAt)}</small>{submissionChangeNotice(duty) && <small>{submissionChangeNotice(duty)}</small>}{duty.exemptionReason && <small>{duty.exemptionReason}</small>}<button className="text-button" onClick={() => open(duty, 'detail')}>查看记录 / 提报</button>{duty.kind === 'plan' && duty.planReviewStatus === 'pending' && <button className="button secondary" onClick={() => open(duty, 'review')}>审核计划</button>}</div>}</td>
          })}</tr>)}{!filteredRoster.length && <tr><td colSpan={3}>暂无符合此状态的成员。</td></tr>}</tbody></table></div>
        </>}
      </>}

      <WeeklyReviewQueue data={data} week={week} onUpdated={ruleUpdated} />

      {mode === 'submit' && selected && <Modal title={`${kindLabel(selected.kind)} · 整份提交`} onClose={closeMode} wide>
        <p className="modal-intro">{nameOf(data, selected.ownerId)} · {selected.contentWeek} 当周。请核对以下内容；保存单条记录不会替代此处的整份提交。</p>
        <PlanReviewStatus duty={selected} />
        {selected.kind === 'plan' && selected.planReviewRequired && <p className="submission-explanation">本次提交保存一份计划快照，供管理者或受托目标负责人审核。提交时间单独记录；等待审核或退回修改不会抹去原提交时间。</p>}
        {recordPreview(selected)}
        <div className="submission-actions"><button className="button secondary" disabled={!data.users.some(user => user.id === selected.ownerId && canUseAccount(user))} onClick={() => selectWork(selected, undefined, true)}>添加该周任务</button><button className="button secondary" disabled={loading} onClick={() => void refreshSelected().catch(() => {})}>刷新并重新核对</button></div>
        <Form key={requestId.current} onCancel={closeMode} submitLabel="确认提交整份内容" onSubmit={async event => {
          const values = Object.fromEntries(new FormData(event.currentTarget))
          await api('/weekly-submissions/submit', json({ ...values, dutyId: selected.id, version: selected.version, manifest: selected.manifest, progressEventIds: selected.progressEventIds ?? [], requestId: requestId.current }))
          await saved(selected.kind === 'plan' && selected.planReviewRequired ? '整份计划已提交审核，提交时间和历史版本已记录' : '整份提报已保存，提交时间和历史版本已记录')
        }}>
          {selectedDrafts.length > 0 && <Field label={`还有 ${selectedDrafts.length} 条草稿，请明确处理`}><select name="draftAction" required defaultValue=""><option value="" disabled>请选择</option><option value="include">全部纳入本次正式提交</option><option value="retain">继续保留草稿，本次不纳入</option></select></Field>}
          <Field label="补充说明 / 无工作安排说明" hint="没有正式记录且保留全部草稿时，必须说明原因。"><textarea name="note" rows={3} defaultValue={selected.latestSubmission?.note ?? ''} required={selected.records.length === 0} /></Field>
          {manager && selected.ownerId !== data.user.id && <Field label="管理员代录原因"><textarea name="reason" required rows={2} /></Field>}
        </Form>
      </Modal>}

      {mode === 'detail' && selected && <Modal title={`${nameOf(data, selected.ownerId)} · ${kindLabel(selected.kind)}`} onClose={closeMode} wide>
        <p><Badge tone={tones[selected.status]}>{submissionProgress(selected).label}</Badge> 截止 {weeklyDeadlineLabel(selected.deadlineAt)}{selected.missingAtDeadline ? ' · 截止时未提交记录已保留' : ''}</p>
        <PlanReviewStatus duty={selected} />
        {submissionChangeNotice(selected) && <p className="submission-notice">{submissionChangeNotice(selected)}</p>}
        <p>记录周：{selected.contentWeek} ～ {advanceWeek(selected.contentWeek,6)}</p>
        <div className="submission-facts">{progress(selected)}</div>
        <h3>当前已保存内容</h3>{recordPreview(selected)}
        <button className="button secondary" onClick={() => selectWork(selected)}>查看该成员该周全部记录</button>
        <h3>整份提报历史</h3>
        <div className="timeline">{selected.submissions.map((receipt, index) => <article key={receipt.id}><h3>第 {index + 1} 次提交 · {dateTime(receipt.submittedAt)}</h3><p>{receipt.records.length} 项记录 · {receipt.note || '无补充说明'}</p>{receipt.reason && <p>代录：{nameOf(data, receipt.actorId)} · {receipt.reason}</p>}{(selected.planReviews ?? []).filter(review => review.submissionId === receipt.id).map(review => <div className="submission-review-history" key={review.id}><Badge tone={review.decision === 'approved' ? 'green' : 'red'}>{review.decision === 'approved' ? '此版本审核通过' : '此版本已退回'}</Badge><p>{nameOf(data, review.reviewedBy)} · {dateTime(review.reviewedAt)}{review.reason ? ` · ${review.reason}` : ''}</p></div>)}<details><summary>查看本次提交快照</summary><WeeklySubmissionSnapshot submission={receipt} data={data} /></details></article>)}{selected.adjustments.map(event => <article key={event.id}><h3>{{ exempt: '豁免', revoke_exemption: '撤销豁免', invalidate: '作废提交', restore: '恢复提交' }[event.action]} · {dateTime(event.occurredAt)}</h3><p>{nameOf(data, event.actorId)} · {event.reason}</p></article>)}{!selected.submissions.length && <p>尚未提交整份提报；上方已保存的周记录仍可查看。</p>}</div>
        {manager && <div className="submission-actions">{selected.kind === 'plan' && selected.planReviewStatus === 'pending' && <button className="button primary" onClick={() => open(selected, 'review')}>审核计划</button>}<button className="button secondary" onClick={() => open(selected, 'submit')}>代录提报</button><button className="button secondary" onClick={() => { setAdjustAction('exempt'); setMode('adjust') }}>豁免 / 纠错</button></div>}
      </Modal>}

      {mode === 'review' && selected?.latestSubmission && manager && <Modal title="审核下周计划" onClose={closeMode} wide>
        <div className="context-box"><strong>{nameOf(data, selected.ownerId)} · {selected.contentWeek} ～ {advanceWeek(selected.contentWeek, 6)}</strong><p>待审提交：{dateTime(selected.latestSubmission.submittedAt)} · {selected.latestSubmission.records.length} 项安排</p><Badge tone={tones[selected.status]}>{submissionProgress(selected).label}</Badge></div>
        <p className="modal-intro">以下为本次提交时保存的计划、任务与月目标内容。审核通过后，相应计划纳入正式统计；日常执行进展可继续更新。</p>
        <WeeklySubmissionSnapshot submission={selected.latestSubmission} data={data} />
        {selected.latestSubmission.note && <p className="submission-notice">补充说明：{selected.latestSubmission.note}</p>}
        {selected.latestSubmission.reason && <p className="submission-explanation">管理员代录原因：{selected.latestSubmission.reason}</p>}
        <button className="text-button" disabled={loading} onClick={() => void refreshSelected('review').catch(() => {})}>刷新待审版本</button>
        {selected.planReviewStatus === 'pending' ? <Form key={selected.latestSubmission.id} onCancel={closeMode} submitLabel={reviewDecision === 'approved' ? '确认审核通过' : '退回修改'} onSubmit={async event => {
          const reason = String(new FormData(event.currentTarget).get('reason') || '').trim()
          if (reviewDecision === 'returned' && !reason) throw new Error('退回时请填写修改意见')
          const input = { dutyId:selected.id, version:selected.version, submissionId:selected.latestSubmission!.id, decision:reviewDecision, reason }
          const payload = JSON.stringify(input)
          if (!reviewAttempt.current || reviewAttempt.current.payload !== payload) reviewAttempt.current = { payload, requestId:createSubmissionRequestId() }
          await api('/weekly-submissions/review', json({ ...input, requestId:reviewAttempt.current.requestId }))
          await saved(reviewDecision === 'approved' ? '该版本周计划已审核通过' : '周计划已退回修改，退回意见已记录')
        }}>
          <Field label="审核结果"><select aria-label="审核结果" value={reviewDecision} onChange={event => setReviewDecision(event.target.value as 'approved' | 'returned')}><option value="approved">审核通过</option><option value="returned">退回修改</option></select></Field>
          <Field label={reviewDecision === 'returned' ? '退回意见' : '审核意见（选填）'} hint={reviewDecision === 'returned' ? '请说明需要修改的内容，成员修改后重新整份提交。' : '本次结论仅对应上方提交版本。'}><textarea name="reason" required={reviewDecision === 'returned'} rows={3} maxLength={LIMITS.text} /></Field>
        </Form> : <div className="submission-notice"><PlanReviewStatus duty={selected} /><p>当前版本已不处于待审状态，请核对最新记录。</p></div>}
      </Modal>}

      {mode === 'adjust' && selected && manager && <Modal title="提报豁免与纠错" onClose={closeMode}>
        <p>所有操作保留原因和操作者，不删除原提交或缺交事实。</p>
        <Form onCancel={closeMode} onSubmit={async event => { await api('/weekly-submissions/adjust', json({ ...Object.fromEntries(new FormData(event.currentTarget)), dutyId: selected.id, version: selected.version })); await saved('调整已记录') }}>
          <Field label="操作"><select name="action" value={adjustAction} onChange={e => setAdjustAction(e.target.value)}><option value="exempt">豁免本项</option><option value="revoke_exemption">撤销豁免</option><option value="invalidate">作废一次错误提交</option><option value="restore">恢复一次提交</option></select></Field>
          {['invalidate', 'restore'].includes(adjustAction) && <Field label="对应提交"><select name="submissionId" required defaultValue=""><option value="" disabled>选择提交记录</option>{selected.submissions.map((receipt, i) => <option key={receipt.id} value={receipt.id}>第 {i + 1} 次 · {dateTime(receipt.submittedAt)}</option>)}</select></Field>}
          <Field label="原因"><textarea name="reason" rows={3} required /></Field>
        </Form>
      </Modal>}

      {mode === 'roster' && view?.cycle && manager && <Modal title="核对应交名单" onClose={closeMode}>
        <p>历史账号状态不足以可靠还原本周名单，请按实际在岗情况确认。</p>
        <p>仅核对该历史周期，不会重新启用账号或新增当前工作。</p>
        <PeriodEditorDirectory data={data} includeInactive>{directory => <Form onCancel={closeMode} onSubmit={async event => {
          const form = new FormData(event.currentTarget)
          await api('/weekly-submissions/roster', json({ week, version: view.cycle!.version, rosterIds: form.getAll('rosterIds'), reason: form.get('reason') })); await saved('应交名单已确认')
        }}>
          {historicalRosterAccounts(directory.users).map(user => <label className="check-field" key={user.id}><input name="rosterIds" type="checkbox" value={user.id} defaultChecked={view.cycle!.rosterIds.includes(user.id)} />{accountDisplayName(user)}</label>)}
          <Field label="核对依据"><textarea name="reason" rows={3} required /></Field>
        </Form>}</PeriodEditorDirectory>
      </Modal>}

      {mode === 'rule' && view && manager && <Modal title="周提报规则" onClose={closeMode}>
        <p>分别提交本周完成情况和下周计划。规则自 {view.rule.effectiveWeek} 起生效。</p><p>启停从下一个完整周生效，已形成的应交项、缺交和补交记录保留。</p>
        {view.rule.planReviewEffectiveWeek && <p>下周计划审核自 {view.rule.planReviewEffectiveWeek} 提报周期开始，覆盖 {advanceWeek(view.rule.planReviewEffectiveWeek, 7)} 当周计划。原有历史无需补审；管理员下发的安排视为已确认，代录计划仍需审核。</p>}
        <Form onCancel={closeMode} onSubmit={async event => { await api('/weekly-submissions/rule', json({ version: view.rule.version, enabled: new FormData(event.currentTarget).get('enabled') === 'true' }, 'PUT')); await saved('提报规则已更新') }}>
          <Field label="后续周期"><select name="enabled" defaultValue={String(view.rule.enabled)}><option value="true">启用周提报检查</option><option value="false">暂停后续周期检查</option></select></Field>
        </Form>
        <WeeklyDeadlineSettings key={`${view.week}-${view.rule.version}-${view.workCalendar?.version}-${view.cycle?.version}`} view={view} onUpdated={ruleUpdated} />
      </Modal>}
    </section>
  )
}

export function WeeklyDeadlineBanner({ view }: { view: Pick<WeeklySubmissionView, 'week' | 'nextWeek' | 'deadlineAt' | 'deadlinePolicy'> }) {
  return <div className="submission-deadline"><Clock3 size={16} /><strong>{view.deadlineAt === null ? weeklyDeadlineLabel(null) : `截止：${weeklyDeadlineLabel(view.deadlineAt)}`}</strong>{view.deadlinePolicy && <span>{view.deadlinePolicy.mode === 'last_workday' ? '按当周最后一个工作日截止' : '固定周五截止'}</span>}<span>完成情况：{view.week} ～ {advanceWeek(view.week,6)} · 下周计划：{view.nextWeek} ～ {advanceWeek(view.nextWeek,6)}</span>{view.deadlineAt === null && <span>无须正式提报，不计缺交；仍可安排任务和记录进展。</span>}</div>
}

export function PlanReviewStatus({ duty }: { duty: WeeklyDutyView }) {
  if (duty.kind !== 'plan') return null
  const status = duty.planReviewStatus ?? 'not_required'
  const review = duty.latestPlanReview
  return <div className="submission-review-state" aria-label="计划审核状态">
    <span>计划审核：<Badge tone={planReviewTones[status]}>{planReviewLabels[status]}</Badge></span>
    {status === 'returned' && review?.reason && <p className="submission-return-reason">退回意见：{review.reason}</p>}
  </div>
}

/** Render receipt-owned context; later task or goal edits must not change the reviewed history. */
export function WeeklySubmissionSnapshot({ submission, data }: { submission: WeeklySubmission; data: PageProps['data'] }) {
  return <div className="submission-preview submission-frozen-preview" aria-label="提交时的计划快照">
    {submission.records.map(row => {
      const task = submission.planTaskSnapshots?.find(item => item.id === row.taskId)
      const plan = submission.planGoalSnapshots?.find(item => item.id === row.monthlyPlanId)
      const current = data.weeklyRecords.find(item => item.id === row.id)
      return <article key={row.id}>
        <strong>{task?.title || row.commitment || `任务 #${row.taskId.slice(-6).toUpperCase()}`}</strong>
        {current?.deletion && <Badge>当前记录已删除 · 历史快照保留</Badge>}
        <p>{nameOf(data, row.ownerId)} · {row.weekStart} ～ {advanceWeek(row.weekStart, 6)}</p>
        <WorkOriginLabel row={row} data={data} />
        <p>本周承诺：{row.commitment || '未填写'}</p>
        <p>月度目标：{plan ? `${plan.month} · ${plan.title}` : row.monthlyPlanId ? `目标 #${row.monthlyPlanId.slice(-6).toUpperCase()}（历史未保存标题）` : '未关联月度目标 / 临时工作'}</p>
        {task && <><p>任务截止：{task.dueDate || '未设置'}</p>{task.description && <p>任务说明：{task.description}</p>}</>}
        {row.actualOutcome && <p>提交时进展：{row.actualOutcome}</p>}
        {row.blocker && <p>提交时阻塞：{row.blocker}</p>}
      </article>
    })}
    {!submission.records.length && <p>本次未包含正式工作安排。{submission.note ? `说明：${submission.note}` : '请核对提交说明。'}</p>}
  </div>
}
