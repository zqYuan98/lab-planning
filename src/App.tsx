import { PageReloadContext, retryableLazy } from './components/LazyPage'
import { Modal } from './ui'
import { validTaskIntent, type OpenTaskIntent } from './navigation'
import { setDraftSession } from './draft-v3'
import './delivery-management.css'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Check,
  LoaderCircle,
} from 'lucide-react'
import type { Bootstrap } from '../shared/types'
import type { Navigate, NavigationIntent, PageId } from './navigation'
import { api, ApiError } from './api'
import { LatestRead, StaleReadError } from './latest-read'
import { advanceMutationContext, captureMutationContext, MutationContextChangedError, readInMutationContext, subscribeMutationResponses } from './mutation-response'
import { bindSessionActor, subscribeSessionIdentityChanges } from './session-identity'
import { mutationEntities } from './workspace-response'
import { shellAffected } from './query-invalidation'
import ArcoModal from '@arco-design/web-react/es/Modal'
import AuthAccess from './components/AuthAccess'
import AuthLanding from './components/AuthLanding'
import WorkspaceShell from './components/WorkspaceShell'
import Brand from './components/WorkspaceBrand'
import type { WorkspaceShellData } from '../shared/workspace-query'
import { shellBootstrap } from './workspace-query'
import PageErrorBoundary from './components/PageErrorBoundary'
import type { FeedbackContext } from '../shared/feedback'
import { allowDraftLeave } from './draft-recovery'
import { appVersion, latestClientError, clearClientError, safeFeedbackPath } from './error-context'
import { useUsageAnalytics } from './usage-analytics'
import { entryLocation, navigationUrl } from './notification-navigation'
import { entryAppLink, exchangeDingTalk, identityThenWorkspace, isDingTalk } from './dingtalk-access'
import './shell.css'
import './notifications.css'

const Overview = retryableLazy(() => import('./pages/Overview'))
const Monthly = retryableLazy(() => import('./pages/Monthly'))
const Weekly = retryableLazy(() => import('./pages/Weekly'))
const Projects = retryableLazy(() => import('./pages/Projects'))
const Goals = retryableLazy(() => import('./pages/Goals'))
const Team = retryableLazy(() => import('./pages/Team'))
const Reports = retryableLazy(() => import('./pages/Reports'))
const Imports = retryableLazy(() => import('./pages/Imports'))
const Messages = retryableLazy(() => import('./pages/Messages'))
const NotificationSettings = retryableLazy(() => import('./pages/NotificationSettings'))
const WorkFollowups = retryableLazy(() => import('./pages/WorkFollowups'))
const WorkRegister = retryableLazy(() => import('./pages/WorkRegister'))
const PeriodReviews = retryableLazy(() => import('./pages/PeriodReviews'))
const AuthorizedWork = retryableLazy(() => import('./pages/AuthorizedWork'))
const Feedback = retryableLazy(() => import('./pages/Feedback'))
const WorkTaskPanel = retryableLazy(() => import('./components/WorkTaskPanel'), {
  fallback: (children, props) => <Modal title="任务详情" onClose={props.onClose}>{children}</Modal>,
})
const FeedbackComposer = retryableLazy(() => import('./components/FeedbackComposer'), {
  fallback: (children, props) => <Modal title="反馈问题" onClose={props.onClose}>{children}</Modal>,
})
const MinimalSupportPanel = retryableLazy(async () => ({ default: (await import('./components/TaskSupport')).MinimalSupportPanel }), {
  fallback: (children, props) => <Modal title="支持事项" onClose={props.onClose}>{children}</Modal>,
})
const managerPages = new Set<PageId>(['reports', 'team', 'notification-settings'])
const pageModules: Record<PageId, { preload: () => void }> = {
  overview: Overview, monthly: Monthly, weekly: Weekly, projects: Projects, goals: Goals, team: Team, reports: Reports, imports: Imports,
  messages: Messages, 'notification-settings': NotificationSettings, collaboration: WorkFollowups, 'work-register': WorkRegister,
  'period-reviews': PeriodReviews, 'authorized-work': AuthorizedWork, feedback: Feedback,
}

