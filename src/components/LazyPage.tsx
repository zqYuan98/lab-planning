import { createContext, createElement, Suspense, useContext, useState, type ComponentType, type ReactNode } from 'react'
import { createLazyResource } from '../lazy-resource'
import PageErrorBoundary from './PageErrorBoundary'

/** App supplies the same draft/unsaved-report protection used by navigation. */
export const PageReloadContext = createContext<(() => void) | undefined>(undefined)

export function retryableLazy<Props extends object>(importer: () => Promise<{ default: ComponentType<Props> }>, options?: { fallback: (children: ReactNode, props: Props) => ReactNode }) {
  const resource = createLazyResource(importer)
  return function LazyPage(props: Props) {
    const [attempt, setAttempt] = useState(0)
    const onReload = useContext(PageReloadContext)
    const renderFallback = options ? (children: ReactNode) => options.fallback(children, props) : undefined
    const loading = <div role="status" aria-live="polite"><p>正在加载页面资源…</p></div>
    return <PageErrorBoundary key={attempt} onReload={onReload} renderFallback={renderFallback} onRetry={() => {
      resource.retry()
      setAttempt(value => value + 1)
    }}>
      <Suspense fallback={renderFallback ? renderFallback(loading) : loading}>
        {createElement(resource.component, props)}
      </Suspense>
    </PageErrorBoundary>
  }
}
