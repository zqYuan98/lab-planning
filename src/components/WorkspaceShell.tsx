import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import Layout from '@arco-design/web-react/es/Layout'
import Menu from '@arco-design/web-react/es/Menu'
import Button from '@arco-design/web-react/es/Button'
import Avatar from '@arco-design/web-react/es/Avatar'
import Breadcrumb from '@arco-design/web-react/es/Breadcrumb'
import Dropdown from '@arco-design/web-react/es/Dropdown'
import Drawer from '@arco-design/web-react/es/Drawer'
import {
  ArrowLeftToLine, ArrowRightFromLine, CalendarDays, ChartNoAxesCombined,
  Check, ChevronDown, ClipboardList, FileInput, FileText, FolderKanban,
  Goal, LogOut, Menu as MenuIcon, Users, X, Bell, Settings2, ListTodo, MessageSquarePlus,
} from 'lucide-react'
import type { Bootstrap } from '../../shared/types'
import type { Navigate, PageId } from '../navigation'
import { currentMonth, monday } from '../ui'
import { shanghaiToday } from '../overview-data'
import WorkspaceBrand from './WorkspaceBrand'
import WorkspaceSearch from './WorkspaceSearch'
import { appVersion } from '../error-context'

const navigation = [
  { id: 'overview', label: '部门概览', memberLabel: '我的工作台', group: '规划', icon: ChartNoAxesCombined },
  { id: 'work-register', label: '我的工作清单', group: '规划', icon: ListTodo },
  { id: 'monthly', label: '月度目标', memberLabel: '我的月度目标', group: '规划', icon: CalendarDays },
  { id: 'weekly', label: '每周执行', memberLabel: '我的周计划', group: '规划', icon: ClipboardList },
  { id: 'messages', label: '我的工作与消息', group: '规划', icon: Bell },
  { id: 'collaboration', label: '进展与催办', memberLabel: '我的进展与回应', group: '规划', icon: ClipboardList },
  { id: 'feedback', label: '问题与建议', memberLabel: '我的反馈', group: '团队', icon: MessageSquarePlus },
  { id: 'goals', label: '年度目标', group: '规划', icon: Goal },
  { id: 'projects', label: '项目档案', group: '资产', icon: FolderKanban },
  { id: 'imports', label: '数据导入', group: '资产', icon: FileInput },
  { id: 'reports', label: '报告中心', group: '资产', icon: FileText, manager: true },
  { id: 'team', label: '成员管理', group: '团队', icon: Users, manager: true },
  { id: 'notification-settings', label: '通知设置', group: '团队', icon: Settings2, manager: true },
] satisfies { id: PageId; label: string; memberLabel?: string; group: string; icon: typeof Goal; manager?: boolean }[]
const collapseKey = 'tianshu.workspace.sidebar-collapsed.v1'

// Arco menu items support Enter; add directional navigation and Space for the shell menus.
function menuKeys(event: KeyboardEvent<HTMLElement>) {
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]'))
  const active = items.indexOf(document.activeElement as HTMLElement)
  if (active < 0) return
  let next = active
  if (event.key === 'ArrowDown') next = (active + 1) % items.length
  else if (event.key === 'ArrowUp') next = (active - 1 + items.length) % items.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = items.length - 1
  else if (event.key === ' ') {
    event.preventDefault()
    items[active].click()
    return
  } else return
  event.preventDefault()
  items[next].focus()
}

function WorkspaceNavigation({ manager, collapsed, page, navigate, unreadCount }: {
  manager: boolean; collapsed: boolean; page: PageId; navigate: Navigate; unreadCount: number
}) {
  const visible = navigation.filter(item => !item.manager || manager)
  const renderItem = (item: typeof navigation[number]) => {
    const label = !manager && item.memberLabel ? item.memberLabel : item.label
    return (
      <Menu.Item key={item.id} aria-label={`${label}${item.id === 'messages' && unreadCount ? `，${unreadCount} 条未查看` : ''}`} aria-current={page === item.id ? 'page' : undefined}
        renderItemInTooltip={() => label}>
        <item.icon size={18} className="workspace-menu-icon" aria-hidden="true" />
        <span className="workspace-menu-label">{label}</span>
        {item.id === 'messages' && unreadCount > 0 && <span className="workspace-unread-count" aria-hidden="true">{unreadCount > 99 ? '99+' : unreadCount}</span>}
      </Menu.Item>
    )
  }
  return (
    <nav aria-label="主导航" className="workspace-navigation" onKeyDown={menuKeys}>
      <Menu selectedKeys={[page]} collapse={collapsed} levelIndent={0} tooltipProps={{ trigger: ['hover', 'focus'] }} onClickMenuItem={key => {
        const item = navigation.find(item => item.id === key && (!item.manager || manager))
        if (item) navigate(item.id)
      }}>
        {collapsed ? visible.map(renderItem) : ['规划', '资产', '团队'].map(group => {
          const items = visible.filter(item => item.group === group)
          if (!items.length) return null
          return (
            <Menu.ItemGroup key={group} title={group}>
              {items.map(renderItem)}
            </Menu.ItemGroup>
          )
        })}
      </Menu>
    </nav>
  )
}

