import { Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { CheckCheck, Download, FileUp, History, Pencil, Plus, RefreshCw, Settings, Trash2, X } from 'lucide-react'
import type { Bootstrap, Report } from '../../shared/types'
import type { ReportAgentBinding, ReportAgentBlock, ReportAgentBootstrap, ReportAgentCell, ReportAgentDataset, ReportAgentField, ReportAgentIssue, ReportAgentJob, ReportAgentReadiness, ReportAssetSummary, ReportTemplate } from '../../shared/report-agent'
import { api, ApiError, json } from '../api'
import { Badge, Modal, PageHeader } from '../ui'
import { shanghaiToday, weekMonday } from '../overview-data'
import type { Navigate, NavigationIntent } from '../navigation'
import { retryableLazy } from './LazyPage'
import { agentAssetUrl, agentJobPending, agentNarrativeLabels, agentReportUrl, agentRequestId, agentTime, readAgentFile } from './ReportAgentHelpers'
const ReportAgentPreview = retryableLazy(() => import('./ReportAgentPreview'))
const ReportAgentCenter = retryableLazy(() => import('./ReportAgentCenter'))

type ReportType = Report['type']
const typeWord = (type: ReportType) => type === 'monthly' ? '月报' : '周报'
const shiftMonth = (month: string, amount: number) => { const date = new Date(`${month}-01T00:00:00Z`); date.setUTCMonth(date.getUTCMonth() + amount); return date.toISOString().slice(0, 7) }
const addDays = (day: string, amount: number) => { const date = new Date(`${day}T00:00:00Z`); date.setUTCDate(date.getUTCDate() + amount); return date.toISOString().slice(0, 10) }
const monthNumber = (month: string) => Number(month.slice(5, 7))
const shortDay = (day: string) => `${Number(day.slice(5, 7))}月${Number(day.slice(8, 10))}日`
/** A monthly report covers the completed month; a weekly report covers the current week. */
const defaultPeriod = (type: ReportType) => type === 'monthly' ? shiftMonth(shanghaiToday().slice(0, 7), -1) : weekMonday(shanghaiToday())
// Adopted templates apply to every period, so switching templates never strands an older month or week.
const ALWAYS = { monthly: '2000-01', weekly: '2000-01-03' } as const

function periodLabel(type: ReportType, period: string) {
  return type === 'monthly' ? `${period.slice(0, 4)}年${monthNumber(period)}月` : `${shortDay(period)}—${shortDay(addDays(period, 6))}`
}
function coverageText(type: ReportType, period: string) {
  return type === 'monthly'
    ? `${monthNumber(period)}月目标完成情况 + ${monthNumber(shiftMonth(period, 1))}月计划及所需支撑`
    : `本周（${periodLabel(type, period)}）完成情况 + 下周计划及需要的支持`
}
function datasetText(type: ReportType, dataset: ReportAgentDataset | undefined, period: string) {
  if (type === 'monthly') return ({ outcomes: `${monthNumber(period)}月目标完成情况`, next_month: `${monthNumber(shiftMonth(period, 1))}月计划`, next_week: `${monthNumber(shiftMonth(period, 1))}月计划`, risks: '问题与所需支撑', effort: '人日投入', annual_goals: '年度目标进展' } as const)[dataset || 'outcomes']
  return ({ outcomes: '本周完成情况', next_week: '下周计划', next_month: '下周计划', risks: '问题与需要的支持', effort: '本周人日投入', annual_goals: '年度目标进展' } as const)[dataset || 'outcomes']
}
const fieldText: Record<ReportAgentField, string> = {
  title: '目标 / 事项名称', owner: '负责人', commitment: '计划 / 预期成果', outcome: '实际完成情况', status: '完成 / 验收状态', evidence: '成果材料',
  blocker: '问题', next_action: '下一步', monthly_goal: '所属月目标', support: '所需支撑', due: '截止日期', criteria: '验收标准', manual: '每期手动填写',
}
function blockTitle(block: ReportAgentBlock, bindings: ReportAgentBinding[], type: ReportType, period: string) {
  const binding = bindings.find(item => item.regionId === block.regionId)
  if (binding?.kind === 'dataset' || binding?.kind === 'section') return datasetText(type, binding.dataset || binding.section, period)
  if (binding?.kind === 'narrative' || binding?.kind === 'manual' && binding.instruction) return binding.label
  return block.label.replace(/^t:(\d+)(?::r:\d+:c:\d+)?\s*/, (_, index: string) => `表格 ${Number(index) + 1} `)
}
export function issueText(issue: ReportAgentIssue, blocks: ReportAgentBlock[], bindings: ReportAgentBinding[], type: ReportType, period: string) {
  const match = /^(.*)\[(\d+),(\d+)\]$/.exec(issue.location)
  const block = blocks.find(item => item.id === (match ? match[1] : issue.location))
  if (!block) return issue.message
  const where = blockTitle(block, bindings, type, period) + (match ? ` 第 ${match[2]} 行「${block.columns[Number(match[3]) - 1]?.label || '内容'}」` : '')
  return `${where}：${issue.message}`
}
const edited = (text: string, source = '管理者修改'): ReportAgentCell => ({ text, factIds: [], manual: true, confirmed: true, source })

export { coverageText }
export default function ReportWorkbench({ data, refresh, notify, navigate, intent, onDirtyChange, onLegacy }: {
  data: Bootstrap; refresh: () => Promise<void>; notify: (message: string) => void; navigate?: Navigate
  intent?: NavigationIntent; onDirtyChange?: (dirty: boolean) => void; onLegacy: (intent?: NavigationIntent) => void
}) {
  const initialType: ReportType = intent?.action === 'write-weekly' ? 'weekly' : 'monthly'
  const [type, setType] = useState<ReportType>(initialType)
  const [periods, setPeriods] = useState<Record<ReportType, string>>({ monthly: defaultPeriod('monthly'), weekly: intent?.action === 'write-weekly' && intent.weekStart ? weekMonday(intent.weekStart) : defaultPeriod('weekly') })
  const period = periods[type]
  const [boot, setBoot] = useState<ReportAgentBootstrap | null>(null)
  const [report, setReport] = useState<Report | null>(null)
  const [setup, setSetup] = useState<ReportTemplate | null>(null)
  const [blocks, setBlocks] = useState<ReportAgentBlock[] | null>(null)
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [useAi, setUseAi] = useState(false)
  const [readiness, setReadiness] = useState<ReportAgentReadiness | null>(null), [readinessEpoch, setReadinessEpoch] = useState(0)
  const [advanced, setAdvanced] = useState(false), [templatePreview, setTemplatePreview] = useState(false), [finalizing, setFinalizing] = useState(false)
  const lock = useRef(false), fileInput = useRef<HTMLInputElement>(null)
  const dirty = !!blocks && !!report && JSON.stringify(blocks) !== JSON.stringify(report.agent!.blocks)
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false) }, [dirty, onDirtyChange])

  const load = useCallback(async () => { const next = await api<ReportAgentBootstrap>('/report-agent'); setBoot(next); return next }, [])
  useEffect(() => { void load().catch(failure => setError(failure instanceof Error ? failure.message : '无法读取报告')) }, [load])
  // Notification links open their report; legacy reports keep their original archive view.
  useEffect(() => {
    if (!intent?.id) return
    api<Report>(`/report-agent/reports/${encodeURIComponent(intent.id)}`).then(found => { setType(found.type); setPeriods(value => ({ ...value, [found.type]: found.period })); setReport(found) })
      .catch(failure => { if (failure instanceof ApiError && failure.status === 404) onLegacy(intent); else setError(failure instanceof Error ? failure.message : '报告读取失败') })
  }, [intent?.id])

  useEffect(() => {
    const controller = new AbortController()
    api<ReportAgentReadiness>(`/report-agent/readiness?type=${type}&period=${encodeURIComponent(period)}`, { signal: controller.signal }).then(setReadiness).catch(() => { if (!controller.signal.aborted) setReadiness(null) })
    return () => controller.abort()
  }, [type, period, readinessEpoch])
  const templates = (boot?.templates || []).filter(row => (row.type || 'weekly') === type)
  const active = templates.filter(row => row.status === 'active' && row.effectiveWeek <= period).sort((a, b) => b.effectiveWeek.localeCompare(a.effectiveWeek) || b.createdAt.localeCompare(a.createdAt))[0]
  const history = (boot?.reports || []).filter(row => row.type === type).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  // Switching type or period shows that period's latest version, or nothing yet.
  useEffect(() => {
    if (!boot) return
    setReport(current => current && current.type === type && current.period === period ? current : boot.reports.filter(row => row.type === type && row.period === period).sort((a, b) => b.revision - a.revision)[0] || null)
  }, [boot, type, period])
  useEffect(() => { setBlocks(null) }, [report?.id, report?.version])

  async function run(label: string, work: () => Promise<void>) {
    if (lock.current) return
    lock.current = true; setBusy(label); setError('')
    try { await work() } catch (failure) { setError(failure instanceof Error ? failure.message : '操作没有完成，请重试。') }
    finally { lock.current = false; setBusy('') }
  }
  function leaveEditing() { return !dirty || window.confirm('修改的内容还没有保存，确定放弃吗？') }
  function switchType(next: ReportType) { if (next !== type && leaveEditing()) { setType(next); setSetup(null); setBlocks(null) } }
  function changePeriod(value: string) {
    if (!value || !leaveEditing()) return
    setPeriods(current => ({ ...current, [type]: type === 'monthly' ? value.slice(0, 7) : weekMonday(value) }))
  }

  async function uploadTemplate(file: File) {
    await run('正在识别模板，并用系统数据试填…', async () => {
      if (!/\.docx$/i.test(file.name)) throw new Error('请上传 Word 文档（.docx）。旧版 .doc 请先在 Word 中另存为 .docx。')
      const asset = await api<ReportAssetSummary>('/report-agent/assets', json({ filename: file.name, contentBase64: await readAgentFile(file), purpose: 'template' }))
      let row = await api<ReportTemplate>('/report-agent/templates', json({ type, name: file.name.replace(/\.docx$/i, '') || `公司${typeWord(type)}模板`, sourceAssetId: asset.id, effectiveWeek: ALWAYS[type], requestId: agentRequestId() }))
      row = await api<ReportTemplate>(`/report-agent/templates/${row.id}`, json({ expectedVersion: row.version, name: row.name, bindings: row.bindings, rules: row.rules, rulesConfirmed: true, exampleAssetIds: [], effectiveWeek: row.effectiveWeek }, 'PATCH'))
      row = await api<ReportTemplate>(`/report-agent/templates/${row.id}/preview`, json({ expectedVersion: row.version, period }))
      setSetup(row)
    })
  }
  async function adopt() {
    if (!setup) return
    await run('正在启用模板…', async () => {
      await api<ReportTemplate>(`/report-agent/templates/${setup.id}/adopt`, json({ expectedVersion: setup.version, layoutVerified: true, layoutNote: '管理者已查看系统试填效果并确认使用' }))
      setSetup(null); await load(); notify(`模板已启用，可以生成${typeWord(type)}了。`)
    })
  }
  async function aiOutline() {
    if (!setup) return
    await run('AI 正在重新识别模板结构，通常需要半分钟…', async () => {
      let row = await api<ReportTemplate>(`/report-agent/templates/${setup.id}/ai-outline`, json({ expectedVersion: setup.version }))
      row = await api<ReportTemplate>(`/report-agent/templates/${row.id}/preview`, json({ expectedVersion: row.version, period }))
      setSetup(row); notify('已按 AI 识别结果重新试填，请核对。')
    })
  }
  async function discardSetup() {
    if (!setup) return
    await run('正在取消…', async () => { await api(`/report-agent/templates/${setup.id}/archive`, json({ expectedVersion: setup.version })); setSetup(null); await load() })
  }

  async function generate() {
    if (!active || !leaveEditing()) return
    await run(useAi ? 'AI 正在润色文字，通常需要 1–2 分钟…' : `正在生成${typeWord(type)}…`, async () => {
      let job = await api<ReportAgentJob>('/report-agent/jobs', json({ requestId: agentRequestId(), templateId: active.id, period, useAi }))
      // The draft exists immediately; editing waits for the background pass so a save cannot conflict with it.
      for (let i = 0; agentJobPending(job.status) && i < 240; i++) { await new Promise(resolve => setTimeout(resolve, 1500)); job = await api<ReportAgentJob>(`/report-agent/jobs/${job.id}`) }
      const created = await api<Report>(`/report-agent/reports/${job.reportId}`)
      await load(); setReport(created); setReadinessEpoch(value => value + 1); void refresh().catch(() => {})
      if (job.status === 'failed') notify('AI 润色没有完成，已保留系统生成的内容。')
      else notify(`${typeWord(type)}已生成，请查看并修改。`)
    })
  }
  async function save() {
    if (!report || !blocks) return
    await run('正在保存…', async () => {
      const saved = await api<Report>(`/report-agent/reports/${report.id}`, json({ expectedVersion: report.version, title: report.title, blocks }, 'PATCH'))
      setReport(saved); setBlocks(null); await load(); notify('修改已保存。')
    })
  }
  async function finalize() {
    if (!report) return
    await run('正在定稿…', async () => {
      const saved = await api<Report>(`/report-agent/reports/${report.id}/finalize`, json({ expectedVersion: report.version, reviewNote: '管理者已核对并一键定稿' }))
      setFinalizing(false); setReport(saved); await load(); void refresh().catch(() => {}); notify(`${typeWord(type)}已定稿，Word 文件已存档。`)
    })
  }
  function changeCell(blockId: string, text: string, row?: number, column?: number) {
    setBlocks(current => (current || []).map(block => block.id !== blockId ? block : row === undefined || column === undefined ? { ...block, content: edited(text) }
      : { ...block, rows: block.rows.map((cells, r) => r !== row ? cells : cells.map((cell, c) => c === column ? edited(text) : cell)) }))
  }
  function changeRows(blockId: string, change: (rows: ReportAgentCell[][], block: ReportAgentBlock) => ReportAgentCell[][]) {
    setBlocks(current => (current || []).map(block => block.id === blockId ? { ...block, rows: change(block.rows, block) } : block))
  }

  if (data.user.role !== 'manager') return null
  const agent = report?.agent, bindings = agent?.template.bindings || []
  const errors = agent?.issues.filter(issue => issue.severity === 'error') || []
  const empty = !!agent && agent.coverage.length > 0 && agent.coverage.every(item => item.disposition === 'not_displayed')
  const draft = report?.status === 'draft'
  return <div className="reports-page report-agent workbench">
    <PageHeader eyebrow="MANAGEMENT / REPORTS" title="报告中心" description="上传一次公司模板，之后选好周期即可用系统数据生成 Word 报告。"
      actions={<button className="button secondary" onClick={() => { if (leaveEditing()) setAdvanced(true) }}><Settings size={16} />高级设置</button>} />
    <div className="workbench-switch" role="tablist" aria-label="报告类型">{(['monthly', 'weekly'] as const).map(value => <button key={value} role="tab" aria-selected={type === value} className={type === value ? 'is-active' : ''} onClick={() => switchType(value)}>{typeWord(value)}</button>)}</div>
    {error && <div className="error" role="alert">{error}</div>}
    {busy && <div className="workbench-busy" role="status"><RefreshCw size={16} className="spin" />{busy}</div>}
    {!boot ? <p role="status">正在读取…</p> : <>
      <section className="workbench-card">
        <div className="workbench-step">1</div>
        <div className="workbench-body">
          <h2>公司模板</h2>
          <input ref={fileInput} type="file" accept=".docx" hidden onChange={event => { const file = event.target.files?.[0]; event.target.value = ''; if (file) void uploadTemplate(file) }} />
          {setup ? <TemplateSetup template={setup} type={type} period={period} busy={!!busy} aiConfigured={boot.aiConfigured} onAiOutline={() => void aiOutline()} onAdopt={() => void adopt()} onDiscard={() => void discardSetup()} onReplace={() => fileInput.current?.click()} />
            : active ? <div className="workbench-row"><p><strong>{active.name}</strong> <Badge tone="green">可以使用</Badge><small>启用于 {agentTime(active.activatedAt || active.updatedAt).split(' ')[0]}</small></p>
              <div className="agent-actions">{active.previewAssetId && <button className="button secondary" onClick={() => setTemplatePreview(true)}>查看试填效果</button>}<button className="button secondary" disabled={!!busy} onClick={() => fileInput.current?.click()}><FileUp size={16} />更换模板</button></div></div>
              : <button className="workbench-drop" disabled={!!busy} onClick={() => fileInput.current?.click()}><FileUp size={22} /><strong>上传公司{typeWord(type)} Word 模板（.docx）</strong><span>只需上传一次。系统会自动识别模板里的表格，并用系统数据试填给你看效果。</span></button>}
        </div>
      </section>

      <section className={`workbench-card ${active ? '' : 'is-disabled'}`}>
        <div className="workbench-step">2</div>
        <div className="workbench-body">
          <h2>选择{type === 'monthly' ? '汇报月份' : '汇报周'}</h2>
          <div className="workbench-period">
            <input aria-label={type === 'monthly' ? '汇报月份' : '汇报周'} type={type === 'monthly' ? 'month' : 'date'} value={period} onChange={event => changePeriod(event.target.value)} />
            <p>将汇报：<strong>{coverageText(type, period)}</strong></p>
          </div>
          <DataCheck readiness={readiness} type={type} period={period} navigate={navigate} />
          {boot.aiConfigured && <label className="agent-check"><input type="checkbox" checked={useAi} onChange={event => setUseAi(event.target.checked)} />用 AI 润色文字（不改变数据，约需 1–2 分钟）</label>}
          <button className="button primary workbench-generate" disabled={!active || !!busy} onClick={() => void generate()}>{report ? <RefreshCw size={17} /> : <Plus size={17} />}{report ? `用最新数据重新生成${typeWord(type)}` : `生成${typeWord(type)}`}</button>
          {!active && <p className="agent-note">请先在第 1 步上传公司模板。</p>}
          {report && <p className="agent-note">重新生成会新建一版，当前这一版仍保留在历史报告中。</p>}
        </div>
      </section>

      <section className="workbench-card">
        <div className="workbench-step">3</div>
        <div className="workbench-body">
          <h2>{typeWord(type)}</h2>
          {!report || !agent ? <p className="agent-note">{periodLabel(type, period)}还没有生成{typeWord(type)}。</p> : <>
            <div className="workbench-row"><p><strong>{report.title}</strong> <Badge tone={draft ? 'amber' : 'green'}>{draft ? '草稿' : '已定稿'}</Badge><small>第 {report.revision} 版 · 数据截至 {agentTime(agent.capturedAt)}</small></p>
              <div className="agent-actions">
                {draft && !blocks && <button className="button secondary" disabled={!!busy} onClick={() => setBlocks(structuredClone(agent.blocks))}><Pencil size={16} />修改内容</button>}
                {!blocks && <a className="button secondary" href={agentReportUrl(report.id, report.version)} download><Download size={16} />下载 Word</a>}
                {draft && !blocks && <button className="button primary" disabled={!!busy || errors.length > 0} title={errors.length ? '请先补齐下方提示的内容' : undefined} onClick={() => setFinalizing(true)}><CheckCheck size={16} />定稿</button>}
              </div></div>
            {empty && <div className="workbench-alert"><strong>报告里没有填入系统数据。</strong>模板中的表格没有对应到月度目标或周记录。请点第 1 步「更换模板」重新上传；如果模板没有问题，可在「高级设置」中调整表格对应关系。</div>}
            {draft && errors.length > 0 && <div className="workbench-alert"><strong>还有 {errors.length} 处需要补充，补齐后才能定稿：</strong><ul>{errors.slice(0, 8).map(issue => <li key={issue.id}>{issueText(issue, agent.blocks, bindings, type, report.period)}</li>)}</ul>{errors.length > 8 && <p>…另有 {errors.length - 8} 处</p>}{!blocks && <button className="button secondary" onClick={() => setBlocks(structuredClone(agent.blocks))}><Pencil size={15} />去补充</button>}</div>}
            {blocks ? <QuickEditor blocks={blocks} bindings={bindings} type={type} period={report.period} busy={!!busy} dirty={dirty} onCell={changeCell} onRows={changeRows} onSave={() => void save()} onCancel={() => { if (leaveEditing()) setBlocks(null) }} />
              : <Suspense fallback={<p role="status">正在载入 Word 预览…</p>}><ReportAgentPreview bare key={`${report.id}:${report.version}`} url={agentReportUrl(report.id, report.version)} title={`${report.title} Word 预览`} /></Suspense>}
          </>}
        </div>
      </section>

      <details className="workbench-history"><summary><History size={16} />历史{typeWord(type)}（{history.length}）</summary>
        {history.length ? <ul>{history.map(row => <li key={row.id}><button className="text-button" onClick={() => { if (!leaveEditing()) return; setPeriods(value => ({ ...value, [type]: row.period })); setReport(row) }}>{periodLabel(type, row.period)} · 第 {row.revision} 版</button><Badge tone={row.status === 'finalized' ? 'green' : 'amber'}>{row.status === 'finalized' ? '已定稿' : '草稿'}</Badge><small>{agentTime(row.createdAt)}</small></li>)}</ul> : <p className="agent-note">还没有生成过{typeWord(type)}。</p>}
        <button className="text-button" onClick={() => { if (leaveEditing()) onLegacy() }}>查看旧版汇报档案</button>
      </details>
    </>}

    {templatePreview && active?.previewAssetId && <Modal title={`${active.name} · 试填效果`} wide onClose={() => setTemplatePreview(false)}><Suspense fallback={<p role="status">正在载入…</p>}><ReportAgentPreview url={agentAssetUrl(active.previewAssetId)} title="模板试填效果" /></Suspense></Modal>}
    {finalizing && report && <Modal title={`定稿${typeWord(type)}`} onClose={() => setFinalizing(false)}><p>定稿后这一版不能再修改，Word 文件会存档，之后下载的都是同一份文件。需要修改时可以重新生成新的一版。</p><div className="agent-actions"><button className="button secondary" onClick={() => setFinalizing(false)}>再看看</button><button className="button primary" disabled={!!busy} onClick={() => void finalize()}><CheckCheck size={16} />确认定稿</button></div>{error && <p className="error" role="alert">{error}</p>}</Modal>}
    {advanced && <Modal title="高级设置" wide onClose={() => { setAdvanced(false); void load().catch(() => {}) }}><p className="agent-note">这里可以逐项调整模板中表格与系统数据的对应关系、设置定时自动生成，以及管理历史模板。日常使用不需要进入这里。</p><Suspense fallback={<p role="status">正在载入…</p>}><ReportAgentCenter initialType={type} data={data} refresh={refresh} notify={notify} onOpenReport={opened => { setAdvanced(false); setType(opened.type); setPeriods(value => ({ ...value, [opened.type]: opened.period })); setReport(opened); void load().catch(() => {}) }} /></Suspense></Modal>}
  </div>
}

