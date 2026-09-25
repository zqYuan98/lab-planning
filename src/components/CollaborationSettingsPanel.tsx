import { useEffect, useRef, useState } from 'react'
import type { CollaborationSettings } from '../../shared/collaboration'
import type { WorkRisk } from '../../shared/collaboration-notifications'
import DirectoryAccountPicker, { directoryAccountName } from './DirectoryAccountPicker'
import { useDirectoryReferences } from '../directory-references'
import { api, json } from '../api'
import { assignmentAttempt, type SubmissionAttempt } from '../notification-navigation'
import { Field, Form, type PageProps } from '../ui'
import WorkCalendarField from './WorkCalendarField'
import { parseWorkCalendar } from '../weekly-deadline-flow'

export default function CollaborationSettingsPanel({ data, notify }: PageProps) {
  const [settings, setSettings] = useState<CollaborationSettings | null>(null), [error, setError] = useState('')
  const [preview, setPreview] = useState<{ risks: WorkRisk[]; automaticCandidates: WorkRisk[]; slot: string | null; recipientCount: number } | null>(null)
  const attempt = useRef<SubmissionAttempt | null>(null)
  const scope = `${data.user.id}:${data.user.role}:${data.operationEpoch}:${data.accessScopeVersion}`
  const people = useDirectoryReferences(preview?.risks.map(row => row.ownerId) ?? [], scope)
  useEffect(() => { let live = true; setSettings(null); setPreview(null); attempt.current = null; void api<CollaborationSettings>('/collaboration/settings').then(row => { if (live) setSettings(row) }).catch(e => { if (live) setError(e.message) }); return () => { live = false } }, [scope])
  const flags = [['enabled', '启用进展与催办'], ['autoRulesEnabled', '自动风险提醒（工作日 09:00 / 17:00）'], ['deadlineApprovalEnabled', '下发任务的延期审批'], ['dailyManagerEnabled', '管理者每日摘要（工作日 17:30）'], ['weeklyManagerEnabled', '管理者每周摘要（周五 17:30，替代当日日摘要）'], ['memberActionsEnabled', '成员下一步行动摘要（工作日 17:30）']] as const
  return <section className="notification-settings-card collaboration-settings"><h2>进展、催办与摘要</h2><p>先选择试点成员和管理接收人。启用后仅跟踪明确纳入督办的有效工作，历史导入不会自动外发。</p>{error && <p role="alert" className="error">{error}</p>}
    {settings && <Form key={settings.version} submitLabel="保存协作设置" onSubmit={async e => { const f = new FormData(e.currentTarget), calendarOverrides = parseWorkCalendar(String(f.get('calendar') ?? '')); const body = { version: settings.version, ...Object.fromEntries(flags.map(([key]) => [key, f.has(key)])), pilotUserIds: f.getAll('pilotUserIds'), defaultManagerIds: f.getAll('defaultManagerIds'), staleWorkdays: Number(f.get('staleWorkdays')), blockerWorkdays: Number(f.get('blockerWorkdays')), calendarOverrides }; attempt.current = assignmentAttempt(attempt.current, body); const result = await api<CollaborationSettings>('/collaboration/settings', json({ ...body, requestId: attempt.current.requestId }, 'PUT')); attempt.current = null; setSettings(result); setPreview(null); notify('协作设置已保存') }}>
      <fieldset><legend>功能开关</legend>{flags.map(([key, label]) => <label className="checkbox-label" key={key}><input type="checkbox" name={key} defaultChecked={settings[key]} />{label}</label>)}</fieldset>
      <div className="form-grid"><fieldset><legend>试点成员</legend><DirectoryAccountPicker name="pilotUserIds" purpose="notification" multiple defaultSelectedIds={settings.pilotUserIds} scope={`${scope}:collaboration-pilots:${settings.version}`} /></fieldset><fieldset><legend>默认管理通知接收人</legend><DirectoryAccountPicker name="defaultManagerIds" purpose="notification" multiple role="manager" defaultSelectedIds={settings.defaultManagerIds} scope={`${scope}:collaboration-managers:${settings.version}`} /><p className="form-hint">未配置时保留站内事实，不向所有管理员广播。每项任务可另行指定接收人。</p></fieldset></div>
      <div className="form-grid"><Field label="无进展阈值（完整工作日）"><input name="staleWorkdays" type="number" min={1} max={30} required defaultValue={settings.staleWorkdays} /></Field><Field label="阻塞升级阈值（完整工作日）"><input name="blockerWorkdays" type="number" min={1} max={30} required defaultValue={settings.blockerWorkdays} /></Field></div>
      <WorkCalendarField overrides={settings.calendarOverrides} /><p className="form-hint">此工作日历与周提报共用，协作功能关闭时日历仍有效。修改后不会自动改写已生成提报周期的截止日期。</p>
      <p className="form-hint">风险卡按任务合并、按日去重。自动风险提醒不会代替每周正式提报。</p>
    </Form>}
    <Form submitLabel="预览当前规则（不发送）" onSubmit={async () => { setPreview(await api('/collaboration/rules-preview')) }}><p className="form-hint">预览只读取当前数据，不纳入任务、不消耗提醒额度。</p></Form>
    {preview && <div><p>当前 {preview.risks.length} 项风险，{preview.automaticCandidates.length} 项可进入 {preview.slot || '下一工作日时段'}，涉及 {preview.recipientCount} 位接收人。</p>{preview.risks.map((risk, index) => <p key={`${risk.key}-${index}`}>{risk.title} · {directoryAccountName(people.get(risk.ownerId))} · {risk.detail}</p>)}</div>}
  </section>
}
