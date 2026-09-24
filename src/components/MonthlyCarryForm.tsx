import { useEffect, useRef, useState } from 'react'
import type { Bootstrap, MonthlyPlan } from '../../shared/types'
import { api, ApiError, json } from '../api'
import { draftText } from '../draft-recovery'
import { carryAttemptKey, createCarryAttempt, parseCarryAttempt, persistCarryAttempt, type CarryAttempt } from '../monthly-carry'
import { Field, Form } from '../ui'

interface Props { plan: MonthlyPlan; data: Bootstrap; refresh: () => Promise<void>; onSaved: (target: MonthlyPlan) => Promise<void>; onCancel: () => void }

export default function MonthlyCarryForm({ plan, data, refresh, onSaved, onCancel }: Props) {
  const storageKey = carryAttemptKey(data.user.id, plan.id)
  const [source, setSource] = useState(plan)
  const [formEpoch, setFormEpoch] = useState(data.operationEpoch || '')
  const [attempt, setAttempt] = useState<CarryAttempt | null>(() => {
    try { return parseCarryAttempt(sessionStorage.getItem(storageKey), data.user.id, plan.id) } catch { return null }
  })
  const command = useRef(attempt)
  const [month, setMonth] = useState(attempt?.payload.month || '')
  const [dueDate, setDueDate] = useState(attempt?.payload.dueDate || '')
  const [reason, setReason] = useState(attempt?.payload.reason || '')
  const [split, setSplit] = useState(false)
  const [mustReviewSource, setMustReviewSource] = useState(false)
  const [mustReconcile, setMustReconcile] = useState(false)
  const [reloaded, setReloaded] = useState(false)
  const [confirmed, setConfirmed] = useState(false)
  const [readError, setReadError] = useState('')
  const [reading, setReading] = useState(false)
  const latest = data.plans.find(item => item.id === plan.id)
  const existing = data.plans.filter(item => item.sourcePlanId === plan.id)
  const matching = existing.filter(item => item.month === month)
  const contextChanged = (attempt?.operationEpoch ?? formEpoch) !== data.operationEpoch
  const sourceChanged = mustReviewSource || !latest || latest.version !== source.version
  const reconciliation = contextChanged || mustReconcile
  useEffect(() => { setReloaded(false); setConfirmed(false) }, [data.operationEpoch])

  function clearAttempt() {
    command.current = null; setAttempt(null)
    try { sessionStorage.removeItem(storageKey) } catch { /* A leftover key can only replay its existing command. */ }
  }
  async function reload() {
    setReading(true); setReadError('')
    try { await refresh(); setReloaded(true) }
    catch (error) { setReadError(error instanceof Error ? error.message : '读取失败，请重试') }
    finally { setReading(false) }
  }

  return <>
    <p className="modal-intro">保留 {source.month} 的承诺和结果，新建有来源关系的月度草稿。交办来源和临时目标信息继续保留。</p>
    {!!existing.length && <div className="context-box"><strong>已有承接目标</strong>{existing.map(item => <p key={item.id}>{item.month} · {item.title} · 截止 {item.dueDate}{item.status === 'merged' ? '（已合并）' : ''}</p>)}</div>}
    {attempt && !reconciliation && <p className="form-hint" role="status">上一次承接结果尚待核对。下方保留原提交内容，点击“核对原承接结果”会安全重试同一次操作。</p>}
    {reconciliation && <div className="context-box" role="status">
      <strong>请先核对已保存的承接目标</strong><p>数据环境或原操作状态已变化，无法直接继续原请求。重新读取并核对已有目标后，才能准备另一项承接。</p>
      <button type="button" className="button secondary" disabled={reading} onClick={() => void reload()}>重新读取已有承接</button>
      {reloaded && <><label className="checkbox-label"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已核对已有目标，仍需重新准备承接</label>
        <button type="button" className="button secondary" disabled={!confirmed || !latest || !data.operationEpoch} onClick={() => {
          clearAttempt(); setSource(latest!); setFormEpoch(data.operationEpoch!); setMustReviewSource(false); setMustReconcile(false); setReloaded(false); setConfirmed(false); setSplit(false)
        }}>重新准备承接</button></>}
    </div>}
    {!attempt && sourceChanged && <div className="context-box"><strong>来源目标已变化，请核对最新内容</strong>
      {latest && <><p>{latest.title}</p><p>预期成果：{latest.expectedOutcome}</p><p>当前成果：{latest.actualOutcome || '尚未填写'}</p></>}
      <button type="button" className="button secondary" disabled={reading} onClick={() => void reload()}>读取最新目标</button>{reloaded && latest && <button type="button" className="button secondary" onClick={() => { setSource(latest); setMustReviewSource(false); setReloaded(false) }}>已核对，使用最新目标</button>}
    </div>}
    {readError && <p className="error" role="alert">{readError}</p>}
    <Form onCancel={onCancel} submitLabel={attempt ? '核对原承接结果' : '创建承接草稿'}
      draftKey={`monthly-carry:${data.user.id}:${plan.id}`}
      draftContext={{ __sourceVersion: String(source.version), __operationEpoch: formEpoch }}
      onDraftRestore={values => {
        if (command.current) {
          // Restore the exact unresolved request, not an older editable form draft.
          values.month = command.current.payload.month; values.dueDate = command.current.payload.dueDate; values.reason = command.current.payload.reason
          return
        }
        const restoredEpoch = draftText(values, '__operationEpoch')
        setFormEpoch(restoredEpoch)
        if (draftText(values, '__sourceVersion') !== String(source.version)) setMustReviewSource(true)
        setMonth(draftText(values, 'month')); setDueDate(draftText(values, 'dueDate')); setReason(draftText(values, 'reason'))
      }}
      onSubmit={async () => {
        if (reconciliation) throw new Error('请先重新读取并核对已有承接目标。')
        if (!command.current) {
          if (!data.operationEpoch) throw new Error('请刷新页面以核对当前数据环境。')
          if (sourceChanged) throw new Error('请先核对来源目标的最新内容。')
          if (matching.length && !split) throw new Error('该月份已有承接目标。继续新建前，请明确确认拆分承接。')
          const next = createCarryAttempt(data.user.id, plan.id, formEpoch, { sourceVersion: source.version, month, dueDate, reason: reason.trim() })
          persistCarryAttempt(sessionStorage, next)
          command.current = next; setAttempt(next)
        }
        const pending = command.current
        let target: MonthlyPlan
        try {
          target = await api<MonthlyPlan>(`/plans/${plan.id}/carry`, {
            ...json({ ...pending.payload, requestId: pending.requestId }), headers: { 'X-Operation-Epoch': pending.operationEpoch },
          })
        } catch (error) {
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
            if (['OPERATION_CONTEXT_CHANGED', 'IDEMPOTENCY_MISMATCH', 'CARRY_TARGET_MISSING'].includes(error.code || '') || error.status === 404) {
              setMustReconcile(true); setReloaded(false); setConfirmed(false)
            } else if (error.status === 400 || error.code === 'SOURCE_VERSION_CONFLICT') {
              clearAttempt()
              if (error.code === 'SOURCE_VERSION_CONFLICT') { setMustReviewSource(true); setReloaded(false) }
            }
          }
          throw error
        }
        clearAttempt()
        await onSaved(target)
      }}>
      <fieldset disabled={!!attempt} className="form-fields">
        <div className="form-grid">
          <Field label="承接月份"><input type="month" name="month" value={month} onChange={event => { setMonth(event.target.value); setSplit(false) }} required /></Field>
          <Field label="新的截止日期"><input type="date" name="dueDate" value={dueDate} onChange={event => setDueDate(event.target.value)} required /></Field>
        </div>
        <Field label="承接原因"><textarea name="reason" value={reason} onChange={event => setReason(event.target.value)} maxLength={12000} required rows={3} /></Field>
        {!!matching.length && <label className="checkbox-label"><input type="checkbox" checked={split} onChange={event => setSplit(event.target.checked)} required />明确拆分：本次在同月另建一个承接目标</label>}
      </fieldset>
    </Form>
  </>
}
