import { useEffect, useRef, useState } from 'react'
import type { ImportCandidateKind, ImportCandidatePage, ImportReferenceIds, ImportReferences } from '../shared/import-workspace'
import { api, json } from './api'
import { workspaceQueryReader } from './workspace-query-state'
import { queryAffected } from './query-invalidation'
import { useWorkspaceQuery } from './workspace-query'
import { MutationContextChangedError } from './mutation-response'
import { useDebouncedSearch } from './use-debounced-search'

export const emptyImportReferences = (): ImportReferences => ({ users: [], projects: [], plans: [], tasks: [] })
export function combineImportReferences(...sources: ImportReferences[]): ImportReferences {
  return Object.fromEntries((['users', 'projects', 'plans', 'tasks'] as const).map(kind => [kind, [...new Map(sources.flatMap(source => source[kind] as { id: string }[]).map(row => [row.id, row])).values()]])) as unknown as ImportReferences
}
/** Explicit references from the current batch/form, partitioned without truncating tail IDs. */
export async function readImportReferences(ids: ImportReferenceIds, signal?: AbortSignal): Promise<ImportReferences> {
  const chunks: ImportReferenceIds[] = [], keys = ['users', 'projects', 'plans', 'tasks'] as const
  const unique = Object.fromEntries(keys.map(kind => [kind, [...new Set(ids[kind].filter(Boolean))]])) as unknown as ImportReferenceIds
  const length = Math.max(...keys.map(kind => unique[kind].length))
  for (let offset = 0; offset < length; offset += 100) chunks.push(Object.fromEntries(keys.map(kind => [kind, unique[kind].slice(offset, offset + 100)])) as unknown as ImportReferenceIds)
  const values: ImportReferences[] = []
  for (const chunk of chunks) values.push(await api<ImportReferences>('/workspace/import-references', { ...json(chunk), signal }))
  return combineImportReferences(emptyImportReferences(), ...values)
}
export function useImportReferences(ids: ImportReferenceIds, scope: string) {
  const [value, setValue] = useState<ImportReferences>(emptyImportReferences), [error, setError] = useState('')
  const key = JSON.stringify(ids), reader = useRef<ReturnType<typeof workspaceQueryReader<ImportReferences>> | null>(null), activeKey = useRef(key), activeScope = useRef(scope), accepted = useRef({ key: '', scope: '' })
  useEffect(() => {
    activeKey.current = key; activeScope.current = scope; accepted.current = { key: '', scope: '' }
    setValue(emptyImportReferences())
    const current = workspaceQueryReader({ load: signal => readImportReferences(JSON.parse(activeKey.current), signal), accept: (value: ImportReferences) => { accepted.current = { key: activeKey.current, scope: activeScope.current }; setValue(value) }, clear: () => setValue(emptyImportReferences()), error: failure => setError(failure instanceof Error ? failure.message : ''), loading: () => {}, affected: path => queryAffected('/workspace/import-references', path) })
    reader.current = current; void current.read().catch(() => {})
    return () => { current.dispose(); if (reader.current === current) reader.current = null }
  }, [scope])
  useEffect(() => {
    if (activeKey.current === key) return
    activeKey.current = key; reader.current?.resetQuery(); setValue(emptyImportReferences())
    void reader.current?.read().catch(() => {})
  }, [key, scope])
  return { value: accepted.current.key === key && accepted.current.scope === scope ? value : emptyImportReferences(), error: activeScope.current === scope ? error : '', reload: () => reader.current?.read() ?? Promise.reject(new MutationContextChangedError()) }
}
const labels: Record<ImportCandidateKind, string> = { users: '成员', projects: '项目', plans: '月度目标', tasks: '个人任务' }
export function ImportCandidateLookup({ kind, scope, ownerId = '', onItems }: { kind: ImportCandidateKind; scope: string; ownerId?: string; onItems: (kind: ImportCandidateKind, value: ImportReferences) => void }) {
  const [q, setQuery] = useState(''), [cursor, setCursor] = useState('')
  const querySearch = useDebouncedSearch(q)
  const callback = useRef(onItems); callback.current = onItems
  const firstPath = `/workspace/import-candidates?kind=${kind}&q=${encodeURIComponent(querySearch)}&ownerId=${encodeURIComponent(ownerId)}&limit=50`
  const resource = useWorkspaceQuery<ImportCandidatePage>(`${firstPath}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, scope, undefined, { onCursorStale: () => { setCursor(''); return firstPath } })
  useEffect(() => { callback.current(kind, resource.value ? { ...emptyImportReferences(), [kind]: resource.value.items, ...(kind === 'tasks' ? { users: resource.value.references.users } : {}) } : emptyImportReferences()) }, [resource.value, kind])
  useEffect(() => { setCursor('') }, [ownerId])
  return <div className="form-hint"><label>查找{labels[kind]} <input aria-label={`查找导入${labels[kind]}`} value={q} maxLength={120} placeholder="输入名称搜索" onChange={event => { setQuery(event.target.value); setCursor('') }} /></label>
    {resource.error ? <span role="alert">{resource.error}<button type="button" className="button small" onClick={() => { setCursor(''); void resource.reload(firstPath).catch(() => {}) }}>重新读取</button></span> : <span>{resource.loading ? '读取中…' : `找到 ${resource.value?.total ?? 0} 项，下方显示当前候选页`}</span>}
    {cursor && <button type="button" className="button small" onClick={() => setCursor('')}>候选首页</button>}
    {resource.value?.nextCursor && <button type="button" className="button small" onClick={() => setCursor(resource.value!.nextCursor!)}>更多{labels[kind]}</button>}
  </div>
}
