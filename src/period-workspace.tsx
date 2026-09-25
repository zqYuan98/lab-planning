import { useEffect, useState, type ReactNode } from 'react'
import type { Bootstrap, MonthlyPlan, Task, User } from '../shared/types'
import type { PeriodCandidates, PeriodReferences } from '../shared/period-workspace'
import type { WorkspacePage } from '../shared/workspace-query'
import type { DirectoryAccount } from '../shared/directory-workspace'
import { api } from './api'
import { captureMutationContext, MutationContextChangedError } from './mutation-response'

export const periodScope = (data: Bootstrap) => `${data.user.id}:${data.operationEpoch}:${data.accessScopeVersion}`
export function mergePeriod(data: Bootstrap, references?: Partial<PeriodReferences>): Bootstrap {
  if (!references) return data
  return { ...data, ...Object.fromEntries((['users', 'projects', 'plans', 'tasks', 'weeklyRecords'] as const).map(key => [key, [...new Map([...(data[key] ?? []), ...(references[key] ?? [])].map(row => [row.id, row])).values()]])) }
}
export function PeriodPager({ total, next, previous, loading, onNext, onPrevious }: { total: number; next: boolean; previous: boolean; loading: boolean; onNext: () => void; onPrevious: () => void }) {
  return <div className="toolbar"><span>符合条件共 {total} 项</span><button className="button secondary" disabled={loading || !previous} onClick={onPrevious}>上一页</button><button className="button secondary" disabled={loading || !next} onClick={onNext}>下一页</button></div>
}
/** Walk every cursor only for an explicitly opened editor/confirmation, never for a page listing. */
export async function readAllPeriod<T>(path: string, signal: AbortSignal): Promise<{ items: T[]; references: Partial<PeriodReferences> }> {
  const context = captureMutationContext(), items: T[] = [], references: Partial<PeriodReferences> = {}, seen = new Set<string>()
  let cursor: string | null = null
  do {
    const params = new URLSearchParams(path.split('?')[1]); params.set('limit', '100'); if (cursor) params.set('cursor', cursor)
    const page = await api<WorkspacePage<T> & { references?: PeriodReferences }>(`${path.split('?')[0]}?${params}`, { signal })
    if (context !== captureMutationContext()) throw new MutationContextChangedError()
    items.push(...page.items)
    if (page.references) for (const key of ['users', 'projects', 'plans', 'tasks', 'weeklyRecords'] as const) references[key] = [...new Map([...(references[key] ?? []), ...page.references[key]].map(row => [row.id, row])).values()] as never
    cursor = page.nextCursor
    if (cursor && seen.has(cursor)) throw new Error('候选分页未能完成，请重新读取')
    if (cursor) seen.add(cursor)
  } while (cursor)
  return { items, references }
}
export function usePeriodCandidates(data: Bootstrap, ownerId: string, purpose: 'weekly' | 'relink' | 'publish' | 'merge', month?: string) {
  const [value, setValue] = useState<Bootstrap | null>(null), [error, setError] = useState(''), [attempt, retry] = useState(0)
  const scope = periodScope(data)
  const key = JSON.stringify([scope, ownerId, purpose, month]), [acceptedKey, setAcceptedKey] = useState('')
  useEffect(() => {
    const controller = new AbortController(); let live = true
    setValue(null); setError(''); setAcceptedKey(key)
    const query = new URLSearchParams({ ownerId, purpose }); if (month) query.set('month', month)
    const paths = [`/workspace/${['publish', 'merge'].includes(purpose) ? 'monthly' : 'weekly'}/candidates?${query}&kind=plans`, ...(purpose === 'weekly' ? [`/workspace/weekly/candidates?${query}&kind=tasks`] : [])]
    void Promise.all(paths.map(path => readAllPeriod<MonthlyPlan | Task>(path, controller.signal))).then(pages => {
      if (!live) return
      let next = { ...data, plans: [], tasks: [] } as Bootstrap
      for (const page of pages) next = mergePeriod(next, page.references)
      setValue(next)
    }).catch(failure => { if (live && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : '候选读取失败') })
    return () => { live = false; controller.abort() }
  }, [scope, ownerId, purpose, month, attempt])
  return { value: acceptedKey === key ? value : null, error: acceptedKey === key ? error : '', retry: () => retry(value => value + 1) }
}
export function PeriodEditorDirectory({ data, children, includeInactive = false, onCancel }: { data: Bootstrap; children: (value: Bootstrap) => ReactNode; includeInactive?: boolean; onCancel?: () => void }) {
  const [value, setValue] = useState<Bootstrap | null>(null), [error, setError] = useState(''), [attempt, retry] = useState(0)
  const key = JSON.stringify([periodScope(data), includeInactive]), [acceptedKey, setAcceptedKey] = useState('')
  useEffect(() => {
    const controller = new AbortController(); let live = true
    setValue(null); setError(''); setAcceptedKey(key)
    void Promise.all([readAllPeriod<DirectoryAccount>(`/workspace/directory/accounts?purpose=${includeInactive ? 'diagnostics' : 'assignment'}&role=business`, controller.signal), readAllPeriod<Bootstrap['projects'][number]>('/workspace/projects', controller.signal)]).then(([accounts, projects]) => {
      if (live) setValue(mergePeriod(data, { users: accounts.items.map(user => ({ email: '', createdAt: '', updatedAt: '', version: 0, ...user } as User)), projects: projects.items }))
    }).catch(failure => { if (live && !controller.signal.aborted) setError(failure instanceof Error ? failure.message : '候选读取失败') })
    return () => { live = false; controller.abort() }
  }, [periodScope(data), attempt, includeInactive])
  if (acceptedKey === key && error) return <div className="error" role="alert">{error}<button onClick={() => retry(value => value + 1)}>重新读取候选</button>{onCancel && <button onClick={onCancel}>取消</button>}</div>
  return acceptedKey === key && value ? children(value) : <div role="status">正在读取编辑候选…{onCancel && <button onClick={onCancel}>取消</button>}</div>
}
