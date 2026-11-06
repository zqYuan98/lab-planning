import { useEffect, useRef, useState } from 'react'
import { ArrowRight, ExternalLink, RefreshCw } from 'lucide-react'
import type { ImportBatch } from '../../shared/import-types'
import type { DingTalkBatchReview, DingTalkImportReviewRow, DingTalkResolveResult, DingTalkRowResolution } from '../../shared/dingtalk-monthly-api'
import { api, json } from '../api'
import type { Navigate } from '../navigation'
import { Badge, Field, dateTime } from '../ui'
import { dingtalkReviewPresentation, dingtalkRowNeedsReview, dingtalkSourceRelations, dingtalkSourceReviewReady, type ImportSourceRelations } from '../import-review'

interface Props {
  batch: ImportBatch
  disabled: boolean
  editing: boolean
  run: (label: string, action: () => Promise<void>) => Promise<void>
  onResolved: (batch: ImportBatch) => void
  onReadinessChange: (batchId: string, version: number, ready: boolean, relations?: ImportSourceRelations) => void
  notify: (message: string) => void
  navigate?: Navigate
}

const actionLabels = { new: '确认为新事项', link: '关联已有目标', exclude: '本次排除' }

function RowDecision({ row, disabled, onSave }: {
  row: DingTalkImportReviewRow
  disabled: boolean
  onSave: (resolution: DingTalkRowResolution) => Promise<void>
}) {
  const [action, setAction] = useState<DingTalkRowResolution['action'] | ''>(row.resolution?.action || '')
  const [planId, setPlanId] = useState(row.resolution?.planId || (row.plans.length === 1 ? row.plans[0].id : ''))
  const [reason, setReason] = useState(row.resolution?.reason || '')
  const canSave = !!action && !!reason.trim() && (action !== 'new' || row.status === 'ambiguous') && (action !== 'link' || row.plans.some(plan => plan.id === planId))
  const actionHelp = action === 'link' ? '关联已有目标会保留原目标内容，不再新建同一目标。'
    : action === 'new' ? '确认为独立的新事项后，才会在最后导入时创建新草稿。'
      : action === 'exclude' ? '本次不导入这条来源，原有目标和钉钉原表不会删除。'
        : '先选择关联已有、确为新增或本次排除，再填写判断依据。'

  return <form className="dingtalk-row-decision" onSubmit={event => {
    event.preventDefault()
    if (canSave && action && !disabled) void onSave({ action, reason: reason.trim(), ...(action === 'link' ? { planId } : {}) })
  }}>
    <Field label="处理方式"><select required disabled={disabled} value={action} onChange={event => setAction(event.target.value as typeof action)}>
      <option value="">请选择处理方式</option>
      {row.plans.length > 0 && <option value="link">关联已有目标</option>}
      {row.status === 'ambiguous' && <option value="new">确认为新事项</option>}
      <option value="exclude">本次排除</option>
    </select></Field>
    <p className="dingtalk-decision-help">{actionHelp}</p>
    {action === 'link' && <Field label="关联目标"><select required disabled={disabled} value={planId} onChange={event => setPlanId(event.target.value)}>
      <option value="">请选择已有目标</option>
      {row.plans.map(plan => <option value={plan.id} key={plan.id}>{plan.month} · {plan.title} · {plan.ownerName || '负责人待核对'}</option>)}
    </select></Field>}
    <Field label="处理依据"><textarea required disabled={disabled} rows={2} maxLength={1000} value={reason} onChange={event => setReason(event.target.value)} placeholder="说明关联、确认新增或排除的依据，便于再次获取时核对。" /></Field>
    <div className="dingtalk-decision-footer">
      <p>{!canSave ? '请选择处理方式，并填写处理依据。' : '这一步只保存核对结果，不会导入或发布目标。'}</p>
      <button type="submit" className="button primary" disabled={disabled || !canSave}>{action === 'link' ? '保存关联选择' : action === 'new' ? '保存新增选择' : action === 'exclude' ? '保存排除选择' : '保存此项选择'}</button>
    </div>
  </form>
}

