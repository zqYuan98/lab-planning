import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, ShieldCheck, Trash2 } from 'lucide-react'
import { registrationApproved } from '../../shared/auth-policy'
import type { User } from '../../shared/types'
import { api, json } from '../api'
import { Badge, Field, Modal, type PageProps } from '../ui'

interface DeletionPreview {
  user: User
  canDelete: boolean
  blockers: { key: string; label: string; count: number }[]
  retainedHistory: true
}

interface Props extends Pick<PageProps, 'data' | 'refresh' | 'notify'> {
  user: User
  onClose: () => void
}

export default function AccountDeleteDialog({ user, data, refresh, notify, onClose }: Props) {
  const [preview, setPreview] = useState<DeletionPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [confirmName, setConfirmName] = useState('')
  const [pending, setPending] = useState<'delete' | 'deactivate' | null>(null)
  const [attempt, setAttempt] = useState(0)
  const pendingRef = useRef(false)
  const account = preview?.user || user
  const canDeactivate = !!preview && !preview.canDelete && account.active &&
    registrationApproved(account) && account.id !== data.user.id &&
    !preview.blockers.some(item => item.key === 'self' || item.key === 'lastManager')

  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    setError('')
    setPreview(null)
    setConfirmName('')
    api<DeletionPreview>(`/users/${user.id}/deletion-preview`, { signal: controller.signal })
      .then(value => { if (!controller.signal.aborted) setPreview(value) })
      .catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '无法检查账号，请重试。')
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [user.id, attempt])

  const close = () => { if (!pendingRef.current) onClose() }

  async function changeAccount(action: 'delete' | 'deactivate') {
    if (pendingRef.current || !preview || loading) return
    if (action === 'delete' && (!preview.canDelete || confirmName !== account.name)) return
    if (action === 'deactivate' && !canDeactivate) return
    pendingRef.current = true
    setPending(action)
    setError('')
    try {
      await api(`/users/${account.id}`, json(
        action === 'delete'
          ? { version: account.version, confirmName }
          : { version: account.version, active: false },
        action === 'delete' ? 'DELETE' : 'PATCH',
      ))
      try {
        await refresh()
        notify(action === 'delete' ? `账号「${account.name}」已删除` : `账号「${account.name}」已停用，历史归属保留`)
      } catch {
        notify(action === 'delete' ? '账号已删除，列表刷新失败，请刷新页面查看。' : '账号已停用，列表刷新失败，请刷新页面查看。')
      }
      onClose()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '操作失败，请重试。')
    } finally {
      pendingRef.current = false
      setPending(null)
    }
  }

  return (
    <Modal title="删除账号" onClose={close}>
      <div className="account-delete-dialog" aria-busy={loading || !!pending}>
        <div className="account-delete-person">
          <span className="avatar light" aria-hidden="true">{account.name.slice(-2)}</span>
          <div><strong>{account.name}</strong><p>{account.email}</p></div>
          <Badge tone={account.active ? 'green' : 'neutral'}>{account.active ? '启用' : '停用'}</Badge>
        </div>
        {loading && <p className="account-delete-loading" role="status"><LoaderCircle className="spin" size={18} />正在检查账号关联的业务与历史记录…</p>}
        {error && <div className="error" role="alert">{error}</div>}
        {!loading && !preview && (
          <footer className="form-footer">
            <button className="button secondary" onClick={close}>关闭</button>
            <button className="button primary" onClick={() => setAttempt(value => value + 1)}>重新检查</button>
          </footer>
        )}
        {preview && !preview.canDelete && (
          <>
            <div className="account-delete-guidance">
              <ShieldCheck size={20} aria-hidden="true" />
              <div><strong>该账号需要保留</strong><p>{preview.blockers.some(item => item.key === 'self' || item.key === 'lastManager') ? '当前登录账号和最后一位启用管理员需要保留，请查看下方原因。' : '停用后从日常列表和新分配选项中隐藏，已有工作与历史记录保留原有归属。'}</p></div>
            </div>
            <ul className="account-delete-blockers" aria-label="无法删除的原因">
              {preview.blockers.map(item => <li key={item.key}><span>{item.label}</span><Badge>{item.count}</Badge></li>)}
            </ul>
            <footer className="form-footer account-delete-actions">
              <button className="button secondary" onClick={close} disabled={!!pending}>返回</button>
              {error && <button className="button secondary" onClick={() => setAttempt(value => value + 1)} disabled={!!pending}>重新检查</button>}
              {canDeactivate && <button className="button primary" onClick={() => void changeAccount('deactivate')} disabled={!!pending}>
                {pending && <LoaderCircle className="spin" size={16} aria-hidden="true" />}{pending ? '正在停用…' : '停用并保留历史'}
              </button>}
            </footer>
          </>
        )}
        {preview?.canDelete && (
          <form onSubmit={event => { event.preventDefault(); void changeAccount('delete') }}>
            <p className="account-delete-description">该账号没有关联业务记录，可以删除。删除后无法再登录；已有账号操作记录仍保留姓名与邮箱快照。</p>
            <fieldset className="form-fields" disabled={!!pending}>
              <Field label="输入当前姓名以确认删除" hint={`请完整输入「${account.name}」。此操作无法撤销。`}>
                <input value={confirmName} onChange={event => setConfirmName(event.target.value)} autoComplete="off" required maxLength={100} />
              </Field>
            </fieldset>
            <footer className="form-footer account-delete-actions">
              <button type="button" className="button secondary" onClick={close} disabled={!!pending}>取消</button>
              {error && <button type="button" className="button secondary" onClick={() => setAttempt(value => value + 1)} disabled={!!pending}>重新检查</button>}
              <button type="submit" className="button danger" disabled={!!pending || confirmName !== account.name}>
                {pending ? <LoaderCircle className="spin" size={16} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}{pending ? '正在删除…' : '确认删除账号'}
              </button>
            </footer>
          </form>
        )}
      </div>
    </Modal>
  )
}
