import { useEffect, useRef, useState } from 'react'
import { ArrowRight, FolderOpen, RefreshCw, Search } from 'lucide-react'
import type { ImportBatch } from '../../shared/import-types'
import type { DingTalkDocumentDiscovery, DingTalkDocumentStatus } from '../../shared/dingtalk-monthly-api'
import { api, json } from '../api'
import { Badge, Field, dateTime } from '../ui'
import '../dingtalk-import.css'

interface Props {
  disabled: boolean
  run: (label: string, action: () => Promise<void>) => Promise<void>
  onFetched: (batch: ImportBatch) => void
}

export default function DingTalkMonthlyImport({ disabled, run, onFetched }: Props) {
  const [status, setStatus] = useState<DingTalkDocumentStatus | null>(null)
  const [checking, setChecking] = useState(true)
  const [month, setMonth] = useState('')
  const [documentUrl, setDocumentUrl] = useState('')
  const [discovery, setDiscovery] = useState<DingTalkDocumentDiscovery | null>(null)
  const [candidateId, setCandidateId] = useState('')
  const [error, setError] = useState('')
  const [checkVersion, setCheckVersion] = useState(0)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    setChecking(true)
    setError('')
    void api<DingTalkDocumentStatus>('/dingtalk-documents/status', { signal: controller.signal }).then(value => {
      if (controller.signal.aborted) return
      setStatus(value)
      setMonth(previous => previous || value.currentMonth)
    }).catch(cause => {
      if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : '钉钉连接状态读取失败')
    }).finally(() => { if (!controller.signal.aborted) setChecking(false) })
    return () => controller.abort()
  }, [checkVersion])

  const selectedCandidate = discovery?.candidates.find(candidate => candidate.id === candidateId)
  const validMonth = /^\d{4}-(0[1-9]|1[0-2])$/.test(month)
  const unavailable = disabled || checking || !status?.configured

  async function discover() {
    await run('正在查找钉钉月度目标', async () => {
      setError('')
      try {
        const next = await api<DingTalkDocumentDiscovery>('/dingtalk-documents/discover', json({ month, ...(documentUrl.trim() ? { documentUrl: documentUrl.trim() } : {}) }))
        if (!mounted.current) return
        setDiscovery(next)
        setCandidateId(next.complete && next.candidates.length === 1 ? next.recommendedCandidateId || '' : '')
      } catch (cause) {
        if (mounted.current) {
          setDiscovery(null)
          setCandidateId('')
          setError(cause instanceof Error ? cause.message : '月度目标查找失败，请重试。')
        }
      }
    })
  }

  async function fetchPreview() {
    if (!discovery || !selectedCandidate) return
    await run('正在获取钉钉目标并建立预览', async () => {
      setError('')
      try {
        const next = await api<ImportBatch>('/dingtalk-documents/fetch', json({ discoveryId: discovery.id, candidateId: selectedCandidate.id }))
        if (mounted.current) onFetched(next)
      } catch (cause) {
        if (mounted.current) setError(cause instanceof Error ? cause.message : '目标读取失败，已保存的校对内容仍然保留。')
      }
    })
  }

  return <section className="dingtalk-import panel" aria-label="从钉钉获取月度目标">
    <div className="dingtalk-import-heading">
      <div>
        <h2><FolderOpen size={19} />从钉钉获取</h2>
        <p>按月份查找月报材料，预览并校对后导入月度目标草稿。</p>
      </div>
      <div className="dingtalk-import-status">
        <Badge tone={status?.configured ? 'green' : 'neutral'}>{checking ? '正在检查连接' : status?.configured ? '文档连接已配置' : '文档连接待配置'}</Badge>
        <button type="button" className="icon-button" aria-label="重新检查钉钉文档连接" disabled={disabled || checking} onClick={() => setCheckVersion(value => value + 1)}><RefreshCw size={15} /></button>
      </div>
    </div>
    {status && <p className="dingtalk-import-connection">来源文件夹：<strong>{status.folderName || '尚未绑定'}</strong>{status.message && <span>{status.message}</span>}</p>}
    <div className="dingtalk-import-query">
      <Field label="目标月份" hint={status?.timeZone ? `按 ${status.timeZone} 确定当前月份` : undefined}>
        <input type="month" value={month} disabled={disabled || checking} onChange={event => {
          setMonth(event.target.value)
          setDiscovery(null)
          setCandidateId('')
          setError('')
        }} />
      </Field>
      <button type="button" className="button secondary" disabled={unavailable || !validMonth} onClick={() => void discover()}><Search size={16} />查找月度目标</button>
    </div>
    <details className="dingtalk-import-manual">
      <summary>指定当月材料链接</summary>
      <Field label="钉钉月报材料链接" hint="用于筛选指定材料；仍会核对文件夹归属与目标工作表。">
        <input type="url" value={documentUrl} disabled={disabled} placeholder="https://alidocs.dingtalk.com/…" onChange={event => {
          setDocumentUrl(event.target.value)
          setDiscovery(null)
          setCandidateId('')
        }} />
      </Field>
    </details>
    {error && <p className="error" role="alert">{error}</p>}
    {discovery && <div className="dingtalk-import-discovery" aria-live="polite">
      {discovery.warnings.map((warning, index) => <p className="import-notice" key={index}>{warning}</p>)}
      {!discovery.complete && <p className="import-notice">查找未完成，当前结果可能不全。请根据下方提示重试；若目录超出读取上限，请联系管理员调整来源文件夹。</p>}
      {!discovery.candidates.length ? <p className="dingtalk-import-empty">当前范围未找到 {discovery.targetMonth} 的目标工作表。请核对月份或更换材料链接后重试。</p> : <>
        <fieldset className="dingtalk-source-options" disabled={unavailable}>
          <legend>核对来源{discovery.candidates.length > 1 ? ` · 找到 ${discovery.candidates.length} 个候选，请选择` : ''}</legend>
          {discovery.candidates.map(candidate => <label className={`dingtalk-source-option${candidate.id === candidateId ? ' is-selected' : ''}`} key={candidate.id}>
            <input type="radio" name="dingtalk-monthly-source" checked={candidate.id === candidateId} onChange={() => setCandidateId(candidate.id)} />
            <span>
              <strong>{candidate.documentTitle} / {candidate.sheetName}</strong>
              <small>{candidate.path.join(' / ') || status?.folderName}</small>
              <small>{candidate.recommended ? `名称符合 ${discovery.targetMonth} 的查找规则，内容仍需预览核对` : '请人工核对材料年份、月份与工作表'}{candidate.modifiedAt ? ` · ${dateTime(candidate.modifiedAt)} 修改` : ''}</small>
            </span>
          </label>)}
        </fieldset>
        <div className="dingtalk-import-fetch">
          <p>查找只读取目录与工作表名称；获取后再查看完整原文。确认导入前不会创建目标。</p>
          <button type="button" className="button primary" disabled={unavailable || !selectedCandidate} onClick={() => void fetchPreview()}>获取并预览<ArrowRight size={16} /></button>
        </div>
      </>}
    </div>}
  </section>
}
