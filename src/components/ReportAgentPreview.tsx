import { useEffect, useRef, useState } from 'react'
import { Download, RefreshCw } from 'lucide-react'

/** Loaded only when a manager opens a preview; the document is never executable HTML. */
export default function ReportAgentPreview({ url, title }: { url: string; title: string }) {
  const host = useRef<HTMLDivElement>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let active = true
    setLoading(true)
    setError('')
    host.current?.replaceChildren()
    async function render() {
      try {
        const [response, { renderAsync }] = await Promise.all([
          fetch(url, { credentials: 'same-origin', signal: controller.signal }),
          import('docx-preview'),
        ])
        if (!response.ok) throw new Error(response.status === 401 ? '登录已过期，请重新登录后预览。' : '无法读取 Word 文件，请重试。')
        const bytes = await response.blob()
        if (!active) return
        // Render off-screen so an obsolete request cannot replace a newer preview.
        const container = document.createElement('div')
        const styles = document.createElement('div')
        await renderAsync(bytes, container, styles, {
          className: 'agent-word-page', inWrapper: true, ignoreWidth: false,
          ignoreHeight: false, breakPages: true, renderHeaders: true,
          renderFooters: true, renderComments: false, renderChanges: false,
          renderAltChunks: false, useBase64URL: true,
        })
        if (active) host.current?.replaceChildren(styles, container)
      } catch (failure) {
        if (active && !(failure instanceof Error && failure.name === 'AbortError')) {
          setError(failure instanceof Error ? failure.message : '网页预览失败，请下载 Word 核对。')
        }
      } finally { if (active) setLoading(false) }
    }
    void render()
    return () => { active = false; controller.abort() }
  }, [url, attempt])
  return <section className="agent-preview" aria-label={title}>
    <div className="agent-toolbar">
      <div><strong>{title}</strong><p className="agent-note">网页为近似预览，分页与字体以 Word 客户端为准。请下载核对表格、页眉页脚、长文字和换页。</p></div>
      <a className="button secondary" href={url} download><Download size={16} />下载 Word</a>
    </div>
    {loading && <p role="status">正在载入 Word 预览…</p>}
    {error && <div role="alert" className="error">{error}<button type="button" className="button secondary" onClick={() => setAttempt(value => value + 1)}><RefreshCw size={15} />重试预览</button></div>}
    <div className="agent-preview-scroll" ref={host} aria-busy={loading} onClick={event => {
      // Preview links are content from a document, not application navigation.
      if ((event.target as Element).closest('a')) event.preventDefault()
    }} />
  </section>
}