function AccountMenu({ data, onLogout }: { data: Bootstrap; onLogout: () => void }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const popup = useRef<HTMLDivElement>(null)
  const role = data.user.role === 'manager' ? '部门管理员' : data.user.position || '团队成员'
  function close() { setOpen(false); button.current?.focus() }
  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => popup.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])
  return (
    <Dropdown trigger="click" position="br" popupVisible={open} onVisibleChange={setOpen}
      droplist={
        <div ref={popup} className="workspace-account-popup" onKeyDown={event => {
          menuKeys(event)
          if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close() }
          if (event.key === 'Tab') { event.preventDefault(); close() }
        }}>
          <div className="workspace-account-info"><strong>{data.user.name}</strong><span>{role}</span><small>{data.user.email}</small></div>
          <Menu onClickMenuItem={() => { close(); onLogout() }}>
            <Menu.Item key="logout"><LogOut size={16} aria-hidden="true" />退出登录</Menu.Item>
          </Menu>
        </div>
      }>
      <Button ref={button} type="text" className="workspace-account-button" aria-label={`账号菜单：${data.user.name}`}
        aria-haspopup="menu" aria-expanded={open} onKeyDown={event => {
          if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true) }
          if (event.key === 'Escape') close()
        }}>
        <Avatar size={32}>{Array.from(data.user.name)[0] || '人'}</Avatar>
        <span className="workspace-account-label"><strong>{data.user.name}</strong><small>{role}</small></span>
        <ChevronDown size={14} className="workspace-account-chevron" aria-hidden="true" />
      </Button>
    </Dropdown>
  )
}

