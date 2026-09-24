import { useEffect, useRef, useState } from 'react'
import { collectDraftValues, draftStorageFailureNotice, draftStorageKey, parseFormDraft, persistFormDraft, setActiveDraft, type DraftValues } from './draft-recovery'
import { discoverDraft, draftIdentity, draftV3Key, saveDraftV3, type DiscoveredDraft } from './draft-v3'

function controls(form: HTMLFormElement) {
  return Array.from(form.elements).filter((node): node is HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement =>
    (node instanceof HTMLInputElement || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement) && !node.closest('[data-draft-ignore]'))
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
  // A refresh must not replace the baseline of an editor with unsaved input.
  const stableKey=useRef(key)
  if(stableKey.current?.replace(/:v\d+$/,'')!==key?.replace(/:v\d+$/,''))stableKey.current=key
  key=stableKey.current
  const formRef = useRef<HTMLFormElement>(null)
  const token = useRef(Symbol('form-draft'))
  const callbacks = useRef({ context, onRestore }); callbacks.current = { context, onRestore }
  const [notice, setNotice] = useState('')
  const [recovery, setRecovery] = useState<DiscoveredDraft | null>(null)
  const initialValues = useRef<DraftValues>({})
  const recoveredKeys = useRef<string[]>([])
  const rebasedVersion=useRef<number|undefined>(undefined)
  const state = useRef({ dirty: false, busy, persisted: false })
  state.current.busy = busy
  const ready = useRef(false)
  const baseline = useRef('')
  const cached = useRef<DraftValues>({})
  const visibleControls = useRef(new WeakMap<Element, string>())
  const restoreFrame = useRef<number | undefined>(undefined)
  const publish = () => { if (key && formRef.current) setActiveDraft(token.current, { form: formRef.current, ...state.current }) }
  const value = () => ({ ...cached.current, ...readValues(formRef.current!), ...callbacks.current.context })
  function rememberDraft() {
    if (!key || !formRef.current || !ready.current) return
    const values = value()
    cached.current = values
    state.current.dirty = JSON.stringify(values) !== baseline.current
    try {
      if (state.current.dirty) {
        const identity = draftIdentity(key)
        if(identity&&rebasedVersion.current!==undefined)identity.baseVersion=rebasedVersion.current
        if(identity&&!recoveredKeys.current.includes(draftV3Key(identity)))recoveredKeys.current.push(draftV3Key(identity))
        const result = identity ? { persisted: saveDraftV3(sessionStorage, identity, initialValues.current, values), notice: '草稿已保存在当前标签页，尚未提交。' } : persistFormDraft(sessionStorage, key, values)
        if (!result.persisted) result.notice = draftStorageFailureNotice
        state.current.persisted = result.persisted
        setNotice(result.notice)
      } else {
        sessionStorage.removeItem(draftStorageKey(key))
        const identity = draftIdentity(key); if (identity) sessionStorage.removeItem(draftV3Key(identity))
        state.current.persisted = true
        setNotice('')
      }
    } catch {
      state.current.persisted = false
      setNotice(draftStorageFailureNotice)
    }
    publish()
  }
  function clearDraft(version?:number) {
    if (!key) return
    state.current.dirty = false
    if (formRef.current) { initialValues.current=value(); baseline.current = JSON.stringify(initialValues.current) }
    if(version!==undefined)rebasedVersion.current=version
    try { sessionStorage.removeItem(draftStorageKey(key)); const identity=draftIdentity(key); if(identity)sessionStorage.removeItem(draftV3Key(identity)); for(const restoredKey of recoveredKeys.current)sessionStorage.removeItem(restoredKey) } catch { /* Submission is already saved. */ }
    setNotice(''); publish()
  }
  useEffect(() => {
    if (!key || !formRef.current) return
    ready.current = false
    state.current.dirty = false
    state.current.persisted = false
    recoveredKeys.current = []
    cached.current = {}
    visibleControls.current = new WeakMap()
    baseline.current = JSON.stringify(value())
    initialValues.current = value()
    rebasedVersion.current=undefined
    setRecovery(null)
    let frame = 0
    try {
      const identity = draftIdentity(key)
      const found = identity ? discoverDraft(sessionStorage, identity, key) : null
      const raw = sessionStorage.getItem(draftStorageKey(key))
      const draft = found || parseFormDraft(raw)
      if (found) recoveredKeys.current.push(found.storageKey)
      if (found && (found.baseVersion !== identity?.baseVersion || found.operationEpoch !== identity?.operationEpoch || !found.baseValues)) {
        setRecovery(found); setNotice('发现此表单其他版本的本地草稿，请比较后恢复。'); ready.current = true
      } else
      if (draft) {
        if(found?.baseValues)initialValues.current=found.baseValues
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
    return () => { ready.current=false; cancelAnimationFrame(frame); if(restoreFrame.current!==undefined)cancelAnimationFrame(restoreFrame.current); setActiveDraft(token.current, null); window.removeEventListener('beforeunload', beforeUnload) }
  }, [key])
  // Changing a form mode may unmount inputs. Retain their values and restore only
  // controls which have just reappeared, without overwriting fields still being edited.
  useEffect(() => {
    if (key && formRef.current) restoreValues(formRef.current, cached.current, visibleControls.current)
  })
  const contextKey = JSON.stringify(context)
  useEffect(() => { if (ready.current) rememberDraft() }, [contextKey])
  useEffect(publish, [busy, key])
  function applyValues(values:DraftValues, baseValues?:DraftValues, version?:number) {
    if(version!==undefined)rebasedVersion.current=version
    cached.current=values
    if(baseValues)initialValues.current=baseValues
    callbacks.current.onRestore?.(values)
    if(formRef.current)restoreValues(formRef.current,values)
    if(restoreFrame.current!==undefined)cancelAnimationFrame(restoreFrame.current)
    restoreFrame.current=requestAnimationFrame(()=>{if(formRef.current)restoreValues(formRef.current,values);rememberDraft()})
    setRecovery(null)
  }
  return { formRef, rememberDraft, clearDraft, notice, recovery, dismissRecovery:()=>setRecovery(null), applyValues,
    snapshot:()=>formRef.current?value():{}, baseValues:()=>initialValues.current }
}
