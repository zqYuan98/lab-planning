import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { CheckCheck, Download, Save, Sparkles } from 'lucide-react'
import type { ReportAgentBinding, ReportAgentJob, ReportAssetSummary, ReportTemplate, UpdateReportTemplateInput } from '../../shared/report-agent'
import type { DocxRegion } from '../../shared/report-docx'
import { api, json } from '../api'
import { Badge, Field, Modal } from '../ui'
import { useFormDraft } from '../use-form-draft'
import { agentAssetUrl, agentBindingLabels, agentDatasetLabels, agentFieldLabels, agentLabel, agentRequestId } from './ReportAgentHelpers'
const ReportAgentPreview = lazy(() => import('./ReportAgentPreview'))

type TemplateDraft = Omit<UpdateReportTemplateInput, 'expectedVersion'>
const templateDraft = (template: ReportTemplate): TemplateDraft => ({ name: template.name, bindings: template.bindings, rules: template.rules, rulesConfirmed: template.rulesConfirmed, exampleAssetIds: template.exampleAssetIds, effectiveWeek: template.effectiveWeek })
export default function ReportAgentTemplate({ initial, assets, accountId, aiConfigured, onSaved, onJob, notify }: {
  initial: ReportTemplate; assets: ReportAssetSummary[]; accountId: string; aiConfigured: boolean
  onSaved: (template: ReportTemplate) => void; onJob: (job: ReportAgentJob) => void; notify: (message: string) => void
}) {
  const [saved, setSaved] = useState(initial)
  const [draft, setDraft] = useState(() => templateDraft(initial))
  const [editVersion, setEditVersion] = useState(initial.version)
  const [rulesText, setRulesText] = useState(initial.rules.join('\n'))
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false)
  const learnRequest = useRef<{ key: string; id: string } | null>(null)
  const [preview, setPreview] = useState<'original' | 'trial' | null>(null)
  const [layoutVerified, setLayoutVerified] = useState(false), [layoutNote, setLayoutNote] = useState('')
  const [useAi, setUseAi] = useState(false)
  const current: TemplateDraft = { ...draft, rules: rulesText.split('\n').map(line => line.trim()).filter(Boolean) }
  const dirty = JSON.stringify(current) !== JSON.stringify(templateDraft(saved))
  const editable = saved.status === 'draft'
  const asset = assets.find(item => item.id === saved.sourceAssetId)
  const regions = asset?.inspection?.regions || []
  const topRegions = regions.filter(region => region.kind !== 'cell')
  const recovery = useFormDraft(editable ? `${accountId}:report-agent-template:${saved.id}` : undefined, { payload: JSON.stringify(current), layoutNote, layoutVerified: String(layoutVerified), baseVersion: String(editVersion) }, values => {
    if (typeof values.baseVersion === 'string' && /^\d+$/.test(values.baseVersion)) setEditVersion(Number(values.baseVersion))
    if (typeof values.layoutNote === 'string') setLayoutNote(values.layoutNote)
    if (values.layoutVerified === 'true' && values.baseVersion === String(saved.version)) setLayoutVerified(true)
    if (typeof values.payload !== 'string') return
    try {
      const restored = JSON.parse(values.payload) as TemplateDraft
      if (typeof restored.name === 'string' && Array.isArray(restored.bindings) && Array.isArray(restored.rules) && Array.isArray(restored.exampleAssetIds)) {
        setDraft(restored); setRulesText(restored.rules.join('\n'))
      }
    } catch { /* Invalid local recovery data is ignored. */ }
  }, busy)
  const baselineVersion = useRef(saved.version)
  useEffect(() => { if (baselineVersion.current !== saved.version) { baselineVersion.current = saved.version; recovery.clearDraft() } }, [saved.version])
  async function action(work: () => Promise<void>) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try { await work() } catch (failure) { setError(failure instanceof Error ? failure.message : '操作失败，请重试。') }
    finally { lock.current = false; setBusy(false) }
  }
  function accept(template: ReportTemplate) {
    setSaved(template); setEditVersion(template.version); setDraft(templateDraft(template)); setRulesText(template.rules.join('\n'))
    setLayoutVerified(false); setLayoutNote(''); recovery.clearDraft(); onSaved(template)
  }
  function changeBinding(binding: ReportAgentBinding) {
    setDraft(value => ({ ...value, bindings: value.bindings.map(item => item.regionId === binding.regionId ? binding : item) }))
    setLayoutVerified(false)
  }
  async function save() {
    await action(async () => {
      const template = await api<ReportTemplate>(`/report-agent/templates/${saved.id}`, json({ ...current, expectedVersion: editVersion }, 'PATCH'))
      accept(template); notify('模板映射与写作规则已保存，请重新试填并核对版式。')
    })
  }
  function renderBinding(binding: ReportAgentBinding) {
    const region = regions.find(item => item.id === binding.regionId)
    return <BindingEditor key={binding.regionId} binding={binding} region={region} disabled={!editable || busy} onChange={changeBinding} />
  }
  return <section className="agent-template">
    <div className="agent-toolbar"><div><h3>{saved.name}</h3><p className="agent-note">逐项确认固定原文、需替换的历史内容和公司指标口径。公司预算、TOP 数量等指标没有可信口径时，保留为人工补充。</p></div><Badge tone={saved.status === 'active' ? 'green' : 'amber'}>{saved.status === 'active' ? '已启用 · 版本锁定' : saved.status === 'archived' ? '已停用' : dirty ? '有未保存修改' : '模板草案'}</Badge></div>
    <div className="agent-actions"><button type="button" className="button secondary" onClick={() => setPreview('original')}>查看原 Word</button><a href={agentAssetUrl(saved.sourceAssetId)} className="button secondary" download><Download size={15} />下载原模板</a></div>
    {asset?.inspection?.warnings.length ? <div className="agent-callout"><strong>模板检查提示</strong><ul>{asset.inspection.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></div> : null}
    <form ref={recovery.formRef} onInput={recovery.rememberDraft} onChange={recovery.rememberDraft} onSubmit={event => { event.preventDefault(); void save() }}>
      {recovery.notice && <p className="agent-note" role="status">{recovery.notice}</p>}
      <fieldset disabled={!editable || busy} className="agent-fieldset">
        <div className="agent-form-grid"><Field label="模板名称"><input name="templateName" value={draft.name} maxLength={120} onChange={event => setDraft(value => ({ ...value, name: event.target.value }))} required /></Field><Field label="从哪一周开始适用" hint="请选择该周任意一天，保存后以周一为准。"><input name="effectiveWeek" type="date" value={draft.effectiveWeek} onChange={event => setDraft(value => ({ ...value, effectiveWeek: event.target.value }))} required /></Field></div>
        <h4>1 · 原文与填写区域</h4>
        {topRegions.map((region, index) => {
          const bindings = draft.bindings.filter(binding => binding.regionId === region.id || region.kind === 'table' && binding.regionId.startsWith(`${region.id}:`))
          return <details className="agent-region" key={region.id} open={topRegions.length < 5 ? true : undefined}>
            <summary>{region.kind === 'table' ? `表格 ${region.tableIndex + 1}` : `段落 ${index + 1}`} · {bindings.find(binding => binding.regionId === region.id)?.label || region.text.slice(0, 55) || '空白区域'} <small>{bindings.length} 项映射</small></summary>
            <div className="agent-region-body"><OriginalRegion region={region} />{bindings.length ? bindings.map(renderBinding) : <p className="error">该区域尚无映射，请重新读取模板检查结果。</p>}</div>
          </details>
        })}
        <h4>2 · 写作范例与规则</h4>
        <p className="agent-note">历史范例只用于学习组织方式与措辞，其中的人名、成果和数字不会成为本期事实。</p>
        <div className="agent-checkbox-list">{assets.filter(item => item.purpose === 'example' || item.purpose === 'template').map(item => <label key={item.id}><input type="checkbox" name="exampleAssets" value={item.id} checked={draft.exampleAssetIds.includes(item.id)} onChange={event => setDraft(value => ({ ...value, exampleAssetIds: event.target.checked ? [...value.exampleAssetIds, item.id] : value.exampleAssetIds.filter(id => id !== item.id), rulesConfirmed: false }))} />{item.filename}<a href={agentAssetUrl(item.id)} download>原文</a></label>)}</div>
        {saved.learningCandidates.length > 0 && <div className="agent-callout"><strong>待采纳的写作建议</strong><ul>{saved.learningCandidates.map((rule, index) => <li key={index}>{rule} <button type="button" className="text-button" onClick={() => { setRulesText(value => `${value}${value ? '\n' : ''}${rule}`); setDraft(value => ({ ...value, rulesConfirmed: false })) }}>加入规则</button></li>)}</ul></div>}
        {saved.learningNotes.map((note, index) => <p key={index} className="agent-note">{note}</p>)}
        <Field label="写作规则（每行一条）" hint="例如：按项目组织；先写实际成果，再说明阻塞；计划与已验收成果分开表述。"><textarea name="rules" rows={5} value={rulesText} onChange={event => { setRulesText(event.target.value); setDraft(value => ({ ...value, rulesConfirmed: false })) }} /></Field>
        <label className="agent-check"><input type="checkbox" name="rulesConfirmed" checked={draft.rulesConfirmed} onChange={event => setDraft(value => ({ ...value, rulesConfirmed: event.target.checked }))} />我已核对并确认以上写作规则</label>
      </fieldset>
      {error && <p className="error" role="alert">{error}</p>}
      {editable && <div className="agent-actions"><button className="button primary" disabled={busy || !dirty}><Save size={16} />保存映射与规则</button><label className="agent-check"><input type="checkbox" checked={useAi} disabled={!aiConfigured || busy} onChange={event => setUseAi(event.target.checked)} />使用已配置的 AI 学习写法</label><button className="button secondary" type="button" disabled={busy || dirty || !draft.exampleAssetIds.length} onClick={() => void action(async () => {
        const key = `${saved.id}:${saved.version}:${useAi}`
        if (learnRequest.current?.key !== key) learnRequest.current = { key, id: agentRequestId() }
        const job = await api<ReportAgentJob>(`/report-agent/templates/${saved.id}/learn`, json({ expectedVersion: saved.version, requestId: learnRequest.current.id, useAi }))
        onJob(job); notify('学习任务已提交。完成后重新打开模板即可查看候选规则。')
      })}><Sparkles size={16} />从范例学习</button></div>}
    </form>
    {editable && <section className="agent-trial"><h4>3 · 试填与启用</h4><p className="agent-note">先保存映射，再生成试填 Word。修改任何映射或规则后，原版式确认失效。</p><div className="agent-actions"><button className="button secondary" disabled={busy || dirty} onClick={() => void action(async () => {
      const template = await api<ReportTemplate>(`/report-agent/templates/${saved.id}/preview`, json({ expectedVersion: saved.version }))
      accept(template); setPreview('trial')
    })}>生成试填 Word</button>{saved.previewAssetId && <button className="button secondary" disabled={dirty} onClick={() => setPreview('trial')}>查看已保存试填</button>}</div>
      <ReportTemplateActivation busy={busy} dirty={dirty} layoutVerified={layoutVerified} layoutNote={layoutNote} hasPreview={!!saved.previewAssetId} rulesConfirmed={draft.rulesConfirmed} onLayoutVerified={setLayoutVerified} onLayoutNote={setLayoutNote} onActivate={() => void action(async () => {
        const template = await api<ReportTemplate>(`/report-agent/templates/${saved.id}/activate`, json({ expectedVersion: saved.version, layoutVerified, layoutNote }))
        accept(template); notify('周报模板已启用，可以选择周次生成报告。')
      })} />
    </section>}
    {saved.status === 'active' && <div className="agent-callout"><p>模板已锁定。修改内容或公司换版时，请上传文件建立新模板；历史报告保留原模板。</p><button className="button secondary" disabled={busy} onClick={() => void action(async () => { const result = await api<ReportTemplate>(`/report-agent/templates/${saved.id}/archive`, json({ expectedVersion: saved.version })); accept(result); notify('模板已停用，历史文件仍保留。') })}>停用此模板</button></div>}
    {preview && <Modal title={preview === 'original' ? '原始 Word 模板' : '试填 Word'} wide onClose={() => setPreview(null)}><Suspense fallback={<p role="status">正在加载预览…</p>}><ReportAgentPreview url={agentAssetUrl(preview === 'original' ? saved.sourceAssetId : saved.previewAssetId!)} title={preview === 'original' ? '原始模板' : '试填结果'} /></Suspense></Modal>}
  </section>
}
export function ReportTemplateActivation({ busy, dirty, layoutVerified, layoutNote, hasPreview, rulesConfirmed, onLayoutVerified, onLayoutNote, onActivate }: {
  busy: boolean; dirty: boolean; layoutVerified: boolean; layoutNote: string; hasPreview: boolean; rulesConfirmed: boolean; onLayoutVerified: (value: boolean) => void; onLayoutNote: (value: string) => void; onActivate: () => void
}) {
  return <><label className="agent-check"><input type="checkbox" checked={layoutVerified} disabled={dirty || busy || !hasPreview} onChange={event => onLayoutVerified(event.target.checked)} />已下载试填文件并在 Word 中核对字体、表格、页眉页脚、换页与历史内容替换</label><Field label="版式核对说明（必填）" hint="请记录核对使用的 Word 客户端、字体环境及已处理的问题。"><textarea value={layoutNote} disabled={dirty || busy || !hasPreview} maxLength={2000} required onChange={event => onLayoutNote(event.target.value)} rows={2} /></Field><button className="button primary" disabled={busy || dirty || !layoutVerified || !hasPreview || !rulesConfirmed || !layoutNote.trim() || layoutNote.trim().length > 2000} onClick={onActivate}><CheckCheck size={16} />确认并启用模板</button></>
}
function OriginalRegion({ region }: { region: DocxRegion }) {
  return <div className="agent-original"><strong>上传文件原文</strong>{region.kind === 'table' ? <div className="agent-table-scroll"><table><tbody>{region.rows.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}><small>第 {rowIndex + 1} 行 · 第 {cellIndex + 1} 列</small>{cell || '（空白）'}</td>)}</tr>)}</tbody></table></div> : <p>{region.text || '（空白段落）'}</p>}</div>
}
function BindingEditor({ binding, region, disabled, onChange }: { binding: ReportAgentBinding; region?: DocxRegion; disabled: boolean; onChange: (value: ReportAgentBinding) => void }) {
  const table = region?.kind === 'table' ? region : undefined
  function changeKind(kind: ReportAgentBinding['kind']) {
    const row = table?.rows[Math.max(table.headerRows, 1)] || table?.rows.at(-1) || []
    onChange({ ...binding, kind, ...(kind === 'dataset' ? { dataset: binding.dataset || 'outcomes', startRow: binding.startRow ?? Math.max(table?.headerRows || 0, 1), endRow: binding.endRow ?? table?.rows.length, columns: binding.columns || row.map((_, index) => ({ label: table?.rows[0]?.[index] || `第 ${index + 1} 列`, field: 'manual', required: true })) } : {}), ...(kind === 'meta' ? { meta: binding.meta || 'period' } : {}), ...(kind === 'section' ? { section: binding.section || 'outcomes' } : {}) })
  }
  return <div className="agent-binding">
    <div className="agent-form-grid"><Field label={agentLabel(binding.label) || '填写区域'}><select aria-label={`${agentLabel(binding.label)}填写方式`} disabled={disabled} value={binding.kind} onChange={event => changeKind(event.target.value as ReportAgentBinding['kind'])}>{Object.entries(agentBindingLabels).filter(([kind]) => kind !== 'dataset' || !!table).map(([kind, label]) => <option key={kind} value={kind}>{label}</option>)}</select></Field><label className="agent-check"><input type="checkbox" disabled={disabled} checked={binding.required} onChange={event => onChange({ ...binding, required: event.target.checked })} />此区域必须填写</label></div>
    {region?.kind === 'cell' && <p className="agent-note">第 {region.rowIndex + 1} 行 · 第 {region.cellIndex + 1} 列原文：{region.text || '（空白）'}</p>}
    {binding.kind === 'keep' && <><p className="agent-note">以下文字会保留到每期输出，请确认没有历史数字、日期、人名或成果。</p>{region?.kind !== 'table' && <Field label="固定文字（可清理旧标题中的示例数字）"><textarea disabled={disabled} value={binding.value ?? region?.text ?? ''} rows={2} onChange={event => onChange({ ...binding, value: event.target.value })} /></Field>}</>}
    {binding.kind === 'clear' && <p className="agent-note">输出时清除此区域的原文。</p>}
    {binding.kind === 'manual' && <p className="agent-callout">每期生成后填写，并注明来源及确认。系统不会用工作条数猜测公司指标。</p>}
    {binding.kind === 'meta' && <Field label="日期或标题来源"><select disabled={disabled} value={binding.meta || 'period'} onChange={event => onChange({ ...binding, meta: event.target.value as ReportAgentBinding['meta'] })}><option value="period">本周开始日期</option><option value="week_range">本周起止日期</option><option value="author">汇报人</option><option value="department">部门名称</option><option value="week_end">本周结束日期</option><option value="captured_at">数据截至时间</option><option value="title">报告标题</option></select></Field>}
    {binding.kind === 'section' && <Field label="段落内容"><select disabled={disabled} value={binding.section || 'outcomes'} onChange={event => onChange({ ...binding, section: event.target.value as ReportAgentBinding['section'] })}>{Object.entries(agentDatasetLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>}
    {binding.kind === 'dataset' && <><Field label="表格内容来源"><select disabled={disabled} value={binding.dataset || 'outcomes'} onChange={event => onChange({ ...binding, dataset: event.target.value as ReportAgentBinding['dataset'] })}>{Object.entries(agentDatasetLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><p className="agent-note">指定原文中需要替换的完整数据行，表头保留。结束行固定为原表格末行，避免旧范例留在新报告中。</p><div className="agent-form-grid"><Field label="开始替换行（从 1 起）"><input disabled={disabled} type="number" min={2} max={table?.rows.length} value={(binding.startRow ?? 1) + 1} onChange={event => onChange({ ...binding, startRow: Number(event.target.value) - 1 })} /></Field><Field label="结束替换行（包含）"><input readOnly type="number" min={(binding.startRow ?? 1) + 1} max={table?.rows.length} value={binding.endRow ?? table?.rows.length ?? 1} onChange={event => onChange({ ...binding, endRow: Number(event.target.value) })} /></Field></div>
      <div className="agent-column-mappings">{binding.columns?.map((column, index) => <div className="agent-column" key={index}><Field label={`第 ${index + 1} 列 · ${column.label}`}><select disabled={disabled} value={column.field} onChange={event => onChange({ ...binding, columns: binding.columns?.map((item, col) => col === index ? { ...item, field: event.target.value as typeof column.field } : item) })}>{Object.entries(agentFieldLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field><label className="agent-check"><input type="checkbox" disabled={disabled} checked={column.required} onChange={event => onChange({ ...binding, columns: binding.columns?.map((item, col) => col === index ? { ...item, required: event.target.checked } : item) })} />必填</label></div>)}</div></>}
  </div>
}
