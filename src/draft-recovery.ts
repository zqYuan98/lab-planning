export type DraftValues = Record<string, string | string[]>
export interface DraftControl { name: string; type: string; value: string; checked?: boolean; selectedValues?: string[] }
export interface SavedFormDraft { schema: 2; savedAt: number; values: DraftValues }
// The full serialized envelope must fit this limit on both write and restore.
export const FORM_DRAFT_MAX_CHARS = 4 * 1024 * 1024
const lifetime = 7 * 24 * 60 * 60 * 1000
export const draftStorageKey = (key: string) => `workspace-draft:v2:${key}`

/** Preserve checkbox groups and multi-selects, including deliberately empty selections. */
export function collectDraftValues(controls: Iterable<DraftControl>): DraftValues {
  const values: DraftValues = Object.create(null)
  for (const control of controls) {
    if (!control.name || ['password', 'file', 'submit', 'button', 'reset', 'hidden'].includes(control.type)) continue
    if (control.type === 'checkbox' || control.type === 'radio') {
      if (!Array.isArray(values[control.name])) values[control.name] = []
      if (control.checked) (values[control.name] as string[]).push(control.value)
    } else if (control.selectedValues) values[control.name] = control.selectedValues
    else values[control.name] = control.value
  }
  return values
}

export function parseFormDraft(raw: string | null, now = Date.now()): SavedFormDraft | null {
  if (!raw || raw.length > FORM_DRAFT_MAX_CHARS) return null
  try {
    const draft = JSON.parse(raw)
    if (draft?.schema !== 2 || typeof draft.savedAt !== 'number' || draft.savedAt > now + 60000 || now - draft.savedAt > lifetime || !draft.values || typeof draft.values !== 'object' || Array.isArray(draft.values)) return null
    for (const [key, value] of Object.entries(draft.values)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || !(typeof value === 'string' || Array.isArray(value) && value.every(v => typeof v === 'string'))) return null
    }
    return draft as SavedFormDraft
  } catch { return null }
}

export interface DraftPersistence { persisted: boolean; notice: string }
type DraftStorage = Pick<Storage, 'setItem' | 'removeItem'>
export const draftStorageFailureNotice = '草稿未备份到浏览器，请保留此页面并及时保存；离开可能丢失输入。'
/** Never claim recovery for bytes the reader would reject, or for a stale backup. */
export function persistFormDraft(storage: DraftStorage, key: string, values: DraftValues, now = Date.now()): DraftPersistence {
  const storageKey = draftStorageKey(key)
  const removeStaleBackup = () => { try { storage.removeItem(storageKey) } catch { /* Storage may be unavailable altogether. */ } }
  try {
    const raw = JSON.stringify({ schema: 2, savedAt: now, values })
    if (!parseFormDraft(raw, now)) {
      removeStaleBackup()
      return { persisted: false, notice: raw.length > FORM_DRAFT_MAX_CHARS
        ? '草稿内容超过浏览器备份上限，尚未备份。请保留此页面并及时保存；离开可能丢失输入。'
        : draftStorageFailureNotice }
    }
    storage.setItem(storageKey, raw)
    return { persisted: true, notice: '草稿已保存在当前标签页，尚未提交。' }
  } catch {
    removeStaleBackup()
    return { persisted: false, notice: draftStorageFailureNotice }
  }
}

export const draftText = (values: DraftValues, key: string) => typeof values[key] === 'string' ? values[key] as string : ''
export const draftChecked = (values: DraftValues, key: string) => Array.isArray(values[key]) && values[key].length > 0

interface ActiveDraft { form: HTMLFormElement; dirty: boolean; busy: boolean; persisted: boolean }
const activeForms = new Map<symbol, ActiveDraft>()
export function setActiveDraft(token: symbol, value: ActiveDraft | null) {
  if (value) activeForms.set(token, value)
  else activeForms.delete(token)
}
export function hasUnsavedForms() { return [...activeForms.values()].some(value => value.dirty || value.busy) }
/** Used by the shell and modal so saved business records never need a redundant confirmation. */
export function allowDraftLeave(container?: Element | null): boolean {
  const forms = [...activeForms.values()].filter(value => !container || container.contains(value.form))
  if (forms.some(value => value.busy)) { window.alert('正在保存，请等待保存结果后再离开。'); return false }
  const dirty = forms.filter(value => value.dirty)
  if (!dirty.length) return true
  return window.confirm(dirty.every(value => value.persisted)
    ? '填写内容尚未提交。草稿已保存在当前浏览器，返回同一表单可恢复。是否离开？'
    : '填写内容尚未提交，且部分草稿无法保存到浏览器。离开可能丢失输入，是否继续？')
}
