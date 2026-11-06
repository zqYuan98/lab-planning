import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Trash2 } from 'lucide-react'
import { LIMITS } from '../../shared/entity-rules'
import type { MonthlyPlanDeletionPreview } from '../../shared/monthly-plan-deletion'
import type { Bootstrap, MonthlyPlan } from '../../shared/types'
import { ApiError, api, finishSaved, json, SavedResultError } from '../api'
import { captureMutationContext } from '../mutation-response'
import { monthlyStatusLabels } from '../monthly-workflow'
import { Badge, dateTime, Field, Modal, nameOf } from '../ui'

export async function submitMonthlyPlanDeletion(preview: MonthlyPlanDeletionPreview, reason: string, onSaved: (plan: MonthlyPlan) => Promise<void>) {
  const trimmedReason = reason.trim()
  if (!preview.canDelete || preview.plan.deletion || preview.plan.visibility) throw new Error('此目标当前不能删除，请重新检查。')
  if (!trimmedReason) throw new Error('请填写删除原因')
  const deleted = await api<MonthlyPlan>(`/plans/${encodeURIComponent(preview.plan.id)}`, json({ version: preview.plan.version, reason: trimmedReason }, 'DELETE'))
  await finishSaved(() => onSaved(deleted), deleted.version)
}

export function MonthlyPlanDeletionNotice({ plan, data }: { plan: MonthlyPlan; data: Bootstrap }) {
  if (!plan.deletion) return null
  return <div className="context-box monthly-deletion-notice" role="status">
    <Badge>已删除 · 只读</Badge>
    <p>此目标已退出当前列表、统计和待办，原有审核与变更历史保留。</p>
    {plan.deletion.deletedAt && <p>删除时间：{dateTime(plan.deletion.deletedAt)}{plan.deletion.deletedBy && ` · 操作人：${nameOf(data, plan.deletion.deletedBy)}`}</p>}
    {plan.deletion.reason && <p>删除原因：{plan.deletion.reason}</p>}
  </div>
}

export default function MonthlyPlanDeletionDialog({ plan, data, enabled, onClose, onSaved }: {
  plan: MonthlyPlan; data: Bootstrap; enabled: boolean; onClose: () => void; onSaved: (plan: MonthlyPlan) => Promise<void>
}) {
  const [preview, setPreview] = useState<MonthlyPlanDeletionPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [reason, setReason] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [pending, setPending] = useState(false)
  const [savedResult, setSavedResult] = useState<SavedResultError | null>(null)
  const pendingRef = useRef(false)
  const accountId = data.user.id
  const accountRole = data.user.role

  useEffect(() => {
    if (!enabled || savedResult || pendingRef.current) return
    const controller = new AbortController(), context = captureMutationContext()
    setLoading(true); setPreview(null); setError('')
    api<MonthlyPlanDeletionPreview>(`/plans/${encodeURIComponent(plan.id)}/deletion-preview`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted && context === captureMutationContext()) setPreview(value) })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '无法检查目标，请重新检查。') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [plan.id, accountId, accountRole, data.scopeVersion, data.accessScopeVersion, data.operationEpoch, enabled, attempt, savedResult])

  const close = () => { if (!pendingRef.current) onClose() }
  async function confirmDeletion() {
    if (pendingRef.current || !enabled || loading || !preview?.canDelete || savedResult) return
    pendingRef.current = true; setPending(true); setError('')
    try { await submitMonthlyPlanDeletion(preview, reason, onSaved) }
    catch (failure) {
      if (failure instanceof SavedResultError) setSavedResult(failure)
      else if (failure instanceof ApiError) setPreview(null)
      setError(failure instanceof Error ? failure.message : '删除未完成，请重新检查目标。')
    } finally { pendingRef.current = false; setPending(false) }
  }
  async function reloadSaved() {
    if (pendingRef.current || !savedResult) return
    pendingRef.current = true; setPending(true)
    try { await savedResult.retry() }
    catch { setError('目标已删除，但页面仍未刷新成功。请重新加载已保存结果，无需再次删除。') }
    finally { pendingRef.current = false; setPending(false) }
  }
  const current = preview?.plan ?? plan
  return <Modal title="删除这项目标" onClose={close}>
    <div className="monthly-deletion-dialog" aria-busy={loading || pending}>
      <div className="context-box"><strong>{current.title}</strong><p>{current.month} · 负责人：{nameOf(data, current.ownerId)}</p><p>当前状态：{current.deletion ? '已删除' : monthlyStatusLabels[current.status]}</p><p>创建方式：{current.importSource ? '数据导入' : '系统内提报'} · 创建时间：{dateTime(current.createdAt)}</p>{current.expectedOutcome && <p>预期成果：{current.expectedOutcome.slice(0, 240)}{current.expectedOutcome.length > 240 ? '…' : ''}</p>}</div>
      <p className="modal-intro">删除后，目标退出当前月度列表、统计及待办，审核与变更历史保留。此操作不会删除同名目标或导入原文。</p>
      {!enabled && !savedResult && <p role="status">正在重新核对当前权限和目标状态，完成后显示可用操作。</p>}
      {enabled && loading && !savedResult && <p role="status"><LoaderCircle className="spin" size={16} aria-hidden="true" /> 正在检查目标及关联任务…</p>}
      {error && <div className="error" role="alert">{error}</div>}
      {preview && !preview.canDelete && !savedResult && <div className="monthly-deletion-blockers"><strong>此目标暂不能删除</strong><ul aria-label="不能删除的原因">{preview.blockers.map((blocker, index) => <li key={`${index}:${blocker}`}>{blocker}</li>)}</ul><p>处理上方关联或权限问题后，可重新检查。</p></div>}
      <form onSubmit={event => { event.preventDefault(); void confirmDeletion() }}>
        {preview?.canDelete && !savedResult && <fieldset className="form-fields" disabled={pending || loading || !enabled}>
          <Field label="删除原因" hint="例如：与已经导入的某项目标重复，保留导入的目标。"><textarea name="reason" value={reason} onChange={event => setReason(event.target.value)} required rows={3} maxLength={LIMITS.text} /></Field>
        </fieldset>}
        <footer className="form-footer">
          <button type="button" className="button secondary" onClick={close} disabled={pending}>{savedResult ? '关闭' : '取消'}</button>
          {savedResult ? <button type="button" className="button primary" disabled={pending} onClick={() => void reloadSaved()}>重新加载已保存结果</button> : <>
            {!loading && (!preview?.canDelete || error) && <button type="button" className="button secondary" disabled={pending || !enabled} onClick={() => setAttempt(value => value + 1)}>重新检查</button>}
            {preview?.canDelete && <button type="submit" className="button danger" disabled={pending || loading || !enabled || !reason.trim()}>{pending ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}{pending ? '正在删除…' : '确认删除目标'}</button>}
          </>}
        </footer>
      </form>
    </div>
  </Modal>
}
