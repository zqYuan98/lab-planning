import type { CollaborationPreference } from '../shared/collaboration-notifications.ts'
import type { CollaborationDashboard, CollaborationDigestSummary, CollaborationTaskRow } from '../shared/collaboration-query.ts'
import type { FollowupRequest, TaskTracking } from '../shared/collaboration.ts'
import type { Task, User, WeeklyRecord } from '../shared/types.ts'
import type { DirectoryAccount } from '../shared/directory-workspace.ts'
import { summarizeCollaborationTask } from '../shared/collaboration-task-summary.ts'
import { HttpError, type Store } from './store.ts'
import { pageContext, pageWindow, queryKeys, queryText } from './page-read-common.ts'
import { readCollaborationSettings } from './collaboration-policy.ts'
import { risksForActor } from './collaboration-rules.ts'
import { historicalPlanDataSql } from './workspace-plan-snapshot.ts'
import { weekOf, shanghaiDate } from './collaboration-calendar.ts'

const taskField = (name: string) => `json_extract(t.data,'$.${name}')`
// Pinned: without statistics SQLite picks the generic status index and scans every open request per task.
const openFollowup = `EXISTS(SELECT 1 FROM entities f INDEXED BY followup_open_task_owner WHERE f.collection='followupRequests' AND json_extract(f.data,'$.taskId')=t.id AND json_extract(f.data,'$.ownerId')=${taskField('ownerId')} AND json_extract(f.data,'$.status')='open')`
const trackingState = `(SELECT json_extract(k.data,'$.state') FROM entities k WHERE k.collection='taskTrackings' AND k.id=t.id)`

