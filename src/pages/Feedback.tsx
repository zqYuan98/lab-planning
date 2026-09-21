import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowRight, MessageSquarePlus, RefreshCw } from 'lucide-react'
import type { FeedbackDetailResponse, FeedbackListResponse, FeedbackMutationResponse, FeedbackStatus } from '../../shared/feedback'
import { feedbackStatusLabels, feedbackStatuses } from '../../shared/feedback'
import { api } from '../api'
import { feedbackError } from '../feedback-draft'
import type { Navigate } from '../navigation'
import { Badge, Empty, Field, PageHeader, dateTime, type PageProps } from '../ui'
import FeedbackDetail from '../components/FeedbackDetail'
import '../feedback.css'

export default function Feedback({ data, intent, notify, navigate, onCreate }: PageProps & { navigate: Navigate; onCreate: () => void }) {
  const manager = data.user.role === 'manager'
  const [scope, setScope] = useState<'mine' | 'all'>(manager ? 'all' : 'mine'), [status, setStatus] = useState<FeedbackStatus | ''>('')
  const [list, setList] = useState<FeedbackListResponse | null>(null), [loading, setLoading] = useState(true), [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState(''), [detailError, setDetailError] = useState(''), [detail, setDetail] = useState<FeedbackDetailResponse | null>(null), [detailLoading, setDetailLoading] = useState(false)
  const [ownerFilter, setOwnerFilter] = useState<'all' | 'assigned'>('all')
  const listSequence = useRef(0), detailSequence = useRef(0), selectedId = intent?.id
  const load = useCallback(async (cursor?: string) => {
    const sequence = ++listSequence.current
    if (cursor) setLoadingMore(true); else setLoading(true)
    setError('')
    const params = new URLSearchParams({ scope, limit: '30' })
    if (status) params.set('status', status)
    if (manager && scope === 'all' && ownerFilter === 'assigned') params.set('assigneeId', data.user.id)
    if (cursor) params.set('cursor', cursor)
    try {
      const result = await api<FeedbackListResponse>(`/feedback?${params}`)
      if (sequence !== listSequence.current) return
      setList(previous => cursor && previous ? { ...result, items: [...previous.items, ...result.items.filter(item => !previous.items.some(old => old.id === item.id))] } : result)
    } catch (error) { if (sequence === listSequence.current) setError(feedbackError(error)); throw error }
    finally { if (sequence === listSequence.current) { setLoading(false); setLoadingMore(false) } }
  }, [scope, status, ownerFilter, manager, data.user.id])
  const loadDetail = useCallback(async () => {
    if (!selectedId) throw new Error('请选择反馈。')
    const sequence = ++detailSequence.current
    const result = await api<FeedbackDetailResponse>(`/feedback/${encodeURIComponent(selectedId)}`)
    if (sequence === detailSequence.current) { setDetail(result); setDetailError('') }
    return result
  }, [selectedId])
  useEffect(() => {
    setList(null)
    void load().catch(() => {})
    return () => { listSequence.current++ }
  }, [load, data.user.id])
  useEffect(() => {
    setDetail(null); setDetailError('')
    if (!selectedId) { setDetailLoading(false); return }
    let live = true
    setDetailLoading(true)
    void loadDetail().catch(error => { if (live) setDetailError(feedbackError(error)) }).finally(() => { if (live) setDetailLoading(false) })
    return () => { live = false; detailSequence.current++ }
  }, [selectedId, loadDetail])
  async function changed(result: FeedbackMutationResponse) {
    setDetail(result)
    notify('反馈处理已保存')
    await load()
  }
  const rows = list?.items || []
  return <div className="feedback-page"><PageHeader eyebrow="WORK / FEEDBACK" title="问题与建议" description="记录使用中的小问题，查看受理、处理和验证结果。"
    actions={<button className="button primary" onClick={onCreate}><MessageSquarePlus size={17} />提问题 / 建议</button>} />
    {selectedId ? detailLoading ? <p role="status">正在读取反馈详情…</p> : detailError ? <div className="feedback-load-error"><p className="error" role="alert">{detailError}</p><div className="feedback-actions"><button className="button secondary" onClick={() => navigate('feedback')}>返回列表</button><button className="button secondary" onClick={() => { setDetailLoading(true); void loadDetail().catch(error => setDetailError(feedbackError(error))).finally(() => setDetailLoading(false)) }}>重新读取</button></div></div>
      : detail && <FeedbackDetail data={data} detail={detail} onBack={() => navigate('feedback')} onRefresh={loadDetail} onChanged={changed} />
      : <>
        <div className="feedback-list-toolbar"><div className="feedback-list-filters">{manager && <Field label="反馈范围"><select value={scope} onChange={event => { setScope(event.target.value as 'mine' | 'all'); setOwnerFilter('all') }}><option value="all">全部反馈</option><option value="mine">我提报的</option></select></Field>}
          <Field label="处理状态"><select value={status} onChange={event => setStatus(event.target.value as FeedbackStatus | '')}><option value="">全部状态</option>{feedbackStatuses.map(value => <option key={value} value={value}>{feedbackStatusLabels[value]}</option>)}</select></Field>
          {manager && scope === 'all' && <Field label="受理范围"><select value={ownerFilter} onChange={event => setOwnerFilter(event.target.value as 'all' | 'assigned')}><option value="all">所有受理人</option><option value="assigned">我受理的</option></select></Field>}
        </div><button className="button secondary" disabled={loading || loadingMore} onClick={() => void load().catch(() => {})}><RefreshCw size={16} />刷新</button></div>
        {list && <div className="feedback-counts" aria-label="反馈数量"><span>共 <strong>{list.counts.all}</strong> 条</span>{feedbackStatuses.map(value => <button key={value} className={status === value ? 'is-active' : ''} onClick={() => setStatus(status === value ? '' : value)}>{feedbackStatusLabels[value]} <strong>{list.counts[value]}</strong></button>)}</div>}
        {error && <p className="error" role="alert">{error}</p>}
        {loading && !list ? <p role="status">正在读取反馈…</p> : rows.length ? <div className="feedback-list">{rows.map(row => <button className="feedback-list-item" key={row.id} onClick={() => navigate('feedback', { id: row.id })}>
          <div className="feedback-row-meta"><Badge tone={row.status === 'closed' ? 'green' : ['new', 'verification'].includes(row.status) ? 'amber' : 'neutral'}>{feedbackStatusLabels[row.status]}</Badge><span>{({ bug: '故障', usability: '使用体验', suggestion: '建议' })[row.kind]}</span>{row.impact === 'blocking' && <Badge tone="red">影响使用</Badge>}{row.duplicateLinked && <span>已关联相同问题</span>}</div>
          <strong className="feedback-list-description">{row.description}</strong>
          {row.waiting && <p className="feedback-waiting">{row.waiting.kind === 'request_info' ? '等待提报人补充' : `暂缓处理 · ${row.waiting.reviewAt ? `复查 ${dateTime(row.waiting.reviewAt)}` : '等待复查'}`}{row.waiting.reviewAt && Date.parse(row.waiting.reviewAt) <= Date.now() ? ' · 已到复查时间' : ''}</p>}
          <div className="feedback-list-meta"><span>{row.reporterName} 提报 · {row.assigneeName} 受理</span><time dateTime={row.updatedAt}>更新于 {dateTime(row.updatedAt)}</time><span className="feedback-open-label">查看处理<ArrowRight size={15} /></span></div>
        </button>)}</div> : !loading && <Empty title={ownerFilter === 'assigned' ? '暂无分配给我的反馈' : status ? '此状态暂无反馈' : '暂无反馈'} description="使用中遇到问题，或者有更顺手的做法，都可以直接提报。" action={!status && ownerFilter === 'all' ? <button className="button primary" onClick={onCreate}>提一条问题或建议</button> : undefined} />}
        {list?.nextCursor && <div className="feedback-load-more"><button className="button secondary" disabled={loading || loadingMore} onClick={() => void load(list.nextCursor!).catch(() => {})}>{loadingMore ? '正在加载…' : '加载更早的反馈'}</button><span>已加载 {list.items.length} 条</span></div>}
        <p className="feedback-scope-note">{scope === 'mine' ? '这里只显示您本人提报的反馈。' : '管理者可查看和受理本系统的反馈。'} 修复上线后，请提报人验证；管理者结案会保留具体原因。</p>
      </>}
  </div>
}