export default function WorkspaceShell({ data, page, navigate, onLogout, onFeedback, leaveConfirmationOpen, children, unreadCount = 0 }: {
  data: Bootstrap; page: PageId; navigate: Navigate; onLogout: () => void; onFeedback?: () => void; leaveConfirmationOpen: boolean; children: ReactNode; unreadCount?: number
}) {
  const manager = data.user.role === 'manager'
  const [collapsed, setCollapsed] = useState(() => {
    try { return localStorage.getItem(collapseKey) === 'true' } catch { return false }
  })
  const [mobileOpen, setMobileOpen] = useState(false)
  const mobileTrigger = useRef<HTMLButtonElement>(null)
  const wasMobileOpen = useRef(false)
  const leaveOpen = useRef(leaveConfirmationOpen)
  leaveOpen.current = leaveConfirmationOpen
  const current = navigation.find(item => item.id === page)!
  const title = !manager && current.memberLabel ? current.memberLabel : current.label
  const today = shanghaiToday()
  useEffect(() => {
    try { localStorage.setItem(collapseKey, String(collapsed)) } catch { /* Private browsing can deny storage. */ }
  }, [collapsed])
  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 901px)')
    function resize() { if (desktop.matches) setMobileOpen(false) }
    desktop.addEventListener('change', resize)
    return () => desktop.removeEventListener('change', resize)
  }, [])
  useEffect(() => {
    const closing = wasMobileOpen.current && !mobileOpen
    wasMobileOpen.current = mobileOpen
    if (!closing) return
    // Restore after React removes inert and Arco releases its focus lock. This also
    // handles closing during the entrance animation, before afterClose can fire.
    const frame = requestAnimationFrame(() => {
      if (!leaveOpen.current) mobileTrigger.current?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [mobileOpen])
  const navigateFromShell: Navigate = (next, intent) => {
    setMobileOpen(false)
    navigate(next, intent)
  }
  return (
    <>
      <Layout className={`shell-light workspace-shell ${collapsed ? 'workspace-collapsed' : ''}`} hasSider inert={mobileOpen || undefined}>
        <a href="#workspace-content" className="workspace-skip-link">跳至主要内容</a>
        <Layout.Sider className="workspace-sider" width={232} collapsedWidth={72} collapsed={collapsed} trigger={null}>
          <div className="workspace-brand-row" aria-label="天枢实验室 · 部门工作空间"><WorkspaceBrand /></div>
          <WorkspaceNavigation manager={manager} collapsed={collapsed} page={page} navigate={navigateFromShell} unreadCount={unreadCount} />
          <div className="workspace-sider-bottom">
            {onFeedback && <Button type="text" long className="workspace-collapse-button" aria-label="提报问题与建议" onClick={onFeedback}
              icon={<MessageSquarePlus size={17} />}>{!collapsed && '提报问题与建议'}</Button>}
            <Button type="text" long className="workspace-collapse-button" aria-label={collapsed ? '展开侧栏' : '收起侧栏'}
              aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}
              icon={collapsed ? <ArrowRightFromLine size={17} /> : <ArrowLeftToLine size={17} />}>
              {!collapsed && '收起导航'}
            </Button>
          </div>
        </Layout.Sider>
        <Layout className="workspace-body">
          <Layout.Header className="workspace-header">
            <div className="workspace-location">
              <Button ref={mobileTrigger} className="workspace-mobile-toggle" type="text" icon={<MenuIcon size={20} />}
                aria-label="打开导航" aria-expanded={mobileOpen} onClick={() => setMobileOpen(true)} />
              <Breadcrumb separator="/" className="workspace-breadcrumb" aria-label="当前位置">
                <Breadcrumb.Item className="workspace-breadcrumb-group">{current.group}</Breadcrumb.Item>
                <Breadcrumb.Item>{title}</Breadcrumb.Item>
              </Breadcrumb>
            </div>
            <div className="workspace-header-search"><WorkspaceSearch data={data} navigate={navigateFromShell} /></div>
            <div className="workspace-header-actions">
              {onFeedback && <Button type="text" aria-label="提报问题与建议" onClick={onFeedback} icon={<MessageSquarePlus size={18} />} />}
              <Button type="primary" className="workspace-primary-action" icon={manager ? <Check size={16} /> : <CalendarDays size={16} />}
                onClick={() => navigateFromShell(manager ? 'monthly' : 'weekly', manager
                  ? { action: 'review', month: currentMonth(), status: 'submitted' }
                  : { action: 'create', weekStart: monday() })}>
                {manager ? '审核月度目标' : '安排本周工作'}
              </Button>
              <span className="workspace-header-divider" />
              <AccountMenu data={data} onLogout={onLogout} />
            </div>
          </Layout.Header>
          <Layout.Content id="workspace-content" className="workspace-main workspace-content-region" tabIndex={-1}>
            {children}
          </Layout.Content>
          <Layout.Footer className="workspace-shell-footer">
            <span>天枢实验室 · 部门工作空间 <small title="反馈问题时会自动关联此版本">版本 {appVersion}</small></span>
            <time dateTime={today}>{new Date(`${today}T12:00:00+08:00`).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', weekday: 'long' })}</time>
          </Layout.Footer>
        </Layout>
      </Layout>
      <Drawer title={<div className="workspace-drawer-heading"><span>工作空间导航</span><Button type="text"
        aria-label="关闭导航" icon={<X size={17} />} onClick={() => setMobileOpen(false)} /></div>}
        {...{ role: 'dialog', 'aria-modal': true, 'aria-label': '工作空间导航' }}
        closable={false} className="workspace-mobile-drawer" placement="left" width="min(292px, calc(100vw - 32px))"
        visible={mobileOpen} footer={null} unmountOnExit focusLock escToExit
        onCancel={() => setMobileOpen(false)}>
        <div className="shell-light workspace-drawer-inner">
          <div className="workspace-brand-row"><WorkspaceBrand /></div>
          <WorkspaceNavigation manager={manager} collapsed={false} page={page} navigate={navigateFromShell} unreadCount={unreadCount} />
          <div className="workspace-drawer-footer">天枢实验室 · 部门工作空间</div>
        </div>
      </Drawer>
    </>
  )
}
