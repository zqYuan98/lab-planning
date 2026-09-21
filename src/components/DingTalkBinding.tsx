import { useEffect, useRef, useState } from 'react'
import { Link2, ShieldCheck } from 'lucide-react'
import type { DingTalkBindingStatus } from '../../shared/notifications'
import type { User } from '../../shared/types'
import { api, json } from '../api'
import { exchangeDingTalk, isDingTalk } from '../dingtalk-access'
import { dateTime } from '../ui'

export default function DingTalkBinding({ user, onSessionChanged, notify }: {
  user: User; onSessionChanged: () => Promise<void>; notify: (message: string) => void
}) {
  const [binding, setBinding] = useState<DingTalkBindingStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmUnbind, setConfirmUnbind] = useState(false)
  const loadSequence = useRef(0)
  async function load() {
    const sequence = ++loadSequence.current
    const status = await api<DingTalkBindingStatus>('/dingtalk/binding')
    if (sequence === loadSequence.current) setBinding(status)
    return status
  }
  useEffect(() => {
    void load().catch(error => setError(error instanceof Error ? error.message : '绑定信息读取失败'))
    return () => { loadSequence.current++ }
  }, [user.id])
  async function run(action: () => Promise<unknown>) {
    if (busy) return
    setBusy(true); setError('')
    try { await action() } catch (error) { setError(error instanceof Error ? error.message : '操作失败') }
    finally { setBusy(false) }
  }
  return <section className="notification-binding" aria-labelledby="binding-title">
    <div className="notification-section-heading"><Link2 size={19} /><h2 id="binding-title">我的钉钉身份</h2>
      <span className={`badge badge-${binding?.bound ? 'green' : 'neutral'}`}>{binding ? binding.bound ? '已绑定' : '未绑定' : '读取中'}</span></div>
    {binding?.bound ? <>
      <p>已绑定企业 {binding.corpId}，可通过钉钉进入工作空间。</p>
      {binding.boundAt && <small>绑定于 {dateTime(binding.boundAt)}</small>}
      {confirmUnbind ? <div className="binding-confirm"><p>解绑后相关登录会话将失效，需重新使用团队账号登录。</p>
        <button className="button secondary" disabled={busy} onClick={() => setConfirmUnbind(false)}>保留绑定</button>
        <button className="button danger" disabled={busy} onClick={() => void run(async () => {
          await api('/dingtalk/unbind', json({})); await onSessionChanged()
        })}>确认解绑并退出</button></div>
        : <button className="text-button" onClick={() => setConfirmUnbind(true)}>解除本人绑定</button>}
    </> : binding?.pending ? <div className="binding-confirm">
      <p>请确认以下两个身份均属于您本人，然后完成绑定。</p>
      <dl><div><dt>工作空间账号</dt><dd>{user.name} · {user.email}</dd></div>
        <div><dt>钉钉身份</dt><dd>{binding.pending.displayName || binding.pending.userid || '当前已验证的钉钉成员'}</dd></div>
        <div><dt>企业</dt><dd>{binding.pending.corpId}</dd></div></dl>
      {binding.pending.expiresAt && <small>本次验证有效期至 {dateTime(binding.pending.expiresAt)}</small>}
      <button className="button primary" disabled={busy} onClick={() => void run(async () => {
        await api('/dingtalk/bind', json({})); await load(); notify('钉钉身份已绑定')
      })}><ShieldCheck size={16} />{busy ? '正在绑定…' : '确认是本人，绑定账号'}</button>
    </div> : <>
      <p>从钉钉工作台打开本应用，验证钉钉身份后，再与当前账号明确绑定。</p>
      {isDingTalk() && <button className="button secondary" disabled={busy} onClick={() => void run(async () => {
        const result = await exchangeDingTalk()
        if (result.authenticated) { await onSessionChanged(); await load(); return }
        const status = await load()
        if (!status.bound && !status.pending) {
          throw new Error('钉钉身份已验证，但未能保留待绑定状态。请重新验证钉钉身份；若仍无确认按钮，请联系管理员。')
        }
      })}>{busy ? '正在验证…' : '验证当前钉钉身份'}</button>}
    </>}
    {error && <div className="error" role="alert">{error}<button className="text-button" disabled={busy} onClick={() => void run(load)}>重新读取</button></div>}
  </section>
}
