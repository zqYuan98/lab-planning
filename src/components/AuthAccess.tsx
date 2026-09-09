import { useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../../shared/auth-policy'
import { api, json } from '../api'
import { Field, Form } from '../ui'

export default function AuthAccess({ initialized, onLogin }: { initialized: boolean; onLogin: () => Promise<void> }) {
  const [registering, setRegistering] = useState(false)
  const [sent, setSent] = useState(false)
  const newAccount = !initialized || registering
  return <section className="auth-form">
    <span className="auth-form-icon"><ShieldCheck size={24} /></span>
    <div className="eyebrow">{registering ? 'JOIN THE TEAM' : initialized ? 'WELCOME BACK' : 'LET’S GET STARTED'}</div>
    <h2>{sent ? '申请已提交' : registering ? '申请加入团队' : initialized ? '欢迎回到工作空间' : '设置首位管理员'}</h2>
    <p>{sent ? '管理员审批通过后，使用您的邮箱和刚设置的密码登录。' : registering ? '填写个人信息，自行设置密码，等待管理员审批。' : initialized ? '登录后，继续推进团队的计划与成果。' : '创建管理员后，团队成员可以自行申请加入。'}</p>
    {sent ? <div role="status" className="registration-success">您的申请正在等待审核，无需重复注册。</div> : <Form
      key={`${initialized}-${registering}`}
      submitLabel={registering ? '提交注册申请' : initialized ? '登录工作空间' : '创建工作空间'}
      onSubmit={async event => {
        const { confirmPassword, ...values } = Object.fromEntries(new FormData(event.currentTarget))
        if (registering && values.password !== confirmPassword) throw new Error('两次输入的密码不一致')
        await api(registering ? '/auth/register' : initialized ? '/auth/login' : '/auth/setup', json(values))
        if (registering) setSent(true)
        else await onLogin()
      }}>
      {newAccount && <Field label="姓名"><input name="name" autoComplete="name" defaultValue={!initialized ? '袁中群' : ''} required maxLength={100} /></Field>}
      {registering && <Field label="岗位（选填）"><input name="position" autoComplete="organization-title" maxLength={100} placeholder="如 算法工程师、产品经理" /></Field>}
      <Field label="邮箱"><input name="email" type="email" autoComplete="username" placeholder="you@company.com" maxLength={254} required /></Field>
      <Field label="密码" hint={newAccount ? '至少 8 位，可使用数字、字母或符号。' : undefined}>
        <input name="password" type="password" autoComplete={newAccount ? 'new-password' : 'current-password'} minLength={newAccount ? PASSWORD_MIN_LENGTH : undefined} maxLength={PASSWORD_MAX_LENGTH} required />
      </Field>
      {registering && <Field label="确认密码"><input name="confirmPassword" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} required /></Field>}
    </Form>}
    {initialized && <div className="auth-switch"><span>{registering ? '已有账号？' : '还没有账号？'}</span><button type="button" className="button secondary" onClick={() => { setRegistering(!registering); setSent(false) }}>{registering ? '返回登录' : '申请加入团队'}</button></div>}
    <p className="auth-form-note">每一次计划，都从清晰的责任开始。</p>
  </section>
}
