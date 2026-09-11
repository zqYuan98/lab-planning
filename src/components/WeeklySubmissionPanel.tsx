import { useCallback, useEffect, useRef, useState } from 'react'
import { CalendarCheck, CheckCircle2, Clock3, RefreshCw } from 'lucide-react'
import type { WeeklyDutyView, WeeklySubmissionView } from '../../shared/weekly-submissions'
import { api, json } from '../api'
import { Badge, Field, Form, Modal, nameOf, type PageProps } from '../ui'

const labels = { due: '待提交', on_time: '按时提交', missing: '逾期未提交', late: '逾期补交', exempt: '已豁免' }
const tones = { due: 'neutral', on_time: 'green', missing: 'red', late: 'amber', exempt: 'blue' }
const kindLabel = (kind: string) => kind === 'results' ? '本周完成情况' : '下周计划'
const dateTime = (value: string | null) => value ? new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(value)) : '尚未提交'
function currentShanghaiWeek() {
  const date = new Date(Date.now() + 8 * 3600000)
  date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7)
  return date.toISOString().slice(0, 10)
}

export default function WeeklySubmissionPanel({ data, refresh, notify, onSelectWeek }: PageProps & { onSelectWeek: (week: string) => void }) {
  const manager = data.user.role === 'manager'
  const [week, setWeek] = useState(currentShanghaiWeek)
  const [view, setView] = useState<WeeklySubmissionView | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [selected, setSelected] = useState<WeeklyDutyView | null>(null)
  const [mode, setMode] = useState<'submit' | 'detail' | 'adjust' | 'roster' | 'rule' | ''>('')
  const [adjustAction, setAdjustAction] = useState('exempt')
  const [statusFilter, setStatusFilter] = useState('all')
  const [kindFilter, setKindFilter] = useState('all')
  const requestSequence = useRef(0)
  const requestId = useRef('')
  const load = useCallback(async () => {
    const sequence = ++requestSequence.current
    setLoading(true); setError('')
    try {
      const result = await api<WeeklySubmissionView>(`/weekly-submissions?week=${week}`)
      if (sequence === requestSequence.current) setView(result)
    } catch (failure) { if (sequence === requestSequence.current) { setView(null); setError(failure instanceof Error ? failure.message : '读取失败') } }
    finally { if (sequence === requestSequence.current) setLoading(false) }
  }, [week])
  useEffect(() => { void load(); return () => { requestSequence.current++ } }, [load, data.weeklyRecords])
  function open(duty: WeeklyDutyView, nextMode: typeof mode) {
    setSelected(duty); requestId.current = crypto.randomUUID(); setMode(nextMode)
  }
  async function saved(message: string) {
    setMode(''); setSelected(null); await refresh(); await load(); notify(message)
  }
  const duties = view?.duties ?? []
  const ownDuties = duties.filter(row => row.ownerId === data.user.id)
  const roster = view?.cycle?.rosterIds ?? []
  const filteredRoster = roster.filter(id => duties.some(duty => duty.ownerId === id && (statusFilter === 'all' || duty.status === statusFilter) && (kindFilter === 'all' || duty.kind === kindFilter)))
  const requiredDuties = duties.filter(duty => duty.status !== 'exempt')
  const requiredPeople = new Set(requiredDuties.map(duty => duty.ownerId)).size
  const missing = duties.filter(row => row.status === 'missing')
  const people = new Set(missing.map(row => row.ownerId)).size
  const selectedDrafts = selected?.records.filter(row => !row.submitted) ?? []
  return (
    <section className="weekly-submission-panel" aria-label="周五提报">
      <header className="submission-heading">
        <div><span className="eyebrow">FRIDAY / WEEKLY CHECK-IN</span><h2><CalendarCheck size={22} /> 周五提报</h2><p>周五 16:00 前更新本周完成情况，并提交下周计划。北京时间。</p></div>
        <div className="submission-tools">
          <Field label="截止周期（周一）"><input aria-label="提报截止周期" type="date" step={7} value={week} onChange={e => {
            if (!e.target.value) return
            const date = new Date(`${e.target.value}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - (date.getUTCDay() + 6) % 7)
            setWeek(date.toISOString().slice(0, 10)); setMode('')
          }} /></Field>
          <button className="button secondary" disabled={loading} onClick={() => void load()} aria-label="刷新提报状态"><RefreshCw size={16} /></button>
          {manager && view && <button className="button secondary" onClick={() => setMode('rule')}>提报规则</button>}
        </div>
      </header>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {loading && !view && <p role="status">正在读取提报状态…</p>}
      {view && <>
        <div className="submission-deadline"><Clock3 size={16} /><strong>截止：{dateTime(view.deadlineAt)}</strong><span>本周 {view.week} 起 · 下周 {view.nextWeek} 起</span></div>
        {!view.cycle && <p className="submission-notice">{week < view.rule.effectiveWeek ? `规则自 ${view.rule.effectiveWeek} 当周起生效，历史周期不记缺交。` : week > currentShanghaiWeek() ? '此截止周期尚未开始，可以先填写周任务草稿。' : '此周期已暂停提报，不计缺交。'}</p>}
        {view.cycle?.needsReview && <div className="submission-notice"><p>本周期应交名单待管理员核对，暂不认定缺交。</p>{manager && <button className="button secondary" onClick={() => setMode('roster')}>核对应交名单</button>}</div>}
        {!manager && view.cycle && !view.cycle.needsReview && !ownDuties.length && <p className="submission-notice">你不在本周期应交名单中，无须补交。周中加入的成员从下一完整周开始计入。</p>}
        {!manager && ownDuties.length === 2 && ownDuties.every(duty => ['on_time', 'late', 'exempt'].includes(duty.status)) && <p className="submission-notice">本周期两项提报已完成或获豁免，历史补交记录仍保留。</p>}
        {!manager && ownDuties.length > 0 && <div className="submission-cards">{ownDuties.map(duty => <article key={duty.id} className="submission-card">
          <div className="submission-card-top"><h3>{kindLabel(duty.kind)}</h3><Badge tone={tones[duty.status]}>{labels[duty.status]}</Badge></div>
          <p>{duty.kind === 'results' ? '如实更新实际进展，仍在进行中的工作也可提交。' : '核对下周所有任务安排后，确认整份计划。'}</p>
          <div className="submission-facts"><span>{duty.records.filter(r => r.submitted).length} 项正式记录 · {duty.records.filter(r => !r.submitted).length} 项草稿</span><span>首次：{dateTime(duty.firstSubmittedAt)}</span></div>
          {duty.changedSinceSubmission && <p className="submission-notice">提交后有更新，请重新核对并提交修订。</p>}
          {duty.missingAtDeadline && <small>截止时未提交的记录已保留。</small>}
          {duty.exemptionReason && <small>豁免原因：{duty.exemptionReason}</small>}
          <div className="submission-actions"><button className="button secondary" onClick={() => onSelectWeek(duty.contentWeek)}>{duty.kind === 'results' ? '填写本周进展' : '填写下周计划'}</button><button className="button primary" onClick={() => open(duty, 'submit')}><CheckCircle2 size={16} />{duty.latestSubmission ? '核对并提交修订' : '核对并正式提交'}</button><button className="button secondary" onClick={() => open(duty, 'detail')}>记录</button></div>
        </article>)}</div>}
        {manager && view.cycle && !view.cycle.needsReview && <>
          <div className="submission-summary"><strong>{requiredPeople} 人应交 · {requiredDuties.length} 项</strong><span>周期名单 {roster.length} 人（含豁免）</span><span>{people} 人有缺交 · 共 {missing.length} 项</span><span>{duties.filter(d => d.status === 'late').length} 项已补交</span><span>任务完成率与提报状态分别统计</span></div>
          <div className="submission-tools"><Field label="按提报状态筛选成员"><select value={statusFilter} onChange={event => setStatusFilter(event.target.value)}><option value="all">全部成员</option>{Object.entries(labels).map(([status, label]) => <option key={status} value={status}>{label}</option>)}</select></Field><Field label="应交项"><select value={kindFilter} onChange={event => setKindFilter(event.target.value)}><option value="all">两项全部</option><option value="results">本周完成情况</option><option value="plan">下周计划</option></select></Field></div>
          <div className="table-wrap"><table><thead><tr><th>成员</th><th>本周完成情况</th><th>下周计划</th></tr></thead><tbody>{filteredRoster.map(id => <tr key={id}><td>{nameOf(data, id)}</td>{(['results', 'plan'] as const).map(kind => {
            const duty = duties.find(d => d.ownerId === id && d.kind === kind)
            return <td key={kind}>{duty && <div className="submission-cell"><Badge tone={tones[duty.status]}>{labels[duty.status]}</Badge><small>{dateTime(duty.firstSubmittedAt)}</small>{duty.changedSinceSubmission && <small>提交后有更新</small>}{duty.exemptionReason && <small>{duty.exemptionReason}</small>}<button className="text-button" onClick={() => open(duty, 'detail')}>查看 / 处理</button></div>}</td>
          })}</tr>)}{!filteredRoster.length && <tr><td colSpan={3}>暂无符合此状态的成员。</td></tr>}</tbody></table></div>
        </>}
      </>}

      {mode === 'submit' && selected && <Modal title={`${kindLabel(selected.kind)} · 整份提交`} onClose={() => setMode('')} wide>
        <p className="modal-intro">{nameOf(data, selected.ownerId)} · {selected.contentWeek} 当周。请核对以下内容；保存单条记录不会替代此处的整份提交。</p>
        <div className="submission-preview">{selected.records.map(row => <article key={row.id}><strong>{data.tasks.find(t => t.id === row.taskId)?.title ?? '个人任务'}</strong><Badge>{row.submitted ? '正式记录' : '草稿'}</Badge><p>{selected.kind === 'results' ? row.actualOutcome || '尚未填写实际进展，请先在下方任务中更新。' : row.commitment || '尚未填写下周承诺'}</p></article>)}{!selected.records.length && <p>没有工作记录，请填写本周期无工作安排的说明。</p>}</div>
        <Form onCancel={() => setMode('')} submitLabel="确认提交整份内容" onSubmit={async event => {
          const values = Object.fromEntries(new FormData(event.currentTarget))
          await api('/weekly-submissions/submit', json({ ...values, dutyId: selected.id, version: selected.version, manifest: selected.manifest, requestId: requestId.current }))
          await saved('整份提报已保存，提交时间和历史版本已记录')
        }}>
          {selectedDrafts.length > 0 && <Field label={`还有 ${selectedDrafts.length} 条草稿，请明确处理`}><select name="draftAction" required defaultValue=""><option value="" disabled>请选择</option><option value="include">全部纳入本次正式提交</option><option value="retain">继续保留草稿，本次不纳入</option></select></Field>}
          <Field label="补充说明 / 无工作安排说明" hint="没有正式记录且保留全部草稿时，必须说明原因。"><textarea name="note" rows={3} defaultValue={selected.latestSubmission?.note ?? ''} required={selected.records.length === 0} /></Field>
          {manager && selected.ownerId !== data.user.id && <Field label="管理员代录原因"><textarea name="reason" required rows={2} /></Field>}
        </Form>
      </Modal>}

      {mode === 'detail' && selected && <Modal title={`${nameOf(data, selected.ownerId)} · ${kindLabel(selected.kind)}`} onClose={() => setMode('')} wide>
        <p><Badge tone={tones[selected.status]}>{labels[selected.status]}</Badge> 截止 {dateTime(selected.deadlineAt)}{selected.missingAtDeadline ? ' · 截止时未提交记录已保留' : ''}</p>
        <div className="timeline">{selected.submissions.map((receipt, index) => <article key={receipt.id}><h3>第 {index + 1} 次提交 · {dateTime(receipt.submittedAt)}</h3><p>{receipt.records.length} 项记录 · {receipt.note || '无补充说明'}</p>{receipt.reason && <p>代录：{nameOf(data, receipt.actorId)} · {receipt.reason}</p>}</article>)}{selected.adjustments.map(event => <article key={event.id}><h3>{{ exempt: '豁免', revoke_exemption: '撤销豁免', invalidate: '作废提交', restore: '恢复提交' }[event.action]} · {dateTime(event.occurredAt)}</h3><p>{nameOf(data, event.actorId)} · {event.reason}</p></article>)}{!selected.submissions.length && <p>尚无整份提交记录。</p>}</div>
        {manager && <div className="submission-actions"><button className="button primary" onClick={() => open(selected, 'submit')}>代录提报</button><button className="button secondary" onClick={() => { setAdjustAction('exempt'); setMode('adjust') }}>豁免 / 纠错</button></div>}
      </Modal>}

      {mode === 'adjust' && selected && manager && <Modal title="提报豁免与纠错" onClose={() => setMode('')}>
        <p>所有操作保留原因和操作者，不删除原提交或缺交事实。</p>
        <Form onCancel={() => setMode('')} onSubmit={async event => { await api('/weekly-submissions/adjust', json({ ...Object.fromEntries(new FormData(event.currentTarget)), dutyId: selected.id, version: selected.version })); await saved('调整已记录') }}>
          <Field label="操作"><select name="action" value={adjustAction} onChange={e => setAdjustAction(e.target.value)}><option value="exempt">豁免本项</option><option value="revoke_exemption">撤销豁免</option><option value="invalidate">作废一次错误提交</option><option value="restore">恢复一次提交</option></select></Field>
          {['invalidate', 'restore'].includes(adjustAction) && <Field label="对应提交"><select name="submissionId" required defaultValue=""><option value="" disabled>选择提交记录</option>{selected.submissions.map((receipt, i) => <option key={receipt.id} value={receipt.id}>第 {i + 1} 次 · {dateTime(receipt.submittedAt)}</option>)}</select></Field>}
          <Field label="原因"><textarea name="reason" rows={3} required /></Field>
        </Form>
      </Modal>}

      {mode === 'roster' && view?.cycle && manager && <Modal title="核对应交名单" onClose={() => setMode('')}>
        <p>历史账号状态不足以可靠还原本周名单，请按实际在岗情况确认。</p>
        <Form onCancel={() => setMode('')} onSubmit={async event => {
          const form = new FormData(event.currentTarget)
          await api('/weekly-submissions/roster', json({ week, version: view.cycle!.version, rosterIds: form.getAll('rosterIds'), reason: form.get('reason') })); await saved('应交名单已确认')
        }}>
          {data.users.filter(user => user.role === 'member').map(user => <label className="check-field" key={user.id}><input name="rosterIds" type="checkbox" value={user.id} defaultChecked={view.cycle!.rosterIds.includes(user.id)} />{user.name}{!user.active ? '（已停用）' : ''}</label>)}
          <Field label="核对依据"><textarea name="reason" rows={3} required /></Field>
        </Form>
      </Modal>}

      {mode === 'rule' && view && manager && <Modal title="周提报规则" onClose={() => setMode('')}>
        <p>每周五北京时间 16:00，分别提交本周完成情况和下周计划。规则自 {view.rule.effectiveWeek} 起生效。</p><p>启停从下一个完整周生效，已形成的应交项、缺交和补交记录保留。</p>
        <Form onCancel={() => setMode('')} onSubmit={async event => { await api('/weekly-submissions/rule', json({ version: view.rule.version, enabled: new FormData(event.currentTarget).get('enabled') === 'true' }, 'PUT')); await saved('提报规则已更新') }}>
          <Field label="后续周期"><select name="enabled" defaultValue={String(view.rule.enabled)}><option value="true">启用周提报检查</option><option value="false">暂停后续周期检查</option></select></Field>
        </Form>
      </Modal>}
    </section>
  )
}