export function TemplateSetup({ template, type, period, busy, aiConfigured = false, onAiOutline, onAdopt, onDiscard, onReplace }: {
  template: ReportTemplate; type: ReportType; period: string; busy: boolean; aiConfigured?: boolean; onAiOutline?: () => void; onAdopt: () => void; onDiscard: () => void; onReplace: () => void
}) {
  const tables = template.bindings.filter(binding => binding.kind === 'dataset' || binding.kind === 'section')
  const sections = template.bindings.filter(binding => binding.kind === 'narrative' || binding.kind === 'manual' && !!binding.instruction)
  const removed = template.bindings.filter(binding => binding.kind === 'remove').length
  const manual = template.bindings.filter(binding => binding.kind === 'manual' && !binding.instruction).length
  const auto = template.bindings.filter(binding => binding.kind === 'meta').length
  const narrativeLabels = agentNarrativeLabels(type === 'monthly')
  const label = (binding: ReportAgentBinding) => binding.regionId.startsWith('t:') ? `表格 ${Number(binding.regionId.split(':')[1]) + 1}` : '段落'
  return <div className="workbench-setup">
    <p>已识别 <strong>{template.name}</strong>，下面是用{periodLabel(type, period)}的系统数据试填的效果。确认没有问题后点「确认使用」。</p>
    {sections.length > 0 && <ul className="workbench-mapping">{sections.map(binding => <li key={binding.regionId}><strong>「{binding.label}」→ {binding.kind === 'narrative' ? `按模板要求写：${narrativeLabels[binding.narrative || 'review']}` : '系统没有对应数据，每期手动填写'}</strong>
      {binding.instruction && <span>要求：{binding.instruction.replace(/\s+/g, ' ').slice(0, 160)}{binding.instruction.length > 160 ? '…' : ''}</span>}</li>)}</ul>}
    {tables.length > 0 && <ul className="workbench-mapping">{tables.map(binding => <li key={binding.regionId}><strong>{label(binding)} → {datasetText(type, binding.dataset || binding.section, period)}</strong>
      {binding.columns && <span>{binding.columns.map(column => `${column.label}：${fieldText[column.field]}`).join('；')}</span>}</li>)}</ul>}
    {!tables.length && !sections.length && <div className="workbench-alert"><strong>没有识别出需要填写的表格或章节。</strong>报告会是空的。{aiConfigured ? '可以点下方「用 AI 重新识别」，' : '请确认模板中有带表头的表格或“一、二、三”这样的章节标题，'}或在「高级设置」中手动设置。</div>}
    <p className="agent-note">{auto ? `${auto} 处标题、报告人、日期等信息自动填写；` : ''}{removed ? `${removed} 段填写要求、建议或附录在生成时删除；` : ''}{manual ? `${manual} 处系统没有对应数据，需要每期手动填写。` : ''}</p>
    {template.previewAssetId && <Suspense fallback={<p role="status">正在载入试填效果…</p>}><ReportAgentPreview bare url={agentAssetUrl(template.previewAssetId)} title="模板试填效果" /></Suspense>}
    <div className="agent-actions"><button className="button primary" disabled={busy} onClick={onAdopt}><CheckCheck size={16} />确认使用</button>{aiConfigured && onAiOutline && <button className="button secondary" disabled={busy} onClick={onAiOutline}>识别不准？用 AI 重新识别</button>}<button className="button secondary" disabled={busy} onClick={onReplace}><FileUp size={16} />换一个文件</button><button className="button secondary" disabled={busy} onClick={onDiscard}><X size={16} />取消</button></div>
  </div>
}

