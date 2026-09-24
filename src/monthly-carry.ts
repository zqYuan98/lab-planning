export interface CarryPayload { sourceVersion: number; month: string; dueDate: string; reason: string }
export interface CarryAttempt {
  schema: 1; actorId: string; sourceId: string; operationEpoch: string; requestId: string;
  payload: CarryPayload; savedAt: number;
}
export const carryAttemptKey = (actorId: string, sourceId: string) => `monthly-carry-attempt:${JSON.stringify([actorId, sourceId])}`

export function createCarryAttempt(actorId: string, sourceId: string, operationEpoch: string, payload: CarryPayload,
  createId: () => string = () => crypto.randomUUID(), now = Date.now()): CarryAttempt {
  return { schema: 1, actorId, sourceId, operationEpoch, requestId: createId(), payload: { ...payload }, savedAt: now }
}

/** Unresolved commands outlive form drafts; silently expiring the key could create duplicates. */
export function parseCarryAttempt(raw: string | null, actorId: string, sourceId: string, now = Date.now()): CarryAttempt | null {
  if (!raw || raw.length > 40000) return null
  try {
    const value = JSON.parse(raw) as CarryAttempt
    if (value.schema !== 1 || value.actorId !== actorId || value.sourceId !== sourceId
        || typeof value.operationEpoch !== 'string' || !value.operationEpoch
        || typeof value.requestId !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(value.requestId)
        || !Number.isFinite(value.savedAt) || value.savedAt > now + 60000
        || !value.payload || !Number.isInteger(value.payload.sourceVersion) || value.payload.sourceVersion < 1
        || typeof value.payload.month !== 'string' || !/^\d{4}-\d{2}$/.test(value.payload.month)
        || typeof value.payload.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.payload.dueDate)
        || typeof value.payload.reason !== 'string' || !value.payload.reason.trim() || value.payload.reason.length > 12000) return null
    return value
  } catch { return null }
}

export function persistCarryAttempt(storage: Pick<Storage, 'setItem'>, attempt: CarryAttempt): void {
  try { storage.setItem(carryAttemptKey(attempt.actorId, attempt.sourceId), JSON.stringify(attempt)) }
  catch { throw new Error('浏览器无法保存本次承接的重试凭证，尚未发送。请允许会话存储后重试。') }
}
