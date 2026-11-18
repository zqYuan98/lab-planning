import type { ReactNode } from 'react'
import Brand from './WorkspaceBrand'

/** 登录页只做一件事：让人登录。不放口号、流程宣传或装饰背景。 */
export default function AuthLanding({ children }: { children: ReactNode }) {
  return <main className="login-page">
    <header className="login-brand"><Brand /></header>
    {children}
  </main>
}
