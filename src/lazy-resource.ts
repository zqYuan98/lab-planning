import { lazy, type ComponentType } from 'react'

export class PageModuleLoadError extends Error {
  constructor(readonly reloadRequired = false) { super('页面资源加载失败'); this.name = 'PageModuleLoadError' }
}

/** Keep successful module identities stable, but discard React's cached rejected lazy value. */
export function createLazyResource<Props extends object>(importer: () => Promise<{ default: ComponentType<Props> }>) {
  let failed = false
  let reloadRequired = false
  let pending: ReturnType<typeof importer> | undefined
  const load = () => pending ??= Promise.resolve().then(importer).catch(error => {
    failed = true
    // Vite remembers failed CSS preloads; browsers also retain failed module fetches.
    // A new React.lazy value cannot clear either cache. The shell's explicit reload
    // action checks drafts first and also obtains current chunk URLs after a release.
    reloadRequired = error instanceof Error && (
      error.message.startsWith('Unable to preload CSS for ')
      || /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i.test(error.message)
    )
    // Do not retain a URL, component props or business content in error telemetry.
    throw new PageModuleLoadError(reloadRequired)
  })
  let component = lazy(load)
  return {
    load,
    get component() { return component },
    retry() {
      if (!failed || reloadRequired) return
      failed = false
      pending = undefined
      component = lazy(load)
    },
  }
}
