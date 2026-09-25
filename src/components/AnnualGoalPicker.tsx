import { useState } from 'react'
import type { GoalsPage } from '../../shared/directory-workspace'
import { useWorkspaceQuery } from '../workspace-query'
import { firstDirectoryPage } from './DirectoryPagination'

interface Props { year: number; value: string; onChange: (value: string) => void; scope: string }
export default function AnnualGoalPicker(props: Props) { return <AnnualGoalChoices key={`${props.scope}:${props.year}`} {...props} /> }
function AnnualGoalChoices({ year, value, onChange, scope }: Props) {
  const [paging, setPaging] = useState(firstDirectoryPage)
  const params = new URLSearchParams({ year: String(year), limit: '30' })
  if (paging.cursor) params.set('cursor', paging.cursor)
  const query = useWorkspaceQuery<GoalsPage>(`/workspace/annual-goals?${params}`, `${scope}:${year}`, undefined, { onCursorStale: () => { setPaging(firstDirectoryPage()); return `/workspace/annual-goals?year=${year}&limit=30` } })
  return <div>
    <select name="annualGoalId" aria-label="关联年度目标" value={value} onChange={event => onChange(event.target.value)}>
      <option value="">未关联年度目标</option>
      {value && !query.value?.items.some(goal => goal.id === value) && <option value={value}>已选年度目标（关联保留）</option>}
      {query.value?.items.map(goal => <option value={goal.id} key={goal.id}>{goal.title}</option>)}
    </select>
    {query.error && <p role="alert">{query.error}<button type="button" onClick={() => { setPaging(firstDirectoryPage()); void query.reload(`/workspace/annual-goals?year=${year}&limit=30`).catch(() => {}) }}>重新读取</button></p>}
    {query.value && query.value.total > 30 && <div><button type="button" disabled={query.loading || !paging.previous.length} onClick={() => setPaging(old => ({ cursor: old.previous.at(-1) ?? null, previous: old.previous.slice(0,-1) }))}>上一页年度目标</button><button type="button" disabled={query.loading || !query.value.nextCursor} onClick={() => setPaging(old => ({ cursor: query.value!.nextCursor, previous: [...old.previous, old.cursor] }))}>下一页年度目标</button></div>}
  </div>
}
