import { Component, type ErrorInfo, type ReactNode } from 'react'
import { rememberClientError, requestErrorFeedback } from '../error-context'
import { PageModuleLoadError } from '../lazy-resource'

export default class PageErrorBoundary extends Component<{ children: ReactNode; onRetry?: () => void; onReload?: () => void; renderFallback?: (children: ReactNode) => ReactNode }, { failed: boolean; moduleFailed: boolean; reloadRequired: boolean; reference: string }> {
  state = { failed: false, moduleFailed: false, reloadRequired: false, reference: '' }
  static getDerivedStateFromError(error: Error) { return { failed: true, moduleFailed: error instanceof PageModuleLoadError, reloadRequired: error instanceof PageModuleLoadError && error.reloadRequired } }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    const reference = `UI-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    this.setState({ reference })
    rememberClientError('页面显示异常', reference)
    // No business text, component props or screen capture is collected automatically.
    console.error('页面显示异常，定位编号：', reference)
  }
  render() {
    if (!this.state.failed) return this.props.children
    const fallback = <section className="empty" role="alert">
      <h2>{this.state.moduleFailed ? '页面资源加载失败' : '此页面暂时无法显示'}</h2>
      <p>{this.state.moduleFailed ? '请检查网络后重试。若系统刚刚更新，可刷新以获取最新页面。' : '可以重新打开页面，或把问题反馈给管理者。已提交的内容仍保存在系统中。'}</p>
      <p>定位编号：{this.state.reference || '正在生成'}</p>
      <div className="header-actions">
        <button className="button primary" onClick={() => {
          if (this.state.reloadRequired && this.props.onReload) { this.props.onReload(); return }
          this.props.onRetry?.(); this.setState({ failed: false, moduleFailed: false, reloadRequired: false, reference: '' })
        }}>{this.state.reloadRequired && this.props.onReload ? '刷新页面并重试' : this.state.moduleFailed ? '重试加载' : '重新打开页面'}</button>
        {this.state.moduleFailed && !this.state.reloadRequired && this.props.onReload && <button className="button secondary" onClick={this.props.onReload}>刷新页面</button>}
        <button className="button secondary" onClick={requestErrorFeedback}>反馈此问题</button>
      </div>
    </section>
    return this.props.renderFallback ? this.props.renderFallback(fallback) : fallback
  }
}
