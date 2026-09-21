import { useCallback, useEffect, useRef, useState, type SetStateAction } from 'react'
import { feedbackDraftKey, readFeedbackDraft, removeFeedbackDraft, writeFeedbackDraft } from '../feedback-draft'

/** The component must be keyed by account and target. Writes stay ordered, even while closing. */
export function useFeedbackDraft<T>(userId: string, target: string, initialValue: () => T, hasContent: (value: T) => boolean) {
  const [value, setValue] = useState(initialValue)
  const valueRef = useRef(value), initial = useRef(initialValue), meaningful = useRef(hasContent)
  const [ready, setReady] = useState(false), [restored, setRestored] = useState(false)
  const [storageError, setStorageError] = useState(''), [saving, setSaving] = useState(false)
  const key = feedbackDraftKey(userId, target), queue = useRef(Promise.resolve(true)), sequence = useRef(0), live = useRef(true)
  meaningful.current = hasContent
  useEffect(() => {
    live.current = true
    let active = true
    void readFeedbackDraft<T>(key).then(saved => {
      if (!active) return
      if (saved) { valueRef.current = saved; setValue(saved); setRestored(true) }
    }).catch(() => {
      if (active) setStorageError('当前浏览器无法读取本地草稿。此次输入仍可提交；关闭或刷新可能丢失内容，请先复制重要文字。')
    }).finally(() => { if (active) setReady(true) })
    return () => { active = false; live.current = false }
  }, [key])
  const persist = useCallback((next: T, clear = false) => {
    const revision = ++sequence.current
    if (live.current) setSaving(true)
    queue.current = queue.current.then(async () => {
      try {
        if (clear || !meaningful.current(next)) await removeFeedbackDraft(key)
        else await writeFeedbackDraft(key, next)
        if (live.current && revision === sequence.current) setStorageError('')
        return true
      } catch {
        if (live.current) setStorageError(clear
          ? '提交已成功，但浏览器未能清除本地草稿。再次打开时请先核对处理记录；原提交编号仍可用于安全重试。'
          : '本地草稿保存失败（浏览器限制或空间不足）。当前内容仍在，请完成提交；关闭或刷新可能丢失文字和截图。')
        return false
      } finally { if (live.current && revision === sequence.current) setSaving(false) }
    })
    return queue.current
  }, [key])
  const update = useCallback((change: SetStateAction<T>) => {
    const next = typeof change === 'function' ? (change as (previous: T) => T)(valueRef.current) : change
    valueRef.current = next; setValue(next)
    void persist(next)
    return next
  }, [persist])
  const reset = useCallback(async (next?: T) => {
    const fresh = next ?? initial.current()
    valueRef.current = fresh; setValue(fresh); setRestored(false)
    return persist(fresh, true)
  }, [persist])
  const flush = useCallback(() => queue.current, [])
  return { value, update, reset, flush, ready, restored, storageError, saving }
}
