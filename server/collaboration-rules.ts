import type { BlockerEpisode, FollowupRequest, TaskTracking } from '../shared/collaboration.ts'
import type { ReminderOccurrence, WorkRisk, WorkRiskKind } from '../shared/collaboration-notifications.ts'
import { workRiskLabels } from '../shared/collaboration-notifications.ts'
import type { Task, User, WeeklyRecord } from '../shared/types.ts'
import type { Store } from './store.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { isActiveTask } from '../shared/task-state.ts'
import { isEffectiveWeeklyRecord } from '../shared/weekly-record-state.ts'
import { readCollaborationSettings, effectiveManagerIds, taskTrackingEligible, liveCollaborationActor } from './collaboration-policy.ts'
import { adjacentWorkday, dayAt, shanghaiDate, shanghaiTime, shiftDay, weekOf, workdayCount, workingDay } from './collaboration-calendar.ts'
import { notificationId } from './notifications.ts'

/** Read-only: neither dry runs nor dashboard reads enroll tasks or consume quota. */
export function evaluateWorkRisks(store: Store, now = new Date(), actor?: User): WorkRisk[] {
  const settings = readCollaborationSettings(store)
  if (!settings.enabled || !Number.isFinite(now.getTime())) return []
  const day = shanghaiDate(now), overrides = settings.calendarOverrides, results: WorkRisk[] = []
  // Closed generations and other owners cannot affect this read. Keep scheduler callers' original scope.
  const ownerScope = actor && actor.role !== 'manager' ? ` AND json_extract(data,'$.ownerId')=?` : ''
  const ownerValues = actor && actor.role !== 'manager' ? [actor.id] : []
  const trackings = actor ? store.selectJson<TaskTracking>(`SELECT data FROM entities WHERE collection='taskTrackings' AND json_extract(data,'$.state') IN ('active','paused')${ownerScope} ORDER BY rowid`, ownerValues) : store.list<TaskTracking>('taskTrackings')
  const requests = actor ? null : store.list<FollowupRequest>('followupRequests'), episodes = actor ? null : store.list<BlockerEpisode>('blockerEpisodes')
  for (const tracking of trackings) {
    const task = actor ? store.selectJson<Task>(`SELECT json_object('id',id,'title',json_extract(data,'$.title'),'ownerId',json_extract(data,'$.ownerId'),'status',json_extract(data,'$.status'),'dueDate',json_extract(data,'$.dueDate'),'monthlyPlanId',json_extract(data,'$.monthlyPlanId'),'cancellation',json_extract(data,'$.cancellation'),'workOrigin',json_extract(data,'$.workOrigin')) AS data FROM entities WHERE collection='tasks' AND id=?`, [tracking.taskId])[0] : store.get<Task>('tasks', tracking.taskId), owner = store.get<User>('users', tracking.ownerId)
    if (!task || !isActiveTask(task) || !owner || !canUseAccount(owner) || task.ownerId !== tracking.ownerId || !settings.pilotUserIds.includes(owner.id) || task.status === 'done') continue
    const managerIds = effectiveManagerIds(store, task)
    const add = (kind: WorkRiskKind, episode: string, dueAt: string, detail: string, managerOnly = false, target = { type: 'task' as const, id: task.id }) => {
      results.push({ key: notificationId(task.id, String(tracking.generation), kind, episode), taskId: task.id, ownerId: task.ownerId,
        title: task.title, kind, generation: tracking.generation, ruleVersion: settings.version, episode, dueAt, detail, managerOnly, managerIds, target })
    }
    if (tracking.state === 'paused') {
      if (tracking.reviewAt && tracking.reviewAt <= now.toISOString()) add('pause_review', tracking.reviewAt, tracking.reviewAt, `暂停原因：${tracking.pauseReason}；请明确恢复或继续暂停`, true)
      continue
    }
    if (tracking.state !== 'active' || tracking.activeFrom > now.toISOString() || !taskTrackingEligible(store, task, now)) continue
    const dateVersion = String(tracking.dueDateVersion)
    if (task.dueDate) {
      if (task.dueDate < day) add('overdue', dateVersion, `${task.dueDate}T23:59:59.999+08:00`, `任务截止：${task.dueDate}；请更新实际进展`)
      else if (task.dueDate === day) add('due_today', dateVersion, `${day}T23:59:59.999+08:00`, `任务截止：今日 ${task.dueDate}`)
      else if (adjacentWorkday(task.dueDate, -1, overrides) === day && tracking.enrolledAt <= dayAt(day, '17:00').toISOString()) add('due_soon', dateVersion, `${task.dueDate}T23:59:59.999+08:00`, `任务截止：${task.dueDate}`)
    }
    const baseline = [tracking.enrolledAt, tracking.activeFrom, tracking.reminderBaselineAt, tracking.lastMeaningfulOwnerProgressAt ?? ''].sort().at(-1)!
    if (workdayCount(shanghaiDate(new Date(baseline)), day, overrides) >= settings.staleWorkdays) add('stale', baseline, '', `本人最近有效进展：${tracking.lastMeaningfulOwnerProgressAt ?? '纳入后尚无'}；已满 ${settings.staleWorkdays} 个完整工作日`)
    const currentRequests = requests ?? store.selectJson<FollowupRequest>(`SELECT data FROM entities WHERE collection='followupRequests' AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.status')='open' AND json_extract(data,'$.ownerId')=? AND json_extract(data,'$.generation')=?`, [task.id, task.ownerId, tracking.generation])
    for (const request of currentRequests.filter(row => row.taskId === task.id && row.status === 'open' && row.ownerId === task.ownerId && row.generation === tracking.generation)) {
      if (request.dueAt < now.toISOString()) add('followup_overdue', request.id, request.dueAt, `回应期限：${request.dueAt}；${request.requirement}`)
    }
    const currentEpisodes = episodes ?? store.selectJson<BlockerEpisode>(`SELECT data FROM entities WHERE collection='blockerEpisodes' AND json_extract(data,'$.parentTaskId')=? AND COALESCE(json_extract(data,'$.resolvedAt'),'')='' AND COALESCE(json_extract(data,'$.managementClosedAt'),'')='' AND json_extract(data,'$.ownerId')=? AND json_extract(data,'$.generation')=?`, [task.id, task.ownerId, tracking.generation])
    for (const episode of currentEpisodes.filter(row => row.parentTaskId === task.id && !row.resolvedAt && !row.managementClosedAt && row.ownerId === task.ownerId && row.generation === tracking.generation)) {
      if (episode.reviewAt && episode.reviewAt > now.toISOString()) continue
      if (episode.sourceType === 'weeklyRecord') {
        const record = store.get<WeeklyRecord>('weeklyRecords', episode.sourceId)
        if (!record || !isEffectiveWeeklyRecord(record) || record.status !== 'blocked') continue
        if (shiftDay(record.weekStart, 6) < day) { add('previous_week_blocker', episode.id, '', `本周工作阻塞尚未核对：${episode.reason}；请决定承接或解除`, true); continue }
      } else if (task.status !== 'blocked') continue
      if (workdayCount(shanghaiDate(new Date(episode.openedAt)), day, overrides) >= settings.blockerWorkdays) add('blocker_escalation', episode.id, '', `${episode.sourceType === 'weeklyRecord' ? '本周工作' : '任务'}阻塞：${episode.reason}；需要支持：${episode.supportNeeded || '待补充'}`, true)
    }
  }
  const order: WorkRiskKind[] = ['blocker_escalation', 'previous_week_blocker', 'pause_review', 'overdue', 'followup_overdue', 'due_today', 'due_soon', 'stale']
  return results.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.dueAt.localeCompare(b.dueAt) || a.taskId.localeCompare(b.taskId))
}

