import type { DingTalkPublicConfig } from '../shared/notifications'
import { api, json } from './api'
import { dingTalkEntryLink } from '../shared/dingtalk-entry'

// UA is a hint to attempt verification, never proof of identity. Desktop bridges
// are also detected because their embedded UA does not always contain DingTalk.
export const isDingTalk = (userAgent = navigator.userAgent) => /DingTalk/i.test(userAgent)
  || typeof window !== 'undefined' && typeof (window as unknown as { dingtalk?: { platform?: { invokeAPI?: unknown } } }).dingtalk?.platform?.invokeAPI === 'function'

export async function entryAppLink(location: Pick<Location, 'origin' | 'pathname' | 'search'>): Promise<string | undefined> {
  if (location.pathname !== '/entry') return undefined
  const config = await api<DingTalkPublicConfig>('/auth/dingtalk/config')
  if (!config.appLinkEnabled) return undefined
  return dingTalkEntryLink(`${location.origin}${location.pathname}${location.search}`, { origin: location.origin, enabled: true, ...config })
}

// Official H5 JSAPI: https://open.dingtalk.com/tools/explorer/jsapi?id=11723
// SDK is bundled with the app; no remote script/CSP exception is necessary.
async function requestCode(config: DingTalkPublicConfig): Promise<string> {
  const dd = await import('dingtalk-jsapi')
  if (!dd.env || dd.env.platform === 'notInDingTalk' || typeof dd.requestAuthCode !== 'function') throw new Error('当前浏览器无法调用钉钉身份接口，请在钉钉中打开或使用普通账号登录。')
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, code?: string) => {
      if (settled) return
      settled = true; window.clearTimeout(timer)
      if (error) reject(error)
      else resolve(code!)
    }
    const timer = window.setTimeout(() => finish(new Error('钉钉身份验证超时，请重试或使用账号登录。')), 12000)
    try {
      const request = dd.requestAuthCode({ clientId: config.clientId, corpId: config.corpId,
        success: (result: { code?: string }) => typeof result.code === 'string' && result.code
          ? finish(undefined, result.code) : finish(new Error('钉钉未返回有效授权码。')),
        fail: () => finish(new Error('无法验证钉钉身份，请确认应用可见范围和钉钉版本，或使用账号登录。')),
      })
      // SDK versions expose a Promise as well as callbacks; consume rejection on both paths.
      void request.catch(() => finish(new Error('钉钉身份验证失败，请重试或使用账号登录。')))
    } catch { finish(new Error('当前钉钉环境不支持免登，请使用账号登录。')) }
  })
}

/** The business loader is reached only after the selected identity path succeeds. */
export async function identityThenWorkspace<T>(options: { dingTalk: boolean; verify: () => Promise<{ authenticated: boolean; bindingRequired?: boolean }>; normalSession: () => Promise<unknown>; load: () => Promise<T> }): Promise<{ data?: T; bindingRequired?: boolean }> {
  if (options.dingTalk) {
    const verified = await options.verify()
    if (!verified.authenticated) return { bindingRequired: !!verified.bindingRequired }
  } else await options.normalSession()
  return { data: await options.load() }
}

export async function exchangeDingTalk(): Promise<{ authenticated: boolean; bindingRequired?: boolean }> {
  if (!isDingTalk()) throw new Error('请在钉钉工作台内打开本应用，再验证本人身份。')
  const config = await api<DingTalkPublicConfig>('/auth/dingtalk/config', { signal: AbortSignal.timeout(10000) })
  if (!config.configured) throw new Error('钉钉接入尚未配置，请先使用团队账号登录。')
  const code = await requestCode(config)
  return api('/auth/dingtalk/exchange', { ...json({ code }), signal: AbortSignal.timeout(15000) })
}