export function DataCheck({ readiness, type, period, navigate }: { readiness: ReportAgentReadiness | null; type: ReportType; period: string; navigate?: Navigate }) {
  if (!readiness || readiness.type !== type || readiness.period !== period) return <p className="agent-note" role="status">正在核对系统数据…</p>
  const { current, accepted, notCompleted, waiting, done, support, next } = readiness
  if (type === 'monthly') {
    const month = monthNumber(period), nextMonth = shiftMonth(period, 1)
    return <ul className="workbench-check">
      <li className={current ? '' : 'is-warning'}>{month}月已发布目标 {current} 项{current ? `：已验收 ${accepted} 项${notCompleted ? `，确认未完成 ${notCompleted} 项` : ''}${waiting ? `，待验收 ${waiting} 项` : ''}` : '，完成情况部分会是空的'}</li>
      {waiting > 0 && <li className="is-warning">还有 {waiting} 项没有验收，报告中会显示为“待验收”。{navigate && <button className="text-button" onClick={() => navigate('monthly', { month: period })}>去验收</button>}</li>}
      <li className={next ? '' : 'is-warning'}>{monthNumber(nextMonth)}月已发布目标 {next} 项{next ? '' : '，计划部分会是空的'}{!next && navigate && <button className="text-button" onClick={() => navigate('monthly', { month: nextMonth })}>去发布</button>}</li>
      <li>提出支持需求的目标 {support} 项（来自目标下的任务和周记录）</li>
    </ul>
  }
  return <ul className="workbench-check">
    <li className={current ? '' : 'is-warning'}>本周已提交的工作 {current} 项{current ? `，其中自报完成 ${done} 项${support ? `，${support} 项需要支持` : ''}` : '，完成情况部分会是空的'}</li>
    <li className={next ? '' : 'is-warning'}>下周已生效计划 {next} 项{next ? '' : '，计划部分会是空的'}{!next && navigate && <button className="text-button" onClick={() => navigate('weekly', { weekStart: addDays(period, 7) })}>去查看</button>}</li>
  </ul>
}

