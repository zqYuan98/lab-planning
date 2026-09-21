import { useEffect, useState } from 'react'
import type { ImportBatch } from '../../shared/import-types'
import { api } from '../api'
import { importReviewCounts } from '../import-review'
import { dateTime } from '../ui'

interface SourcePreview {
  fileName: string
  kind: 'table' | 'text' | 'image'
  text?: string
  imageDataUrl?: string
  sheets?: { name: string; rows: { rowNumber: number; cells: string[] }[]; merges?: string[] }[]
  warnings: string[]
}

export default function ImportSourceReview({ batch, disabled, reviewerName, onConfirm }: {
  batch: ImportBatch
  disabled: boolean
  reviewerName?: string
  onConfirm: (sourceItemCount: number) => Promise<void>
}) {
  const [preview, setPreview] = useState<SourcePreview | null>(null)
  const [opened, setOpened] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [sourceItemCount, setSourceItemCount] = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const immutable = batch.status === 'committed'
  const counts = importReviewCounts(batch.rows)
  const countMatches = /^\d+$/.test(sourceItemCount) && Number(sourceItemCount) === counts.expectedSourceCount
  const selectedSheets = batch.analysisOptions?.sheetNames

  useEffect(() => {
    setPreview(null)
    setOpened(false)
    setError('')
    setSourceItemCount('')
    setConfirmed(false)
  }, [batch.id])
  useEffect(() => { setConfirmed(false) }, [batch.version])

  useEffect(() => {
    if (!opened || preview) return
    let cancelled = false
    setLoading(true)
    setError('')
    void api<SourcePreview>(`/imports/${batch.id}/source-preview`).then(value => {
      if (!cancelled) setPreview(value)
    }).catch(cause => {
      if (!cancelled) setError(cause instanceof Error ? cause.message : '原始资料读取失败')
    }).finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [batch.id, opened])

  return <section className="import-completeness" aria-label="原始事项完整性核对">
    <div className="import-section-title">
      <h3>对照原始资料，核对是否收全</h3>
      <button className="button secondary" disabled={loading} onClick={() => {
        setOpened(!opened)
      }}>{opened ? '收起原始资料' : '查看原始资料'}</button>
    </div>
    <p>逐项对照原文；一行中有多件独立工作时也要分别计数。字段校验通过仅说明已识别记录可填写，不代表任务已收全。</p>
    {batch.kind === 'table' && selectedSheets && <p className="import-review-scope">
      本批次解析范围：{selectedSheets.join('、') || '未选择工作表'}。
      {batch.sourceSheets.some(sheet => !selectedSheets.includes(sheet.name)) && <strong>
        另有 {batch.sourceSheets.filter(sheet => !selectedSheets.includes(sheet.name)).map(sheet => sheet.name).join('、')} 未纳入本批次，需另行处理。
      </strong>}
    </p>}
    {opened && <div className="import-source-preview">
      {loading && <p role="status">正在读取原始资料…</p>}
      {error && <p role="alert">{error}。可收起后重试，或下载原始文件核对。</p>}
      {preview?.warnings.map((warning, index) => <p className="import-notice" key={index}>{warning}</p>)}
      {preview?.kind === 'image' && preview.imageDataUrl && <a href={preview.imageDataUrl} target="_blank" rel="noreferrer" title="打开原图放大核对"><img src={preview.imageDataUrl} alt={`${preview.fileName} 原始工作事项`} /></a>}
      {preview?.kind === 'text' && <pre>{preview.text || '原始文字为空'}</pre>}
      {preview?.kind === 'table' && preview.sheets?.map(sheet => <details key={sheet.name} open={selectedSheets?.includes(sheet.name) ?? true}>
        <summary>{sheet.name} · {sheet.rows.length} 行{selectedSheets && !selectedSheets.includes(sheet.name) ? ' · 本批次未解析' : ''}</summary>
        <p>“未生成候选”可能是表头、日期行或漏项，请逐行判断；同一源行有多个事项也需分别核对。</p>
        <div className="table-scroll"><table><thead><tr><th>原始行</th><th>候选对应</th><th>原始内容</th></tr></thead><tbody>
          {sheet.rows.map(row => {
            const represented = batch.rows.filter(candidate => candidate.sourceSheet === sheet.name && candidate.sourceRow === row.rowNumber)
            return <tr key={row.rowNumber}><td>{row.rowNumber}</td><td>{represented.length ? `${represented.length} 项候选` : '未生成候选'}</td><td>{row.cells.map((cell, index) => <span className="import-source-cell" key={index}>{cell || '（空）'}</span>)}</td></tr>
          })}
        </tbody></table></div>
      </details>)}
    </div>}
    {batch.completionReview ? <p className="import-valid" role="status">
      已对照核对 {batch.completionReview.sourceItemCount} 项 · {reviewerName || '核对人已留档'} · {dateTime(batch.completionReview.reviewedAt)}。后续修改候选或重新识别需再次核对。
    </p> : immutable ? <p className="import-notice">历史批次未记录完整性核对。这里只展示当时保存结果；需要补漏时，请对照当前工作后另建批次，避免重复创建。</p> : batch.requiresCompletionReview && batch.rows.length > 0 ? <div className="import-review-confirmation">
      <label>原文实际工作事项数（含本次不导入的真实工作）
        <input type="number" min="1" step="1" value={sourceItemCount} disabled={disabled} onChange={event => { setSourceItemCount(event.target.value); setConfirmed(false) }} />
      </label>
      <p>当前有 {counts.total} 项候选，扣除已说明原因的重复候选 {counts.duplicates} 项、非工作事项 {counts.nonTasks} 项，应对应原文 {counts.expectedSourceCount} 件工作。其中本次不导入的真实工作仍计入原文事项数。</p>
      {sourceItemCount && !countMatches && <p className="import-notice">数量不一致：请补录漏项、拆分候选，或明确标记重复候选和非工作事项后再核对。</p>}
      {!!counts.missingReasons && <p className="import-notice">有 {counts.missingReasons} 项未选择且未填写排除原因，请先校对。</p>}
      <label className="import-review-checkbox"><input type="checkbox" checked={confirmed} disabled={disabled || !preview || !countMatches || !!counts.missingReasons} onChange={event => setConfirmed(event.target.checked)} />我已逐项对照原文，确认每个事项都有候选或明确排除理由</label>
      {!preview && <small>先打开原始资料，逐项核对后再确认。</small>}
      <button className="button secondary" disabled={disabled || !confirmed || !countMatches || !!counts.missingReasons} onClick={() => void onConfirm(Number(sourceItemCount))}>保存完整性核对</button>
    </div> : null}
  </section>
}
