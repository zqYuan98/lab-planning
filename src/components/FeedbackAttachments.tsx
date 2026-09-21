import { useEffect, useRef, useState } from 'react'
import { ImagePlus, X } from 'lucide-react'
import type { FeedbackAttachmentInput } from '../../shared/feedback'
import { feedbackAttachmentLimits } from '../../shared/feedback'
import { filesFromTransfer, hasTransferredFiles } from '../import-input'
import { feedbackError, feedbackImage, feedbackImageUrl } from '../feedback-draft'

export default function FeedbackAttachments({ value, onChange, disabled = false, onBusyChange }: {
  value: FeedbackAttachmentInput[]; onChange: (value: FeedbackAttachmentInput[]) => void; disabled?: boolean; onBusyChange?: (busy: boolean) => void
}) {
  const [error, setError] = useState(''), [reading, setReading] = useState(false), [dragging, setDragging] = useState(false), [preview, setPreview] = useState<number | null>(null)
  const current = useRef(value), busy = useRef(false), input = useRef<HTMLInputElement>(null), section = useRef<HTMLElement>(null)
  current.current = value
  async function add(files: File[], issues: string[] = []) {
    if (disabled || busy.current) return
    busy.current = true; setReading(true); onBusyChange?.(true); setError('')
    const added = [...current.current], messages = [...issues]
    try {
      for (const file of files) {
        if (added.length >= feedbackAttachmentLimits.count) { messages.push('每次最多上传 3 张截图，请先移除多余图片。'); break }
        try {
          const image = await feedbackImage(file)
          if (added.some(item => item.mimeType === image.mimeType && item.dataBase64 === image.dataBase64)) continue
          added.push(image)
        } catch (error) { messages.push(feedbackError(error)) }
      }
      current.current = added; onChange(added)
      setError(messages.join(' '))
    } finally { busy.current = false; setReading(false); onBusyChange?.(false) }
  }
  useEffect(() => {
    const form = section.current?.closest('form')
    if (!form) return
    const paste = (event: ClipboardEvent) => {
      if (disabled || !event.clipboardData || !hasTransferredFiles(event.clipboardData)) return
      event.preventDefault(); event.stopPropagation()
      const result = filesFromTransfer(event.clipboardData)
      void add(result.files, result.issues)
    }
    // Screenshots can be pasted while the description textarea has focus.
    form.addEventListener('paste', paste)
    return () => form.removeEventListener('paste', paste)
  }, [disabled, onChange])
  return <section ref={section} className={`feedback-attachments-editor${dragging ? ' is-dragging' : ''}`} aria-label="反馈截图"
    onDragOver={event => { if (!disabled && hasTransferredFiles(event.dataTransfer)) { event.preventDefault(); setDragging(true) } }}
    onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false) }}
    onDrop={event => {
      event.preventDefault(); setDragging(false)
      if (disabled) return
      const result = filesFromTransfer(event.dataTransfer)
      void add(result.files, result.issues)
    }}>
    <div className="feedback-upload-zone" tabIndex={disabled ? -1 : 0} role="group" aria-label="在此粘贴或拖入截图">
      <ImagePlus size={23} />
      <div><strong>添加截图（选填）</strong><p>在此粘贴或拖入图片，也可选择照片。最多 3 张，单张不超过 2 MiB。</p></div>
      <button type="button" className="button secondary" disabled={disabled || reading || value.length >= 3} onClick={() => input.current?.click()}>选择截图</button>
      <input ref={input} className="feedback-file-input" type="file" accept="image/png,image/jpeg,image/webp" multiple tabIndex={-1} aria-label="选择反馈截图" disabled={disabled || reading} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ''; void add(files) }} />
    </div>
    {reading && <p role="status" className="form-hint">正在读取截图，请稍候…</p>}
    {value.length > 0 && <div className="feedback-image-grid">{value.map((file, index) => <figure key={`${index}-${file.name}`}>
      <button type="button" className="feedback-image-open" onClick={() => setPreview(preview === index ? null : index)} aria-label={`查看截图 ${index + 1}：${file.name}`} aria-expanded={preview === index}><img src={feedbackImageUrl(file)} alt={`待提交截图 ${index + 1}：${file.name}`} /></button>
      <figcaption>{file.name}</figcaption><button className="icon-button feedback-remove-image" type="button" aria-label={`移除截图 ${index + 1}`} disabled={disabled || reading} onClick={() => { setPreview(null); onChange(value.filter((_, position) => position !== index)) }}><X size={16} /></button>
    </figure>)}</div>}
    {preview !== null && value[preview] && <div className="feedback-image-expanded"><button className="text-button" type="button" onClick={() => setPreview(null)}>收起预览</button><img src={feedbackImageUrl(value[preview])} alt={`截图完整预览：${value[preview].name}`} /></div>}
    {error && <p className="error" role="alert">{error}</p>}
  </section>
}