export default function App() {
  const [data, setData] = useState<Bootstrap | null>(null),
    [loading, setLoading] = useState(true),
    [initialized, setInitialized] = useState(true)
  const [page, setPage] = useState<PageId>(() => entryLocation(window.location).page),
    [intent, setIntent] = useState<NavigationIntent | undefined>(() => entryLocation(window.location).intent),
    [navigationKey, setNavigationKey] = useState(0)
  useUsageAnalytics(data?.user, page)
  const [taskIntent,setTaskIntent] = useState<OpenTaskIntent|null>(null)
  const [supportIntent,setSupportIntent] = useState<string|null>(null)
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
  const mounted = useRef(true)
  const currentData = useRef<Bootstrap | null>(null)
  const workspaceRead = useRef<LatestRead<Bootstrap> | null>(null)
  if (!workspaceRead.current) workspaceRead.current = new LatestRead({
    load: async signal => shellBootstrap(await api<WorkspaceShellData>('/workspace', { signal }), currentData.current),
    accept: next => {
      const previous = currentData.current
      const scopeChanged = previous && (previous.user.id !== next.user.id || previous.user.role !== next.user.role || previous.operationEpoch !== next.operationEpoch || previous.accessScopeVersion !== next.accessScopeVersion)
      if (scopeChanged) { advanceMutationContext(); setTaskIntent(null); setSupportIntent(null) }
      if (!scopeChanged && previous && next.user.version < previous.user.version) throw new StaleReadError()
      setDraftSession({userId:next.user.id,operationEpoch:next.operationEpoch||''})
      bindSessionActor(next.user.id)
      currentData.current = next; setData(next)
    },
    error: error => {
      if (error instanceof ApiError && [401,403].includes(error.status)) {
        identitySequence.current++; advanceMutationContext(); workspaceRead.current!.reset()
        currentData.current = null; bindSessionActor(null); setDraftSession(null); setTaskIntent(null); setSupportIntent(null); setData(null); setLoading(false)
        setDingTalkNotice('登录已过期或账号不可用，请重新登录。已暂存的草稿仍保留。')
      } else if (error) setToast(error instanceof Error ? error.message : '工作空间刷新失败，请重试。')
    },
  })
  const [pendingLeave, setPendingLeave] = useState<
    { page: PageId; intent?: NavigationIntent } | 'logout' | 'reload' | null
  >(null)
  const refresh = useCallback(async () => {
    if (!mounted.current) throw new MutationContextChangedError()
    await readInMutationContext(() => workspaceRead.current!.read())
    if (!mounted.current) throw new MutationContextChangedError()
  }, [])
  const changeIdentity = useCallback(() => {
    if (currentData.current) setIntent(value=>value?.targetType==='task'?undefined:value)
    identitySequence.current++; advanceMutationContext(); workspaceRead.current!.reset()
    currentData.current = null; bindSessionActor(null); setDraftSession(null); setTaskIntent(null); setSupportIntent(null)
    if (mounted.current) setData(null)
    return identitySequence.current
  }, [])
  const identityCurrent = (sequence: number) => mounted.current && sequence === identitySequence.current
  async function loadIdentityWorkspace(sequence: number) {
    if (!identityCurrent(sequence)) throw new MutationContextChangedError()
    await readInMutationContext(() => workspaceRead.current!.read())
    if (!identityCurrent(sequence) || !currentData.current) throw new MutationContextChangedError()
    return currentData.current
  }
  const sessionChanged = useCallback(async () => {
    const sequence = changeIdentity()
    try { await refresh() }
    catch (error) {
      if (!mounted.current || sequence !== identitySequence.current) return
      if (error instanceof ApiError && error.status === 401) { setDingTalkNotice('请重新登录团队账号。') }
      else throw error
    }
  }, [refresh, changeIdentity])
  useEffect(() => subscribeSessionIdentityChanges(() => { void sessionChanged().catch(error => setToast(error instanceof Error ? error.message : '账号状态更新失败，请重新登录。')) }), [sessionChanged])
  function applyNavigation(next: PageId, nextIntent?: NavigationIntent, writeHistory = true) {
    // Reset before rendering so destination-specific anchors can still scroll into view.
    if (next !== page) window.scrollTo({ top: 0, behavior: 'instant' })
    setPage(next)
    setIntent(nextIntent)
    setNavigationKey((value) => value + 1)
    if (writeHistory) window.history.pushState(null, '', navigationUrl(next, nextIntent))
  }
  const navigate: Navigate = (next, nextIntent) => {
    if(data?.user.role==='observer' && next!=='authorized-work') {setToast('观察者仅可查看明确授权的工作。');return}
    if(nextIntent?.targetType==='task'&&nextIntent.id) {showTask({taskId:nextIntent.id,section:nextIntent.section,weeklyRecordId:nextIntent.weeklyRecordId});return}
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
  function showTask(value:OpenTaskIntent) {
    const validated=validTaskIntent(value)
    if(!validated || !allowDraftLeave())return
    const returnContext=value.returnContext || {url:window.location.pathname+window.location.search,scrollY:window.scrollY}
    setTaskIntent({...validated,returnContext})
    window.history.pushState(null,'',navigationUrl(page==='authorized-work'?'authorized-work':'work-register',{id:validated.taskId,targetType:'task',section:validated.section,weeklyRecordId:validated.weeklyRecordId}))
  }
  function closeTask() {
    const context=taskIntent?.returnContext
    const returnUrl=context?.url || navigationUrl(page,intent?.targetType==='task'?undefined:intent)
    const destination=entryLocation(new URL(returnUrl,window.location.origin))
    setTaskIntent(null)
    setIntent(destination.intent)
    window.history.replaceState(null,'',returnUrl)
    requestAnimationFrame(()=>window.scrollTo({top:context?.scrollY||0,behavior:'instant'}))
  }
  useEffect(()=>{
    const open=(event:Event)=>showTask((event as CustomEvent<OpenTaskIntent>).detail)
    const support=(event:Event)=>setSupportIntent((event as CustomEvent<string>).detail)
    window.addEventListener('workspace-open-task',open);window.addEventListener('workspace-open-support',support)
    return()=>{window.removeEventListener('workspace-open-task',open);window.removeEventListener('workspace-open-support',support)}
  },[page,intent,data?.user.id])
  useEffect(()=>{
    if(data && intent?.targetType==='task' && intent.id) setTaskIntent({taskId:intent.id,section:intent.section,weeklyRecordId:intent.weeklyRecordId,returnContext:{url:navigationUrl(page),scrollY:0}})
  },[data?.user.id,intent?.id,intent?.section,intent?.weeklyRecordId])
  useEffect(()=>{if(data?.user.role==='observer'&&page!=='authorized-work'){setPage('authorized-work');setIntent(undefined);window.history.replaceState(null,'',navigationUrl('authorized-work'))}},[data?.user.role,page])
  async function logout() {
    const sequence = changeIdentity()
    try {
      await api('/auth/logout', { method: 'POST' })
      if (!identityCurrent(sequence)) return
      setUnreadCount(0)
      setReportDirty(false)
      setFeedbackContext(null)
      clearClientError()
    } catch (e) {
      if (!identityCurrent(sequence)) return
      setToast(e instanceof Error ? e.message : '退出失败')
    }
  }
  async function dingTalkLogin() {
    const sequence = changeIdentity()
    setData(null); setOrdinaryLogin(false); setDingTalkConflict(false)
    setDingTalkBusy(true); setDingTalkNotice('正在验证钉钉身份…')
    try {
      const result = await identityThenWorkspace({ dingTalk: true, verify: exchangeDingTalk, normalSession: async () => {}, load: () => loadIdentityWorkspace(sequence) })
      if (!identityCurrent(sequence)) return
      if (result.data) { setDingTalkNotice('') }
      else if (result.bindingRequired) setDingTalkNotice('钉钉身份已验证。请先登录已开通的团队账号，再确认本人身份并完成绑定。')
      else setDingTalkNotice('请使用团队账号登录。')
    } catch (error) {
      if (!identityCurrent(sequence)) return
      setDingTalkConflict(error instanceof ApiError && error.status === 409)
      setDingTalkNotice(error instanceof Error ? error.message : '钉钉验证失败，请使用账号登录。')
    } finally { if (identityCurrent(sequence)) { setDingTalkBusy(false); setLoading(false) } }
  }
  async function chooseOrdinaryLogin() {
    const sequence = changeIdentity()
    setDingTalkBusy(true)
    try {
      await api('/auth/logout', { method: 'POST' })
      if (!identityCurrent(sequence)) return
      setData(null); setOrdinaryLogin(true); setDingTalkConflict(false)
      setDingTalkNotice('正在使用普通团队账号登录；此方式不代表当前钉钉身份已核验。')
    } catch { if (identityCurrent(sequence)) setDingTalkNotice('暂时无法退出原账号，请重试。') }
    finally { if (identityCurrent(sequence)) setDingTalkBusy(false) }
  }
  async function switchDingTalkIdentity() {
    const sequence = changeIdentity()
    setData(null)
    setDingTalkBusy(true)
    try { await api('/auth/logout', { method: 'POST' }); if (identityCurrent(sequence)) await dingTalkLogin() }
    catch { if (identityCurrent(sequence)) { setDingTalkNotice('切换身份失败，请重试。'); setDingTalkBusy(false) } }
  }
  async function leaveWithoutSaving() {
    const target = pendingLeave
    setPendingLeave(null)
    if (target === 'logout') await logout()
    else if (target === 'reload') window.location.reload()
    else if (target) {
      setReportDirty(false)
      applyNavigation(target.page, target.intent)
    }
  }
  async function start() {
    const sequence = changeIdentity()
    setLoading(true)
    setFatal('')
    try {
      const status = await api<{ initialized: boolean }>('/auth/status')
      if (!identityCurrent(sequence)) return
      setInitialized(status.initialized)
      if (status.initialized) {
        // Download the entry page's code while identity and workspace requests are in flight.
        pageModules[entryLocation(window.location).page]?.preload()
        if (isDingTalk()) { await dingTalkLogin(); return }
        try {
          await identityThenWorkspace({ dingTalk: false, verify: exchangeDingTalk, normalSession: () => api('/auth/me'), load: () => loadIdentityWorkspace(sequence) })
        } catch (error) {
          if (!identityCurrent(sequence)) return
          if (error instanceof ApiError && error.status === 401) {
            setData(null)
          }
          else throw error
        }
      }
    } catch (e) {
      if (!identityCurrent(sequence)) return
      setFatal(e instanceof Error ? e.message : '服务连接失败')
    } finally {
      if (identityCurrent(sequence)) setLoading(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    void start()
    let live = true
    void entryAppLink(window.location).then(link => { if (live) setAppLink(link) }).catch(() => {})
    return () => { live = false; mounted.current = false; identitySequence.current++; advanceMutationContext(); workspaceRead.current!.reset() }
  }, [])
  useEffect(() => subscribeMutationResponses(event => {
    if (!mounted.current || !currentData.current || event.context !== captureMutationContext()) return
    if (!shellAffected(event.path)) return
    workspaceRead.current!.invalidate()
    const self = mutationEntities(event.value).users?.find(row => row.id === currentData.current!.user.id) as Bootstrap['user'] | undefined
    if (self && self.version >= currentData.current.user.version) {
      if (self.role !== currentData.current.user.role || self.active !== currentData.current.user.active) changeIdentity()
      else { const next = { ...currentData.current, user: self, users: [self] }; currentData.current = next; setData(next) }
    }
    void refresh().catch(() => {})
  }), [refresh, changeIdentity])
  useEffect(() => {
    const back = () => {
      const destination = entryLocation(window.location)
      if(taskIntent) {
        if(!allowDraftLeave()){window.history.pushState(null,'',navigationUrl(page,{id:taskIntent.taskId,targetType:'task',section:taskIntent.section,weeklyRecordId:taskIntent.weeklyRecordId}));return}
        const context=taskIntent.returnContext
        setTaskIntent(null)
        applyNavigation(destination.page,destination.intent,false)
        if(context?.url===window.location.pathname+window.location.search)requestAnimationFrame(()=>window.scrollTo({top:context.scrollY,behavior:'instant'}))
        return
      }
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
  }, [reportDirty, page, intent,taskIntent])
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
    if (!data || data.user.role==='observer') return
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
    if (feedbackUser.current !== data?.user.id || data?.user.role==='observer') { setFeedbackContext(null); clearClientError() }
    feedbackUser.current = data?.user.id
  }, [data?.user.id,data?.user.role])
  useEffect(() => {
    const open = () => openFeedback()
    const login = () => { changeIdentity(); setFeedbackContext(null); setOrdinaryLogin(true); setDingTalkNotice('请重新登录。已暂存的草稿可在返回原表单后恢复。') }
    window.addEventListener('workspace-feedback', open)
    window.addEventListener('workspace-login-expired', login)
    return () => { window.removeEventListener('workspace-feedback', open); window.removeEventListener('workspace-login-expired', login) }
  }, [data?.user.id,data?.user.role])
  useEffect(() => {
    if (!data || data.user.role==='observer') {setUnreadCount(0);return}
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
            const sequence = changeIdentity(); setInitialized(true); await refresh()
            if (identityCurrent(sequence) && isDingTalk() && page === 'overview') applyNavigation('messages')
          }} />}
      </AuthLanding>
    )
  const manager = data.user.role === 'manager'
  const reloadPage = () => {
    if (!allowDraftLeave()) return
    if (reportDirty) setPendingLeave('reload')
    else window.location.reload()
  }
  const props = { data, refresh, notify: setToast, intent }
  const route = {
    'authorized-work': <AuthorizedWork {...props} />,
    overview: <Overview {...props} navigate={navigate} />,
    monthly: <Monthly {...props} navigate={navigate} />,
    weekly: <Weekly {...props} navigate={navigate} />,
    collaboration: <WorkFollowups {...props} navigate={navigate} />,
    'work-register': <WorkRegister {...props} navigate={navigate} />,
    'period-reviews': <PeriodReviews {...props} />,
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
    <PageReloadContext.Provider value={reloadPage}>
      <div inert={!!feedbackContext || undefined}>
      <WorkspaceShell data={data} page={page} navigate={navigate} unreadCount={unreadCount} onFeedback={openFeedback} leaveConfirmationOpen={!!pendingLeave} onLogout={() => {
        if (!allowDraftLeave()) return
        if (reportDirty) setPendingLeave('logout')
        else void logout()
      }}>
        {ordinaryLogin && isDingTalk() && <div className="dingtalk-auth-notice" role="status">普通账号登录，当前钉钉身份尚未核验。<button className="button secondary" disabled={dingTalkBusy} onClick={() => void dingTalkLogin()}>验证当前钉钉身份</button></div>}
        <PageErrorBoundary key={`${data.user.id}:${data.operationEpoch}:${data.accessScopeVersion}:${page}-${navigationKey}`}>{data.user.role==='observer'?<AuthorizedWork {...props}/>:route}</PageErrorBoundary>
      </WorkspaceShell>
      </div>
      {taskIntent&&<WorkTaskPanel key={`${data.user.id}:${taskIntent.taskId}:${taskIntent.section}:${taskIntent.weeklyRecordId||''}:${data.operationEpoch}`} {...props} taskId={taskIntent.taskId} section={taskIntent.section} weeklyRecordId={taskIntent.weeklyRecordId} onClose={closeTask} onChanged={async()=>{}}/>}
      {supportIntent&&<MinimalSupportPanel key={supportIntent} {...props} blockerId={supportIntent} onClose={()=>setSupportIntent(null)}/>}
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
    </PageReloadContext.Provider>
  )
}
