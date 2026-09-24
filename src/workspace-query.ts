import { useEffect, useRef, useState } from 'react'
import type { Bootstrap } from '../shared/types'
import type { WorkspaceShellData } from '../shared/workspace-query'
import { api } from './api'
import { MutationContextChangedError } from './mutation-response'
import { workspaceQueryReader } from './workspace-query-state'

/** The shell has no collection membership. Legacy pages explicitly load /bootstrap. */
export function shellBootstrap(shell: WorkspaceShellData, previous: Bootstrap | null): Bootstrap {
  const sameScope = previous?.user.id === shell.user.id && previous.user.role === shell.user.role && previous.accessScopeVersion === shell.accessScopeVersion && previous.operationEpoch === shell.operationEpoch
  return { ...(sameScope ? previous : { users: [shell.user], projects: [], plans: [], tasks: [], weeklyRecords: [], annualGoals: [], publications: [], reports: [] }), user: shell.user, operationEpoch: shell.operationEpoch, accessScopeVersion: shell.accessScopeVersion, aiConfigured: shell.aiConfigured }
}
/** Query/identity changes cancel and invalidate old reads; mutation receipts survive refresh failures. */
export function useWorkspaceQuery<T>(path: string, scope: string, mergeMutation?: (value: T, receipt: unknown) => T) {
  const [value, setValue] = useState<T | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const [accessRevoked, setAccessRevoked] = useState(false)
  const read = useRef<ReturnType<typeof workspaceQueryReader<T>> | null>(null), merge = useRef(mergeMutation)
  merge.current = mergeMutation
  useEffect(() => {
    setValue(null); setAccessRevoked(false)
    const reader = workspaceQueryReader<T>({
      load: signal => api<T>(path, { signal }),
      accept: result => { setValue(result); setAccessRevoked(false) },
      clear: () => { setValue(null); setAccessRevoked(true) },
      merge: (value, receipt) => merge.current ? merge.current(value,receipt) : value,
      error: failure => setError(failure instanceof Error ? failure.message : ''), loading: setLoading,
    })
    read.current = reader
    void reader.read().catch(() => {})
    return () => { reader.dispose(); if (read.current === reader) read.current = null }
  }, [path, scope])
  return { value, error, loading, accessRevoked, reload: () => read.current?.read() ?? Promise.reject(new MutationContextChangedError()) }
}
