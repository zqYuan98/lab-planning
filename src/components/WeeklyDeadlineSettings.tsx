import { useState } from 'react'
import type { WeeklyDeadlineRepairPreview, WeeklyRule, WeeklySubmissionView } from '../../shared/weekly-submissions'
import { api, finishSaved, json } from '../api'
import { Field, Form } from '../ui'
import { deadlinePolicyRequest, deadlineRepairRequest, weeklyDeadlineLabel } from '../weekly-deadline-flow'
import WorkCalendarField from './WorkCalendarField'

interface Props { view: WeeklySubmissionView; onUpdated: (message: string) => Promise<void> }

export default function WeeklyDeadlineSettings({ view, onUpdated }: Props) {
  const policies = [...(view.rule.deadlinePolicies ?? [])].sort((a, b) => a.fromWeek.localeCompare(b.fromWeek) || a.version - b.version)
  const latest = policies.at(-1)
  const [preview, setPreview] = useState<WeeklyDeadlineRepairPreview | null>(null)
  const [repairError, setRepairError] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  function editPolicy() { setDirty(true); setPreview(null); setRepairError('') }
  return <fieldset className="form-fields submission-deadline-settings" disabled={busy}>
    <section aria-label="截止方式与工作日历">
      <h3>截止方式与工作日历</h3>
      <p className="submission-explanation">北京时间 16:00 截止。保存后从下一个完整周生效，已生成周期保持原截止时间；按工作日截止时，整周没有工作日则不生成应交项。</p>
      {latest && <p className="submission-explanation">最近配置：{latest.fromWeek} 起按{latest.mode === 'last_workday' ? '当周最后一个工作日' : '周五'}截止。</p>}
      <Form submitLabel="保存后续截止规则" onSubmit={async event => {
        const form = new FormData(event.currentTarget)
        setBusy(true)
        try {
          const rule = await api<WeeklyRule>('/weekly-submissions/deadline-policy', json(deadlinePolicyRequest(view, String(form.get('mode')), String(form.get('calendar') ?? '')), 'PUT'))
          setPreview(null); setDirty(false)
          const fromWeek = [...(rule.deadlinePolicies ?? [])].sort((a, b) => a.fromWeek.localeCompare(b.fromWeek)).at(-1)?.fromWeek
          await finishSaved(() => onUpdated(`截止规则已保存${fromWeek ? `，自 ${fromWeek} 当周生效` : '，从下一完整周生效'}`), rule.version)
        } finally { setBusy(false) }
      }}>
        <Field label="后续周期截止方式"><select name="mode" defaultValue={latest?.mode ?? 'friday'} onChange={editPolicy}><option value="friday">固定周五 16:00</option><option value="last_workday">当周最后一个工作日 16:00（含调休）</option></select></Field>
        {view.workCalendar && <><WorkCalendarField overrides={view.workCalendar.overrides} onChange={editPolicy} /><p className="form-hint">此日历与「进展、催办与摘要」共用；协作功能关闭时日历仍有效。保存日历也会影响协作功能后续的工作日判断，不会自动改写已生成提报周期。</p></>}
      </Form>
    </section>
    <section aria-label="已生成周期截止修复">
      <h3>已生成周期截止修复</h3>
      <p className="submission-explanation">当前所选周期：{view.week}。预览按已保存共享日历的当周最后一个工作日计算，不写入周期。仅支持当前周期，且原、新截止都未到，尚无提交、缺交、审核、调整或报告快照等事实；历史事实保留。</p>
      {dirty && <p className="submission-notice">上方有未保存的配置，请先保存后再预览修复。</p>}
      <DeadlineRepairPreviewButton disabled={dirty} onPreview={async () => {
        setPreview(null); setRepairError(''); setBusy(true)
        try { setPreview(await api<WeeklyDeadlineRepairPreview>('/weekly-submissions/deadline-repair/preview', json({ week: view.week }))) }
        finally { setBusy(false) }
      }} />
      {repairError && <p className="error" role="alert">{repairError}</p>}
      {preview && <>
        <WeeklyDeadlineRepairSummary preview={preview} />
        {preview.eligible && !preview.unchanged && <Form key={preview.token} submitLabel="确认修复该周期截止" onSubmit={async event => {
          const body = deadlineRepairRequest(preview, String(new FormData(event.currentTarget).get('reason') ?? ''))
          let result: WeeklyDeadlineRepairPreview
          setBusy(true)
          try { result = await api<WeeklyDeadlineRepairPreview>('/weekly-submissions/deadline-repair', json(body)) }
          catch (failure) {
            setPreview(null)
            setRepairError(`${failure instanceof Error ? failure.message : '修复未完成'}。请重新预览后再确认。`)
            return
          } finally { setBusy(false) }
          setPreview(result)
          try { await onUpdated('本周期截止已修复，修复原因和操作者已记录') }
          catch { setRepairError('修复已保存，但页面刷新失败。请关闭规则窗口并刷新提报状态，无需再次修复。') }
        }}><Field label="修复原因" hint="原因将与旧、新截止日期一同留痕。"><textarea name="reason" rows={3} required /></Field></Form>}
      </>}
    </section>
  </fieldset>
}

function DeadlineRepairPreviewButton({ disabled, onPreview }: { disabled: boolean; onPreview: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  return <><button type="button" className="button secondary" disabled={disabled || busy} onClick={async () => {
    setBusy(true); setError('')
    try { await onPreview() } catch (failure) { setError(failure instanceof Error ? failure.message : '读取修复预览失败') }
    finally { setBusy(false) }
  }}>{busy ? '正在读取预览…' : '预览所选周期截止修复（只读）'}</button>{error && <p className="error" role="alert">{error}</p>}</>
}

export function WeeklyDeadlineRepairSummary({ preview }: { preview: WeeklyDeadlineRepairPreview }) {
  return <div className="submission-notice" aria-label="截止修复预览" role="status">
    <p>原截止：<strong>{weeklyDeadlineLabel(preview.previousDeadlineAt)}</strong></p>
    <p>新截止：<strong>{weeklyDeadlineLabel(preview.deadlineAt)}</strong></p>
    <p>涉及应交项：{preview.dutyCount} 项 · 周期版本：{preview.cycleVersion}</p>
    <p>计算方式：{preview.deadlinePolicy.mode === 'last_workday' ? '当周最后一个工作日' : '固定周五'}；工作日：{preview.deadlinePolicy.workingDays.join('、') || '无'}</p>
    <p>{preview.unchanged ? '截止配置已一致，无需修复。' : preview.eligible ? '可以修复，填写原因后确认执行。' : '不可修复，原有记录保持不变。'}</p>
    {preview.reasons.length > 0 && <ul>{preview.reasons.map((reason, index) => <li key={index}>{reason}</li>)}</ul>}
  </div>
}
