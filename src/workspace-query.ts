import { useEffect, useRef, useState } from 'react'
import type { Bootstrap } from '../shared/types'
import type { WorkspaceShellData } from '../shared/workspace-query'
import { api } from './api'
import { MutationContextChangedError } from './mutation-response'
import { workspaceQueryReader } from './workspace-query-state'
import { queryAffected } from './query-invalidation'
import { subscribeWorkspaceRefresh } from './workspace-refresh'

/** Shell state carries identity/configuration only; each page owns its queried collections. */
export function shellBootstrap(shell: WorkspaceShellData, _previous?: Bootstrap | null): Bootstrap {
  return { users: [shell.user], projects: [], plans: [], tasks: [], weeklyRecords: [], annualGoals: [], publications: [], reports: [], user: shell.user, operationEpoch: shell.operationEpoch, accessScopeVersion: shell.accessScopeVersion, aiConfigured: shell.aiConfigured }
}
/** Query/identity changes cancel and invalidate old reads; mutation receipts survive refresh failures. */
export function useWorkspaceQuery<T>(path: string, scope: string, mergeMutation?: (value: T, receipt: unknown) => T, options?: { onCursorStale?: () => string }) {
  const [value, setValue] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const [accessRevoked, setAccessRevoked] = useState(false)
  const read = useRef<ReturnType<typeof workspaceQueryReader<T>> | null>(null), merge = useRef(mergeMutation)
  const cursorRecovery = useRef(options?.onCursorStale)
  const activePath = useRef(path), activeScope = useRef(scope), acceptedPath = useRef(''), acceptedScope = useRef('')
  merge.current = mergeMutation
  cursorRecovery.current = options?.onCursorStale
  useEffect(() => {
    activePath.current = path
    activeScope.current = scope; acceptedPath.current = ''; acceptedScope.current = ''
    setValue(null); setAccessRevoked(false)
    const reader = workspaceQueryReader<T>({
      load: signal => api<T>(activePath.current, { signal }),
      accept: result => { acceptedPath.current = activePath.current; acceptedScope.current = activeScope.current; setValue(result); setAccessRevoked(false) },
      clear: () => { setValue(null); setAccessRevoked(true) },
      recoverQuery: () => {
        if (!cursorRecovery.current || !new URLSearchParams(activePath.current.split('?')[1]).has('cursor')) return false
        const nextPath = cursorRecovery.current()
        if (nextPath === activePath.current || new URLSearchParams(nextPath.split('?')[1]).has('cursor')) return false
        // Same filters, new pagination boundary: keep the previous projection mounted
        // until its replacement arrives. A transport failure must not erase drafts.
        activePath.current = nextPath; acceptedPath.current = nextPath; setAccessRevoked(false)
        return true
      },
      ...(mergeMutation ? { merge: (value: T, receipt: unknown) => merge.current ? merge.current(value,receipt) : value } : {}),
      affected: mutationPath => queryAffected(activePath.current, mutationPath),
      error: failure => setError(failure instanceof Error ? failure.message : ''), loading: setLoading,
    })
    read.current = reader
    void reader.read().catch(() => {})
    // Workspace collections keep editor snapshots independently. Settings/review forms
    // keyed by live versions (including the submission-reference dependent read)
    // deliberately remain explicit refreshes.
    const unsubscribeRefresh = subscribeWorkspaceRefresh(() => {
      const endpoint = activePath.current.split('?')[0]
      if (endpoint.startsWith('/workspace/') && endpoint !== '/workspace/weekly/submission-references') void reader.revalidate().catch(() => {})
    })
    return () => { unsubscribeRefresh(); reader.dispose(); if (read.current === reader) read.current = null }
  }, [scope])
  useEffect(() => {
    if (activePath.current === path) return
    activePath.current = path
    read.current?.resetQuery()
    setValue(null); setAccessRevoked(false)
    void read.current?.read().catch(() => {})
  }, [path, scope])
  const current = acceptedPath.current === path && acceptedScope.current === scope, matchingQuery = activeScope.current === scope && activePath.current === path
  return { value: current ? value : null, error: matchingQuery ? error : '', loading: matchingQuery ? loading : true, accessRevoked: matchingQuery ? accessRevoked : false, reload: (nextPath?: string) => {
    if (nextPath && activePath.current !== nextPath) { activePath.current = nextPath; read.current?.resetQuery(); setValue(null); setAccessRevoked(false) }
    return read.current?.read() ?? Promise.reject(new MutationContextChangedError())
  } }
}
