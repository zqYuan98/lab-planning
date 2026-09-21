import { useState } from 'react'
import type { User } from '../../shared/types'
import { api, json } from '../api'
import { Badge, Field, Form, Modal, type PageProps } from '../ui'
import AccountDeleteDialog from './AccountDeleteDialog'

export default function RegistrationRequests({ data, refresh, notify }: PageProps) {
  const [reviewing, setReviewing] = useState<User | null>(null)
  const [deleting, setDeleting] = useState<User | null>(null)
  const [decision, setDecision] = useState('approve')
  const [saving, setSaving] = useState(false)
  const requests = data.users.filter(user => user.registrationStatus === 'pending' || user.registrationStatus === 'rejected').sort((a, b) => Number(b.registrationStatus === 'pending') - Number(a.registrationStatus === 'pending') || b.createdAt.localeCompare(a.createdAt))
  const pending = requests.filter(user => user.registrationStatus === 'pending').length
  const closeReview = () => { if (!saving) setReviewing(null) }
  const openDeletion = (user: User) => { setReviewing(null); setDeleting(user) }
  return <section className="panel registration-panel">
    <div className="registration-heading"><div><h2>注册申请 <Badge tone={pending ? 'amber' : 'gray'}>{pending} 待审核</Badge></h2><p>成员在登录页自行申请，审批通过后以普通成员身份加入团队。</p></div></div>
    {requests.length ? <div className="table-scroll"><table><thead><tr><th>申请人</th><th>岗位</th><th>邮箱</th><th>状态</th><th>操作</th></tr></thead><tbody>{requests.map(user => <tr key={user.id}>
      <td>{user.name}</td><td>{user.position || '未填写'}</td><td>{user.email}</td><td><Badge tone={user.registrationStatus === 'pending' ? 'amber' : 'gray'}>{user.registrationStatus === 'pending' ? '待审核' : '已驳回'}</Badge></td>
      <td><div className="team-account-actions"><button className="button secondary small" onClick={() => { setReviewing(user); setDecision('approve') }}>{user.registrationStatus === 'pending' ? '审核申请' : '重新审核'}</button><button className="text-button team-delete-button" aria-label={`删除账号：${user.name}`} onClick={() => openDeletion(user)}>删除</button></div></td>
    </tr>)}</tbody></table></div> : <p className="registration-empty">暂无待审核的注册申请。</p>}
    {reviewing && <Modal title="审核注册申请" onClose={closeReview}>
      <p className="modal-intro">{reviewing.name} · {reviewing.email} · {reviewing.position || '未填写岗位'}</p>
      {reviewing.registrationReviewComment && <p>上次审核说明：{reviewing.registrationReviewComment}</p>}
      <Form submitLabel={decision === 'approve' ? '通过并启用账号' : '驳回申请'} onCancel={closeReview} onSubmit={async event => {
        const values = Object.fromEntries(new FormData(event.currentTarget))
        setSaving(true)
        try {
          await api(`/users/${reviewing.id}/registration-review`, json({ ...values, decision, version: reviewing.version }))
          await refresh()
          notify(decision === 'approve' ? '注册已通过，该成员现在可以登录' : '注册申请已驳回')
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
