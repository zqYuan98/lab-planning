import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { CheckCheck, Download, RefreshCw, Save, Sparkles } from 'lucide-react'
import type { Report } from '../../shared/types'
import type { ReportAgentBlock, ReportAgentCell, ReportAgentJob, ReportFact } from '../../shared/report-agent'
import { api, finishSaved, json, SavedResultError } from '../api'
import { Badge, Field, Modal } from '../ui'
import { useFormDraft } from '../use-form-draft'
import { allowDraftLeave } from '../draft-recovery'
import ReportAgentJobCard from './ReportAgentJobCard'
import { agentJobPending, agentLabel, agentReportUrl, agentRequestId, agentTime, editAgentCell, readAgentReportTarget, submitAgentGeneration, type AgentPendingRequest } from './ReportAgentHelpers'
const ReportAgentPreview = lazy(() => import('./ReportAgentPreview'))

export function canRewriteAgentBlock(block: ReportAgentBlock): boolean {
  const cells = block.kind === 'text' ? [block.content] : block.rows.flat()
  return cells.some(cell => !cell.manual && cell.factIds.length > 0 && !!cell.text.trim())
}

export default function ReportAgentEditor({ report, accountId, aiConfigured, refresh, notify, onSaved }: {
  report: Report; accountId: string; aiConfigured: boolean; refresh: () => Promise<void>; notify: (message: string) => void; onSaved: (report: Report) => void
}) {
  const [saved, setSaved] = useState(report)
  const [title, setTitle] = useState(report.title)
  const [blocks, setBlocks] = useState(report.agent!.blocks)
  const [editVersion, setEditVersion] = useState(report.version)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [refreshFailed, setRefreshFailed] = useState(false)
  const [preview, setPreview] = useState(false), [finalizeOpen, setFinalizeOpen] = useState(false)
  const [reviewNote, setReviewNote] = useState(''), [reviewed, setReviewed] = useState(false)
  const [job, setJob] = useState<ReportAgentJob | null>(null), [jobReady, setJobReady] = useState(false)
  const [refreshSource, setRefreshSource] = useState(true)
  const lock = useRef(false)
  const rewriteRequest = useRef<{ key: string; id: string } | null>(null)
  const generationRequest = useRef<AgentPendingRequest | null>(null)
  const agent = saved.agent!
  const editable = saved.status === 'draft'
  const dirty = title !== saved.title || JSON.stringify(blocks) !== JSON.stringify(agent.blocks)
  const blockers = agent.issues.filter(issue => issue.severity === 'error')
  const recovery = useFormDraft(editable ? `${accountId}:report-agent-report:${saved.id}` : undefined,
    { title, blocks: JSON.stringify(blocks), baseVersion: String(editVersion) }, values => {
      if (typeof values.title === 'string') setTitle(values.title)
      if (typeof values.blocks === 'string') {
        try {
          const candidate = JSON.parse(values.blocks) as ReportAgentBlock[]
          if (Array.isArray(candidate) && candidate.every(item => typeof item.id === 'string' && Array.isArray(item.rows) && !!item.content)) setBlocks(candidate)
        } catch { /* Ignore malformed local draft. */ }
      }
      if (typeof values.baseVersion === 'string' && /^\d+$/.test(values.baseVersion)) setEditVersion(Number(values.baseVersion))
      if (values.baseVersion !== String(saved.version)) setError('恢复的草稿来自较早版本。当前编辑已保留，请对照已保存内容后再保存；服务器将核对版本。')
    }, busy)
  const baselineVersion = useRef(saved.version)
  useEffect(() => { if (baselineVersion.current !== saved.version) { baselineVersion.current = saved.version; recovery.clearDraft() } }, [saved.version])
  async function action(work: () => Promise<void>) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError(''); setRefreshFailed(false)
    try { await work() }
    catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，当前编辑已保留。'); setRefreshFailed(failure instanceof SavedResultError) }
    finally { lock.current = false; setBusy(false) }
  }
  function accept(next: Report) {
    setSaved(next); setEditVersion(next.version); setTitle(next.title); setBlocks(next.agent!.blocks)
    recovery.clearDraft(); onSaved(next); setJobReady(false)
  }
  async function save() {
    await action(async () => {
      const result = await api<Report>(`/report-agent/reports/${saved.id}`, json({ expectedVersion: editVersion, title, blocks }, 'PATCH'))
      accept(result); notify('周报内容已保存并重新校验。'); await finishSaved(refresh)
    })
  }
  async function reload(resultJob?: Pick<ReportAgentJob, 'reportId'> | null) {
    await readAgentReportTarget(saved.id, resultJob, () => allowDraftLeave(recovery.formRef.current), id => action(async () => {
      accept(await api<Report>(`/report-agent/reports/${encodeURIComponent(id)}`)); notify('已读取服务器保存的报告。')
    }))
  }
  function changeCell(blockId: string, cell: ReportAgentCell, row?: number, column?: number) {
    setBlocks(current => current.map(block => block.id !== blockId ? block : row === undefined || column === undefined ? { ...block, content: cell } : { ...block, rows: block.rows.map((cells, rowIndex) => rowIndex === row ? cells.map((value, colIndex) => colIndex === column ? cell : value) : cells) }))
  }
  async function rewrite(blockId: string) {
    await action(async () => {
      const key = `${saved.id}:${saved.version}:${blockId}`
      if (rewriteRequest.current?.key !== key) rewriteRequest.current = { key, id: agentRequestId() }
      const result = await api<ReportAgentJob>(`/report-agent/reports/${saved.id}/rewrite`, json({ expectedVersion: saved.version, blockId, useAi: true, requestId: rewriteRequest.current.id }))
      setJob(result); setJobReady(result.status === 'ready' || result.status === 'needs_input'); notify('已提交章节改写，采用本次冻结事实。')
    })
  }
  return <div className="report-agent agent-editor">
    <header className="report-document-header"><div><span className="report-overline">WEEKLY REPORT / V{saved.revision}</span><h2>{saved.title}</h2><p>事实截至 {agentTime(agent.capturedAt)} · 上海时间</p><p className="agent-note">模板：{agent.template.name} · 模板版本 {agent.template.version} · {agent.modelIdentifier ? '已使用 AI 辅助写作' : '规则草稿'}</p></div><Badge tone={editable ? 'amber' : 'green'}>{editable ? dirty ? '编辑未保存' : '草稿已保存' : '已定稿 · 文件已归档'}</Badge></header>
    <div className="agent-editor-body">
      <div className="agent-callout">周阶段完成与月目标验收分别记录。表格逐格保留来源；系统外补充需填写来源并明确确认。修改文字不改变业务计划状态。</div>
      {job && <ReportAgentJobCard key={job.id} initial={job} onOpen={id => void reload({ reportId: id })} onComplete={result => { setJob(result); if (result.status === 'ready' || result.status === 'needs_input') setJobReady(true) }} />}
      {jobReady && <div className="agent-callout">任务已处理，当前人工编辑仍保留。<button type="button" className="text-button" disabled={busy} onClick={() => void reload(job)}>读取保存结果</button></div>}
      {error && <div className="error" role="alert">{error}{refreshFailed && <button type="button" className="text-button" onClick={() => void action(async () => { await refresh(); notify('已刷新报告列表。') })}>重新加载列表</button>}</div>}
      <form ref={recovery.formRef} onInput={recovery.rememberDraft} onChange={recovery.rememberDraft} onSubmit={event => { event.preventDefault(); void save() }}>
        {recovery.notice && <p className="agent-note" role="status">{recovery.notice}</p>}
        <fieldset className="agent-fieldset" disabled={!editable || busy}>
          <Field label="报告标题"><input name="title" value={title} onChange={event => setTitle(event.target.value)} maxLength={200} required /></Field>
          {blocks.map(block => <section className="agent-content-block" key={block.id}>
            <div className="agent-toolbar"><h3>{agentLabel(block.label)}{block.required && <span className="agent-required">必填</span>}</h3>{editable && canRewriteAgentBlock(block) && <button type="button" className="button secondary" disabled={busy || dirty || !aiConfigured || !!job && agentJobPending(job.status)} title={dirty ? '先保存当前编辑，再改写本节' : undefined} onClick={() => void rewrite(block.id)}><Sparkles size={15} />只改写本节</button>}</div>
            {block.kind === 'text' ? <CellEditor label={agentLabel(block.label)} cell={block.content} forceManual={agent.template.bindings.find(binding => binding.regionId === block.regionId)?.kind === 'manual'} facts={agent.facts} editable={editable && !busy} onChange={cell => changeCell(block.id, cell)} /> : block.rows.length ? <div className="agent-table-scroll"><table className="agent-edit-table"><thead><tr>{block.columns.map((column, index) => <th key={index} scope="col">{column.label}{column.required ? ' *' : ''}</th>)}</tr></thead><tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, columnIndex) => <td key={columnIndex}><CellEditor label={`${agentLabel(block.label)}第 ${rowIndex + 1} 行${block.columns[columnIndex]?.label || `第 ${columnIndex + 1} 列`}`} cell={cell} forceManual={block.columns[columnIndex]?.field === 'manual'} facts={agent.facts} editable={editable && !busy} onChange={value => changeCell(block.id, value, rowIndex, columnIndex)} /></td>)}</tr>)}</tbody></table></div> : <p className="agent-note">本期无符合此表格来源的有效记录；没有把历史示例填入本期。</p>}
          </section>)}
        </fieldset>
        {editable && <div className="agent-actions"><button className="button primary" disabled={busy || !dirty}><Save size={16} />保存并校验</button><button type="button" className="button secondary" disabled={busy} onClick={() => void reload()}><RefreshCw size={16} />读取已保存版本</button></div>}
      </form>
      <section className="agent-validation" aria-label="报告校验结果"><h3>核对与定稿</h3>{dirty && <p className="agent-callout">有未保存的编辑。下方校验对应上次保存版本，请先保存再预览或定稿。</p>}{agent.issues.length ? <ul>{agent.issues.map(issue => <li key={issue.id} className={issue.severity === 'error' ? 'agent-issue-error' : ''}><Badge tone={issue.severity === 'error' ? 'red' : 'amber'}>{issue.severity === 'error' ? '需处理' : '提醒'}</Badge> {issue.message}<small>{agentLabel(blocks.find(block => block.id === issue.location || block.regionId === issue.location)?.label || '报告内容')}</small></li>)}</ul> : <p className="agent-note">当前保存版本未发现阻止定稿的问题，请继续核对 Word 版式和正文含义。</p>}
        <details><summary>全量来源覆盖（{agent.coverage.length} 项）</summary><ul>{agent.coverage.map((item, index) => <li key={`${item.sourceId}:${index}`}>{agent.facts.find(fact => fact.sourceId === item.sourceId)?.subject || '源记录'} · {item.disposition === 'included' ? '已写入正文' : '未显示'} · {item.reason}</li>)}</ul></details>
        <div className="agent-actions"><button type="button" className="button secondary" disabled={busy || dirty} onClick={() => setPreview(true)}>预览{editable ? '已保存草稿' : '归档定稿'}</button>{!dirty && <a className="button secondary" href={agentReportUrl(saved.id, saved.version)} download><Download size={16} />{editable ? '导出草稿 Word' : '下载定稿 Word'}</a>}{editable && <button type="button" className="button primary" disabled={busy || dirty || blockers.length > 0} onClick={() => { setReviewed(false); setFinalizeOpen(true) }}><CheckCheck size={16} />审阅并定稿</button>}</div>
        {agent.finalHash && <p className="agent-note">定稿已归档，后续下载使用相同文件。校验摘要：{agent.finalHash.slice(0, 16)}…</p>}
      </section>
      <details className="agent-new-version"><summary>从此报告生成新版本</summary><p className="agent-note">原报告及人工编辑保留。可选择沿用本次冻结事实，或重新读取当前系统数据；过去的周次不会恢复当时的历史状态。</p><label className="agent-check"><input type="checkbox" checked={refreshSource} onChange={event => setRefreshSource(event.target.checked)} />刷新事实（截至重新生成时）</label><button type="button" className="button secondary" disabled={busy || dirty || !!job && agentJobPending(job.status)} onClick={() => void action(async () => {
        const result = await submitAgentGeneration(generationRequest, { templateId: agent.template.id, period: saved.period, sourceReportId: saved.id, refreshSnapshot: refreshSource, useAi: false }, input => api<ReportAgentJob>('/report-agent/jobs', json(input)))
        setJob(result); setJobReady(result.status === 'ready' || result.status === 'needs_input'); notify('已提交新版本生成任务。')
      })}>生成独立新版本</button></details>
    </div>
    {preview && <Modal title={editable ? '已保存周报草稿' : '已归档周报定稿'} wide onClose={() => setPreview(false)}><Suspense fallback={<p role="status">正在加载预览…</p>}><ReportAgentPreview url={agentReportUrl(saved.id, saved.version)} title={editable ? '保存版本的 Word 预览' : '归档文件预览'} /></Suspense></Modal>}
    {finalizeOpen && <Modal title="确认周报定稿" onClose={() => setFinalizeOpen(false)}><p>将归档当前已保存的第 {saved.revision} 版及其 Word 文件。定稿后不可继续编辑，需要修改时生成新版本。</p><ReportFinalizeReview busy={busy} reviewed={reviewed} reviewNote={reviewNote} hasWarnings={agent.issues.some(issue => issue.severity === 'warning')} onReviewed={setReviewed} onReviewNote={setReviewNote} onClose={() => setFinalizeOpen(false)} onConfirm={() => void action(async () => {
      const result = await api<Report>(`/report-agent/reports/${saved.id}/finalize`, json({ expectedVersion: saved.version, reviewNote }))
      accept(result); setFinalizeOpen(false); notify('周报已定稿，Word 文件已归档。'); await finishSaved(refresh)
    })} />{error && <p className="error" role="alert">{error}</p>}</Modal>}
  </div>
}
export function ReportFinalizeReview({ busy, reviewed, reviewNote, hasWarnings, onReviewed, onReviewNote, onConfirm, onClose }: {
  busy: boolean; reviewed: boolean; reviewNote: string; hasWarnings: boolean; onReviewed: (value: boolean) => void; onReviewNote: (value: string) => void; onConfirm: () => void; onClose: () => void
}) {
  return <><label className="agent-check"><input type="checkbox" checked={reviewed} disabled={busy} onChange={event => onReviewed(event.target.checked)} />已核对正文事实、人工补充及下载后的 Word 版式</label><Field label="审阅说明（必填）" hint={hasWarnings ? '请记录正文与版式核对结果，并说明提醒项的核对结论或保留原因。' : '请记录正文事实、人工补充和 Word 版式的核对结果。'}><textarea value={reviewNote} disabled={busy} maxLength={2000} required onChange={event => onReviewNote(event.target.value)} rows={3} /></Field><div className="agent-actions"><button className="button primary" disabled={busy || !reviewed || !reviewNote.trim() || reviewNote.trim().length > 2000} onClick={onConfirm}>确认定稿</button><button className="button secondary" disabled={busy} onClick={onClose}>继续核对</button></div></>
}
function CellEditor({ label, cell, facts, editable, onChange, forceManual = false }: { label: string; cell: ReportAgentCell; facts: ReportFact[]; editable: boolean; onChange: (cell: ReportAgentCell) => void; forceManual?: boolean }) {
  const [picking, setPicking] = useState(false)
  const selectedFacts = facts.filter(fact => cell.factIds.includes(fact.id))
  return <div className="agent-cell">
    <label><span className="sr-only">{label}</span><textarea aria-label={label} value={cell.text} rows={Math.min(8, Math.max(3, cell.text.split('\n').length))} disabled={!editable} onChange={event => onChange(editAgentCell(cell, event.target.value))} /></label>
    <details className="agent-sources" open={cell.manual && !cell.confirmed ? true : undefined}><summary>{cell.manual ? cell.confirmed ? '人工补充 · 已确认' : '人工补充 · 待确认' : `查看依据（${selectedFacts.length}）`}</summary>
      {selectedFacts.map(fact => <div className="agent-fact" key={fact.id}><strong>{fact.subject}</strong><p>{fact.value || '（未填写）'}</p><small>{fact.period} · {fact.sourceType === 'weeklyRecord' ? '周记录' : fact.sourceType === 'monthlyPlan' ? '月目标' : fact.sourceType === 'metric' ? '系统指标' : '任务'} · 来源版本 {fact.sourceVersion}</small></div>)}
      <label className="agent-check"><input type="checkbox" disabled={!editable || forceManual} checked={cell.manual} onChange={event => onChange({ ...cell, manual: event.target.checked, confirmed: false })} />这是管理者补充的事实</label>
      {cell.manual ? <><Field label={`${label}的补充来源`}><input aria-label={`${label}的补充来源`} disabled={!editable} value={cell.source} placeholder="例如：项目验收记录、业务负责人确认" onChange={event => onChange({ ...cell, source: event.target.value, confirmed: false })} /></Field><label className="agent-check"><input type="checkbox" disabled={!editable || !cell.text.trim() || !cell.source.trim()} checked={cell.confirmed} onChange={event => onChange({ ...cell, confirmed: event.target.checked })} />我已核对这项补充及其来源</label></> : editable && <details onToggle={event => setPicking(event.currentTarget.open)}><summary>调整引用的冻结事实</summary><div className="agent-fact-picker">{picking && facts.map(fact => <label key={fact.id}><input type="checkbox" checked={cell.factIds.includes(fact.id)} onChange={event => onChange({ ...cell, factIds: event.target.checked ? [...cell.factIds, fact.id] : cell.factIds.filter(id => id !== fact.id) })} /><span>{fact.subject} · {fact.value || '（未填写）'}<small>{fact.period} · 版本 {fact.sourceVersion}</small></span></label>)}</div></details>}
    </details>
  </div>
}
