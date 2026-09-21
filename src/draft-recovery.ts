export type DraftValues = Record<string, string | string[]>
export interface DraftControl { name: string; type: string; value: string; checked?: boolean; selectedValues?: string[] }
export interface SavedFormDraft { schema: 2; savedAt: number; values: DraftValues }
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
  if (!raw || raw.length > 256 * 1024) return null
  try {
    const draft = JSON.parse(raw)
    if (draft?.schema !== 2 || typeof draft.savedAt !== 'number' || draft.savedAt > now + 60000 || now - draft.savedAt > lifetime || !draft.values || typeof draft.values !== 'object' || Array.isArray(draft.values)) return null
    for (const [key, value] of Object.entries(draft.values)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key) || !(typeof value === 'string' || Array.isArray(value) && value.every(v => typeof v === 'string'))) return null
    }
    return draft as SavedFormDraft
  } catch { return null }
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