export default function DingTalkImportReview({ batch, disabled, editing, run, onResolved, onReadinessChange, notify, navigate }: Props) {
  const [review, setReview] = useState<DingTalkBatchReview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reload, setReload] = useState(0)
  const readiness = useRef(onReadinessChange)
  readiness.current = onReadinessChange
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    readiness.current(batch.id, batch.version, false)
    void api<DingTalkBatchReview>(`/dingtalk-documents/batches/${batch.id}`, { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return
      if (value.batchId !== batch.id || value.batchVersion !== batch.version) throw new Error('批次已发生变化，请刷新批次后继续核对。')
      setReview(value)
      readiness.current(value.batchId, value.batchVersion, dingtalkSourceReviewReady(value, batch.rows), dingtalkSourceRelations(value, batch.rows))
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '来源差异读取失败，请重试。')
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [batch.id, batch.version, reload])

  const currentReview = review?.batchId === batch.id && review.batchVersion === batch.version ? review : null
  // Keep mounted forms while a new version is read so unfinished decision notes survive.
  const displayedReview = review?.batchId === batch.id ? review : null
  const source = batch.dingtalk!
  const confirmedReview = !loading && !error ? currentReview : null
  const presentation = dingtalkReviewPresentation(confirmedReview, batch.rows)
  const pending = presentation.counts?.pending || 0
  const unmatched = batch.rows.filter(row => row.selected && !row.ownerId).length
  const immutable = batch.status === 'committed'
  const locked = disabled || loading || editing || immutable || !currentReview

  async function resolve(rowId: string, resolution: DingTalkRowResolution) {
    if (locked) return
    await run('正在保存来源事项处理结果', async () => {
      setError('')
      try {
        const result = await api<DingTalkResolveResult>(`/dingtalk-documents/batches/${batch.id}/resolve`, json({ version: batch.version, rowId, ...resolution }))
        if (!mounted.current) return
        setReview(result.review)
        onResolved(result.batch)
        notify('来源事项处理结果已保存，请重新核对原文完整性。')
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : '处理结果保存失败，填写内容已保留。')
      }
    })
  }

  return <section className="dingtalk-review" aria-label="钉钉来源与差异核对">
    <div className="dingtalk-import-heading">
      <div><h3>钉钉来源与差异核对</h3><p>{source.targetMonth} · {source.documentTitle} / {source.sheetName}</p></div>
      <a className="button secondary" href={source.documentUrl} target="_blank" rel="noreferrer">查看钉钉原表<ExternalLink size={14} /></a>
    </div>
    <p className="dingtalk-review-meta">获取于 {dateTime(source.fetchedAt)} · 原始工作事项 {batch.rows.length} 行。每行保留为一个目标，单元格内的多行内容保持完整。</p>
    <p className="dingtalk-review-meta">本批次固定导入 {source.targetMonth} 的月度目标草稿。已导入目标的内容变更，请打开原目标处理。</p>
    {loading && <p role="status">正在核对来源与已有目标…</p>}
    {error && <div className="error" role="alert"><p>{error}</p><div className="dingtalk-review-retry">
      <button type="button" className="button secondary" disabled={disabled || editing || loading} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} />重读差异</button>
      <button type="button" className="button secondary" disabled={disabled || editing || loading} onClick={() => void run('正在刷新导入批次', async () => onResolved(await api<ImportBatch>(`/imports/${batch.id}`)))}>刷新批次</button>
    </div></div>}
    {editing && <p className="import-notice">请先保存或关闭当前校对，再处理来源关联，以保留尚未保存的编辑内容。</p>}
    {displayedReview && <>
      <div className="dingtalk-review-counts" aria-label="来源对账数量">
        {presentation.counts ? <>
          <Badge>新增 {presentation.counts.new}</Badge><Badge tone="green">已导入 {presentation.counts.imported}</Badge>
          <Badge tone="green">已关联 {presentation.counts.linked}</Badge><Badge tone={pending ? 'orange' : 'neutral'}>待处理 {pending}</Badge>
          <Badge>负责人待匹配 {unmatched}</Badge><Badge>已确认排除 {presentation.counts.excluded}</Badge>
        </> : <Badge>{error ? '来源关系待重新核对' : '来源关系核对中'}</Badge>}
      </div>
      {displayedReview.warnings.filter(warning => !batch.warnings.includes(warning)).map((warning, index) => <p className="import-notice" key={index}>{warning}</p>)}
      {pending > 0 && <p className="import-notice">还有 {pending} 项来源关系待处理。逐项记录处理依据后，再完成原文核对并确认导入。</p>}
      <div className="dingtalk-review-rows">
        {displayedReview.rows.map(row => {
          const sourceRow = batch.rows.find(candidate => candidate.id === row.rowId)
          const needsReview = dingtalkRowNeedsReview(row, sourceRow)
          const display = presentation.rows[row.rowId]
          return <details className="dingtalk-review-row" key={row.rowId} open={needsReview ? true : undefined}>
            <summary><span>第 {row.sourceRow} 行 · {row.title || '未命名事项'}</span><Badge tone={display?.tone || 'neutral'}>{display?.label || (error ? '来源关系待重新核对' : '来源关系核对中')}</Badge></summary>
            <p>{row.reason}</p>
            <div className="dingtalk-review-source">
              {row.previousSourceText && <div><strong>此前来源 / 已有目标内容</strong><pre>{row.previousSourceText}</pre></div>}
              <div><strong>本次来源原文</strong><pre>{sourceRow?.sourceText || '原文见下方完整性核对。'}</pre></div>
            </div>
            {row.plans.length > 0 && <ul className="dingtalk-review-plan-links">{row.plans.map(plan => <li key={plan.id}>
              <span>{plan.month} · {plan.title} · {plan.ownerName || '负责人待核对'}</span>
              {navigate && <button type="button" className="import-edit-button" onClick={() => navigate('monthly', { id: plan.id, month: plan.month })}>打开原目标<ArrowRight size={12} /></button>}
            </li>)}</ul>}
            {row.resolution && <p className={confirmedReview ? 'import-valid' : 'form-hint'}>{confirmedReview ? '已记录' : '此前记录'}：{actionLabels[row.resolution.action]} · {row.resolution.reason}</p>}
            {needsReview && !row.requiresResolution && <p className="import-notice">当前勾选与来源处理结论不一致。请重新保存处理方式：新增事项须勾选，关联或排除事项不应勾选。</p>}
            {!immutable && (needsReview || !!row.resolution) && <RowDecision row={row} disabled={locked} onSave={resolution => resolve(row.rowId, resolution)} />}
          </details>
        })}
      </div>
      {displayedReview.removed.length > 0 && <details className="dingtalk-review-removed"><summary>来源已移除 {displayedReview.removed.length} 项</summary><p>以下事项不再出现在源表中，系统目标继续保留。</p><ul>{displayedReview.removed.map(item => <li key={item.planId}>{item.title}{navigate && <button type="button" className="import-edit-button" onClick={() => navigate('monthly', { id: item.planId, month: source.targetMonth })}>打开原目标<ArrowRight size={12} /></button>}</li>)}</ul></details>}
    </>}
    {immutable && navigate && <button type="button" className="button secondary" onClick={() => navigate('monthly', { month: source.targetMonth })}>查看本月目标<ArrowRight size={15} /></button>}
  </section>
}
