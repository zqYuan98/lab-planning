export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}
export async function api<T = unknown>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(
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
  )
  const content = await response.text()
  let value: any
  try {
    value = content ? JSON.parse(content) : undefined
  } catch {
    throw new Error('服务返回了无法识别的数据，请稍后重试。')
  }
  if (!response.ok)
    throw new ApiError(
      value?.error || `请求失败（${response.status}）`,
      response.status,
    )
  return value as T
}
export const json = (body: unknown, method = 'POST'): RequestInit => ({
  method,
  body: JSON.stringify(body),
})
