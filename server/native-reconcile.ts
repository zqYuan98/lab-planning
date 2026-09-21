import type { Entity } from '../shared/types.ts'
import type { ChannelOperation, ExternalObjectLink } from '../shared/native-actions.ts'
import type { DingTalkNativeClient, TodoRemote } from './dingtalk-native.ts'
import { Store } from './store.ts'
import { getNativeSettings, nativeCapabilityState } from './native-settings.ts'
import { enqueueNativeOperation, linkEligible, nativeHash } from './native-service.ts'
import { applyNativeDeparture } from './native-callbacks.ts'

interface TodoScan extends Entity { deploymentId: string; activationId: string; unionId: string; startedAt: string; nextToken: string | null; seenTokens: string[]; items: TodoRemote[] }
/** Paginated reads are restartable; absence never proves business completion or deletion. */
export async function reconcileNativeTodos(store: Store, client: DingTalkNativeClient, now = new Date(), shouldStop = () => false) {
  const settings = getNativeSettings(store)
  if (!nativeCapabilityState(store, client).todo.enabled) return
  const links = store.list<ExternalObjectLink>('nativeLinks').filter(row => row.channel === 'todo' && !['isolated', 'external_missing', 'failed'].includes(row.state) && (!row.reconcileAt || row.reconcileAt <= now.toISOString()) && linkEligible(store, row, client))
  for (const unionId of [...new Set(links.map(row => row.unionId))].slice(0, 10)) {
    if (shouldStop()) return
    const scanId = nativeHash(['todo-scan', settings.deploymentId, settings.activationId, unionId])
    let scan = store.get<TodoScan>('nativeSyncState', scanId)
    if (!scan) scan = store.insert<TodoScan>('nativeSyncState', { id: scanId, deploymentId: settings.deploymentId, activationId: settings.activationId, unionId, startedAt: now.toISOString(), nextToken: null, seenTokens: [], items: [] })
    try {
      let finished = false
      for (let page = 0; page < 20 && !shouldStop(); page++) {
        const data = await client.listTodos(unionId, scan.nextToken ?? undefined)
        if (shouldStop() || getNativeSettings(store).activationId !== settings.activationId) return
        if (data.nextToken && scan.seenTokens.includes(data.nextToken) || scan.items.length + data.items.length > 100_000) throw new Error('invalid pagination')
        scan = store.update<TodoScan>('nativeSyncState', scan.id, scan.version, { items: [...scan.items, ...data.items], nextToken: data.nextToken, seenTokens: data.nextToken ? [...scan.seenTokens, data.nextToken] : scan.seenTokens })
        if (!data.nextToken) { finished = true; break }
      }
      if (!finished) continue
      store.transaction(() => {
        for (const link of store.list<ExternalObjectLink>('nativeLinks').filter(row => row.channel === 'todo' && row.unionId === unionId && !['isolated', 'external_missing', 'failed'].includes(row.state) && linkEligible(store, row, client))) {
          const matches = scan!.items.filter(row => row.sourceId === link.sourceId)
          const nextAt = new Date(now.getTime() + 15 * 60000).toISOString()
          if (matches.length !== 1 || link.providerId && matches[0].taskId !== link.providerId) {
            // Completed todos older than the provider's 180-day window are not discoverable.
            const historicalClosed = link.state === 'closed' && !!link.lastSyncedAt && now.getTime() - Date.parse(link.lastSyncedAt) > 180 * 86400000
            store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { reconcileAt: nextAt, ...(historicalClosed ? {} : { state: link.state === 'unknown' ? 'unknown' : 'mismatch', lastError: matches.length > 1 ? '发现多个相同来源待办，请管理员核查' : '本次查询未定位外部对象，不能据此推断完成或删除' }) }); continue
          }
          const remote = matches[0], mismatch = remote.isDone !== link.desired.done
          const next = store.update<ExternalObjectLink>('nativeLinks', link.id, link.version, { providerId: remote.taskId, observedDone: remote.isDone, state: mismatch ? 'mismatch' : link.desired.done ? 'closed' : 'created', lastSyncedAt: now.toISOString(), reconcileAt: nextAt, lastError: mismatch ? '外部完成状态与平台义务不一致，请以平台记录为准' : '' })
          // An exact sourceId match resolves uncertain creation without issuing another create.
          for (const operation of store.list<ChannelOperation>('nativeOperations')) if (operation.linkId === link.id && operation.status === 'unknown' && (operation.kind === 'todo_create' || operation.kind === 'todo_update' && operation.desiredRevision === link.desired.revision && !mismatch && remote.subject === link.desired.title && remote.dueTime === link.desired.dueTime)) store.update<ChannelOperation>('nativeOperations', operation.id, operation.version, { status: 'succeeded', lastError: '通过来源标识和当前状态对账确认', leaseUntil: null })
          if (link.desired.done && !remote.isDone || !mismatch && (remote.subject !== link.desired.title || remote.dueTime !== link.desired.dueTime)) enqueueNativeOperation(store, next, 'todo_update', now, nativeHash([scan!.startedAt, remote]))
        }
        store.delete('nativeSyncState', scan!.id, scan!.version)
      })
    } catch {
      // Retain the page cursor for a later read; never resend an uncertain creation.
      for (const link of links.filter(row => row.unionId === unionId)) { const current = store.get<ExternalObjectLink>('nativeLinks', link.id); if (current) store.update<ExternalObjectLink>('nativeLinks', current.id, current.version, { reconcileAt: new Date(now.getTime() + 5 * 60000).toISOString(), lastError: '外部对账暂未完成，已保留分页位置' }) }
    }
  }
}
interface LeaveScan extends Entity { deploymentId: string; activationId: string; completedAt: string | null; startTime: string; endTime: string; nextToken: string | null; seenTokens: string[] }
const boundedSetting = (key: string, fallback: number, maximum: number) => { const value = Number(process.env[key]); return Number.isInteger(value) && value >= 1 && value <= maximum ? value : fallback }
export async function reconcileNativeDepartures(store: Store, client: DingTalkNativeClient, now = new Date(), shouldStop = () => false, force = false) {
  const settings = getNativeSettings(store)
  if (!nativeCapabilityState(store, client).leaveSync.enabled || !settings.enabledAt) return
  const id = nativeHash(['leave-sync', settings.deploymentId, settings.activationId])
  let scan = store.get<LeaveScan>('nativeSyncState', id)
  const interval = boundedSetting('DINGTALK_LEAVE_SYNC_INTERVAL_HOURS', 24, 168) * 3600000, overlap = boundedSetting('DINGTALK_LEAVE_SYNC_LOOKBACK_DAYS', 1, 7) * 86400000
  if (scan?.completedAt && !force && now.getTime() - Date.parse(scan.completedAt) < interval) return
  if (!scan || scan.completedAt) {
    const fields = { deploymentId: settings.deploymentId, activationId: settings.activationId, completedAt: null, startTime: new Date(Math.max(Date.parse(settings.enabledAt) - overlap, Date.parse(scan?.endTime ?? settings.enabledAt) - overlap, now.getTime() - 364 * 86400000)).toISOString(), endTime: now.toISOString(), nextToken: null, seenTokens: [] }
    scan = scan ? store.update<LeaveScan>('nativeSyncState', id, scan.version, fields) : store.insert<LeaveScan>('nativeSyncState', { id, ...fields })
  }
  for (let page = 0; page < boundedSetting('DINGTALK_LEAVE_SYNC_PAGE_LIMIT', 20, 100) && !shouldStop(); page++) {
    const data = await client.listLeaveRecords(scan.startTime, scan.endTime, scan.nextToken ?? undefined)
    if (shouldStop() || getNativeSettings(store).activationId !== settings.activationId) return
    if (data.nextToken && scan.seenTokens.includes(data.nextToken)) throw new Error('离职补偿分页游标重复')
    store.transaction(() => {
      for (const row of data.records) if (row.leaveTime <= scan!.endTime) applyNativeDeparture(store, client, row.userid, row.leaveTime, 'leave_record_reconciliation', now)
      scan = store.update<LeaveScan>('nativeSyncState', id, scan!.version, { nextToken: data.nextToken, seenTokens: data.nextToken ? [...scan!.seenTokens, data.nextToken] : scan!.seenTokens, completedAt: data.nextToken ? null : now.toISOString() })
    })
    if (!data.nextToken) return
  }
}
