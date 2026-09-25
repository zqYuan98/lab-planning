import { useEffect, useState } from 'react'
import { Plus, Users, Search } from 'lucide-react'
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../../shared/auth-policy'
import type { TeamPage } from '../../shared/directory-workspace'
import { useWorkspaceQuery } from '../workspace-query'
import { useDebouncedSearch } from '../use-debounced-search'
import DirectoryPagination, { firstDirectoryPage } from '../components/DirectoryPagination'
import RegistrationRequests from '../components/RegistrationRequests'
import AccountDeleteDialog from '../components/AccountDeleteDialog'
import type { User } from '../../shared/types'
import { api, json, finishSaved } from '../api'
import {
  Badge,
  Empty,
  Field,
  Form,
  Modal,
  PageHeader,
  type PageProps,
} from '../ui'
import '../team.css'

type MemberStatus = 'active' | 'inactive' | 'all'

export default function Team({ data, notify, intent }: PageProps) {
  const [search, setSearch] = useState(intent?.query || '')
  const [status, setStatus] = useState<MemberStatus>(intent?.id ? 'all' : 'active')
  const [paging, setPaging] = useState(firstDirectoryPage)
  const [deleting, setDeleting] = useState<User | null>(null)
  const [saving, setSaving] = useState(false)
  const scope = `${data.user.id}:${data.user.role}:${data.operationEpoch}:${data.accessScopeVersion}`
  const querySearch = useDebouncedSearch(search)
  const params = new URLSearchParams({ status, q: querySearch, limit: '30' })
  if (intent?.id) params.set('focusId', intent.id)
  if (paging.cursor) params.set('cursor', paging.cursor)
  const query = useWorkspaceQuery<TeamPage>(`/workspace/team?${params}`, scope, undefined, { onCursorStale: () => { const first = new URLSearchParams(params); first.delete('cursor'); setPaging(firstDirectoryPage()); return `/workspace/team?${first}` } })
  const reloadFirst = async () => { const first = new URLSearchParams(params); first.delete('cursor'); setPaging(firstDirectoryPage()); await query.reload(`/workspace/team?${first}`) }
  const activeCount = query.value?.counts.active ?? 0, inactiveCount = query.value?.counts.inactive ?? 0, activeManagerCount = query.value?.counts.activeManagers ?? 0
  const members = query.value?.items ?? [], intendedMember = query.value?.focus
  const refresh = reloadFirst
  const [editing, setEditing] = useState<User | 'new' | null>(null),
    user = editing && editing !== 'new' ? editing : null
  const protectedAccount = !!user && (user.id === data.user.id || (user.active && user.role === 'manager' && activeManagerCount <= 1))
  useEffect(() => {
    setEditing(null); setDeleting(null); setPaging(firstDirectoryPage())
  }, [scope])
  const closeEditor = () => { if (!saving) setEditing(null) }
  const openDeletion = (account: User) => {
    setEditing(null)
    setDeleting(account)
  }
  return (
    <>
      <PageHeader
        eyebrow="PEOPLE / TEAM"
        title="团队成员"
        description="管理成员与账号。停用成员从日常列表隐藏，历史工作归属保留。"
        actions={
          <button className="button primary" onClick={() => setEditing('new')}>
            <Plus size={17} />
            添加成员
          </button>
        }
      />
      <RegistrationRequests data={data} refresh={refresh} notify={notify} />
      <div className="toolbar team-toolbar">
        <div className="team-status-filter" role="group" aria-label="按账号状态筛选成员">
          {([
            ['active', '启用', activeCount],
            ['inactive', '停用', inactiveCount],
            ['all', '全部', query.value?.counts.all ?? 0],
          ] as const).map(([value, label, count]) => (
            <button key={value} className={status === value ? 'is-selected' : ''} aria-pressed={status === value} onClick={() => { setStatus(value); setPaging(firstDirectoryPage()) }}>
              {label}<span>{count}</span>
            </button>
          ))}
        </div>
        <label className="search-input">
          <Search size={17} />
          <input
            aria-label="搜索成员"
            placeholder="搜索姓名、岗位或邮箱"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPaging(firstDirectoryPage()) }}
          />
        </label>
      </div>
      {query.error && <p className="error" role="alert">{query.error}<button className="text-button" onClick={() => { setPaging(firstDirectoryPage()); void reloadFirst().catch(() => {}) }}>重新读取</button></p>}
      {query.loading && !query.value && <p role="status">正在读取团队成员…</p>}
      {intendedMember && !members.some(row => row.id === intendedMember.id) && <div className="panel navigation-highlight"><strong>{intendedMember.name}</strong><p>{intendedMember.position} · {intendedMember.active ? '启用' : '停用'}</p><button className="button secondary" onClick={() => setEditing(intendedMember)}>管理定位账号</button></div>}
      {query.value && (paging.previous.length > 0 || Boolean(query.value.nextCursor)) && <DirectoryPagination total={query.value.total} nextCursor={query.value.nextCursor} paging={paging} setPaging={setPaging} loading={query.loading} />}
      <div className="team-intro">
        <Users size={22} />
        <span>
          <strong>{activeCount}</strong>{' '}
          位启用成员
        </span>
        <p>{status === 'inactive' ? '停用账号无法登录、接收新任务；原有计划和成果保留归属。' : '无业务记录的账号可删除；有业务记录的账号可停用并保留历史。'}</p>
      </div>
      {members.length ? (
        <div className="panel">
          <div className="table-scroll" role="region" aria-label="团队成员表，可横向滚动" tabIndex={0}>
            <table className="team-members-table">
              <thead>
                <tr>
                  <th>成员</th>
                  <th>岗位</th>
                  <th>邮箱 / 登录账号</th>
                  <th>权限</th>
                  <th>状态</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {members.map((item) => (
                  <tr
                    key={item.id}
                    className={
                      item.id === intent?.id
                        ? 'navigation-highlight'
                        : undefined
                    }
                  >
                    <td>
                      <div className="person-cell">
                        <span className="avatar light">
                          {item.name.slice(-2)}
                        </span>
                        <strong>{item.name}</strong>
                        {item.id === data.user.id && <Badge>我</Badge>}
                      </div>
                    </td>
                    <td>{item.position || '待设置'}</td>
                    <td>{item.email}</td>
                    <td>{item.role === 'manager' ? '管理员' : item.role === 'observer' ? '观察者' : '成员'}</td>
                    <td>
                      <Badge tone={item.active ? 'green' : 'neutral'}>
                        {item.active ? '启用' : '停用'}
                      </Badge>
                    </td>
                    <td>
                      <div className="team-account-actions">
                      <button
                        className="text-button"
                        aria-label={`管理账号：${item.name}`}
                        onClick={() => setEditing(item)}
                      >
                        管理账号
                      </button>
                      <button className="text-button team-delete-button" aria-label={`删除账号：${item.name}`} onClick={() => openDeletion(item)}>删除</button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <Empty
          title={search ? '没有匹配的成员' : status === 'inactive' ? '暂无停用成员' : status === 'active' ? '暂无启用成员' : '暂无成员'}
          description={search ? '尝试其他关键词，或切换账号状态查看。' : undefined}
        />
      )}
      {editing && (
        <Modal
          title={user ? '管理成员账号' : '添加团队成员'}
          onClose={closeEditor}
        >
          <Form
            onCancel={closeEditor}
            submitLabel={user ? '保存账号设置' : '创建成员账号'}
            onSubmit={async (event) => {
              const form = new FormData(event.currentTarget),
                values = Object.fromEntries(form)
              const body: Record<string, unknown> = {
                ...values,
                ...(user
                  ? { version: user.version, active: protectedAccount ? user.active : form.has('active') }
                  : {}),
              }
              if (user && !values.password) delete body.password
              setSaving(true)
              try {
                const saved = await api<User>(
                  user ? `/users/${user.id}` : '/users',
                  json(body, user ? 'PATCH' : 'POST'),
                )
                notify(
                  user
                    ? '账号设置已保存'
                    : '成员账号已创建，可使用邮箱和初始密码登录',
                )
                await finishSaved(async () => { await refresh(); setEditing(null) }, saved.version)
                setEditing(null)
              } finally {
                setSaving(false)
              }
            }}
          >
            <Field label="姓名">
              <input
                name="name"
                required
                maxLength={80}
                defaultValue={user?.name}
              />
            </Field>
            <Field label="岗位">
              <input
                name="position"
                maxLength={100}
                defaultValue={user?.position}
                placeholder="如 算法工程师、产品经理、测试工程师"
              />
            </Field>
            {!user && (
              <Field label="登录邮箱">
                <input name="email" type="email" required autoComplete="off" />
              </Field>
            )}
            <Field label="角色">
              <select name="role" defaultValue={user?.role || 'member'}>
                <option value="member">成员 · 本人提报与执行</option><option value="observer">观察者 · 仅明确授权的只读对象</option>
                <option value="manager">管理员 · 审核发布、验收与管理</option>
              </select>
            </Field>
            <Field
              label={user ? '重设密码（留空则保留）' : '初始密码'}
              hint="至少 8 位。通过部门认可的方式将初始密码交给本人。"
            >
              <input
                name="password"
                type="password"
                minLength={PASSWORD_MIN_LENGTH}
                maxLength={PASSWORD_MAX_LENGTH}
                required={!user}
                autoComplete="new-password"
              />
            </Field>
            {user && (
              <>
                <label className="checkbox-label">
                  <input
                    name="active"
                    type="checkbox"
                    defaultChecked={user.active}
                    disabled={protectedAccount}
                  />
                  启用账号
                </label>
                <p className="team-account-hint">{protectedAccount ? user.id === data.user.id ? '不能停用当前登录账号。' : '需要保留至少一位启用的管理员。' : '停用后隐藏日常入口、停止新分配，已有工作和历史记录保留。'}</p>
                <div className="team-delete-entry">
                  <div><strong>删除账号</strong><p>先检查业务关联，仅无业务记录的账号可以删除。</p></div>
                  <button type="button" className="button danger" onClick={() => openDeletion(user)}>检查并删除</button>
                </div>
              </>
            )}
          </Form>
        </Modal>
      )}
      {deleting && <AccountDeleteDialog user={deleting} data={data} refresh={refresh} notify={notify} onClose={() => setDeleting(null)} />}
    </>
  )
}
