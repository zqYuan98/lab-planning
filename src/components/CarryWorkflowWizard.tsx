import { LIMITS } from '../../shared/entity-rules'
import { useEffect, useRef, useState } from 'react'
import type { MonthlyPlan } from '../../shared/types'
import type { CarryApplyPreview, CarryPreview, CarryWorkflowView } from '../../shared/carry-workflows'
import { isActiveTask } from '../../shared/task-state'
import { api, ApiError, json } from '../api'
import { Field } from '../ui'

export interface CarryWorkflowWizardProps {
  sourcePlan: MonthlyPlan; actorId: string; operationEpoch: string; refresh: () => Promise<void>; onClose: () => void; onOpenTarget: (plan: MonthlyPlan) => void
}
interface PendingCommand { path: string; method: string; body: Record<string, unknown>; epoch: string }
const labels: Record<string, string> = { draft: '草稿', submitted: '待审核', returned: '退回修改', approved: '已批准，等待发布', published: '已发布', merged: '已合并', preparing: '准备中', awaiting_publication: '等待发布', ready: '可继续处理', completed: '已完成', cancelled: '已取消' }
const sourceLabels: Record<string, string> = { title: '标题', expectedOutcome: '预期成果', actualOutcome: '实际成果', acceptanceCriteria: '验收标准', acceptanceStatus: '验收结论', acceptanceNote: '验收说明', dueDate: '截止日期', ownerId: '负责人', collaboratorIds: '协作成员', projectId: '项目', category: '工作类别', priority: '优先级', workSource: '工作来源', assignedBy: '交办人', assignedOn: '交办日期', status: '目标状态', reviewComment: '审核意见', publishedVersion: '发布版本', isTemporary: '临时目标', temporaryReason: '临时原因' }
const changeText = (value: unknown): string => value === undefined || value === null || value === '' ? '未填写' : typeof value === 'object' ? JSON.stringify(value) : String(value)

