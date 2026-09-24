import { useEffect, useRef, useState } from 'react'
import type { PeriodReviewDisplayReferences, PeriodReviewPreview, PeriodReviewSnapshot } from '../../shared/period-reviews'
import { api, finishSaved, json } from '../api'
import { Field, Form, Modal, dateTime, type PageProps } from '../ui'
import { useBusinessResource } from '../use-business-resource'
import { captureMutationContext, subscribeMutationResponses } from '../mutation-response'
import { assignmentAttempt, type SubmissionAttempt } from '../notification-navigation'
import PeriodReviewDetail from '../components/PeriodReviewDetail'
import '../period-reviews.css'

type ReviewListItem = Pick<PeriodReviewSnapshot, 'id' | 'period' | 'cutoffAt' | 'revision' | 'status' | 'generatedAt' | 'laterEvidenceThrough'>
const timestamp = (value: FormDataEntryValue | null) => value ? new Date(String(value)).toISOString() : undefined
const localTime = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16)
export default function PeriodReviews({ data, notify }: PageProps) {
  const manager = data.user.role === 'manager', scope = `${data.user.id}:${data.user.role}:${data.accessScopeVersion}:${data.operationEpoch}`
  const list = useBusinessResource<{ items: ReviewListItem[] }>('/period-reviews', scope)
  const [selected, setSelected] = useState<PeriodReviewSnapshot | null>(null), [preview, setPreview] = useState<PeriodReviewPreview | null>(null)
  const [references, setReferences] = useState<PeriodReviewDisplayReferences | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [evidenceOpen, setEvidenceOpen] = useState(false), [revisionOf, setRevisionOf] = useState<PeriodReviewSnapshot | null>(null)
  const readSequence = useRef(0), attempts = useRef<Record<string, SubmissionAttempt>>({})
  useEffect(() => { readSequence.current++; setSelected(null); setPreview(null); setReferences(null); setRevisionOf(null); setEvidenceOpen(false); setBusy(false); attempts.current = {}; setError('') }, [scope])
  useEffect(() => subscribeMutationResponses(() => {}, () => { readSequence.current++; setSelected(null); setPreview(null); setReferences(null); setRevisionOf(null); setEvidenceOpen(false); setBusy(false); attempts.current = {} }), [])
  useEffect(() => { if (!list.loading && list.error && !list.value) { setSelected(null); setPreview(null); setRevisionOf(null) } }, [list.loading, list.error, list.value])
  async function choose(id: string) {
    const seq = ++readSequence.current, context = captureMutationContext(); setError(''); setPreview(null)
    try { const [result, refs] = await Promise.all([api<PeriodReviewSnapshot>(`/period-reviews/${id}`), api<PeriodReviewDisplayReferences>(`/period-reviews/${id}/display-references`)]); if (seq === readSequence.current && context === captureMutationContext()) { setSelected(result); setReferences(refs); setRevisionOf(null) } }
    catch (failure) { if (seq === readSequence.current) { setSelected(null); setError(failure instanceof Error ? failure.message : '读取失败') } }
  }
  async function mutate<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const payload = { ...body, operationEpoch: data.operationEpoch }, attempt = assignmentAttempt(attempts.current[path] ?? null, payload); attempts.current[path] = attempt
    const result = await api<T>(path, json({ ...payload, requestId: attempt.requestId })); delete attempts.current[path]; return result
  }
  async function freeze() {
    if (!preview || busy) return
    setBusy(true); setError('')
    try { const result = await mutate<PeriodReviewSnapshot>('/period-reviews', { period: preview.period, cutoffAt: preview.cutoffAt, laterEvidenceThrough: preview.laterEvidenceThrough, previousSnapshotId: preview.previousSnapshotId, fingerprint: preview.fingerprint, sourceManifest: preview.sourceManifest }); setSelected(result); setPreview(null); setRevisionOf(null); await finishSaved(list.refresh, result.version); notify('已冻结草稿，核对后可定稿') }
    catch (failure) { setError(failure instanceof Error ? failure.message : '冻结失败') } finally { setBusy(false) }
  }
  const shown = preview || selected
  return <div className="period-reviews"><header className="page-header"><div><h1>{manager ? '历史周期复盘' : '我的历史交付复盘'}</h1><p>按期末承诺、责任归属和当时可知的正式证据复盘。</p></div></header>
    <p className="period-review-mode">当前管理使用今天的状态与期限；此页独立展示历史周期事实。{!manager && '仅显示期末属于本人的已定稿投影。'}</p>
    {(error || list.error) && <p role="alert" className="error">{error || list.error}{list.error && <button type="button" className="button secondary" onClick={() => { void list.refresh().then(() => setError('')).catch(() => {}) }}>重新读取已保存列表</button>}</p>}
    <div className="period-review-layout"><aside className="period-review-history"><h2>已保存的复盘</h2>{list.loading && <p>正在读取…</p>}{list.value?.items.map(row => <button className={`period-review-history-item ${selected?.id === row.id ? 'selected' : ''}`} key={row.id} onClick={() => void choose(row.id)}><strong>{row.period} · 修订 {row.revision}</strong><span>{row.status === 'finalized' ? '已定稿' : '冻结草稿'}{row.laterEvidenceThrough ? ' · 含事后核实' : ''}</span><small>{dateTime(row.generatedAt)}</small></button>)}{!list.loading && !list.value?.items.length && <p>暂无已保存的历史复盘。</p>}</aside>
      <main>{manager && <details open={!selected || !!revisionOf} className="period-review-controls"><summary>{revisionOf ? `基于 ${revisionOf.period} 第 ${revisionOf.revision} 版新增修订` : '生成历史复盘预览'}</summary><Form key={revisionOf?.id || 'new'} submitLabel="读取期末事实并预览" onSubmit={async event => {
        const f = new FormData(event.currentTarget), seq = ++readSequence.current, context = captureMutationContext()
        const result = await api<PeriodReviewPreview & { displayReferences: PeriodReviewDisplayReferences }>('/period-reviews/preview', json({ period: revisionOf?.period || f.get('period'), cutoffAt: revisionOf?.cutoffAt || timestamp(f.get('cutoffAt')), laterEvidenceThrough: timestamp(f.get('laterEvidenceThrough')), previousSnapshotId: revisionOf?.id }))
        if (seq !== readSequence.current || context !== captureMutationContext()) return
        setPreview(result); setReferences(result.displayReferences); setError('')
      }}><div className="period-review-form-grid"><Field label="复盘月份"><input type="month" name="period" required defaultValue={revisionOf?.period || new Date().toISOString().slice(0, 7)} disabled={!!revisionOf}/></Field><Field label="期末时点（明确时间）"><input type="datetime-local" name="cutoffAt" required defaultValue={revisionOf ? localTime(new Date(revisionOf.cutoffAt)) : localTime(new Date())} disabled={!!revisionOf}/></Field>{revisionOf && <Field label="事后核实截至（可选）"><input type="datetime-local" name="laterEvidenceThrough"/></Field>}</div><p className="form-hint">预览不会修改业务事实；冻结后内容固定，后续事实变化通过新修订呈现。</p></Form></details>}
        {shown && <><div className="period-review-actions">{preview && manager && <button className="button" disabled={busy} onClick={() => void freeze()}>{busy ? '正在冻结…' : '冻结此预览为草稿'}</button>}{selected && !preview && <><span>修订 {selected.revision} · {selected.status === 'finalized' ? '已定稿' : '冻结草稿'}</span><a className="button secondary" href={`/api/period-reviews/${selected.id}/export`}>导出相同口径文本</a>{manager && selected.status === 'draft' && <Form submitLabel="核对完成，正式定稿" onSubmit={async () => { const result = await mutate<PeriodReviewSnapshot>(`/period-reviews/${selected.id}/finalize`, { version: selected.version, contentHash: selected.contentHash }); setSelected(result); await finishSaved(list.refresh, result.version); notify('历史复盘已定稿') }}>{null}</Form>}{manager && selected.status === 'finalized' && <button className="button secondary" onClick={() => { setRevisionOf(selected); setPreview(null) }}>创建新修订</button>}</>}{manager && <button className="button secondary" onClick={() => setEvidenceOpen(true)}>记录历史补证</button>}</div><PeriodReviewDetail review={shown} data={data} references={references}/></>}
      </main></div>
    {evidenceOpen && manager && <Modal title="记录历史补证" onClose={() => setEvidenceOpen(false)}><p>保留声称发生时间与实际录入时间。此记录只作为人工佐证，原定稿与正式提交回执均不改写。</p><Form submitLabel="保存独立补证" onSubmit={async event => {
      const f = new FormData(event.currentTarget); await mutate('/period-reviews/evidence', { taskId: f.get('taskId'), claimedAt: timestamp(f.get('claimedAt')), statement: f.get('statement'), evidence: String(f.get('evidence') || '').split('\n').filter(Boolean), reason: f.get('reason') }); setEvidenceOpen(false); setPreview(null); notify('补证已独立保存；请生成修订预览以核对新证据')
    }}><Field label="任务"><select name="taskId" required><option value="">请选择</option>{[...new Map([...(shown?.entries || []).map(row => [row.taskId, row.title] as const), ...data.tasks.map(row => [row.id, row.title] as const)]).entries()].map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></Field><Field label="声称发生时间"><input type="datetime-local" name="claimedAt" required/></Field><Field label="佐证说明"><textarea name="statement" required/></Field><Field label="证据（每行一项）"><textarea name="evidence" required/></Field><Field label="补证原因"><textarea name="reason" required/></Field></Form></Modal>}
  </div>
}