/** Full counts and bounded rows share one authorization/query snapshot. */
export function collaborationDashboard(store: Store, actor: User, input: Record<string, unknown>, now = new Date()): CollaborationDashboard {
  return store.readTransaction(() => {
    queryKeys(input, ['filter', 'q', 'cursor', 'limit'])
    const context = pageContext(store, actor); actor = context.actor
    const filter = queryText(input.filter) || 'all', q = queryText(input.q, 120)
    if (!['all', 'unfinished', 'done', 'risk', 'followup', 'active', 'paused'].includes(filter)) throw new HttpError(400, '工作事项筛选无效')
    const window = pageWindow(input, context, 'collaboration'), risks = risksForActor(store, actor, now)
    const riskIds = [...new Set(risks.map(row => row.taskId))]
    const base = `t.collection='tasks' AND ${taskField('cancellation')} IS NULL${actor.role === 'manager' ? '' : ` AND ${taskField('ownerId')}=?`}`
    const baseValues = actor.role === 'manager' ? [] : [actor.id]
    const counts = store.selectRows(`SELECT COUNT(*) AS allCount,SUM(CASE WHEN ${taskField('status')}<>'done' THEN 1 ELSE 0 END) AS unfinished,SUM(CASE WHEN ${taskField('status')}='done' THEN 1 ELSE 0 END) AS done,SUM(CASE WHEN ${openFollowup} THEN 1 ELSE 0 END) AS followup,SUM(CASE WHEN ${trackingState}='active' THEN 1 ELSE 0 END) AS active,SUM(CASE WHEN ${trackingState}='paused' THEN 1 ELSE 0 END) AS paused FROM entities t WHERE ${base}`, baseValues)[0]
    let where = base; const values: (string | number)[] = [...baseValues]
    if (q) { where += ` AND instr(lower(${taskField('title')}),lower(?))>0`; values.push(q) }
    if (filter === 'unfinished' || filter === 'done') where += ` AND ${taskField('status')}${filter === 'unfinished' ? '<>' : '='}'done'`
    else if (filter === 'followup') where += ` AND ${openFollowup}`
    else if (filter === 'risk') { where += ` AND t.id IN (SELECT value FROM json_each(?))`; values.push(JSON.stringify(riskIds)) }
    else if (filter === 'active' || filter === 'paused') { where += ` AND ${trackingState}=?`; values.push(filter) }
    const total = Number(store.selectRows(`SELECT COUNT(*) AS n FROM entities t WHERE ${where}`, values)[0].n)
    const tasks = store.selectJson<Task>(`SELECT t.data AS data FROM entities t WHERE ${where} ORDER BY t.rowid LIMIT ? OFFSET ?`, [...values, window.limit, window.offset])
    const rows = tasks.map(task => {
      const tracking = store.get<TaskTracking>('taskTrackings', task.id) ?? null
      const followup = store.selectJson<FollowupRequest>(`SELECT data FROM entities WHERE collection='followupRequests' AND json_extract(data,'$.taskId')=? AND json_extract(data,'$.ownerId')=? AND json_extract(data,'$.status')='open' ORDER BY rowid LIMIT 1`, [task.id, task.ownerId])[0] ?? null
      const record = store.selectJson<WeeklyRecord>(`SELECT r.data AS data FROM entities r WHERE r.collection='weeklyRecords' AND json_extract(r.data,'$.taskId')=? AND json_extract(r.data,'$.ownerId')=? AND json_extract(r.data,'$.deletion') IS NULL AND json_extract(r.data,'$.weekStart')<=? AND (?=json_extract(r.data,'$.ownerId') OR (json_extract(r.data,'$.submitted')=1 AND (NOT COALESCE(json_extract(r.data,'$.planApproval.required'),0) OR json_extract(r.data,'$.planApproval.suspended')=1 OR (COALESCE(json_extract(r.data,'$.planApproval.approvedSubmissionId'),'')<>'' AND json_extract(r.data,'$.planApproval.approvedFingerprint')=json_array(json_extract(r.data,'$.taskId'),json_extract(r.data,'$.ownerId'),json_extract(r.data,'$.weekStart'),json_extract(r.data,'$.monthlyPlanId'),json_extract(r.data,'$.commitment')))))) ORDER BY json_extract(r.data,'$.weekStart') DESC,json_extract(r.data,'$.updatedAt') DESC,json_extract(r.data,'$.version') DESC,r.id LIMIT 1`, [task.id, task.ownerId, weekOf(shanghaiDate(now)), actor.id])
      const owner = store.selectJson<DirectoryAccount>(`SELECT json_object('id',id,'name',json_extract(data,'$.name'),'role',json_extract(data,'$.role'),'position',json_extract(data,'$.position'),'active',json_extract(data,'$.active'),'registrationStatus',COALESCE(json_extract(data,'$.registrationStatus'),'approved')) AS data FROM entities WHERE collection='users' AND id=?`, [task.ownerId])[0] ?? null
      const plan = !task.monthlyPlanId ? null : store.selectJson<CollaborationTaskRow['plan']>(`WITH viewer AS (SELECT ? AS actorId), source AS (SELECT CASE WHEN ?=1 OR json_extract(p.data,'$.ownerId')=viewer.actorId OR EXISTS(SELECT 1 FROM json_each(p.data,'$.collaboratorIds') c WHERE c.value=viewer.actorId) THEN p.data ELSE ${historicalPlanDataSql('p.id', 'viewer.actorId')} END AS data FROM entities p,viewer WHERE p.collection='plans' AND p.id=?) SELECT json_object('id',json_extract(data,'$.id'),'priority',json_extract(data,'$.priority'),'isTemporary',COALESCE(json_extract(data,'$.isTemporary'),0)) AS data FROM source WHERE data IS NOT NULL`, [actor.id, Number(actor.role === 'manager'), task.monthlyPlanId])[0] ?? null
      return { task, tracking, openFollowup: followup, owner, plan, ...summarizeCollaborationTask(task, record, actor, now) }
    })
    const ids = new Set(tasks.map(row => row.id))
    const digests = store.selectJson<CollaborationDigestSummary>(`SELECT json_object('id',id,'type',json_extract(data,'$.type'),'generatedAt',json_extract(data,'$.generatedAt'),'itemCount',json_array_length(data,'$.itemIds')) AS data FROM entities WHERE collection='notificationDigests' AND json_extract(data,'$.recipientId')=? ORDER BY rowid DESC LIMIT 50`, [actor.id])
    return { settings: readCollaborationSettings(store), preference: store.get<CollaborationPreference>('collaborationPreferences', actor.id) ?? { version: 0, memberActionsEnabled: true }, tasks: rows, risks: risks.filter(row => ids.has(row.taskId)), digests,
      counts: { all: Number(counts.allCount), unfinished: Number(counts.unfinished ?? 0), done: Number(counts.done ?? 0), followup: Number(counts.followup ?? 0), active: Number(counts.active ?? 0), paused: Number(counts.paused ?? 0), risks: risks.length, riskTasks: riskIds.length }, total,
      nextCursor: window.offset + rows.length < total ? window.cursor(window.offset + rows.length) : null, revision: context.revision, accessScopeVersion: context.accessScopeVersion }
  })
}