export function risksForActor(store: Store, actor: User, now = new Date()) {
  actor = liveCollaborationActor(store, actor)
  return evaluateWorkRisks(store, now, actor).filter(risk => actor.role === 'manager' || risk.ownerId === actor.id && !risk.managerOnly)
}

/** Current-day slots only. Missed historical slots never become a replay backlog. */
export function automaticRiskCandidates(store: Store, now = new Date()): { slot: '09:00' | '17:00'; risks: WorkRisk[] } | undefined {
  const settings = readCollaborationSettings(store), day = shanghaiDate(now), time = shanghaiTime(now)
  if (!settings.enabled || !settings.autoRulesEnabled || !workingDay(day, settings.calendarOverrides) || time < '09:00') return
  const slot = time >= '17:00' ? '17:00' : '09:00', occurrences = store.list<ReminderOccurrence>('reminderOccurrences')
  const expanded = evaluateWorkRisks(store, now).flatMap(risk => {
    if (risk.kind === 'followup_overdue' && new Set(occurrences.filter(row => row.riskKey === risk.key && row.createdFor === 'member').map(row => row.day)).size >= 2) return [{ ...risk, managerOnly: true }]
    if (risk.kind === 'overdue' && workdayCount(risk.dueAt.slice(0, 10), day, settings.calendarOverrides, true) >= 3) return [risk, { ...risk, managerOnly: true }]
    return [risk]
  })
  const risks = expanded.filter(risk => {
    if (slot === '17:00' && risk.kind !== 'due_soon' || slot === '09:00' && risk.kind === 'due_soon') return false
    const prior = [...new Map(occurrences.filter(row => row.taskId === risk.taskId && row.createdFor === (risk.managerOnly ? 'manager' : 'member') && row.kinds.includes(risk.kind)).map(row => [row.day, row])).values()]
    if (prior.some(row => row.day === day)) return false
    const latest = prior.sort((a, b) => b.day.localeCompare(a.day))[0]
    if (['overdue', 'blocker_escalation'].includes(risk.kind) && latest && workdayCount(latest.day, day, settings.calendarOverrides, true) < 2) return false
    const weekCount = prior.filter(row => weekOf(row.day) === weekOf(day)).length
    if (!risk.managerOnly && (risk.kind === 'overdue' && weekCount >= 3 || risk.kind === 'stale' && weekCount >= 2)) return false
    if (['due_soon', 'due_today', 'previous_week_blocker'].includes(risk.kind) && prior.some(row => row.riskKey === risk.key)) return false
    return true
  })
  return { slot, risks }
}

export function riskTitle(risks: WorkRisk[]) { return [...new Set(risks.map(risk => workRiskLabels[risk.kind]))].join('、') }
