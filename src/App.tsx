import { useCallback, useEffect, useState } from 'react'
import {
  Check,
  LoaderCircle,
} from 'lucide-react'
import type { Bootstrap } from '../shared/types'
import type { Navigate, NavigationIntent, PageId } from './navigation'
import { api, ApiError } from './api'
import ArcoModal from '@arco-design/web-react/es/Modal'
import AuthAccess from './components/AuthAccess'
import WorkspaceShell from './components/WorkspaceShell'
import Brand from './components/WorkspaceBrand'
import Overview from './pages/Overview'
import Monthly from './pages/Monthly'
import Weekly from './pages/Weekly'
import Projects from './pages/Projects'
import Goals from './pages/Goals'
import Team from './pages/Team'
import Reports from './pages/Reports'
import Imports from './pages/Imports'
import './shell.css'

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null),
    [loading, setLoading] = useState(true),
    [initialized, setInitialized] = useState(true)
  const [page, setPage] = useState<PageId>('overview'),
    [intent, setIntent] = useState<NavigationIntent>(),
    [navigationKey, setNavigationKey] = useState(0)
  const [toast, setToast] = useState(''),
    [fatal, setFatal] = useState('')
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
  }
  const navigate: Navigate = (next, nextIntent) => {
    if (data?.user.role !== 'manager' && ['reports', 'team'].includes(next)) {
      setToast('当前账号没有访问此页面的权限。')
      return
    }
    if (next === page && !nextIntent) {
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
            <h1>部门工作空间</h1>
            <p>管理实验室的目标、项目与工作记录。</p>
            <dl className="auth-workflow">
              <div><dt>月度目标</dt><dd>确定交付内容、负责人和验收标准</dd></div>
              <div><dt>每周执行</dt><dd>安排本周任务，提交进展与问题</dd></div>
              <div><dt>成果汇报</dt><dd>汇总执行记录，保存报告版本</dd></div>
            </dl>
          </div>
        </section>
        <AuthAccess initialized={initialized} onLogin={async () => { setInitialized(true); await refresh() }} />
      </div>
    )
  const manager = data.user.role === 'manager'
  const props = { data, refresh, notify: setToast, intent }
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
    <>
      <WorkspaceShell data={data} page={page} navigate={navigate} leaveConfirmationOpen={!!pendingLeave} onLogout={() => {
        if (reportDirty) setPendingLeave('logout')
        else void logout()
      }}>
        <div key={`${page}-${navigationKey}`}>{route}</div>
      </WorkspaceShell>
      <ArcoModal title="汇报编辑尚未保存" visible={!!pendingLeave} className="workspace-leave-modal"
        onCancel={() => setPendingLeave(null)} onOk={() => void leaveWithoutSaving()}
        cancelText="继续编辑" okText="放弃编辑并离开" maskClosable={false} focusLock autoFocus
        style={{ width: 460, maxWidth: 'calc(100vw - 32px)' }}>
        <p>当前汇报包含未保存的修改。继续离开将放弃这些编辑，已经保存的报告版本不受影响。</p>
      </ArcoModal>
      {toast && (
        <div className="toast" role="status">
          <Check size={18} />
          {toast}
        </div>
      )}
    </>
  )
}
