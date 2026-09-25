import { useCallback, useEffect, useRef, useState } from 'react'
import { Plus, RefreshCw, Upload } from 'lucide-react'
import type { Bootstrap, Report } from '../../shared/types'
import type { ReportAgentBootstrap, ReportAgentJob, ReportAssetSummary, ReportTemplate } from '../../shared/report-agent'
import { api, finishSaved, json, SavedResultError } from '../api'
import { Empty, Field } from '../ui'
import { allowDraftLeave } from '../draft-recovery'
import { useFormDraft } from '../use-form-draft'
import { shanghaiToday, weekMonday } from '../overview-data'
import ReportAgentTemplate from './ReportAgentTemplate'
import ReportAgentScheduleForm from './ReportAgentSchedule'
import ReportAgentJobCard from './ReportAgentJobCard'
import { agentJobPending, agentRequestId, readAgentFile } from './ReportAgentHelpers'
import '../report-agent.css'

export default function ReportAgentCenter({ initialType = 'weekly', data, refresh, notify, onOpenReport }: {
  initialType?: Report['type']; data: Bootstrap; refresh: () => Promise<void>; notify: (message: string) => void; onOpenReport: (report: Report) => void
}) {
  const [type, setType] = useState<Report['type']>(initialType)
  const typeLabel = type === 'monthly' ? '月报' : '周报'
  const normalizePeriod = (value: string) => type === 'monthly' ? value : weekMonday(value)
  const [bootstrap, setBootstrap] = useState<ReportAgentBootstrap | null>(null)
  const [tab, setTab] = useState<'templates' | 'generate' | 'schedule'>('templates')
  const [selected, setSelected] = useState<ReportTemplate | null>(null)
  const [templateEpoch, setTemplateEpoch] = useState(0)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [period, setPeriod] = useState(initialType === 'monthly' ? shanghaiToday().slice(0, 7) : weekMonday(shanghaiToday())), [templateId, setTemplateId] = useState('')
  const [useAi, setUseAi] = useState(false)
  const lock = useRef(false)
  const generateRequest = useRef<{ key: string; id: string } | null>(null)
  const load = useCallback(async () => { setBootstrap(await api<ReportAgentBootstrap>('/report-agent')) }, [])
  useEffect(() => {
    const controller = new AbortController()
    api<ReportAgentBootstrap>('/report-agent', { signal: controller.signal }).then(value => { setBootstrap(value); setError('') }).catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '无法读取报告模板与任务') })
    return () => controller.abort()
  }, [loadAttempt])
  async function action(work: () => Promise<void>) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await work() } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请重试。') }
    finally { lock.current = false; setBusy(false) }
  }
  function rememberTemplate(template: ReportTemplate) {
    setSelected(current => current?.id === template.id ? template : current)
    setBootstrap(value => value ? { ...value, templates: value.templates.map(item => item.id === template.id ? template : item) } : value)
  }
  function rememberJob(job: ReportAgentJob) {
    setBootstrap(value => value ? { ...value, jobs: [job, ...value.jobs.filter(item => item.id !== job.id)] } : value)
  }
  function switchTab(next: typeof tab) { if (next === tab || allowDraftLeave()) setTab(next) }
  async function openReport(id: string) {
    if (!allowDraftLeave()) return
    await action(async () => { const report = await api<Report>(`/report-agent/reports/${id}`); onOpenReport(report) })
  }
  const templates = (bootstrap?.templates || []).filter(template => (template.type || 'weekly') === type)
  const reports = (bootstrap?.reports || []).filter(report => report.type === type)
  const jobs = (bootstrap?.jobs || []).filter(job => templates.some(template => template.id === job.templateId))
  const schedule = type === 'monthly' ? bootstrap?.monthlySchedule : bootstrap?.schedule
  const activeTemplates = templates.filter(template => template.status === 'active').sort((a, b) => b.effectiveWeek.localeCompare(a.effectiveWeek) || b.createdAt.localeCompare(a.createdAt))
  const resolvedTemplateId = templateId || activeTemplates.find(template => period && template.effectiveWeek <= normalizePeriod(period))?.id || ''
  if (data.user.role !== 'manager') return <Empty title="报告模板与生成面向部门管理者" />
  return <div className="report-agent">
    <div className="agent-intro"><div><h2>{typeLabel}模板与生成</h2><p>沿用公司 Word 模板，冻结本期事实，逐项核对后定稿。</p></div><Field label="报告类型"><select value={type} onChange={event => { if (!allowDraftLeave()) return; const next = event.target.value as Report['type']; setType(next); setSelected(null); setTemplateId(''); setPeriod(next === 'monthly' ? shanghaiToday().slice(0, 7) : weekMonday(shanghaiToday())) }}><option value="weekly">周报</option><option value="monthly">月报</option></select></Field></div>
    <ol className="agent-steps" aria-label="报告工作流程"><li>上传模板与范例</li><li>确认映射与写法</li><li>试填并启用</li><li>生成、审阅与定稿</li></ol>
    <nav className="report-tabs" aria-label="报告模板与生成功能"><button aria-pressed={tab === 'templates'} onClick={() => switchTab('templates')}>模板与范例</button><button aria-pressed={tab === 'generate'} onClick={() => switchTab('generate')}>生成与任务</button><button aria-pressed={tab === 'schedule'} onClick={() => switchTab('schedule')}>周期自动草稿</button></nav>
    {error && <div className="error" role="alert">{error}<button type="button" className="text-button" onClick={() => setLoadAttempt(value => value + 1)}>重新加载</button></div>}
    {!bootstrap ? <p role="status">正在读取模板和任务…</p> : <>
      {tab === 'templates' && <div className="agent-template-layout"><aside className="agent-template-list" aria-label="报告模板版本"><UploadTemplate key={type} type={type} accountId={data.user.id} notify={notify} onCreated={template => { setSelected(template); setTemplateEpoch(value => value + 1); void action(load) }} onUploaded={load} assets={bootstrap.assets} />
        <h3>已保存模板</h3>{templates.length ? templates.map(template => <button key={template.id} className={`agent-template-choice ${selected?.id === template.id ? 'is-selected' : ''}`} onClick={() => { if (allowDraftLeave()) { setSelected(template); setTemplateEpoch(value => value + 1) } }}><strong>{template.name}</strong><span>{template.status === 'active' ? '已启用' : template.status === 'draft' ? '待确认' : '已停用'} · 版本 {template.version}</span><small>{template.effectiveWeek} 起适用</small></button>) : <p className="agent-note">选择已有 Word 模板，建立对应周期版本后试填、确认排版并启用；无需重新提供 Word。</p>}</aside>
        <div className="agent-template-detail">{selected ? <><div className="agent-toolbar"><p className="agent-note">学习任务完成后，可重新读取模板查看候选规则。当前编辑不会被任务进度覆盖。</p><button type="button" className="button secondary" disabled={busy} onClick={() => { if (allowDraftLeave()) void action(async () => { const latest = await api<ReportAgentBootstrap>('/report-agent'); setBootstrap(latest); const template = latest.templates.find(item => item.id === selected.id); if (template) { setSelected(template); setTemplateEpoch(value => value + 1) } }) }}><RefreshCw size={15} />重新读取</button></div><ReportAgentTemplate key={`${selected.id}:${templateEpoch}`} initial={selected} assets={bootstrap.assets} accountId={data.user.id} aiConfigured={bootstrap.aiConfigured} notify={notify} onSaved={rememberTemplate} onJob={rememberJob} /></> : <Empty title={`建立可复用的${typeLabel}模板`} description="可选用已上传 Word 沿用现有结构；逐表确认本期成果、下期安排和投入来源，试填核对排版通过后启用。" />}</div></div>}
      {tab === 'generate' && <section className="agent-generation"><h3>选择周期，生成待审阅草稿</h3>{!activeTemplates.length && <p className="agent-callout">尚未启用{typeLabel}模板。请到「模板与范例」选择已有 Word → 试填 → 确认排版 → 启用。</p>}<div className="agent-form-grid"><Field label={type === 'monthly' ? '报告月份' : '报告周次'} hint={type === 'monthly' ? '月完成以目标验收结论为准；投入按周一所属月份归集。' : '以周一至周日为一个报告周期。'}><input type={type === 'monthly' ? 'month' : 'date'} value={period} onChange={event => setPeriod(event.target.value)} /></Field><Field label="已启用的 Word 模板"><select value={resolvedTemplateId} onChange={event => setTemplateId(event.target.value)}><option value="">请选择模板</option>{activeTemplates.map(template => <option key={template.id} value={template.id}>{template.name}（{template.effectiveWeek} 起）</option>)}</select></Field></div><p className="agent-note">本次选择：{period ? normalizePeriod(period) : '待选周期'}。生成时读取当前数据并冻结；历史周期显示本次实际截至时间。</p><label className="agent-check"><input type="checkbox" checked={useAi} disabled={!bootstrap.aiConfigured || busy} onChange={event => setUseAi(event.target.checked)} />使用已配置的 AI 按已确认规则辅助写作</label>{!bootstrap.aiConfigured && <p className="agent-note">尚未配置 AI，仍可生成带来源的规则草稿并逐格编辑。</p>}<button className="button primary" disabled={busy || !resolvedTemplateId || !period} onClick={() => void action(async () => {
        const payload = { templateId: resolvedTemplateId, period: normalizePeriod(period), useAi }
        const key = JSON.stringify(payload)
        if (generateRequest.current?.key !== key) generateRequest.current = { key, id: agentRequestId() }
        const job = await api<ReportAgentJob>('/report-agent/jobs', json({ ...payload, requestId: generateRequest.current.id }))
        generateRequest.current = null; rememberJob(job); notify('生成任务已提交，可关闭页面后继续查看。')
      })}><Plus size={16} />生成{typeLabel}草稿</button>
        <h3>{typeLabel}档案</h3><div className="agent-report-list">{reports.length ? reports.map(report => <button key={report.id} className="agent-template-choice" onClick={() => void openReport(report.id)}><strong>{report.title}</strong><span>{report.period} · 第 {report.revision} 版 · {report.status === 'finalized' ? '已定稿' : '待审阅'}</span></button>) : <p className="agent-note">完成第一项生成任务后，在这里审阅报告。</p>}</div>
      </section>}
      {tab === 'schedule' && schedule && <ReportAgentScheduleForm key={schedule.id} initial={schedule} templates={activeTemplates} data={data} missedPeriods={type === 'monthly' ? bootstrap.monthlyMissedPeriods : bootstrap.missedPeriods} notify={notify} onSaved={value => setBootstrap(current => current ? { ...current, [type === 'monthly' ? 'monthlySchedule' : 'schedule']: value } : current)} />}
      {(tab === 'generate' || jobs.some(job => agentJobPending(job.status) || job.status === 'failed')) && <section className="agent-jobs" aria-label="后台任务"><h3>生成与学习任务</h3>{jobs.slice(0, 12).map(job => <ReportAgentJobCard key={job.id} initial={job} onOpen={id => void openReport(id)} onComplete={() => { void load().catch(failure => setError(`任务进度已更新，但列表刷新失败：${failure instanceof Error ? failure.message : '请重新读取'}`)); void refresh().catch(() => {}) }} />)}</section>}
    </>}
  </div>
}
function UploadTemplate({ type, accountId, assets, onCreated, onUploaded, notify }: { type: Report['type']; accountId: string; assets: ReportAssetSummary[]; onCreated: (template: ReportTemplate) => void; onUploaded: () => Promise<void>; notify: (message: string) => void }) {
  const [file, setFile] = useState<File | null>(null), [examples, setExamples] = useState<File[]>([])
  const [uploadEpoch, setUploadEpoch] = useState(0)
  const [sourceAssetId, setSourceAssetId] = useState(''), [name, setName] = useState(''), [week, setWeek] = useState(type === 'monthly' ? shanghaiToday().slice(0, 7) : weekMonday(shanghaiToday()))
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [progress, setProgress] = useState('')
  const lock = useRef(false)
  const uploaded = useRef(new Map<string, ReportAssetSummary>())
  const requestId = useRef(agentRequestId())
  const recovery = useFormDraft(`${accountId}:report-agent-upload:${type}`, { name, sourceAssetId, week, selectedFile: file?.name || '', selectedExamples: examples.map(item => item.name) }, values => { if (typeof values.name === 'string') setName(values.name); if (typeof values.sourceAssetId === 'string') setSourceAssetId(values.sourceAssetId); if (typeof values.week === 'string') setWeek(values.week) }, busy)
  const clearedUpload = useRef(uploadEpoch)
  useEffect(() => { if (clearedUpload.current !== uploadEpoch) { clearedUpload.current = uploadEpoch; recovery.clearDraft() } }, [uploadEpoch])
  async function upload(asset: File, purpose: 'template' | 'example') {
    const key = `${purpose}:${asset.name}:${asset.size}:${asset.lastModified}`
    const previous = uploaded.current.get(key)
    if (previous) return previous
    setProgress(`正在上传 ${asset.name}`)
    const result = await api<ReportAssetSummary>('/report-agent/assets', json({ filename: asset.name, contentBase64: await readAgentFile(asset), purpose }))
    uploaded.current.set(key, result); return result
  }
  async function submit() {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      if (examples.length + (file ? 1 : 0) > 10) throw new Error('每批最多上传 10 份 DOCX 文件。')
      let source = sourceAssetId
      if (file) source = (await upload(file, 'template')).id
      if (!source) throw new Error('请选择 Word 模板或已上传的版式基准。')
      const ids: string[] = []
      for (const example of examples) ids.push((await upload(example, 'example')).id)
      setProgress('正在检查并建立模板')
      const template = await api<ReportTemplate>('/report-agent/templates', json({ type, name: name.trim() || file?.name.replace(/\.docx$/i, '') || (type === 'monthly' ? '公司月报模板' : '公司周报模板'), sourceAssetId: source, exampleAssetIds: ids, effectiveWeek: type === 'monthly' ? week : weekMonday(week), requestId: requestId.current }))
      recovery.clearDraft(); setFile(null); setExamples([]); setName(''); setSourceAssetId(''); setUploadEpoch(value => value + 1); requestId.current = agentRequestId(); setProgress(''); notify('模板已建立，请逐项确认原文映射和写作规则。'); onCreated(template)
      await finishSaved(onUploaded)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '上传失败，已上传文件仍保留。'); if (!(failure instanceof SavedResultError)) void onUploaded().catch(() => {}) }
    finally { lock.current = false; setBusy(false); setProgress('') }
  }
  return <details className="agent-upload" open><summary><Upload size={16} />上传模板与范例</summary><form ref={recovery.formRef} onInput={recovery.rememberDraft} onChange={recovery.rememberDraft} onSubmit={event => { event.preventDefault(); void submit() }}><fieldset disabled={busy} className="agent-fieldset"><Field label="公司 Word 模板"><input key={`template-${uploadEpoch}`} type="file" accept=".docx" onChange={event => { setFile(event.target.files?.[0] || null); setSourceAssetId('') }} /></Field><Field label="或使用已上传的文件"><select name="sourceAssetId" value={sourceAssetId} disabled={!!file} onChange={event => setSourceAssetId(event.target.value)}><option value="">请选择</option>{assets.filter(asset => asset.purpose === 'template' || asset.purpose === 'example').map(asset => <option key={asset.id} value={asset.id}>{asset.filename}</option>)}</select></Field><Field label="历史成品范例（可选）"><input key={`examples-${uploadEpoch}`} type="file" accept=".docx" multiple onChange={event => setExamples(Array.from(event.target.files || []))} /></Field><Field label="模板名称"><input name="name" value={name} onChange={event => setName(event.target.value)} maxLength={120} placeholder={type === 'monthly' ? '例如：公司月报 2026 版' : '例如：公司周报 2026 版'} /></Field><Field label={type === 'monthly' ? '适用起始月' : '适用起始周'}><input name="week" type={type === 'monthly' ? 'month' : 'date'} value={week} onChange={event => setWeek(event.target.value)} required /></Field><p className="agent-note">仅 DOCX；每份不超过 12 MiB，每批最多 10 份。文件选择无法随浏览器草稿恢复，请重新选择。原件保留，识别异常会给出清理说明。</p>{recovery.notice && <p className="agent-note">{recovery.notice}</p>}{progress && <p role="status">{progress}</p>}{error && <p role="alert" className="error">{error}</p>}<button className="button primary" disabled={busy || (!file && !sourceAssetId)}>{busy ? '正在处理…' : '上传并建立模板'}</button></fieldset></form></details>
}
