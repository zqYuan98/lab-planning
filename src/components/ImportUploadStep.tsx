import { useRef, useState } from 'react'
import { FileInput, FileText, Upload } from 'lucide-react'
import { filesFromTransfer, hasTransferredFiles } from '../import-input'
import { Field } from '../ui'

export interface UploadResult {
  name: string
  status: 'waiting' | 'uploading' | 'saved' | 'failed'
  error?: string
}

interface Props {
  busy: boolean
  draggingFiles: boolean
  uploadResults: UploadResult[]
  upload: (files: File[], issues?: string[]) => Promise<void>
  run: (label: string, action: () => Promise<void>) => Promise<void>
  saveText: (text: string) => Promise<void>
}

export default function ImportUploadStep({ busy, draggingFiles, uploadResults, upload, run, saveText }: Props) {
  const [pasted, setPasted] = useState('')
  const [showPaste, setShowPaste] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const pasteInput = useRef<HTMLTextAreaElement>(null)
  return (
    <section
      className={`import-upload panel${draggingFiles ? ' is-dragging' : ''}`}
      tabIndex={0}
      aria-label="文件拖放与粘贴导入区域"
      aria-describedby="import-upload-help"
      aria-busy={!!busy}
      onPaste={(event) => {
        if (!hasTransferredFiles(event.clipboardData)) return
        event.preventDefault()
        const { files, issues } = filesFromTransfer(event.clipboardData)
        void upload(files, issues)
      }}
    >
      <div className="import-upload-copy">
        <span className="import-upload-icon">
          <FileInput size={28} strokeWidth={1.6} />
        </span>
        <div>
          <h2>从现有资料开始</h2>
          <p id="import-upload-help">将文件或图片拖到此页，或点击此区域后按 Ctrl / ⌘ + V 粘贴截图。</p>
          <small>
            支持 XLSX、CSV、TSV、TXT、PNG、JPG、WebP。钉钉表格可先导出为
            Excel。支持多文件，每个文件单独建立批次，单个文件最大 10 MB。
          </small>
        </div>
      </div>
      <div className="import-upload-actions">
        <input
          ref={fileInput}
          className="import-file-input"
          type="file"
          multiple
          accept=".xlsx,.csv,.tsv,.txt,.png,.jpg,.jpeg,.webp"
          aria-label="选择导入文件"
          disabled={!!busy}
          onChange={(event) => {
            const files = Array.from(event.target.files || [])
            event.target.value = ''
            if (files.length) void upload(files)
          }}
        />
        <button
          className="button primary"
          disabled={!!busy}
          onClick={() => fileInput.current?.click()}
        >
          <Upload size={16} />
          上传文件
        </button>
        <button
          className="button secondary"
          disabled={!!busy}
          onClick={() => {
            setShowPaste((value) => !value)
            if (!showPaste) window.setTimeout(() => pasteInput.current?.focus(), 0)
          }}
        >
          <FileText size={16} />
          粘贴内容
        </button>
      </div>
      {draggingFiles && (
        <div className="import-drop-status" role="status">
          <Upload size={18} />
          {busy ? '当前操作进行中，请稍后重新拖入文件' : '松开即可保存文件或图片，支持一次拖入多个文件'}
        </div>
      )}
      {uploadResults.length > 0 && (
        <ul className="import-upload-results" aria-label="文件处理结果" aria-live="polite">
          {uploadResults.map((result, index) => (
            <li key={index} className={result.status === 'failed' ? 'has-error' : ''}>
              <span>{result.name}</span>
              <small>
                {result.status === 'waiting' ? '等待保存' : result.status === 'uploading' ? '正在保存…' : result.status === 'saved' ? '已保存为导入批次' : result.error}
              </small>
            </li>
          ))}
        </ul>
      )}
      {showPaste && (
        <div className="import-paste">
          <Field label="粘贴表格或工作记录">
            <textarea
              ref={pasteInput}
              rows={6}
              disabled={!!busy}
              value={pasted}
              onChange={(event) => setPasted(event.target.value)}
              placeholder="直接粘贴 Excel 单元格、钉钉工作记录或旧计划文字；粘贴截图或文件会直接保存为导入批次…"
            />
          </Field>
          <button
            className="button primary"
            disabled={!!busy || !pasted.trim()}
            onClick={() =>
              void run('正在保存文字资料', async () => {
                await saveText(pasted)
                setPasted('')
                setShowPaste(false)
              })
            }
          >
            保存并准备解析
          </button>
        </div>
      )}
    </section>
  )
}
