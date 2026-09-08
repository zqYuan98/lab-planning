import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
  type FormEvent,
} from 'react'
import { X, Inbox, LoaderCircle } from 'lucide-react'
import type { Bootstrap } from '../shared/types'
import type { NavigationIntent } from './navigation'

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
  closeRef.current = onClose
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    ref.current
      ?.querySelector<HTMLElement>('input,select,textarea,button')
      ?.focus()
    function key(event: KeyboardEvent) {
      if (event.key === 'Escape') closeRef.current()
      if (event.key === 'Tab') {
        const nodes = Array.from(
          ref.current?.querySelectorAll<HTMLElement>(
            'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),a[href]',
          ) || [],
        )
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
        if (event.target === event.currentTarget) onClose()
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
            onClick={onClose}
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
}: {
  onSubmit: (event: FormEvent<HTMLFormElement>) => Promise<void>
  children: ReactNode
  submitLabel?: string
  onCancel?: () => void
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('')
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault()
        if (busy) return
        setBusy(true)
        setError('')
        try {
          await onSubmit(event)
        } catch (e) {
          setError(e instanceof Error ? e.message : '操作失败')
        } finally {
          setBusy(false)
        }
      }}
    >
      <fieldset disabled={busy} className="form-fields">
        {children}
      </fieldset>
      {error && (
        <div className="error" role="alert">
          {error}
        </div>
      )}
      <footer className="form-footer">
        {onCancel && (
          <button
            type="button"
            className="button secondary"
            onClick={onCancel}
            disabled={busy}
          >
            取消
          </button>
        )}
        <button type="submit" className="button primary" disabled={busy}>
          {busy && <LoaderCircle className="spin" size={16} />}{' '}
          {busy ? '正在保存…' : submitLabel}
        </button>
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
  data.users.find((user) => user.id === id)?.name || '未指定'
export const projectOf = (data: Bootstrap, id: string | null) =>
  data.projects.find((project) => project.id === id)?.name || '部门工作'
export const dateTime = (value: string) =>
  new Date(value).toLocaleString('zh-CN', { hour12: false })
