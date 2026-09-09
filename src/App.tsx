import { useCallback, useEffect, useState } from 'react'
import {
  ArrowRight,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ClipboardList,
  FolderKanban,
  Goal,
  LogOut,
  Menu,
  Users,
  FileText,
  FileInput,
  LoaderCircle,
  UserRound,
  X,
} from 'lucide-react'
import type { Bootstrap } from '../shared/types'
import type { Navigate, NavigationIntent, PageId } from './navigation'
import { api, ApiError } from './api'
import { Modal, currentMonth, monday, localDate } from './ui'
import AuthAccess from './components/AuthAccess'
import WorkspaceSearch from './components/WorkspaceSearch'
import Overview from './pages/Overview'
import Monthly from './pages/Monthly'
import Weekly from './pages/Weekly'
import Projects from './pages/Projects'
import Goals from './pages/Goals'
import Team from './pages/Team'
import Reports from './pages/Reports'
import Imports from './pages/Imports'
import labIcon from './assets/lab-icon.png'
import labWordmark from './assets/lab-wordmark.png'
import './shell.css'

const navigation = [
  {
    id: 'overview' as const,
    label: '部门概览',
    group: '规划',
    icon: ChartNoAxesCombined,
  },
  {
    id: 'monthly' as const,
    label: '月度计划',
    group: '规划',
    icon: CalendarDays,
  },
  {
    id: 'weekly' as const,
    label: '每周执行',
    group: '规划',
    icon: ClipboardList,
  },
  { id: 'goals' as const, label: '年度目标', group: '规划', icon: Goal },
  {
    id: 'projects' as const,
    label: '项目档案',
    group: '资产',
    icon: FolderKanban,
  },
  {
    id: 'imports' as const,
    label: '数据导入',
    group: '资产',
    icon: FileInput,
  },
  {
    id: 'reports' as const,
    label: '报告中心',
    group: '资产',
    icon: FileText,
    manager: true,
  },
  {
    id: 'team' as const,
    label: '成员管理',
    group: '团队',
    icon: Users,
    manager: true,
  },
]
function Brand({ wordmark = false }: { wordmark?: boolean }) {
  if (wordmark)
    return (
      <div className="brand-wordmark">
        <img src={labWordmark} alt="天枢实验室 TIANSHU LAB" />
        <span>部门工作空间</span>
      </div>
    )
  return (
    <div className="brand">
      <span className="brand-icon">
        <img src={labIcon} alt="" />
      </span>
      <span>天枢实验室</span>
    </div>
  )
}
export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null),
    [loading, setLoading] = useState(true),
    [initialized, setInitialized] = useState(true)
  const [page, setPage] = useState<PageId>('overview'),
    [intent, setIntent] = useState<NavigationIntent>(),
    [navigationKey, setNavigationKey] = useState(0)
  const [toast, setToast] = useState(''),
    [fatal, setFatal] = useState(''),
    [mobileOpen, setMobileOpen] = useState(false)
  const [reportDirty, setReportDirty] = useState(false)
  const [pendingLeave, setPendingLeave] = useState<
    { page: PageId; intent?: NavigationIntent } | 'logout' | null
  >(null)
  const refresh = useCallback(async () => {
    setData(await api<Bootstrap>('/bootstrap'))
  }, [])
  function applyNavigation(next: PageId, nextIntent?: NavigationIntent) {
    setPage(next)
    setIntent(nextIntent)
    setNavigationKey((value) => value + 1)
    setMobileOpen(false)
  }
  const navigate: Navigate = (next, nextIntent) => {
    if (data?.user.role !== 'manager' && ['reports', 'team'].includes(next)) {
      setToast('当前账号没有访问此页面的权限。')
      return
    }
    if (next === page && !nextIntent) {
      setMobileOpen(false)
      return
    }
    if (reportDirty) {
      setPendingLeave({ page: next, intent: nextIntent })
      return
    }
    applyNavigation(next, nextIntent)
  }
  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' })
      setData(null)
      setPage('overview')
      setIntent(undefined)
      setReportDirty(false)
      setMobileOpen(false)
    } catch (e) {
      setToast(e instanceof Error ? e.message : '退出失败')
    }
  }
  async function leaveWithoutSaving() {
    const target = pendingLeave
    setPendingLeave(null)
    if (target === 'logout') await logout()
    else if (target) {
      setReportDirty(false)
      applyNavigation(target.page, target.intent)
    }
  }
  async function start() {
    setLoading(true)
    setFatal('')
    try {
      const status = await api<{ initialized: boolean }>('/auth/status')
      setInitialized(status.initialized)
      if (status.initialized) {
        try {
          await api('/auth/me')
          await refresh()
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) setData(null)
          else throw error
        }
      }
    } catch (e) {
      setFatal(e instanceof Error ? e.message : '服务连接失败')
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => {
    void start()
  }, [])
  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 4500)
    return () => clearTimeout(timer)
  }, [toast])
  useEffect(() => {
    if (!mobileOpen) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMobileOpen(false)
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [mobileOpen])
  if (loading)
    return (
      <div className="shell-light app-loading">
        <Brand />
        <LoaderCircle className="spin" size={22} />
        <p>正在读取工作空间</p>
      </div>
    )
  if (fatal)
    return (
      <div className="shell-light app-loading">
        <Brand />
        <h2>暂时无法连接工作空间</h2>
        <p role="alert">{fatal}</p>
        <button className="button primary" onClick={() => void start()}>
          重新连接
        </button>
      </div>
    )
  if (!data)
    return (
      <div className="shell-light auth-page">
        <section className="auth-story">
          <Brand wordmark />
          <div className="auth-copy">
            <span className="auth-kicker">
              <span />
              一起把计划，变成成果
            </span>
            <h1>
              有方向的计划，
              <br />
              有记录的每一步。
            </h1>
            <p>
              从月度共识到每周推进，
              <br />
              让每一次协作都有清晰的目标和真实的反馈。
            </p>
            <div className="auth-steps">
              <span>
                <CalendarDays size={19} />
                月度计划<small>明确承诺</small>
              </span>
              <ArrowRight size={15} />
              <span>
                <ClipboardList size={19} />
                每周执行<small>记录进展</small>
              </span>
              <ArrowRight size={15} />
              <span>
                <FileText size={19} />
                成果汇报<small>沉淀价值</small>
              </span>
            </div>
          </div>
          <small className="auth-story-footer">
            TIANSHU LAB <span>让团队的工作，连贯而有序。</span>
          </small>
        </section>
        <AuthAccess initialized={initialized} onLogin={async () => { setInitialized(true); await refresh() }} />
      </div>
    )
  const manager = data.user.role === 'manager'
  const props = { data, refresh, notify: setToast, intent }
  const visibleNavigation = navigation.filter(
    (item) => !item.manager || manager,
  )
  const route = {
    overview: <Overview {...props} navigate={navigate} />,
    monthly: <Monthly {...props} />,
    weekly: <Weekly {...props} />,
    projects: <Projects {...props} />,
    goals: <Goals {...props} />,
    imports: <Imports {...props} navigate={navigate} />,
    reports: manager ? (
      <Reports {...props} onDirtyChange={setReportDirty} />
    ) : null,
    team: manager ? <Team {...props} /> : null,
  }[page] || <Overview {...props} navigate={navigate} />
  return (
    <div className="shell-light app-shell">
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <div className="sidebar-brand-row">
          <Brand />
          <button
            type="button"
            className="icon-button sidebar-close"
            aria-label="关闭导航"
            onClick={() => setMobileOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <nav aria-label="主导航">
          {['规划', '资产', '团队'].map((group) => {
            const items = visibleNavigation.filter(
              (item) => item.group === group,
            )
            if (!items.length) return null
            return (
              <div className="nav-group" key={group}>
                <div className="nav-group-label">{group}</div>
                {items.map((item) => (
                  <button
                    key={item.id}
                    aria-current={page === item.id ? 'page' : undefined}
                    className={`nav-item ${page === item.id ? 'active' : ''}`}
                    onClick={() => navigate(item.id)}
                  >
                    <item.icon size={18} />
                    <span>
                      {!manager && item.id === 'overview'
                        ? '我的工作台'
                        : !manager && item.id === 'monthly'
                          ? '我的月计划'
                          : !manager && item.id === 'weekly'
                            ? '我的周计划'
                            : item.label}
                    </span>
                    {page === item.id && <span className="nav-dot" />}
                  </button>
                ))}
              </div>
            )
          })}
        </nav>
        <div className="sidebar-note">
          <span className="status-dot" />
          计划有来源，协作有记录
        </div>
        <div className="profile">
          <span className="profile-mark">
            <UserRound size={20} />
          </span>
          <div>
            <strong>{data.user.name}</strong>
            <small>
              {manager ? '部门管理员' : data.user.position || '团队成员'}
            </small>
          </div>
          <button
            className="icon-button"
            aria-label="退出登录"
            onClick={() => {
              if (reportDirty) setPendingLeave('logout')
              else void logout()
            }}
          >
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      {mobileOpen && (
        <button
          className="mobile-shade"
          aria-label="关闭导航"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <div className="main-workspace">
        <div className="topbar">
          <div className="topbar-search-area">
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              <Menu size={21} />
            </button>
            <WorkspaceSearch data={data} navigate={navigate} />
          </div>
          <div className="topbar-actions">
            <time dateTime={localDate()}>
              {new Date().toLocaleDateString('zh-CN', {
                month: 'long',
                day: 'numeric',
                weekday: 'short',
              })}
            </time>
            <button
              className="button primary topbar-primary"
              onClick={() =>
                navigate(
                  manager ? 'monthly' : 'weekly',
                  manager
                    ? {
                        action: 'review',
                        month: currentMonth(),
                        status: 'submitted',
                      }
                    : { action: 'create', weekStart: monday() },
                )
              }
            >
              {manager ? <Check size={16} /> : <CalendarDays size={16} />}
              <span>{manager ? '审核月度计划' : '安排本周工作'}</span>
            </button>
          </div>
        </div>
        <main key={`${page}-${navigationKey}`}>{route}</main>
        <footer className="workspace-footer">
          TIANSHU LAB <span>计划清晰，协作有序。</span>
        </footer>
      </div>
      {pendingLeave && (
        <Modal title="汇报编辑尚未保存" onClose={() => setPendingLeave(null)}>
          <p className="modal-intro">
            当前汇报包含未保存的修改。继续离开将放弃这些编辑，已经保存的报告版本不受影响。
          </p>
          <div className="form-footer">
            <button
              className="button secondary"
              onClick={() => setPendingLeave(null)}
            >
              继续编辑
            </button>
            <button
              className="button primary"
              onClick={() => void leaveWithoutSaving()}
            >
              放弃编辑并离开
            </button>
          </div>
        </Modal>
      )}
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
        </div>
      )}
    </div>
  )
}
