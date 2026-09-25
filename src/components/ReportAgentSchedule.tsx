import { useEffect, useRef, useState } from 'react'
import { CalendarClock } from 'lucide-react'
import type { Bootstrap } from '../../shared/types'
import type { ReportAgentSchedule, ReportTemplate, UpdateReportAgentScheduleInput } from '../../shared/report-agent'
import { api, json } from '../api'
import { Field } from '../ui'
import { useFormDraft } from '../use-form-draft'
import { agentTime } from './ReportAgentHelpers'

export default function ReportAgentScheduleForm({ initial, templates, data, missedPeriods, notify, onSaved }: { initial: ReportAgentSchedule; templates: ReportTemplate[]; data: Bootstrap; missedPeriods: string[]; notify: (message: string) => void; onSaved: (schedule: ReportAgentSchedule) => void }) {
  const monthly = initial.type === 'monthly'
  const label = monthly ? '每月' : '每周'
  const [saved, setSaved] = useState(initial), [draft, setDraft] = useState(initial)
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false)
  const recovery = useFormDraft(`${data.user.id}:report-agent-schedule:${initial.type || 'weekly'}`, { payload: JSON.stringify(draft) }, values => { try { const value = JSON.parse(String(values.payload)); if (typeof value.enabled === 'boolean' && typeof value.templateId === 'string') setDraft(value) } catch { /* Invalid recovery is ignored. */ } }, busy)
  const baselineVersion = useRef(saved.version)
  useEffect(() => { if (baselineVersion.current !== saved.version) { baselineVersion.current = saved.version; recovery.clearDraft() } }, [saved.version])
  return <section className="agent-schedule"><h3><CalendarClock size={18} /> {label}自动生成待审阅草稿</h3><p className="agent-note">默认关闭。启用后由指定的有效管理者拥有任务，采用上海时间；定稿仍需人工确认。</p><form ref={recovery.formRef} onInput={recovery.rememberDraft} onChange={recovery.rememberDraft} onSubmit={async event => {
    event.preventDefault(); if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const payload: UpdateReportAgentScheduleInput = { ...(monthly ? { type: 'monthly', monthlyDay: draft.monthlyDay ?? 0, targetMonth: draft.targetMonth ?? 'current' } as const : {}), expectedVersion: draft.version, enabled: draft.enabled, actorId: draft.actorId, templateId: draft.templateId, weekday: draft.weekday, time: draft.time, targetWeek: draft.targetWeek, useAi: draft.useAi }
      const result = await api<ReportAgentSchedule>(monthly ? '/report-agent/monthly-schedule' : '/report-agent/schedule', json(payload, 'PUT'))
      setSaved(result); setDraft(result); recovery.clearDraft(); onSaved(result); notify(`${label}自动草稿已${result.enabled ? '启用' : '关闭'}。`)
    } catch (failure) { setError(failure instanceof Error ? failure.message : '设置保存失败') }
    finally { lock.current = false; setBusy(false) }
  }}><fieldset disabled={busy} className="agent-fieldset"><label className="agent-check"><input type="checkbox" checked={draft.enabled} onChange={event => setDraft(value => ({ ...value, enabled: event.target.checked }))} />启用{label}自动草稿</label><div className="agent-form-grid"><Field label="任务所属管理者"><select value={draft.actorId} onChange={event => setDraft(value => ({ ...value, actorId: event.target.value }))}><option value="">请选择管理者</option>{data.users.filter(user => user.role === 'manager' && user.active).map(user => <option value={user.id} key={user.id}>{user.name}</option>)}</select></Field><Field label="自动生成使用的模板"><select value={draft.templateId} onChange={event => setDraft(value => ({ ...value, templateId: event.target.value }))}><option value="">请选择已启用模板</option>{templates.map(template => <option value={template.id} key={template.id}>{template.name}</option>)}</select></Field>{monthly ? <Field label="每月哪一天" hint="29–31 日在较短月份按实际月末触发。"><select value={draft.monthlyDay ?? 0} onChange={event => setDraft(value => ({ ...value, monthlyDay: Number(event.target.value) }))}><option value={0}>每月最后一天</option>{Array.from({ length: 31 }, (_, i) => <option value={i + 1} key={i + 1}>每月 {i + 1} 日</option>)}</select></Field> : <Field label="每周哪一天"><select value={draft.weekday} onChange={event => setDraft(value => ({ ...value, weekday: Number(event.target.value) }))}>{['周一', '周二', '周三', '周四', '周五', '周六', '周日'].map((day, index) => <option key={index + 1} value={index + 1}>{day}</option>)}</select></Field>}<Field label="时间（Asia/Shanghai）"><input type="time" value={draft.time} onChange={event => setDraft(value => ({ ...value, time: event.target.value }))} required /></Field><Field label={monthly ? '生成哪一月' : '生成哪一周'}><select value={monthly ? draft.targetMonth : draft.targetWeek} onChange={event => setDraft(value => ({ ...value, [monthly ? 'targetMonth' : 'targetWeek']: event.target.value as 'current' | 'previous' }))}><option value="current">触发时所在{monthly ? '月' : '周'}</option><option value="previous">触发时的上一{monthly ? '月' : '周'}</option></select></Field></div><label className="agent-check"><input type="checkbox" checked={draft.useAi} disabled={!data.aiConfigured} onChange={event => setDraft(value => ({ ...value, useAi: event.target.checked }))} />自动任务使用已配置的 AI 辅助写作</label><p className="agent-note">正式模板启用后已接管同类型生成；暂停调度不恢复旧写入入口。</p><p className="agent-note">周期、触发日和当期 / 上期分别配置。停机恢复只补最近一次符合条件的周期，并记录实际读取数据的时间。</p>{recovery.notice && <p className="agent-note" role="status">{recovery.notice}</p>}{error && <p className="error" role="alert">{error}</p>}<button className="button primary" disabled={busy || (draft.enabled && (!draft.actorId || !draft.templateId))}>保存自动草稿设置</button></fieldset></form><p className="agent-note">最近设置于 {agentTime(saved.updatedAt)}</p>{missedPeriods.length > 0 && <div className="agent-callout"><strong>较早未生成的周期</strong><p>{missedPeriods.join('、')}</p><p>可到「生成与任务」选择对应周期补生成；补生成将显示本次实际数据截至时间。</p></div>}</section>
}
