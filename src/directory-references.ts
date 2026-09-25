import { useEffect, useState } from 'react'
import type { DirectoryAccount, DirectoryAccountPurpose, DirectoryAccountsPage } from '../shared/directory-workspace'
import { api } from './api'
import { captureMutationContext } from './mutation-response'

/** Resolve only references already present in a bounded page/preview, never enumerate a directory. */
export function useDirectoryReferences(ids: string[], scope: string, purpose: DirectoryAccountPurpose = 'diagnostics') {
  const key = JSON.stringify([...new Set(ids)].sort()), [value, setValue] = useState<Map<string, DirectoryAccount>>(new Map())
  useEffect(() => {
    const controller = new AbortController(), context = captureMutationContext(), selected = JSON.parse(key) as string[]
    setValue(new Map())
    const chunks: string[][] = []
    for (let i = 0; i < selected.length; i += 100) chunks.push(selected.slice(i, i + 100))
    void Promise.all(chunks.map(ids => api<DirectoryAccountsPage>(`/workspace/directory/accounts?${new URLSearchParams({ purpose, selectedIds: JSON.stringify(ids), limit: '1' })}`, { signal: controller.signal }))).then(pages => {
      if (!controller.signal.aborted && context === captureMutationContext()) setValue(new Map(pages.flatMap(page => page.selected).map(account => [account.id, account])))
    }).catch(() => {})
    return () => controller.abort()
  }, [key, scope, purpose])
  return value
}