/** Recovery is server-backed. Unknown commands retain their exact request ID until read/replayed. */
export default function CarryWorkflowWizard({ sourcePlan, actorId, operationEpoch, refresh, onClose, onOpenTarget }: CarryWorkflowWizardProps) {
  const storageKey = `carry-workflow:${actorId}:${operationEpoch}:${sourcePlan.id}`
  const [view, setView] = useState<CarryWorkflowView | null>(null), [flows, setFlows] = useState<CarryWorkflowView[]>([])
  const [sourcePreview, setSourcePreview] = useState<CarryPreview | null>(null), [applyPreview, setApplyPreview] = useState<CarryApplyPreview | null>(null)
  const [step, setStep] = useState(1), [month, setMonth] = useState(() => {
    const next = new Date(`${sourcePlan.month}-01T00:00:00Z`); next.setUTCMonth(next.getUTCMonth() + 1); return next.toISOString().slice(0, 7)
  })
  const [targetId, setTargetId] = useState(''), [dueDate, setDueDate] = useState(''), [remainingWork, setRemainingWork] = useState(''), [reason, setReason] = useState(''), [split, setSplit] = useState(false)
  const [selectedIds, setSelectedIds] = useState<string[]>([]), [week, setWeek] = useState(''), [commitments, setCommitments] = useState<Record<string, string>>({})
  const [confirmed, setConfirmed] = useState(false), [cancelReason, setCancelReason] = useState(''), [cancelOpen, setCancelOpen] = useState(false)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [refreshFailed, setRefreshFailed] = useState(false)
  const [pending, setPending] = useState<PendingCommand | null>(() => {
    try { const saved = JSON.parse(sessionStorage.getItem(storageKey) || 'null') as PendingCommand | null; return saved?.epoch === operationEpoch ? saved : null } catch { return null }
  })
  const pendingRef = useRef(pending), serial = useRef(0), busyRef = useRef(false), alive = useRef(true)
  const currentSource = sourcePreview?.source || view?.source || sourcePlan
  const terminal = view && ['completed', 'cancelled'].includes(view.workflow.status)
  const setAttempt = (value: PendingCommand | null) => {
    pendingRef.current = value; setPending(value)
    try { if (value) sessionStorage.setItem(storageKey, JSON.stringify(value)); else sessionStorage.removeItem(storageKey) } catch { /* server list remains the recovery source */ }
  }
  const adopt = (next: CarryWorkflowView) => {
    setView(next); setApplyPreview(null); setConfirmed(false); setCancelOpen(false)
    setSelectedIds(next.workflow.selectedTaskIds); setWeek(next.workflow.targetWeek); setCommitments(next.workflow.commitments || {})
    setStep(next.workflow.status === 'ready' ? 4 : ['completed', 'cancelled'].includes(next.workflow.status) ? 5 : 3)
  }
  const run = async (action: () => Promise<void>) => {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true); setError('')
    try { await action() } catch (caught) { if (alive.current) setError(caught instanceof Error ? caught.message : '操作失败，请重新读取核对') }
    finally { busyRef.current = false; if (alive.current) setBusy(false) }
  }
  const loadFlows = async () => {
    const ticket = ++serial.current
    const rows = await api<CarryWorkflowView[]>(`/carry-workflows?sourcePlanId=${encodeURIComponent(sourcePlan.id)}`)
    if (!alive.current || ticket !== serial.current) return
    setFlows(rows)
    const unresolved = pendingRef.current
    if (unresolved) {
      const found = rows.find(row => row.workflow.stepReceipts.some(receipt => receipt.requestId === unresolved.body.requestId))
      if (found) { setAttempt(null); adopt(found) }
    }
  }
  useEffect(() => {
    alive.current = true
    void loadFlows().catch(caught => { if (alive.current) setError(caught instanceof Error ? caught.message : '读取流程失败') })
    return () => { alive.current = false; ++serial.current }
    // The parent remounts this component on source or operation epoch changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const readAgain = async () => {
    await refresh()
    await loadFlows()
    if (view) adopt(await api<CarryWorkflowView>(`/carry-workflows/${view.workflow.id}`))
    setRefreshFailed(false)
  }
  const send = async (path: string, body: Record<string, unknown>, method = 'POST') => {
    const attempt = pendingRef.current || { path, body: { ...body, requestId: crypto.randomUUID() }, method, epoch: operationEpoch }
    setAttempt(attempt)
    try {
      const result = await api<CarryWorkflowView>(attempt.path, { ...json(attempt.body, attempt.method), headers: { 'X-Operation-Epoch': attempt.epoch } })
      setAttempt(null); adopt(result)
      return result
    } catch (caught) {
      if (caught instanceof ApiError && caught.status >= 400 && caught.status < 500) {
        setAttempt(null); setApplyPreview(null); setConfirmed(false)
        if (view) setStep(view.canApply ? 4 : 3)
        else if (caught.code === 'SOURCE_VERSION_CONFLICT') { setSourcePreview(null); setStep(1) }
      }
      throw caught
    }
  }
  const refreshSaved = async () => {
    try { await refresh(); await loadFlows(); setRefreshFailed(false) }
    catch { setRefreshFailed(true); setError('操作已经保存，页面刷新失败。请重新读取已保存结果，无需重复提交。') }
  }
  const selectSource = async () => {
    const ticket = ++serial.current
    const result = await api<CarryPreview>('/carry-workflows/preview', json({ sourcePlanId: sourcePlan.id, targetMonth: month }))
    if (!alive.current || ticket !== serial.current) return
    setSourcePreview(result); setTargetId(result.candidates[0]?.id || ''); setSplit(false)
  }
  const sourceStatus = { pending: '待交付', submitted: '待验收', accepted: '已验收', not_completed: '未完成' }[currentSource.acceptanceStatus]
  return <div className="carry-wizard">
    <ol className="carry-steps" aria-label="跨期处理步骤">{['核对来源', '建立承接目标', '等待发布', '预览影响', '确认关联与排周'].map((label, index) => <li key={label} aria-current={step === index + 1 ? 'step' : undefined}><span>{index + 1}</span>{label}</li>)}</ol>
    {error && <p className="error" role="alert">{error}</p>}
    {refreshFailed && <button type="button" className="button secondary" disabled={busy} onClick={() => void run(readAgain)}>重新读取已保存结果</button>}
    {pending && <div className="context-box" role="status"><strong>上次操作的结果尚待核对</strong><p>先读取部门流程；如仍未找到结果，可用原提交标识安全核对。</p><div className="carry-actions"><button className="button secondary" disabled={busy} onClick={() => void run(loadFlows)}>读取已有流程</button><button className="button secondary" disabled={busy} onClick={() => void run(async () => { await send(pending.path, pending.body, pending.method); await refreshSaved() })}>核对原操作结果</button></div></div>}
    {!view && flows.length > 0 && <details className="carry-recovery" open><summary>已有跨期流程（{flows.length}）</summary>{flows.map(row => <div className="carry-recovery-row" key={row.workflow.id}><span><strong>{row.workflow.targetMonth} · {row.target.title}</strong><small>{labels[row.workflow.status]} · 创建人 {row.workflow.actorId} · 流程 {row.workflow.id.slice(0, 8)}</small></span><button className="button secondary" disabled={busy || !!pending} onClick={() => void run(async () => adopt(await api<CarryWorkflowView>(`/carry-workflows/${row.workflow.id}`)))}>打开流程</button></div>)}</details>}
    {!view && <fieldset className="form-fields" disabled={busy || !!pending}>
      {step === 1 && <>
        <div className="context-box"><h3>{currentSource.month} · {currentSource.title}</h3><p>验收结论：{sourceStatus} · {currentSource.acceptanceNote || '尚无验收说明'}</p><p>已完成部分：{currentSource.actualOutcome || '尚未记录'}</p><p>原预期成果：{currentSource.expectedOutcome}</p></div>
        <Field label="承接月份"><input aria-label="承接月份" type="month" value={month} onChange={event => { setMonth(event.target.value); setSourcePreview(null) }} /></Field>
        <button className="button secondary" onClick={() => void run(selectSource)}>读取来源任务与已有承接目标</button>
        {sourcePreview && <><p>来源目标版本 V{sourcePreview.source.version}；{sourcePreview.tasks.length} 项关联任务，{sourcePreview.candidates.length} 个同月承接目标。</p><ul>{sourcePreview.tasks.map(task => <li key={task.id}>{task.title} · {task.id} · {task.cancellation ? '已作废' : task.status === 'done' ? '已完成' : '可持续执行'}</li>)}</ul><button className="button primary" onClick={() => setStep(2)}>已核对来源，继续</button></>}
      </>}
      {step === 2 && sourcePreview && <form onSubmit={event => { event.preventDefault(); void run(async () => {
        if (!targetId && sourcePreview.candidates.length > 0 && !split) throw new Error('请明确确认另建拆分目标')
        await send('/carry-workflows', { sourcePlanId: sourcePreview.source.id, sourceVersion: sourcePreview.source.version, targetMonth: month, targetPlanId: targetId || null, dueDate, remainingWork, reason, split }); await refreshSaved()
      }) }}>
        <Field label="承接目标"><select value={targetId} onChange={event => setTargetId(event.target.value)}>{sourcePreview.candidates.map(target => <option key={target.id} value={target.id}>{target.title} · {labels[target.status]} · {target.id.slice(0, 8)}</option>)}<option value="">明确新建承接草稿</option></select></Field>
        {!targetId && <Field label="承接目标截止日期"><input type="date" required value={dueDate} onChange={event => setDueDate(event.target.value)} /></Field>}
        {!targetId && sourcePreview.candidates.length > 0 && <label className="checkbox-label"><input type="checkbox" required checked={split} onChange={event => setSplit(event.target.checked)} />明确拆分：在同一来源、同一月份另建目标</label>}
        <Field label="剩余工作"><textarea required rows={3} maxLength={LIMITS.text} value={remainingWork} onChange={event => setRemainingWork(event.target.value)} /></Field>
        <Field label="跨期处理原因"><textarea required rows={2} maxLength={LIMITS.text} value={reason} onChange={event => setReason(event.target.value)} /></Field>
        <p className="form-hint">新草稿沿用原目标责任与验收字段；可在月度目标中调整后审核发布。任务会沿用原编号。</p>
        <div className="carry-actions"><button type="button" className="button secondary" onClick={() => setStep(1)}>返回核对来源</button><button type="submit" className="button primary">{targetId ? '使用已有目标，建立流程' : '建立流程与承接草稿'}</button></div>
      </form>}
    </fieldset>}
    {view && <>
      <div className="context-box"><strong>{view.source.month} → {view.target.month} · {view.target.title}</strong><p>目标状态：{labels[view.target.status]}；剩余工作：{view.workflow.remainingWork}</p><small>流程 {view.workflow.id} · 创建人 {view.workflow.actorId}</small></div>
      {view.blockedReason && <p className="error" role="alert">{view.blockedReason}</p>}
      {view.sourceChanged && <div className="context-box"><strong>等待期间来源目标已更新</strong><p>开始时 V{view.workflow.sourceVersionAtStart}，现在 V{view.source.version}。请核对后重新预览。</p><dl className="carry-diff">{view.sourceChanges.map(key => <div key={key}><dt>{sourceLabels[key] || key}</dt><dd><del>{changeText((view.workflow.sourceSnapshot as unknown as Record<string, unknown>)[key])}</del><span> → {changeText((view.source as unknown as Record<string, unknown>)[key])}</span></dd></div>)}</dl></div>}
      {step === 3 && <div><h3>{view.blockedReason ? '需要重新核对来源' : '等待承接目标正式发布'}</h3><p>{view.blockedReason ? '核对最新来源目标后，可取消此流程并从有效来源重新发起。已创建的承接目标会保留。' : view.target.status === 'approved' ? '审核已经通过，发布后才能继续关联任务。' : '通过现有月度目标入口完成修改、审核及发布，再返回本流程。'}</p>{view.target.reviewComment && <p>审核意见：{view.target.reviewComment}</p>}<div className="carry-actions"><button className="button primary" disabled={busy} onClick={() => onOpenTarget(view.target)}>打开目标审核 / 发布入口</button><button className="button secondary" disabled={busy} onClick={() => void run(readAgain)}>重新读取发布状态</button></div></div>}
      {step === 4 && view.canApply && <fieldset className="form-fields" disabled={busy || !!pending || refreshFailed}>
        <h3>选择持续执行任务与目标周</h3><p className="form-hint">原任务继续使用原编号。需要拆分任务时，请退出向导进入新任务创建。</p>
        <Field label="目标周（自动按周一归一）"><input type="date" value={week} onChange={event => { setWeek(event.target.value); setApplyPreview(null) }} /></Field>
        {view.tasks.filter(task => task.monthlyPlanId === view.source.id && isActiveTask(task) && task.status !== 'done').map(task => <div className="carry-task" key={task.id}><label className="checkbox-label"><input type="checkbox" checked={selectedIds.includes(task.id)} onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, task.id] : ids.filter(id => id !== task.id))} /><strong>{task.title}</strong></label><small>原任务编号 {task.id} · V{task.version}</small>{selectedIds.includes(task.id) && <Field label="目标周承诺（已有安排会保留原承诺）"><textarea rows={2} value={commitments[task.id] ?? view.workflow.remainingWork} onChange={event => setCommitments(values => ({ ...values, [task.id]: event.target.value }))} /></Field>}</div>)}
        <button className="button primary" disabled={!selectedIds.length || !week} onClick={() => void run(async () => {
          const selection = { selectedTaskIds: selectedIds, targetWeek: week, commitments: Object.fromEntries(selectedIds.map(id => [id, commitments[id] ?? view.workflow.remainingWork])) }
          const saved = await send(`/carry-workflows/${view.workflow.id}`, { workflowVersion: view.workflow.version, ...selection }, 'PATCH')
          const preview = await api<CarryApplyPreview>(`/carry-workflows/${saved.workflow.id}/preview-apply`, json(selection))
          setView(preview.view); setApplyPreview(preview); setConfirmed(false); setStep(5)
        })}>保存选择并预览影响</button>
      </fieldset>}
      {step === 5 && applyPreview && !terminal && <fieldset className="form-fields" disabled={busy || !!pending || refreshFailed}>
        <h3>核对本次完整影响</h3><p>目标周 {applyPreview.selection.targetWeek}；将处理 {applyPreview.impacts.length} 个原任务。</p>
        {applyPreview.impacts.map(impact => <div className="carry-task" key={impact.task.id}><strong>{impact.task.title}</strong><small>沿用编号 {impact.task.id}；任务当前 V{impact.task.version}</small><p>任务关联到：{applyPreview.view.target.title}</p><p>调整周草稿：{impact.relinkDrafts.length ? impact.relinkDrafts.map(row => `${row.weekStart}（${row.id} / V${row.version}）`).join('、') : '无'}</p><p>保留历史记录：{impact.preservedRecords.length} 条（成果、正式提交、撤回历史及删除记录保留原归属）。</p>{impact.preservedRecords.length > 0 && <details><summary>逐条核对保留的周记录</summary><ul>{impact.preservedRecords.map(row => <li key={row.id}>{row.weekStart} · {row.id} · V{row.version}{row.deletion ? ' · 已删除' : row.submitted ? ' · 已提交' : ' · 保留原归属'}<p>{row.commitment}</p></li>)}</ul></details>}<p>{impact.existingTargetRecord ? `复用已有安排 ${impact.existingTargetRecord.id}，承诺保留：` : '新建目标周草稿，承诺：'}{impact.commitment}</p></div>)}
        <p className="form-hint">原月成果、发布快照、周审核和定稿报告保持原记录。任一清单变化均需重新预览；所有关联与排周一次完成。</p>
        <Field label="关联与排周原因"><textarea required value={reason} onChange={event => setReason(event.target.value)} rows={2} /></Field>
        <label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已核对最新来源、全部任务及周记录影响，确认关联与排周</label>
        <div className="carry-actions"><button className="button secondary" onClick={() => { setApplyPreview(null); setStep(4) }}>返回选择</button><button className="button primary" disabled={!confirmed || !reason.trim()} onClick={() => void run(async () => {
          await send(`/carry-workflows/${view.workflow.id}/apply`, { workflowVersion: applyPreview.view.workflow.version, ...applyPreview.selection, manifest: applyPreview.manifest, fingerprint: applyPreview.fingerprint, reason }); await refreshSaved()
        })}>确认关联与排周</button></div>
      </fieldset>}
      {view.workflow.status === 'completed' && <div role="status"><h3>关联与排周已完成</h3><p>沿用任务编号：</p><ul>{view.workflow.result?.taskIds.map(id => <li key={id}>{view.tasks.find(task => task.id === id)?.title || '任务'} · {id}</li>)}</ul><p>调整 {view.workflow.result?.relinkedDraftIds.length || 0} 条周草稿；新建 {view.workflow.result?.createdRecordIds.length || 0} 条安排；复用 {view.workflow.result?.reusedRecordIds.length || 0} 条安排。</p><p>目标周：{view.workflow.targetWeek}</p>{([['调整周草稿', view.workflow.result?.relinkedDraftIds], ['新建目标周安排', view.workflow.result?.createdRecordIds], ['复用已有安排', view.workflow.result?.reusedRecordIds]] as const).map(([label, ids]) => ids && ids.length > 0 && <details key={label}><summary>{label}（{ids.length}）</summary><ul>{ids.map(id => { const row = view.records.find(record => record.id === id); return <li key={id}>{row?.weekStart || '历史周'} · {id}{row && <p>{row.commitment}</p>}</li> })}</ul></details>)}</div>}
      {view.workflow.status === 'cancelled' && <p role="status">流程已取消。已建立的承接目标、审批与历史记录均已保留。</p>}
      {!terminal && <div className="carry-cancel"><button className="button secondary" disabled={busy || !!pending} onClick={() => setCancelOpen(value => !value)}>取消此流程</button>{cancelOpen && <form onSubmit={event => { event.preventDefault(); void run(async () => { await send(`/carry-workflows/${view.workflow.id}/cancel`, { workflowVersion: view.workflow.version, reason: cancelReason }); await refreshSaved() }) }}><p>取消仅停止后续处理。已创建的承接草稿和审核发布记录会保留，不会删除历史。</p><Field label="取消原因"><textarea required value={cancelReason} onChange={event => setCancelReason(event.target.value)} /></Field><button className="button danger" disabled={busy || !cancelReason.trim()}>确认取消并保留目标</button></form>}</div>}
    </>}
    <div className="carry-actions carry-footer"><button className="button secondary" disabled={busy} onClick={onClose}>关闭，稍后继续</button>{view && <button className="button secondary" disabled={busy} onClick={() => void run(readAgain)}>重新读取流程</button>}</div>
  </div>
}
