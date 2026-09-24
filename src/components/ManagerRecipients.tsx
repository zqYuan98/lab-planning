import { useEffect, useState } from 'react'
import type { User } from '../../shared/types'
import type { WorkspacePage } from '../../shared/workspace-query'
import { useBusinessResource } from '../use-business-resource'
import { Field } from '../ui'

/** Selection is independent from the current search page, so paging never clears recipients. */
export default function ManagerRecipients({ initialIds, scope }: { initialIds: string[]; scope: string }) {
  const [selected, setSelected] = useState(initialIds), [query, setQuery] = useState(''), [cursor, setCursor] = useState('')
  const resource = useBusinessResource<WorkspacePage<User>>(`/workspace/candidates?kind=user&role=manager&limit=50&q=${encodeURIComponent(query)}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, scope)
  useEffect(() => { setSelected(initialIds); setCursor(''); setQuery('') }, [scope])
  return <fieldset><legend>管理通知接收人（不选则使用默认管理者）</legend>
    {selected.map(id => <input key={id} type="hidden" name="managerRecipientIds" value={id} />)}
    <Field label="搜索管理者"><input value={query} maxLength={120} onChange={event => { setQuery(event.target.value); setCursor('') }} /></Field>
    <p className="form-hint">已选择 {selected.length} 人。切换搜索和分页会保留已选接收人。</p>
    {resource.error && <p className="error">{resource.error}<button type="button" className="button small" onClick={() => { setCursor(''); void resource.refresh().catch(() => {}) }}>刷新候选</button></p>}
    {resource.loading ? <p>正在读取管理者…</p> : resource.value?.items.map(user => <label className="checkbox-label" key={user.id}><input type="checkbox" checked={selected.includes(user.id)} onChange={event => setSelected(previous => event.target.checked ? [...previous, user.id] : previous.filter(id => id !== user.id))} />{user.name}</label>)}
    {!!selected.length && <button type="button" className="button small" onClick={() => setSelected([])}>清空已选，使用默认管理者</button>}
    {(cursor || resource.value?.nextCursor) && <div className="row-actions"><button type="button" className="button small" disabled={!cursor || resource.loading} onClick={() => setCursor('')}>回到首页</button><button type="button" className="button small" disabled={!resource.value?.nextCursor || resource.loading} onClick={() => setCursor(resource.value!.nextCursor!)}>下一页</button></div>}
  </fieldset>
}
