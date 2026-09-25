export interface DirectoryPaging { cursor: string | null; previous: (string | null)[] }
export const firstDirectoryPage = (): DirectoryPaging => ({ cursor: null, previous: [] })
export default function DirectoryPagination({ total, nextCursor, paging, setPaging, loading = false }: {
  total: number; nextCursor: string | null; paging: DirectoryPaging; setPaging: React.Dispatch<React.SetStateAction<DirectoryPaging>>; loading?: boolean
}) {
  return <div className="header-actions"><span>共 {total} 项</span><button className="button secondary" disabled={loading || !paging.previous.length} onClick={() => setPaging(old => ({ cursor: old.previous.at(-1) ?? null, previous: old.previous.slice(0, -1) }))}>上一页</button><button className="button secondary" disabled={loading || !nextCursor} onClick={() => setPaging(old => ({ cursor: nextCursor, previous: [...old.previous, old.cursor] }))}>下一页</button>{paging.cursor && <button className="text-button" onClick={() => setPaging(firstDirectoryPage())}>返回第一页</button>}</div>
}
