import { useEffect, useState } from 'react'
import type { DirectoryAccount, DirectoryAccountPurpose, DirectoryAccountsPage } from '../../shared/directory-workspace'
import { canUseAccount } from '../../shared/auth-policy'
import { useWorkspaceQuery } from '../workspace-query'

export function directoryAccountName(account: DirectoryAccount | null | undefined) {
  return account ? `${account.name}${!account.active ? '（已停用）' : account.registrationStatus === 'pending' ? '（待审批）' : account.registrationStatus === 'rejected' ? '（审批未通过）' : ''}` : '原账号'
}
interface PickerProps {
  name: string; purpose?: DirectoryAccountPurpose; defaultSelectedIds?: string[]; multiple?: boolean; scope: string; disabled?: boolean; role?: 'member' | 'manager' | 'observer' | 'business'; label?: string
  renderAccount?: (account: DirectoryAccount) => React.ReactNode
  onChange?: (ids: string[]) => void; allowEmpty?: boolean
}
/** Keep all selected IDs in the form while fetching candidates only when the chooser is opened. */
export default function DirectoryAccountPicker({ defaultSelectedIds = [], ...props }: PickerProps) {
  const [selected, setSelected] = useState(() => [...new Set(defaultSelectedIds)]), [expanded, setExpanded] = useState(false)
  useEffect(() => { setSelected([...new Set(defaultSelectedIds)]); setExpanded(false) }, [props.scope])
  return <div className="directory-account-picker">
    {selected.map(id => <input key={id} type="hidden" name={props.name} value={id} />)}
    <details open={expanded} onToggle={event => setExpanded(event.currentTarget.open)}>
      <summary>{props.label ?? '选择成员'} · {selected.length ? `已选 ${selected.length} 位` : props.allowEmpty ? '全部成员' : '尚未选择'}</summary>
      {expanded && <AccountChoices {...props} selected={selected} choose={next => { setSelected(next); props.onChange?.(next); if (!props.multiple) setExpanded(false) }} />}
    </details>
  </div>
}
function AccountChoices({ purpose = 'assignment', multiple = false, scope, disabled = false, role, label = '搜索成员', renderAccount, allowEmpty = false, selected, choose: accept }: Omit<PickerProps, 'defaultSelectedIds' | 'onChange'> & { selected: string[]; choose: (ids: string[]) => void }) {
  const [q, setQuery] = useState(''), [selectedPage, setSelectedPage] = useState(0)
  const [paging, setPaging] = useState<{ cursor: string | null; previous: (string | null)[] }>({ cursor: null, previous: [] })
  const selectionPage = Math.min(selectedPage, Math.max(0, Math.ceil(selected.length / 20) - 1)), visibleSelected = selected.slice(selectionPage * 20, selectionPage * 20 + 20)
  const params = new URLSearchParams({ purpose, q, limit: '20', selectedIds: JSON.stringify(visibleSelected) })
  if (role) params.set('role', role)
  if (paging.cursor) params.set('cursor', paging.cursor)
  const query = useWorkspaceQuery<DirectoryAccountsPage>(`/workspace/directory/accounts?${params}`, scope, undefined, { onCursorStale: () => { const first = new URLSearchParams(params); first.delete('cursor'); setPaging({ cursor: null, previous: [] }); return `/workspace/directory/accounts?${first}` } })
  const reloadFirst = () => { const first = new URLSearchParams(params); first.delete('cursor'); setPaging({ cursor: null, previous: [] }); return query.reload(`/workspace/directory/accounts?${first}`) }
  const known = new Map([...(query.value?.selected ?? []), ...(query.value?.items ?? [])].map(user => [user.id, user]))
  function choose(id: string, checked: boolean) {
    accept(multiple ? checked ? [...new Set([...selected, id])] : selected.filter(value => value !== id) : checked ? [id] : [])
    setPaging({ cursor: null, previous: [] })
  }
  return <div>
    {allowEmpty && <button type="button" className="text-button" disabled={disabled} onClick={() => { accept([]); setPaging({ cursor: null, previous: [] }) }}>全部成员</button>}
    <label className="field"><span>{label}</span><input type="search" value={q} disabled={disabled} onChange={event => { setQuery(event.target.value); setPaging({ cursor: null, previous: [] }) }} placeholder="输入姓名或岗位" /></label>
    {!!selected.length && <div className="form-hint">已选 {selected.length} 项：{visibleSelected.map(id => <span key={id} style={{ display: 'inline-block', marginRight: 12 }}>{known.has(id) ? directoryAccountName(known.get(id)) : query.loading ? '已选账号（姓名待载入）' : '原账号（关联保留）'}{multiple && <button type="button" className="text-button" disabled={disabled} onClick={() => choose(id, false)} aria-label={`移除 ${known.get(id)?.name ?? '已选账号'}`}>移除</button>}</span>)}{selected.length > 20 && <div><button type="button" disabled={disabled || !selectionPage} onClick={() => { setSelectedPage(selectionPage - 1); setPaging({ cursor: null, previous: [] }) }}>上一组选中成员</button><span> {selectionPage + 1} / {Math.ceil(selected.length / 20)} </span><button type="button" disabled={disabled || (selectionPage + 1) * 20 >= selected.length} onClick={() => { setSelectedPage(selectionPage + 1); setPaging({ cursor: null, previous: [] }) }}>下一组选中成员</button></div>}</div>}
    {query.error && <p role="alert" className="error">{query.error}<button type="button" className="text-button" onClick={() => { void reloadFirst().catch(() => {}) }}>重新读取成员</button></p>}
    {query.loading && !query.value && <p role="status">正在读取成员候选…</p>}
    {query.value && <>
      <div className="notification-pilots">{query.value.items.map(user => <label key={user.id} className="checkbox-label"><input type={multiple ? 'checkbox' : 'radio'} checked={selected.includes(user.id)} disabled={disabled || ['assignment', 'notification'].includes(purpose) && !canUseAccount(user)} onChange={event => choose(user.id, event.target.checked)} /><span>{directoryAccountName(user)}{user.position && <small>{user.position}</small>}</span>{renderAccount?.(user)}</label>)}</div>
      {!query.value.total && <p className="form-hint">没有匹配的成员；已选关联仍保留。</p>}
      <div className="header-actions"><span className="form-hint">匹配 {query.value.total} 位</span><button type="button" className="button secondary" disabled={disabled || query.loading || !paging.previous.length} onClick={() => setPaging(old => ({ cursor: old.previous.at(-1) ?? null, previous: old.previous.slice(0, -1) }))}>上一页</button><button type="button" className="button secondary" disabled={disabled || query.loading || !query.value.nextCursor} onClick={() => setPaging(old => ({ cursor: query.value!.nextCursor, previous: [...old.previous, old.cursor] }))}>下一页</button></div>
    </>}
  </div>
}
