import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from 'react'
import { X, Inbox, LoaderCircle } from 'lucide-react'
import type { Bootstrap } from '../shared/types'
import type { EditableObject } from '../shared/task-view'
import type { NavigationIntent } from './navigation'
import { accountDisplayName } from './account-options'
import { allowDraftLeave, type DraftValues } from './draft-recovery'
import { useFormDraft } from './use-form-draft'
import { ApiError, SavedResultError } from './api'
import { requestErrorFeedback, rememberClientError } from './error-context'
import DraftComparison from './components/DraftComparison'
import { editingUnavailable, editableComparisonValues, readEditableObject } from './form-editing'

export interface PageProps {
  data: Bootstrap
  refresh: () => Promise<void>
  notify: (message: string) => void
  intent?: NavigationIntent
}
export function Modal({
  title,
  onClose,
  children,
  wide = false,
}: {
  title: string
  onClose: () => void
  children: ReactNode
  wide?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef(onClose)
  closeRef.current = () => { if (allowDraftLeave(ref.current)) onClose() }
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current
      ?.querySelector<HTMLElement>('input,select,textarea,button')
      ?.focus()
    function key(event: KeyboardEvent) {
      const dialogs = document.querySelectorAll('[role="dialog"]')
      if (dialogs[dialogs.length - 1] !== ref.current) return
      if (event.key === 'Escape') closeRef.current()
      if (event.key === 'Tab') {
        const nodes = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href],summary,[tabindex]:not([tabindex="-1"])',
          ) || [],
        ).filter(node => node.tabIndex >= 0 && node.getClientRects().length > 0 && !node.closest('[hidden],[inert]') && !node.matches(':disabled'))
        const first = nodes[0],
          last = nodes[nodes.length - 1]
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault()
          last?.focus()
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault()
          first?.focus()
        }
      }
    }
    document.addEventListener('keydown', key)
    return () => {
      document.removeEventListener('keydown', key)
      document.body.style.overflow = previousOverflow
      before?.focus()
    }
  }, [])
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) closeRef.current()
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`modal ${wide ? 'modal-wide' : ''}`}
      >
        <div className="modal-heading">
          <h2>{title}</h2>
          <button
            type="button"
            className="icon-button"
            aria-label="关闭对话框"
            onClick={() => closeRef.current()}
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}
export function Field({
  label,
  children,
  hint,
}: {
  label: string
  children: ReactNode
  hint?: string
}) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <small>{hint}</small>}
    </label>
  )
}
export function Empty({
  title,
  description,
  action,
}: {
  title: string
  description?: string
  action?: ReactNode
}) {
  return (
    <div className="empty">
      <Inbox size={32} strokeWidth={1.3} />
      <h3>{title}</h3>
      {description && <p>{description}</p>}
      {action}
    </div>
  )
}
export function Badge({
  children,
  tone = 'neutral',
}: {
  children: ReactNode
  tone?: string
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>
}
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: string
  description?: string
  actions?: ReactNode
  eyebrow?: string
}) {
  return (
    <header className="page-header">
      <div>
        {eyebrow && <div className="eyebrow">{eyebrow}</div>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="header-actions">{actions}</div>}
    </header>
  )
}
export function Form({
  onSubmit,
  children,
  submitLabel = '保存',
  onCancel,
  draftKey,
  draftContext,
  onDraftRestore,
  workspaceErrorActions = true,
  editablePath,
  editVersion,
  onConflictResolved,
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>, version?: number) => Promise<void | number>
  children: ReactNode
  submitLabel?: string
  onCancel?: () => void
  /** Opt-in, tab-local recovery for work forms; never used for credentials. */
  draftKey?: string
  draftContext?: DraftValues
  onDraftRestore?: (values: DraftValues) => void
  workspaceErrorActions?: boolean
  editablePath?: string
  editVersion?: number
  onConflictResolved?: (current: EditableObject) => void
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  const sending = useRef(false)
  const [requestId, setRequestId] = useState<string>()
  const [sessionExpired, setSessionExpired] = useState(false)
  const [savedResult, setSavedResult] = useState<SavedResultError | null>(null)
  const draft = useFormDraft(draftKey, draftContext, onDraftRestore, busy)
  const { formRef, rememberDraft, clearDraft, notice } = draft
  const [version,setVersion] = useState(editVersion)
  const latestEditVersion=useRef(editVersion);latestEditVersion.current=editVersion
  const [writeUnavailable,setWriteUnavailable]=useState(false)
  const [comparison,setComparison] = useState<{base:DraftValues|null;server:DraftValues;local:DraftValues;version:number;editable:EditableObject}|null>(null)
  return (
    <form
      ref={formRef}
      onInput={rememberDraft}
      onChange={rememberDraft}
      onSubmit={async (event) => {
        event.preventDefault()
        if (sending.current || savedResult || writeUnavailable || comparison) return
        sending.current = true
        setBusy(true)
        setError('')
        setRequestId(undefined)
        setSessionExpired(false)
        try {
          const confirmedVersion=await onSubmit(event, version)
          const nextVersion=confirmedVersion ?? latestEditVersion.current
          clearDraft(nextVersion)
          if(nextVersion!==undefined)setVersion(nextVersion)
        } catch (e) {
          if (e instanceof SavedResultError) { clearDraft(e.savedVersion); if(e.savedVersion!==undefined)setVersion(e.savedVersion); setSavedResult(e) }
          if (e instanceof ApiError) { setRequestId(e.requestId); setSessionExpired(e.status === 401) }
          if (editingUnavailable(e)) { setWriteUnavailable(true); setComparison(null); draft.dismissRecovery() }
          if(e instanceof ApiError && e.status===409 && e.code==='VERSION_CONFLICT' && editablePath) {
            try { const current=await readEditableObject(editablePath);const local=draft.snapshot();setComparison({base:draft.baseValues(),server:editableComparisonValues(current,local),local,version:current.version,editable:current}) }
            catch(readError) {setComparison(null);if(editingUnavailable(readError)){setWriteUnavailable(true);draft.dismissRecovery()}setError(readError instanceof Error?readError.message:'无法读取当前编辑内容，已保留本地输入。');return}
          }
          setError(e instanceof Error ? e.message : '操作失败')
        } finally {
          sending.current = false
          setBusy(false)
        }
      }}
    >
      {notice && <p className="form-hint" role="status">{notice}</p>}
      {(comparison || draft.recovery) && <DraftComparison base={comparison?.base ?? draft.recovery?.baseValues ?? null} server={comparison?.server ?? draft.baseValues()} local={comparison?.local ?? draft.recovery!.values} onCancel={()=>{setComparison(null);draft.dismissRecovery()}} onMerge={values=>{if(comparison){setVersion(comparison.version);onConflictResolved?.(comparison.editable)}draft.applyValues(values,comparison?.server ?? draft.baseValues(),comparison?.version);setComparison(null);setError('已合并，请核对后重新提交。')}} />}
      <fieldset disabled={busy || !!savedResult || writeUnavailable || !!comparison} className="form-fields">
        {children}
      </fieldset>
      {error && (
        <div className="error" role="alert">
          {error}
          {requestId && <p>定位编号：{requestId}</p>}
          {workspaceErrorActions && sessionExpired && <button className="text-button" type="button" onClick={() => window.dispatchEvent(new Event('workspace-login-expired'))}>重新登录并保留草稿</button>}
          {workspaceErrorActions && !savedResult && <button className="text-button" type="button" onClick={() => { rememberClientError(error, requestId); requestErrorFeedback() }}>反馈此问题</button>}
        </div>
      )}
      {writeUnavailable&&<button type="button" className="button secondary" onClick={()=>void navigator.clipboard.writeText(JSON.stringify(draft.snapshot(),null,2))}>复制保留的本地输入</button>}
      <footer className="form-footer">
        {onCancel && (
          <button
            type="button"
            className="button secondary"
            onClick={() => { if (allowDraftLeave(formRef.current)) onCancel() }}
            disabled={busy}
          >
            取消
          </button>
        )}
        {savedResult ? <button type="button" className="button primary" disabled={busy} onClick={async () => {
          if (sending.current) return
          sending.current = true; setBusy(true)
          try { await savedResult.retry(); const nextVersion=savedResult.savedVersion ?? latestEditVersion.current; clearDraft(nextVersion); if(nextVersion!==undefined)setVersion(nextVersion); setError(''); setSavedResult(null) }
          catch { setError('内容已保存，重新加载仍未成功。请保留此页面并稍后重试。') }
          finally { sending.current = false; setBusy(false) }
        }}>重新加载已保存结果</button> : <button type="submit" className="button primary" disabled={busy || writeUnavailable || !!comparison}>
          {busy && <LoaderCircle className="spin" size={16} />}{' '}
          {busy ? '正在保存…' : submitLabel}
        </button>}
      </footer>
    </form>
  )
}
export function useAction(
  refresh: () => Promise<void>,
  notify: (message: string) => void,
) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  async function run(action: () => Promise<unknown>, message: string) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await action()
      await refresh()
      notify(message)
    } catch (e) {
      setError(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }
  return { busy, error, run }
}
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}
export function monday(date = new Date()) {
  const d = new Date(date)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  return localDate(d)
}
export function addDays(date: string, amount: number) {
  const d = new Date(`${date}T12:00:00`)
  d.setDate(d.getDate() + amount)
  return localDate(d)
}
export const currentMonth = () => localDate().slice(0, 7)
export const nameOf = (data: Bootstrap, id: string) =>
  accountDisplayName(data.users.find((user) => user.id === id))
export const projectOf = (data: Bootstrap, id: string | null) =>
  data.projects.find((project) => project.id === id)?.name || '部门工作'
export const dateTime = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { hour12: false })
