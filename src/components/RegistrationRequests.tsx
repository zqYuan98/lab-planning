import { useEffect, useState } from 'react'
import { Inbox } from 'lucide-react'
import type { RegistrationPage } from '../../shared/directory-workspace'
import { useWorkspaceQuery } from '../workspace-query'
import DirectoryPagination, { firstDirectoryPage } from './DirectoryPagination'
import type { User } from '../../shared/types'
import { api, json, finishSaved } from '../api'
import { Badge, Field, Form, Modal, type PageProps } from '../ui'
import AccountDeleteDialog from './AccountDeleteDialog'

export default function RegistrationRequests({ data, notify }: PageProps) {
  const [reviewing, setReviewing] = useState<User | null>(null)
  const [deleting, setDeleting] = useState<User | null>(null)
  const [decision, setDecision] = useState('approve')
  const [saving, setSaving] = useState(false)
  const [paging, setPaging] = useState(firstDirectoryPage)
  const scope = `${data.user.id}:${data.user.role}:${data.operationEpoch}:${data.accessScopeVersion}`
  const params = new URLSearchParams({ status: 'all', limit: '20' })
  if (paging.cursor) params.set('cursor', paging.cursor)
  const query = useWorkspaceQuery<RegistrationPage>(`/workspace/registration-requests?${params}`, scope, undefined, { onCursorStale: () => { const first = new URLSearchParams(params); first.delete('cursor'); setPaging(firstDirectoryPage()); return `/workspace/registration-requests?${first}` } })
  const reloadFirst = async () => { const first = new URLSearchParams(params); first.delete('cursor'); setPaging(firstDirectoryPage()); await query.reload(`/workspace/registration-requests?${first}`) }
  const requests = query.value?.items ?? [], pending = query.value?.counts.pending ?? 0
  const refresh = reloadFirst
  useEffect(() => { setReviewing(null); setDeleting(null); setPaging(firstDirectoryPage()) }, [scope])
  const closeReview = () => { if (!saving) setReviewing(null) }
  const openDeletion = (user: User) => { setReviewing(null); setDeleting(user) }
  return <section className="panel registration-panel">
    <div className="registration-heading"><div><h2>注册申请 <Badge tone={pending ? 'amber' : 'gray'}>{pending} 待审核</Badge></h2><p>成员在登录页自行申请，审批通过后以普通成员身份加入团队。</p></div></div>
    {query.error && <p className="error" role="alert">{query.error}<button className="text-button" onClick={() => { setPaging(firstDirectoryPage()); void reloadFirst().catch(() => {}) }}>重新读取</button></p>}
    {query.loading && !query.value && <p role="status">正在读取注册申请…</p>}
    {query.value && (paging.previous.length > 0 || Boolean(query.value.nextCursor)) && <DirectoryPagination total={query.value.total} nextCursor={query.value.nextCursor} paging={paging} setPaging={setPaging} loading={query.loading} />}
    {query.value && (requests.length ? <div className="table-scroll" role="region" aria-label="注册申请表，可横向滚动" tabIndex={0}><table><thead><tr><th>申请人</th><th>岗位</th><th>邮箱</th><th>状态</th><th>操作</th></tr></thead><tbody>{requests.map(user => <tr key={user.id}>
      <td>{user.name}</td><td>{user.position || '未填写'}</td><td>{user.email}</td><td><Badge tone={user.registrationStatus === 'pending' ? 'amber' : 'gray'}>{user.registrationStatus === 'pending' ? '待审核' : '已驳回'}</Badge></td>
      <td><div className="team-account-actions"><button className="button secondary small" onClick={() => { setReviewing(user); setDecision('approve') }}>{user.registrationStatus === 'pending' ? '审核申请' : '重新审核'}</button><button className="text-button team-delete-button" aria-label={`删除账号：${user.name}`} onClick={() => openDeletion(user)}>删除</button></div></td>
    </tr>)}</tbody></table></div> : <div className="registration-empty"><Inbox size={18} aria-hidden="true" /><span>暂无注册申请，新的申请会显示在这里。</span></div>)}
    {reviewing && <Modal title="审核注册申请" onClose={closeReview}>
      <p className="modal-intro">{reviewing.name} · {reviewing.email} · {reviewing.position || '未填写岗位'}</p>
      {reviewing.registrationReviewComment && <p>上次审核说明：{reviewing.registrationReviewComment}</p>}
      <Form submitLabel={decision === 'approve' ? '通过并启用账号' : '驳回申请'} onCancel={closeReview} onSubmit={async event => {
        const values = Object.fromEntries(new FormData(event.currentTarget))
        setSaving(true)
        try {
          const saved = await api<User>(`/users/${reviewing.id}/registration-review`, json({ ...values, decision, version: reviewing.version }))
          notify(decision === 'approve' ? '注册已通过，该成员现在可以登录' : '注册申请已驳回')
          await finishSaved(async () => { await refresh(); setReviewing(null) }, saved.version)
          setReviewing(null)
        } finally {
          setSaving(false)
        }
      }}>
        <Field label="审核结果"><select value={decision} onChange={event => setDecision(event.target.value)}><option value="approve">通过 · 启用普通成员账号</option><option value="reject">驳回 · 暂不允许加入</option></select></Field>
        <Field label={decision === 'reject' ? '驳回原因' : '审核说明（选填）'}><textarea name="comment" required={decision === 'reject'} maxLength={1000} rows={3} /></Field>
        <div className="team-delete-entry"><div><strong>清理无业务账号</strong><p>可检查并删除误注册或不再需要的申请账号。</p></div><button type="button" className="button danger" onClick={() => openDeletion(reviewing)}>检查并删除</button></div>
      </Form>
    </Modal>}
    {deleting && <AccountDeleteDialog user={deleting} data={data} refresh={refresh} notify={notify} onClose={() => setDeleting(null)} />}
  </section>
}
