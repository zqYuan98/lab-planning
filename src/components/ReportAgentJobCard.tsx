import { useEffect, useRef, useState } from 'react'
import { RefreshCw, X } from 'lucide-react'
import type { ReportAgentJob } from '../../shared/report-agent'
import { api, json } from '../api'
import { Badge } from '../ui'
import { agentJobLabels, agentJobPending, agentTime } from './ReportAgentHelpers'

export default function ReportAgentJobCard({ initial, onComplete, onOpen }: { initial: ReportAgentJob; onComplete?: (job: ReportAgentJob) => void; onOpen?: (id: string) => void }) {
  const [job, setJob] = useState(initial)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const callback = useRef(onComplete); callback.current = onComplete
  const reported = useRef<string>('')
  const observedPending = useRef(agentJobPending(initial.status))
  const mutationLock = useRef(false)
  const [retryPoll, setRetryPoll] = useState(0)
  useEffect(() => {
    let active = true
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    async function poll() {
      try {
        const latest = await api<ReportAgentJob>(`/report-agent/jobs/${initial.id}`, { signal: controller.signal })
        if (!active) return
        setJob(latest); setError('')
        if (agentJobPending(latest.status)) { observedPending.current = true; timer = setTimeout(poll, 2000) }
        else if (observedPending.current && reported.current !== `${latest.id}:${latest.version}`) {
          reported.current = `${latest.id}:${latest.version}`; callback.current?.(latest)
        }
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : '读取进度失败，后台任务可能仍在运行。')
      }
    }
    void poll()
    return () => { active = false; controller.abort(); if (timer) clearTimeout(timer) }
  }, [initial.id, retryPoll])
  async function change(action: 'retry' | 'cancel') {
    if (mutationLock.current) return
    mutationLock.current = true
    setBusy(true); setError('')
    try {
      const latest = await api<ReportAgentJob>(`/report-agent/jobs/${job.id}/${action}`, json({ expectedVersion: job.version }))
      setJob(latest); setRetryPoll(value => value + 1)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败') }
    finally { mutationLock.current = false; setBusy(false) }
  }
  return <article className="agent-job">
    <div className="agent-toolbar"><strong>{job.kind === 'learn' ? '学习写作规则' : job.kind === 'rewrite' ? '章节改写' : '生成报告'}</strong><Badge tone={job.status === 'ready' ? 'green' : 'amber'}>{agentJobLabels[job.status]}</Badge></div>
    <p role="status">{job.progress || '等待处理'}{job.completedBlockIds.length ? ` · 已处理 ${job.completedBlockIds.length} 个区域` : ''}</p>
    <p className="agent-note">创建于 {agentTime(job.createdAt)}{job.startedAt ? ` · 开始于 ${agentTime(job.startedAt)}` : ''}</p>
    {job.error && <p className="error" role="alert">{job.error}</p>}
    {error && <p className="error" role="alert">{error} <button type="button" className="text-button" onClick={() => setRetryPoll(value => value + 1)}>重新读取进度</button></p>}
    <div className="agent-actions">
      {agentJobPending(job.status) && <button type="button" className="button secondary" disabled={busy} onClick={() => void change('cancel')}><X size={15} />取消任务</button>}
      {['failed', 'needs_input', 'cancelled'].includes(job.status) && <button type="button" className="button secondary" disabled={busy} onClick={() => void change('retry')}><RefreshCw size={15} />重试任务</button>}
      {job.reportId && onOpen && <button type="button" className="button secondary" onClick={() => onOpen(job.reportId!)}>打开报告</button>}
    </div>
  </article>
}
