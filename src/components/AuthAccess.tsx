import { LIMITS } from '../../shared/entity-rules'
import { useState } from 'react'
import { Eye, EyeOff, LockKeyhole, Mail } from 'lucide-react'
import { PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../../shared/auth-policy'
import { api, json } from '../api'
import { Field, Form } from '../ui'

export default function AuthAccess({ initialized, onLogin }: { initialized: boolean; onLogin: () => Promise<void> }) {
  const [registering, setRegistering] = useState(false)
  const [sent, setSent] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [passwordHelp, setPasswordHelp] = useState(false)
  const newAccount = !initialized || registering
  return <section className="auth-form">
    <div className="auth-form-kicker"><span aria-hidden="true" /> TEAM WORKSPACE</div>
    <h2>{sent ? '申请已提交' : registering ? '申请加入团队' : initialized ? '登录工作空间' : '设置首位管理员'}</h2>
    <p>{sent ? '管理员审批通过后，使用您的邮箱和刚设置的密码登录。' : registering ? '填写个人信息，自行设置密码，等待管理员审批。' : initialized ? '使用已开通的团队账号登录。' : '创建管理员后，团队成员可以自行申请加入。'}</p>
    {sent ? <div role="status" className="registration-success">您的申请正在等待审核，无需重复注册。</div> : <Form
      key={`${initialized}-${registering}`}
      workspaceErrorActions={false}
      submitLabel={registering ? '提交注册申请' : initialized ? '登录工作空间' : '创建工作空间'}
      onSubmit={async event => {
        const { confirmPassword, ...values } = Object.fromEntries(new FormData(event.currentTarget))
        if (registering && values.password !== confirmPassword) throw new Error('两次输入的密码不一致')
        await api(registering ? '/auth/register' : initialized ? '/auth/login' : '/auth/setup', json(values))
        if (registering) setSent(true)
        else await onLogin()
      }}>
      {newAccount && <Field label="姓名"><input name="name" autoComplete="name" defaultValue={!initialized ? '袁中群' : ''} required maxLength={LIMITS.personName} /></Field>}
      {registering && <Field label="岗位（选填）"><input name="position" autoComplete="organization-title" maxLength={LIMITS.position} placeholder="如 算法工程师、产品经理" /></Field>}
      <div className="auth-input-group"><Mail className="auth-input-icon" size={19} aria-hidden="true" /><Field label="邮箱"><input name="email" type="email" autoComplete="username" placeholder="you@company.com" maxLength={LIMITS.email} required /></Field></div>
      <div className="auth-input-group auth-password-group">
        <LockKeyhole className="auth-input-icon" size={19} aria-hidden="true" />
        <Field label="密码" hint={newAccount ? '至少 8 位，可使用数字、字母或符号。' : undefined}>
          <input name="password" type={showPassword ? 'text' : 'password'} autoComplete={newAccount ? 'new-password' : 'current-password'} placeholder={newAccount ? '设置登录密码' : '请输入密码'} minLength={newAccount ? PASSWORD_MIN_LENGTH : undefined} maxLength={PASSWORD_MAX_LENGTH} required />
        </Field>
        <button type="button" className="auth-password-toggle" aria-label={showPassword ? '隐藏密码' : '显示密码'} aria-pressed={showPassword} onClick={() => setShowPassword(!showPassword)}>{showPassword ? <Eye size={19} aria-hidden="true" /> : <EyeOff size={19} aria-hidden="true" />}</button>
      </div>
      {registering && <Field label="确认密码"><input name="confirmPassword" type="password" autoComplete="new-password" minLength={PASSWORD_MIN_LENGTH} maxLength={PASSWORD_MAX_LENGTH} required /></Field>}
      {!newAccount && <div className="auth-password-help"><button type="button" aria-expanded={passwordHelp} aria-controls="auth-password-help" onClick={() => setPasswordHelp(!passwordHelp)}>忘记密码？</button>{passwordHelp && <p id="auth-password-help" role="status">请联系团队管理员，在「成员管理」中重置您的密码，再使用新密码登录。</p>}</div>}
    </Form>}
    {initialized && <><div className="auth-divider"><span>或</span></div><div className="auth-switch"><span>{registering ? '已有账号？' : '还没有账号？'}</span><button type="button" className="button secondary" onClick={() => { setRegistering(!registering); setSent(false); setShowPassword(false); setPasswordHelp(false) }}>{registering ? '返回登录' : '申请加入团队'}</button></div></>}
  </section>
}
