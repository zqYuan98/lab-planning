export interface MutationResponse { context: number; path: string; value: unknown }
export class MutationContextChangedError extends Error {
  constructor() { super('账号或访问范围已变化，已停止更新旧页面，请核对原账号的保存结果。'); this.name = 'MutationContextChangedError' }
}
let context = 0
const listeners = new Set<(event: MutationResponse) => void>()
const resets = new Set<() => void>()
export const captureMutationContext = () => context
export async function readInMutationContext(read: () => Promise<void>): Promise<void> {
  const startedIn = context
  await read()
  if (startedIn !== context) throw new MutationContextChangedError()
}
export function advanceMutationContext() { context++; for (const reset of resets) reset(); return context }
export function subscribeMutationResponses(listener: (event: MutationResponse) => void, reset?: () => void) {
  listeners.add(listener); if (reset) resets.add(reset)
  return () => { listeners.delete(listener); if (reset) resets.delete(reset) }
}
export function publishMutationResponse(startedIn: number, path: string, value: unknown): boolean {
  if (startedIn !== context) return false
  path = path.replace(/^\/api(?=\/)/, ''); if (!path.startsWith('/')) path = `/${path}`
  if (path.startsWith('/auth/')) return true
  for (const listener of listeners) {
    if (startedIn !== context) return false
    listener({ context, path, value })
  }
  return startedIn === context
}
