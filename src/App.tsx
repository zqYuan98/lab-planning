import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  LoaderCircle,
} from 'lucide-react'
import type { Bootstrap } from '../shared/types'
import type { Navigate, NavigationIntent, PageId } from './navigation'
import { api, ApiError } from './api'
import ArcoModal from '@arco-design/web-react/es/Modal'
import AuthAccess from './components/AuthAccess'
import AuthLanding from './components/AuthLanding'
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
import Messages from './pages/Messages'
import NotificationSettings from './pages/NotificationSettings'
import WorkFollowups from './pages/WorkFollowups'
import WorkRegister from './pages/WorkRegister'
import Feedback from './pages/Feedback'
import FeedbackComposer from './components/FeedbackComposer'
import PageErrorBoundary from './components/PageErrorBoundary'
import type { FeedbackContext } from '../shared/feedback'
import { allowDraftLeave } from './draft-recovery'
import { appVersion, latestClientError, clearClientError, safeFeedbackPath } from './error-context'
import { entryLocation, navigationUrl } from './notification-navigation'
import { entryAppLink, exchangeDingTalk, identityThenWorkspace, isDingTalk } from './dingtalk-access'
import './shell.css'
import './notifications.css'

const managerPages = new Set<PageId>(['reports', 'team', 'notification-settings'])

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null),
    [loading, setLoading] = useState(true),
    [initialized, setInitialized] = useState(true)
  const [page, setPage] = useState<PageId>(() => entryLocation(window.location).page),
    [intent, setIntent] = useState<NavigationIntent | undefined>(() => entryLocation(window.location).intent),
    [navigationKey, setNavigationKey] = useState(0)
  const [toast, setToast] = useState(''),
    [fatal, setFatal] = useState('')
  const [reportDirty, setReportDirty] = useState(false)
  const [unreadCount, setUnreadCount] = useState(0)
  const [feedbackContext, setFeedbackContext] = useState<FeedbackContext | null>(null)
  const feedbackTrigger = useRef<HTMLElement | null>(null)
  const feedbackUser = useRef<string | undefined>(undefined)
  const [dingTalkNotice, setDingTalkNotice] = useState('')
  const [dingTalkBusy, setDingTalkBusy] = useState(false)
  const [ordinaryLogin, setOrdinaryLogin] = useState(() => !isDingTalk())
  const [dingTalkConflict, setDingTalkConflict] = useState(false)
  const [appLink, setAppLink] = useState<string>()
  const identitySequence = useRef(0)
  const started = useRef(false)
  const [pendingLeave, setPendingLeave] = useState<
    { page: PageId; intent?: NavigationIntent } | 'logout' | null
  >(null)
  const refresh = useCallback(async () => {
    const sequence = identitySequence.current, next = await api<Bootstrap>('/bootstrap')
    if (sequence === identitySequence.current) setData(next)
  }, [])
  const sessionChanged = useCallback(async () => {
    try { await refresh() }
    catch (error) {
      if (error instanceof ApiError && error.status === 401) { setData(null); setDingTalkNotice('请重新登录团队账号。') }
      else throw error
    }
  }, [refresh])
  function applyNavigation(next: PageId, nextIntent?: NavigationIntent, writeHistory = true) {
    // Reset before rendering so destination-specific anchors can still scroll into view.
    if (next !== page) window.scrollTo({ top: 0, behavior: 'instant' })
    setPage(next)
    setIntent(nextIntent)
    setNavigationKey((value) => value + 1)
    if (writeHistory) window.history.pushState(null, '', navigationUrl(next, nextIntent))
  }
  const navigate: Navigate = (next, nextIntent) => {
    if (data?.user.role !== 'manager' && managerPages.has(next)) {
      setToast('当前账号没有访问此页面的权限。')
      return
    }
    if (next === page && !nextIntent && !intent) {
      return
    }
    if (!allowDraftLeave()) return
    if (reportDirty) {
      setPendingLeave({ page: next, intent: nextIntent })
      return
    }
    applyNavigation(next, nextIntent)
  }
  async function logout() {
    identitySequence.current++
    try {
      await api('/auth/logout', { method: 'POST' })
      setData(null)
      setUnreadCount(0)
      setReportDirty(false)
      setFeedbackContext(null)
      clearClientError()
    } catch (e) {
      setToast(e instanceof Error ? e.message : '退出失败')
    }
  }
  async function dingTalkLogin() {
    const sequence = ++identitySequence.current
    setData(null); setOrdinaryLogin(false); setDingTalkConflict(false)
    setDingTalkBusy(true); setDingTalkNotice('正在验证钉钉身份…')
    try {
      const result = await identityThenWorkspace({ dingTalk: true, verify: exchangeDingTalk, normalSession: async () => {}, load: () => api<Bootstrap>('/bootstrap') })
      if (sequence !== identitySequence.current) return
      if (result.data) { setData(result.data); setDingTalkNotice('') }
      else if (result.bindingRequired) setDingTalkNotice('钉钉身份已验证。请先登录已开通的团队账号，再确认本人身份并完成绑定。')
      else setDingTalkNotice('请使用团队账号登录。')
    } catch (error) {
      if (sequence !== identitySequence.current) return
      setDingTalkConflict(error instanceof ApiError && error.status === 409)
      setDingTalkNotice(error instanceof Error ? error.message : '钉钉验证失败，请使用账号登录。')
    } finally { if (sequence === identitySequence.current) setDingTalkBusy(false) }
  }
  async function chooseOrdinaryLogin() {
    identitySequence.current++
    setDingTalkBusy(true)
    try {
      await api('/auth/logout', { method: 'POST' })
      identitySequence.current++
      setData(null); setOrdinaryLogin(true); setDingTalkConflict(false)
      setDingTalkNotice('正在使用普通团队账号登录；此方式不代表当前钉钉身份已核验。')
    } catch { setDingTalkNotice('暂时无法退出原账号，请重试。') }
    finally { setDingTalkBusy(false) }
  }
  async function switchDingTalkIdentity() {
    identitySequence.current++
    setData(null)
    setDingTalkBusy(true)
    try { await api('/auth/logout', { method: 'POST' }); await dingTalkLogin() }
    catch { setDingTalkNotice('切换身份失败，请重试。'); setDingTalkBusy(false) }
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
        if (isDingTalk()) { await dingTalkLogin(); return }
        try {
          const result = await identityThenWorkspace({ dingTalk: false, verify: exchangeDingTalk, normalSession: () => api('/auth/me'), load: () => api<Bootstrap>('/bootstrap') })
          setData(result.data ?? null)
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            setData(null)
          }
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
    if (started.current) return
    started.current = true
    void start()
    void entryAppLink(window.location).then(setAppLink).catch(() => {})
  }, [])
  useEffect(() => {
    const back = () => {
      const destination = entryLocation(window.location)
      if (!allowDraftLeave()) {
        window.history.pushState(null, '', navigationUrl(page, intent))
        return
      }
      if (reportDirty) {
        setPendingLeave(destination)
        window.history.pushState(null, '', navigationUrl(page, intent))
      } else applyNavigation(destination.page, destination.intent, false)
    }
    window.addEventListener('popstate', back)
    return () => window.removeEventListener('popstate', back)
  }, [reportDirty, page, intent])
  useEffect(() => {
    if (!data || data.user.role === 'manager' || !managerPages.has(page)) return
    // An old bookmark or account switch must not leave an inaccessible page title in the shell.
    setPage('overview')
    setIntent(undefined)
    setNavigationKey(value => value + 1)
    window.history.replaceState(null, '', navigationUrl('overview'))
    window.scrollTo({ top: 0, behavior: 'instant' })
  }, [data?.user.role, page])
  function openFeedback() {
    if (!data) return
    feedbackTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const recent = latestClientError()
    setFeedbackContext({ path: safeFeedbackPath(window.location.pathname, window.location.search), appVersion,
      userAgent: navigator.userAgent.slice(0, 250), viewport: `${window.innerWidth} × ${window.innerHeight}`,
      ...(recent?.requestId ? { errorRequestId: recent.requestId } : {}) })
  }
  function closeFeedback() {
    setFeedbackContext(null)
    requestAnimationFrame(() => { if (feedbackTrigger.current?.isConnected) feedbackTrigger.current.focus() })
  }
  useEffect(() => {
    if (feedbackUser.current !== data?.user.id) { setFeedbackContext(null); clearClientError() }
    feedbackUser.current = data?.user.id
  }, [data?.user.id])
  useEffect(() => {
    const open = () => openFeedback()
    const login = () => { identitySequence.current++; setData(null); setFeedbackContext(null); setOrdinaryLogin(true); setDingTalkNotice('请重新登录。已暂存的草稿可在返回原表单后恢复。') }
    window.addEventListener('workspace-feedback', open)
    window.addEventListener('workspace-login-expired', login)
    return () => { window.removeEventListener('workspace-feedback', open); window.removeEventListener('workspace-login-expired', login) }
  }, [data?.user.id])
  useEffect(() => {
    if (!data) return
    let live = true
    const update = () => {
      if (document.visibilityState === 'hidden') return
      void api<{ unreadCount: number }>('/notifications').then(result => live && setUnreadCount(result.unreadCount)).catch(() => { /* Inbox shows actionable read errors. */ })
    }
    update()
    const timer = window.setInterval(update, 60000)
    document.addEventListener('visibilitychange', update)
    return () => { live = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', update) }
  }, [data?.user.id])
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
      <AuthLanding>
          {(dingTalkNotice || isDingTalk()) && <div className="dingtalk-auth-notice" role="status">
            <p>{dingTalkNotice || '可验证钉钉身份进入工作空间，也可使用团队账号登录。'}</p>
            <button className="button secondary" disabled={dingTalkBusy} onClick={() => void dingTalkLogin()}>{dingTalkBusy ? '正在验证…' : '重新验证钉钉身份'}</button>
            {dingTalkConflict && <button className="button secondary" disabled={dingTalkBusy} onClick={() => void switchDingTalkIdentity()}>退出原账号并切换为当前钉钉身份</button>}
            {!ordinaryLogin && <button className="button secondary" disabled={dingTalkBusy} onClick={() => void chooseOrdinaryLogin()}>改用普通团队账号登录</button>}
          </div>}
          {appLink && <a className="button secondary" href={appLink}>在钉钉中打开此事项</a>}
          {(ordinaryLogin || !initialized) && !dingTalkBusy && <AuthAccess initialized={initialized} onLogin={async () => {
            identitySequence.current++; setInitialized(true); await refresh()
            if (isDingTalk() && page === 'overview') applyNavigation('messages')
          }} />}
      </AuthLanding>
    )
  const manager = data.user.role === 'manager'
  const props = { data, refresh, notify: setToast, intent }
  const route = {
    overview: <Overview {...props} navigate={navigate} />,
    monthly: <Monthly {...props} navigate={navigate} />,
    weekly: <Weekly {...props} navigate={navigate} />,
    collaboration: <WorkFollowups {...props} navigate={navigate} />,
    'work-register': <WorkRegister {...props} navigate={navigate} />,
    feedback: <Feedback {...props} navigate={navigate} onCreate={openFeedback} />,
    projects: <Projects {...props} />,
    goals: <Goals {...props} />,
    imports: <Imports {...props} navigate={navigate} />,
    messages: <Messages {...props} navigate={navigate} onUnreadChange={setUnreadCount} onSessionChanged={sessionChanged} />,
    'notification-settings': manager ? <NotificationSettings {...props} /> : null,
    reports: manager ? (
      <Reports {...props} onDirtyChange={setReportDirty} />
    ) : null,
    team: manager ? <Team {...props} /> : null,
  }[page] || <Overview {...props} navigate={navigate} />
  return (
    <>
      <div inert={!!feedbackContext || undefined}>
      <WorkspaceShell data={data} page={page} navigate={navigate} unreadCount={unreadCount} onFeedback={openFeedback} leaveConfirmationOpen={!!pendingLeave} onLogout={() => {
        if (!allowDraftLeave()) return
        if (reportDirty) setPendingLeave('logout')
        else void logout()
      }}>
        {ordinaryLogin && isDingTalk() && <div className="dingtalk-auth-notice" role="status">普通账号登录，当前钉钉身份尚未核验。<button className="button secondary" disabled={dingTalkBusy} onClick={() => void dingTalkLogin()}>验证当前钉钉身份</button></div>}
        <PageErrorBoundary key={`${data.user.id}:${page}-${navigationKey}`}>{route}</PageErrorBoundary>
      </WorkspaceShell>
      </div>
      {feedbackContext && <FeedbackComposer key={data.user.id} data={data} context={feedbackContext}
        onClose={closeFeedback} onCreated={id => { setFeedbackContext(null); navigate('feedback', { id }) }} />}
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
