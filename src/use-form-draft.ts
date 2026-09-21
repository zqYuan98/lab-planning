import { useEffect, useRef, useState } from 'react'
import { collectDraftValues, draftStorageKey, parseFormDraft, setActiveDraft, type DraftValues } from './draft-recovery'

function controls(form: HTMLFormElement) {
  return Array.from(form.elements).filter((node): node is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement)
}
function readValues(form: HTMLFormElement): DraftValues {
  return collectDraftValues(controls(form).map(node => ({ name: node.name, type: node.type, value: node.value,
    checked: node instanceof HTMLInputElement ? node.checked : undefined,
    selectedValues: node instanceof HTMLSelectElement && node.multiple ? Array.from(node.selectedOptions).map(option => option.value) : undefined })))
}
function restoreValues(form: HTMLFormElement, values: DraftValues, newlyVisible?: WeakMap<Element, string>) {
  for (const node of controls(form)) {
    if (newlyVisible) {
      const previousName = newlyVisible.get(node)
      newlyVisible.set(node, node.name)
      if (previousName === node.name) continue
    }
    if (!node.name || !Object.hasOwn(values, node.name) || ['password', 'file', 'hidden'].includes(node.type)) continue
    const value = values[node.name]
    if (node instanceof HTMLInputElement && ['checkbox', 'radio'].includes(node.type)) node.checked = Array.isArray(value) && value.includes(node.value)
    else if (node instanceof HTMLSelectElement) {
      const selected = Array.isArray(value) ? value : [value]
      // Never restore a deleted/inaccessible option by manufacturing an option.
      for (const option of Array.from(node.options)) option.selected = selected.includes(option.value)
    } else if (typeof value === 'string') node.value = value
  }
}

export function useFormDraft(key: string | undefined, context?: DraftValues, onRestore?: (values: DraftValues) => void, busy = false) {
  const formRef = useRef<HTMLFormElement>(null)
  const token = useRef(Symbol('form-draft'))
  const callbacks = useRef({ context, onRestore }); callbacks.current = { context, onRestore }
  const [notice, setNotice] = useState('')
  const state = useRef({ dirty: false, busy, persisted: false })
  state.current.busy = busy
  const ready = useRef(false)
  const baseline = useRef('')
  const cached = useRef<DraftValues>({})
  const visibleControls = useRef(new WeakMap<Element, string>())
  const publish = () => { if (key && formRef.current) setActiveDraft(token.current, { form: formRef.current, ...state.current }) }
  const value = () => ({ ...cached.current, ...readValues(formRef.current!), ...callbacks.current.context })
  function rememberDraft() {
    if (!key || !formRef.current || !ready.current) return
    const values = value()
    cached.current = values
    state.current.dirty = JSON.stringify(values) !== baseline.current
    try {
      if (state.current.dirty) sessionStorage.setItem(draftStorageKey(key), JSON.stringify({ schema: 2, savedAt: Date.now(), values }))
      else sessionStorage.removeItem(draftStorageKey(key))
      state.current.persisted = true
      setNotice(state.current.dirty ? '草稿已保存在当前标签页，尚未提交。' : '')
    } catch {
      state.current.persisted = false
      setNotice('浏览器无法保存草稿，请保留此页面并及时提交。')
    }
    publish()
  }
  function clearDraft() {
    if (!key) return
    state.current.dirty = false
    if (formRef.current) baseline.current = JSON.stringify(value())
    try { sessionStorage.removeItem(draftStorageKey(key)) } catch { /* Submission is already saved. */ }
    setNotice(''); publish()
  }
  useEffect(() => {
    if (!key || !formRef.current) return
    ready.current = false
    cached.current = {}
    visibleControls.current = new WeakMap()
    baseline.current = JSON.stringify(value())
    let frame = 0
    try {
      const draft = parseFormDraft(sessionStorage.getItem(draftStorageKey(key)))
      if (draft) {
        cached.current = draft.values
        callbacks.current.onRestore?.(draft.values)
        restoreValues(formRef.current, draft.values)
        state.current.dirty = true; state.current.persisted = true
        setNotice('已恢复此标签页中未提交的草稿，请核对后保存。')
        // Controlled selections may reveal additional fields on the next React render.
        frame = requestAnimationFrame(() => {
          if (formRef.current) restoreValues(formRef.current, draft.values)
          ready.current = true; publish()
        })
      } else ready.current = true
    } catch { ready.current = true; setNotice('浏览器无法读取草稿，请及时保存。') }
    publish()
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (state.current.dirty || state.current.busy) { event.preventDefault(); event.returnValue = '' }
    }
    window.addEventListener('beforeunload', beforeUnload)
    return () => { cancelAnimationFrame(frame); setActiveDraft(token.current, null); window.removeEventListener('beforeunload', beforeUnload) }
  }, [key])
  // Changing a form mode may unmount inputs. Retain their values and restore only
  // controls which have just reappeared, without overwriting fields still being edited.
  useEffect(() => {
    if (key && formRef.current) restoreValues(formRef.current, cached.current, visibleControls.current)
  })
  const contextKey = JSON.stringify(context)
  useEffect(() => { if (ready.current) rememberDraft() }, [contextKey])
  useEffect(publish, [busy, key])
  return { formRef, rememberDraft, clearDraft, notice }
}
