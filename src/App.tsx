import { useCallback, useEffect, useState } from 'react'
import {
  ArrowRight,
  CalendarDays,
  ChartNoAxesCombined,
  Check,
  ClipboardList,
  FlaskConical,
  FolderKanban,
  Goal,
  LogOut,
  Menu,
  Users,
  FileText,
  LoaderCircle,
} from 'lucide-react'
import type { Bootstrap } from '../shared/types'
import { api, json, ApiError } from './api'
import { Field, Form, Modal } from './ui'
import Overview from './pages/Overview'
import Monthly from './pages/Monthly'
import Weekly from './pages/Weekly'
import Projects from './pages/Projects'
import Goals from './pages/Goals'
import Team from './pages/Team'
import Reports from './pages/Reports'

const navigation = [
  { id: 'overview', label: '部门概览', icon: ChartNoAxesCombined },
  { id: 'monthly', label: '月度计划', icon: CalendarDays },
  { id: 'weekly', label: '每周执行', icon: ClipboardList },
  { id: 'projects', label: '项目档案', icon: FolderKanban },
  { id: 'goals', label: '年度目标', icon: Goal },
  { id: 'reports', label: '报告中心', icon: FileText, manager: true },
  { id: 'team', label: '团队成员', icon: Users, manager: true },
]
export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null),
    [loading, setLoading] = useState(true),
    [initialized, setInitialized] = useState(true)
  const [page, setPage] = useState('overview'),
    [toast, setToast] = useState(''),
    [fatal, setFatal] = useState(''),
    [mobileOpen, setMobileOpen] = useState(false)
  const [reportDirty, setReportDirty] = useState(false)
  const [pendingLeave, setPendingLeave] = useState<
    { page: string } | 'logout' | null
  >(null)
  const refresh = useCallback(async () => {
    setData(await api<Bootstrap>('/bootstrap'))
  }, [])
  function navigate(next: string) {
    if (next === page) {
      setMobileOpen(false)
      return
    }
    if (reportDirty) {
      setPendingLeave({ page: next })
      return
    }
    setPage(next)
    setMobileOpen(false)
  }
  async function logout() {
    try {
      await api('/auth/logout', { method: 'POST' })
      setData(null)
      setPage('overview')
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
      setPage(target.page)
      setMobileOpen(false)
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
  if (loading)
    return (
      <div className="app-loading">
        <FlaskConical size={34} />
        <LoaderCircle className="spin" size={22} />
        <p>正在读取工作空间</p>
      </div>
    )
  if (fatal)
    return (
      <div className="app-loading">
        <h2>暂时无法连接工作空间</h2>
        <p role="alert">{fatal}</p>
        <button className="button primary" onClick={() => void start()}>
          重新连接
        </button>
      </div>
    )
  if (!data)
    return (
      <div className="auth-page">
        <section className="auth-story">
          <div className="brand">
            <FlaskConical />
            <span>
              人工智能实验室<small>LAB / PLANNING</small>
            </span>
          </div>
          <div className="auth-copy">
            <div className="eyebrow">从方向到每周的进展</div>
            <h1>
              让每一份努力，
              <br />
              成为看得见的成果。
            </h1>
            <p>
              成员提报月计划，负责人审核发布。
              <br />
              每周记录进展，以真实成果形成部门汇报。
            </p>
            <div className="auth-steps">
              <span>01 月度承诺</span>
              <ArrowRight size={16} />
              <span>02 每周执行</span>
              <ArrowRight size={16} />
              <span>03 成果汇报</span>
            </div>
          </div>
          <small>人工智能实验室 · 部门计划协作平台</small>
        </section>
        <section className="auth-form">
          <div className="eyebrow">
            {initialized ? 'WELCOME BACK' : '建立你的工作空间'}
          </div>
          <h2>{initialized ? '登录工作空间' : '设置首位管理员'}</h2>
          <p>
            {initialized
              ? '继续推进团队本周的工作。'
              : '创建管理员后，可以添加成员开始提报月计划。'}
          </p>
          <Form
            submitLabel={initialized ? '登录' : '创建工作空间'}
            onSubmit={async (event) => {
              const values = Object.fromEntries(
                new FormData(event.currentTarget),
              )
              await api(
                initialized ? '/auth/login' : '/auth/setup',
                json(values),
              )
              setInitialized(true)
              await refresh()
            }}
          >
            {!initialized && (
              <Field label="姓名">
                <input
                  name="name"
                  autoComplete="name"
                  required
                  maxLength={80}
                />
              </Field>
            )}
            <Field label="邮箱">
              <input
                name="email"
                type="email"
                autoComplete="username"
                placeholder="you@company.com"
                required
              />
            </Field>
            <Field
              label="密码"
              hint={
                !initialized
                  ? '至少 10 位，建议使用字母、数字和符号组合。'
                  : undefined
              }
            >
              <input
                name="password"
                type="password"
                autoComplete={initialized ? 'current-password' : 'new-password'}
                minLength={initialized ? undefined : 10}
                required
              />
            </Field>
          </Form>
        </section>
      </div>
    )
  const manager = data.user.role === 'manager'
  const props = { data, refresh, notify: setToast }
  const route = {
    overview: <Overview {...props} navigate={navigate} />,
    monthly: <Monthly {...props} />,
    weekly: <Weekly {...props} />,
    projects: <Projects {...props} />,
    goals: <Goals {...props} />,
    reports: manager ? (
      <Reports {...props} onDirtyChange={setReportDirty} />
    ) : null,
    team: manager ? <Team {...props} /> : null,
  }[page] || <Overview {...props} navigate={navigate} />
  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileOpen ? 'open' : ''}`}>
        <div className="brand">
          <FlaskConical size={29} />
          <span>
            人工智能实验室<small>LAB / PLANNING</small>
          </span>
        </div>
        <div className="workspace-label">部门工作空间</div>
        <nav aria-label="主导航">
          {navigation
            .filter((item) => !item.manager || manager)
            .map((item) => (
              <button
                key={item.id}
                className={`nav-item ${page === item.id ? 'active' : ''}`}
                onClick={() => navigate(item.id)}
              >
                <item.icon size={19} />
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
        </nav>
        <div className="sidebar-note">
          <span className="status-dot" />
          以真实进展，沉淀部门成果<p>计划有来源 · 调整有记录</p>
        </div>
        <div className="profile">
          <div className="avatar">{data.user.name.slice(-2)}</div>
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
            <LogOut size={17} />
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
          <div>
            <button
              className="icon-button mobile-menu"
              aria-label="打开导航"
              onClick={() => setMobileOpen(!mobileOpen)}
            >
              <Menu size={22} />
            </button>
            <span className="breadcrumb">
              工作空间 <span>/</span>{' '}
              {navigation.find((item) => item.id === page)?.label}
            </span>
          </div>
          <time>
            {new Date().toLocaleDateString('zh-CN', {
              year: 'numeric',
              month: 'long',
              day: 'numeric',
              weekday: 'long',
            })}
          </time>
        </div>
        <main key={page}>{route}</main>
        <footer className="workspace-footer">
          LAB PLANNING <span>计划连贯，协作有序。</span>
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
