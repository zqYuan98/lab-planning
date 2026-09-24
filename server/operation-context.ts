import { randomUUID } from 'node:crypto'
import type { Entity } from '../shared/types.ts'
import { HttpError, type Store } from './store.ts'

interface OperationContext extends Entity { epoch: string }
const collection = 'operationContexts'
const contextId = 'business-commands'

/** Runtime context is included in full backups, never in portable business packets. */
export function getOperationEpoch(store: Store): string {
  const existing = store.get<OperationContext>(collection, contextId)
  if (existing) return existing.epoch
  return store.transaction(() => store.get<OperationContext>(collection, contextId)?.epoch
    ?? store.insert<OperationContext>(collection, { id: contextId, epoch: randomUUID() }).epoch)
}

export function assertOperationEpoch(store: Store, value: unknown): void {
  if (typeof value !== 'string' || value !== getOperationEpoch(store)) {
    throw new HttpError(409, '数据环境已变化，请刷新并核对已有承接目标后重新操作。', 'OPERATION_CONTEXT_CHANGED')
  }
}

/** Call in the restore transaction, or explicitly after restoring a whole backup. */
export function rotateOperationEpoch(store: Store): string {
  return store.transaction(() => {
    const current = store.get<OperationContext>(collection, contextId)
    const epoch = randomUUID()
    return current
      ? store.update<OperationContext>(collection, contextId, current.version, { epoch }).epoch
      : store.insert<OperationContext>(collection, { id: contextId, epoch }).epoch
  })
}
