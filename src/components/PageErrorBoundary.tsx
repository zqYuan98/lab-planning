import { Component, type ErrorInfo, type ReactNode } from 'react'
import { rememberClientError, requestErrorFeedback } from '../error-context'

export default class PageErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean; reference: string }> {
  state = { failed: false, reference: '' }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    const reference = `UI-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.setState({ reference })
    rememberClientError('页面显示异常', reference)
    // No business text, component props or screen capture is collected automatically.
    console.error('页面显示异常，定位编号：', reference)
  }
  render() {
    if (!this.state.failed) return this.props.children
    return <section className="empty" role="alert">
      <h2>此页面暂时无法显示</h2>
      <p>可以重新打开页面，或把问题反馈给管理者。已提交的内容仍保存在系统中。</p>
      <p>定位编号：{this.state.reference || '正在生成'}</p>
      <div className="header-actions">
        <button className="button primary" onClick={() => this.setState({ failed: false, reference: '' })}>重新打开页面</button>
        <button className="button secondary" onClick={requestErrorFeedback}>反馈此问题</button>
      </div>
    </section>
  }
}
