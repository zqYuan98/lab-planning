import { rememberClientError } from './error-context'

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public requestId?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
/** A mutation has succeeded. Only its read/refresh completion may be retried. */
export class SavedResultError extends Error {
  constructor(public retry: () => Promise<void>) {
    super('内容已经保存，但页面刷新失败。请重新加载已保存结果，无需重复提交。')
    this.name = 'SavedResultError'
  }
}
export async function finishSaved(refresh: () => Promise<void>) {
  try { await refresh() } catch { throw new SavedResultError(refresh) }
}
export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response
  try { response = await fetch(
    path.startsWith('/api/')
      ? path
      : `/api${path.startsWith('/') ? '' : '/'}${path}`,
    {
      ...options,
      ...(!['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase()) &&
      !options.body
        ? { body: '{}' }
        : {}),
      credentials: 'same-origin',
      headers: {
        ...(!['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase())
          ? { 'Content-Type': 'application/json' }
          : {}),
        ...options.headers,
      },
    },
  ) } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error
    const message = ['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase())
      ? '网络连接中断，请检查网络后重试。'
      : '网络连接中断，暂时无法确认保存结果。已保留填写内容，请先核对记录后再重试。'
    rememberClientError(message)
    throw new ApiError(message, 0)
  }
  let content: string
  try { content = await response.text() } catch {
    const requestId = response.headers.get('X-Request-Id') || undefined
    const message = ['GET', 'HEAD'].includes((options.method || 'GET').toUpperCase())
      ? '读取结果时连接中断，请重新加载。'
      : '读取结果时连接中断，暂时无法确认保存结果。已保留填写内容，请先核对记录后再重试。'
    rememberClientError(message, requestId)
    throw new ApiError(message, 0, requestId)
  }
  let value: any
  try {
    value = content ? JSON.parse(content) : undefined
  } catch {
    const requestId = response.headers.get('X-Request-Id') || undefined
    const message = '服务返回了无法识别的数据，请重新加载核对结果。'
    rememberClientError(message, requestId)
    throw new ApiError(message, response.status, requestId)
  }
  if (!response.ok) {
    const requestId = response.headers.get('X-Request-Id') || (typeof value?.requestId === 'string' ? value.requestId : undefined)
    const message = response.status === 401 && !path.includes('/auth/') ? '登录已过期，请重新登录。请保留当前页面，已暂存的草稿可在登录后恢复。' : value?.error || `请求失败（${response.status}）`
    if (response.status >= 500) rememberClientError(message, requestId)
    throw new ApiError(message, response.status, requestId)
  }
  return value as T
}
export const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  body: JSON.stringify(body),
})
