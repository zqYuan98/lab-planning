/** Only controlled same-origin locations may be placed inside a DingTalk AppLink. */
export interface DingTalkEntryConfig { origin: string; agentId?: string; corpId?: string; enabled?: boolean }
const bytes = (value: string) => new TextEncoder().encode(value).length
export function validatedNotificationEntry(value: string, origin: string): URL {
  const base = new URL(origin), url = new URL(value)
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash
    || url.origin !== base.origin || url.username || url.password || url.pathname !== '/entry' || url.hash
    || [...url.searchParams.keys()].some(key => key !== 'notificationId') || url.searchParams.getAll('notificationId').length !== 1
    || !/^[a-zA-Z0-9_-]{1,450}$/.test(url.searchParams.get('notificationId') ?? '') || url.href.length > 500 || bytes(url.href) > 1024) throw new Error('事项入口无效')
  return url
}
/** Official H5 AppLink: https://open.dingtalk.com/document/orgapp/open-h5-micro-application
 * No caller-provided redirect, token, HTML or business content is accepted. */
export function dingTalkEntryLink(value: string, config: DingTalkEntryConfig): string {
  const entry = validatedNotificationEntry(value, config.origin)
  if (!config.enabled) return entry.href
  if (!/^[1-9]\d{0,19}$/.test(config.agentId ?? '') || !/^[a-zA-Z0-9_-]{1,100}$/.test(config.corpId ?? '')) throw new Error('钉钉应用入口尚未配置')
  const link = new URL('https://applink.dingtalk.com/page/h5_app_open')
  link.searchParams.set('appId', config.agentId!)
  link.searchParams.set('appType', '2')
  link.searchParams.set('corpId', config.corpId!)
  link.searchParams.set('path', `${entry.pathname}${entry.search}`)
  link.searchParams.set('target', 'panel')
  link.searchParams.set('targetDesktop', 'popupWindow')
  if (link.href.length > 1024 || bytes(link.href) > 1024) throw new Error('完整钉钉事项入口超出长度预算')
  return link.href
}
