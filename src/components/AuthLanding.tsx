import { useState, type ReactNode } from 'react'
import { ArrowUpRight, BarChart3, CalendarClock, Moon, Sun, Target } from 'lucide-react'
import Brand from './WorkspaceBrand'

const steps = [
  { title: '月度目标', description: '锚定工作方向，明确目标与交付', Icon: Target },
  { title: '每周执行', description: '聚焦关键任务，推进进度与问题', Icon: CalendarClock },
  { title: '成果汇报', description: '汇总执行成果，让每一份进展可见', Icon: BarChart3 },
]

export default function AuthLanding({ children }: { children: ReactNode }) {
  const [light, setLight] = useState(() => {
    try { return localStorage.getItem('tianshu-login-theme') === 'light' } catch { return false }
  })
  function toggleTheme() {
    const next = !light
    setLight(next)
    try { localStorage.setItem('tianshu-login-theme', next ? 'light' : 'dark') } catch { /* Theme remains usable without storage. */ }
  }
  return <main className={`auth-page tech-auth${light ? ' tech-auth-light' : ''}`}>
    <div className="auth-network" aria-hidden="true" />
    <button type="button" className="auth-theme-toggle" aria-label={light ? '切换为深色登录页' : '切换为浅色登录页'} aria-pressed={light} onClick={toggleTheme}>
      <Sun size={18} aria-hidden="true" className={light ? 'is-active' : ''} />
      <Moon size={18} aria-hidden="true" className={!light ? 'is-active' : ''} />
    </button>
    <section className="auth-story" aria-labelledby="auth-title">
      <header className="auth-brand"><Brand wordmark /><p className="auth-brand-motto">智汇 · 探索 · 未来</p></header>
      <div className="auth-copy">
        <h1 id="auth-title">部门工作空间</h1>
        <span className="auth-title-rule" aria-hidden="true" />
        <p>连接协作，赋能创新</p>
        <ul className="auth-workflow">
          {steps.map(({ title, description, Icon }, index) => <li key={title}>
            <span className="auth-workflow-icon"><Icon size={30} strokeWidth={1.7} aria-hidden="true" /></span>
            <div><h2>{title}</h2><p>{description}</p></div>
            <span className="auth-step-number" aria-hidden="true">0{index + 1}<ArrowUpRight size={15} /></span>
          </li>)}
        </ul>
      </div>
      <p className="auth-story-caption"><span aria-hidden="true" />让目标、行动与成果，在这里连接。</p>
    </section>
    <div className="auth-entry-column">{children}<p className="auth-entry-caption">TIANSHU LAB <span>·</span> 让创新有迹可循</p></div>
  </main>
}