function QuickEditor({ blocks, bindings, type, period, busy, dirty, onCell, onRows, onSave, onCancel }: {
  blocks: ReportAgentBlock[]; bindings: ReportAgentBinding[]; type: ReportType; period: string; busy: boolean; dirty: boolean
  onCell: (blockId: string, text: string, row?: number, column?: number) => void
  onRows: (blockId: string, change: (rows: ReportAgentCell[][], block: ReportAgentBlock) => ReportAgentCell[][]) => void
  onSave: () => void; onCancel: () => void
}) {
  const rows = (text: string) => Math.min(6, Math.max(1, Math.ceil(text.length / 18), text.split('\n').length))
  return <div className="workbench-editor">
    <p className="agent-note">直接修改文字即可。修改只影响这份报告，不会改动月度目标或周记录。</p>
    {blocks.map(block => <section key={block.id} className="workbench-block">
      <h3>{blockTitle(block, bindings, type, period)}</h3>
      {(() => { const instruction = bindings.find(binding => binding.regionId === block.regionId)?.instruction; return instruction ? <details className="workbench-requirement"><summary>查看模板要求</summary><p>{instruction}</p></details> : null })()}
      {block.kind === 'text' ? <textarea aria-label={blockTitle(block, bindings, type, period)} value={block.content.text} rows={Math.max(2, rows(block.content.text))} disabled={busy} onChange={event => onCell(block.id, event.target.value)} />
        : <div className="agent-table-scroll"><table><thead><tr>{block.columns.map((column, index) => <th key={index}>{column.label}</th>)}<th aria-label="操作" /></tr></thead>
          <tbody>{block.rows.map((row, r) => <tr key={r}>{row.map((cell, c) => <td key={c} className={/序号/.test(block.columns[c]?.label || '') ? 'workbench-index' : undefined}><textarea aria-label={`${block.columns[c]?.label || '内容'} 第 ${r + 1} 行`} value={cell.text} rows={rows(cell.text)} disabled={busy} onChange={event => onCell(block.id, event.target.value, r, c)} /></td>)}
            <td className="workbench-row-action"><button type="button" className="text-button" aria-label={`删除第 ${r + 1} 行`} title="删除这一行" disabled={busy} onClick={() => onRows(block.id, current => current.filter((_, index) => index !== r))}><Trash2 size={15} /></button></td></tr>)}</tbody></table>
          <button type="button" className="text-button" disabled={busy} onClick={() => onRows(block.id, (current, target) => [...current, target.columns.map(() => edited('', '管理者添加'))])}><Plus size={15} />添加一行</button></div>}
    </section>)}
    <div className="agent-actions workbench-editor-actions"><button className="button primary" disabled={busy || !dirty} onClick={onSave}>保存修改</button><button className="button secondary" disabled={busy} onClick={onCancel}>取消</button></div>
  </div>
}
