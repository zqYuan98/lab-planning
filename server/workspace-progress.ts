import type { DatabaseSync } from 'node:sqlite'
import type { Task } from '../shared/types.ts'
import type { ExecutionProgress, WorkProgress } from '../shared/work-progress.ts'
import { meaningfulText } from './collaboration-store.ts'

/** Keep the same string/time semantics as the complete work-progress projector. */
export function registerWorkspaceProgressFunctions(db: DatabaseSync) {
  db.function('progress_clean', { deterministic: true }, value => typeof value === 'string' ? value.trim() : '')
  db.function('progress_meaningful', { deterministic: true }, value => meaningfulText(value))
  db.function('progress_time', { deterministic: true }, value => typeof value === 'string' && value && Number.isFinite(Date.parse(value)) ? value : null)
}

export interface WorkspaceProgressRow {
  taskId: string
  kind: 'overall' | 'latest' | 'historical'
  text: string
  sourceType: ExecutionProgress['sourceType'] | null
  sourceId: string | null
  weekStart: string | null
  occurredAt: string | null
  recordedAt: string | null
  actorId: string | null
  proxy: number | null
  evidenceQuality: ExecutionProgress['evidenceQuality'] | null
}

/** SQL may inspect relevant history, but returns at most 22 small facts per requested task. */
export function workspaceProgressSql(tasks: Task[], actorId: string, manager: boolean, today: string) {
  const taskValues = tasks.map(task => ({ id: task.id, ownerId: task.ownerId, currentProgress: task.currentProgress ?? '', completionNote: task.completionNote ?? '' }))
  return { values: [JSON.stringify(taskValues), manager ? 1 : 0, actorId, today], sql: `
WITH
context AS (SELECT ? AS tasks,? AS manager,? AS actorId,? AS today),
tasks AS MATERIALIZED (
 SELECT json_extract(t.value,'$.id') AS id,json_extract(t.value,'$.ownerId') AS ownerId,
 progress_clean(json_extract(t.value,'$.currentProgress')) AS currentProgress,
 progress_clean(json_extract(t.value,'$.completionNote')) AS completionNote
 FROM context c,json_each(c.tasks) t WHERE c.manager=1 OR json_extract(t.value,'$.ownerId')=c.actorId
),
records AS MATERIALIZED (
 SELECT r.id,r.rowid AS position,json_extract(r.data,'$.taskId') AS taskId,json_extract(r.data,'$.weekStart') AS weekStart,
 progress_clean(json_extract(r.data,'$.actualOutcome')) AS actualOutcome
 FROM tasks t CROSS JOIN entities r CROSS JOIN context c
 WHERE r.collection='weeklyRecords' AND json_extract(r.data,'$.taskId')=+t.id AND (c.manager=1 OR json_extract(r.data,'$.ownerId')=c.actorId)
 AND json_extract(r.data,'$.deletion') IS NULL AND json_extract(r.data,'$.submitted')=1
 AND json_extract(r.data,'$.weekStart')<=c.today
 AND (NOT COALESCE(json_extract(r.data,'$.planApproval.required'),0) OR json_extract(r.data,'$.planApproval.suspended')=1
 OR (COALESCE(json_extract(r.data,'$.planApproval.approvedSubmissionId'),'')<>''
 AND json_extract(r.data,'$.planApproval.approvedFingerprint')=json_array(json_extract(r.data,'$.taskId'),json_extract(r.data,'$.ownerId'),json_extract(r.data,'$.weekStart'),json_extract(r.data,'$.monthlyPlanId'),json_extract(r.data,'$.commitment'))))
),
progress AS MATERIALIZED (
 SELECT e.id,e.rowid AS position,e.data,t.id AS taskId,r.weekStart,
 json_extract(e.data,'$.weeklyRecordId') AS weeklyRecordId
 FROM tasks t CROSS JOIN entities e
 LEFT JOIN records r ON r.id=json_extract(e.data,'$.weeklyRecordId') CROSS JOIN context c
 WHERE e.collection='progressEvents' AND json_extract(e.data,'$.taskId')=+t.id AND (c.manager=1 OR json_extract(e.data,'$.ownerId')=c.actorId)
 AND (COALESCE(json_extract(e.data,'$.weeklyRecordId'),'')='' OR r.id IS NOT NULL)
),
audits AS MATERIALIZED (
 SELECT e.id,e.rowid AS position,e.data,t.id AS taskId,t.ownerId,NULL AS weekStart,
 json_extract(e.data,'$.entityType') AS entityType,json_extract(e.data,'$.entityId') AS entityId
 FROM tasks t CROSS JOIN entities e
 CROSS JOIN context c
 WHERE e.collection='events' AND json_extract(e.data,'$.entityType')='task' AND json_extract(e.data,'$.entityId')=+t.id
 AND (c.manager=1 OR json_extract(e.data,'$.after.ownerId')=c.actorId)
 UNION ALL
 SELECT e.id,e.rowid,e.data,r.taskId,t.ownerId,r.weekStart,'weeklyRecord',r.id
 FROM records r CROSS JOIN entities e
 JOIN tasks t ON t.id=r.taskId CROSS JOIN context c
 WHERE e.collection='events' AND json_extract(e.data,'$.entityType')='weeklyRecord' AND json_extract(e.data,'$.entityId')=+r.id
 AND (c.manager=1 OR json_extract(e.data,'$.after.ownerId')=c.actorId)
),
event_text AS (
 SELECT p.*,COALESCE(NULLIF(progress_clean(json_extract(p.data,'$.note')),''),(
 SELECT progress_clean(json_extract(ch.value,'$.after')) FROM json_each(p.data,'$.changes') ch
 WHERE json_extract(ch.value,'$.field') IN ('weeklyRecord.actualOutcome','task.currentProgress','task.completionNote')
 AND progress_clean(json_extract(ch.value,'$.after'))<>'' ORDER BY CAST(ch.key AS INTEGER) LIMIT 1)) AS text
 FROM progress p WHERE COALESCE(json_extract(p.data,'$.noteType'),'')<>'no_change'
),
recorded_audits AS MATERIALIZED (SELECT ids.value AS id FROM progress p,json_each(p.data,'$.auditEventIds') ids),
audit_text AS (
 SELECT a.*,CASE WHEN a.entityType='weeklyRecord' THEN
 CASE WHEN progress_clean(json_extract(a.data,'$.after.actualOutcome'))<>progress_clean(json_extract(a.data,'$.before.actualOutcome')) THEN progress_clean(json_extract(a.data,'$.after.actualOutcome')) END
 WHEN progress_clean(json_extract(a.data,'$.after.currentProgress'))<>'' AND progress_clean(json_extract(a.data,'$.after.currentProgress'))<>progress_clean(json_extract(a.data,'$.before.currentProgress')) THEN progress_clean(json_extract(a.data,'$.after.currentProgress'))
 WHEN progress_clean(json_extract(a.data,'$.after.completionNote'))<>progress_clean(json_extract(a.data,'$.before.completionNote')) THEN progress_clean(json_extract(a.data,'$.after.completionNote')) END AS text
 FROM audits a WHERE json_type(a.data,'$.after')='object'
 AND NOT EXISTS(SELECT 1 FROM recorded_audits ids WHERE ids.id=a.id)
),
raw_facts AS (
 SELECT taskId,text,CASE WHEN weeklyRecordId IS NOT NULL AND weeklyRecordId<>'' THEN 'weeklyRecord'
 WHEN json_extract(data,'$.source') IN ('progress','followup') THEN 'progress' ELSE 'task' END AS sourceType,
 id AS sourceId,weekStart,progress_time(json_extract(data,'$.occurredAt')) AS occurredAt,progress_time(json_extract(data,'$.createdAt')) AS recordedAt,
 json_extract(data,'$.actorId') AS actorId,json_extract(data,'$.actorId')<>json_extract(data,'$.ownerId') AS proxy,
 CASE WHEN progress_time(json_extract(data,'$.occurredAt')) IS NOT NULL THEN 'recorded' ELSE 'unknown' END AS evidenceQuality,0 AS phase,position
 FROM event_text WHERE text<>''
 UNION ALL
 SELECT taskId,text,entityType,id,weekStart,progress_time(json_extract(data,'$.createdAt')),progress_time(json_extract(data,'$.createdAt')),
 json_extract(data,'$.actorId'),json_extract(data,'$.actorId')<>ownerId,
 CASE WHEN progress_time(json_extract(data,'$.createdAt')) IS NOT NULL THEN 'audit_reconstructed' ELSE 'unknown' END,1,position
 FROM audit_text WHERE text<>''
),
facts AS MATERIALIZED (SELECT *,progress_meaningful(text) AS normalizedText FROM raw_facts),
recorded_changes AS MATERIALIZED (
 SELECT p.taskId,p.weeklyRecordId,json_extract(ch.value,'$.field') AS field,progress_meaningful(json_extract(ch.value,'$.after')) AS normalizedText
 FROM progress p,json_each(p.data,'$.changes') ch WHERE progress_time(json_extract(p.data,'$.occurredAt')) IS NOT NULL
),
audit_changes AS MATERIALIZED (
 SELECT a.taskId,a.entityType,a.entityId,'currentProgress' AS field,progress_meaningful(json_extract(a.data,'$.after.currentProgress')) AS normalizedText
 FROM audits a WHERE a.entityType='task' AND progress_time(json_extract(a.data,'$.createdAt')) IS NOT NULL AND json_type(a.data,'$.after')='object'
 AND progress_meaningful(json_extract(a.data,'$.after.currentProgress'))<>progress_meaningful(json_extract(a.data,'$.before.currentProgress'))
 UNION ALL
 SELECT a.taskId,a.entityType,a.entityId,'completionNote',progress_meaningful(json_extract(a.data,'$.after.completionNote'))
 FROM audits a WHERE a.entityType='task' AND progress_time(json_extract(a.data,'$.createdAt')) IS NOT NULL AND json_type(a.data,'$.after')='object'
 AND progress_meaningful(json_extract(a.data,'$.after.completionNote'))<>progress_meaningful(json_extract(a.data,'$.before.completionNote'))
 UNION ALL
 SELECT a.taskId,a.entityType,a.entityId,'actualOutcome',progress_meaningful(json_extract(a.data,'$.after.actualOutcome'))
 FROM audits a WHERE a.entityType='weeklyRecord' AND progress_time(json_extract(a.data,'$.createdAt')) IS NOT NULL AND json_type(a.data,'$.after')='object'
 AND progress_meaningful(json_extract(a.data,'$.after.actualOutcome'))<>progress_meaningful(json_extract(a.data,'$.before.actualOutcome'))
),
legacy AS (
 SELECT id AS taskId,currentProgress AS text,'task' AS sourceType,id AS sourceId,NULL AS weekStart,'currentProgress' AS field,ownerId AS actorId,0 AS position FROM tasks
 UNION ALL SELECT id,completionNote,'task',id,NULL,'completionNote',ownerId,1 FROM tasks
 UNION ALL SELECT r.taskId,r.actualOutcome,'weeklyRecord',r.id,r.weekStart,'actualOutcome',t.ownerId,r.position FROM records r JOIN tasks t ON t.id=r.taskId
),
unrecorded_legacy AS (
 SELECT l.*,row_number() OVER(PARTITION BY l.taskId,l.sourceId,progress_meaningful(l.text) ORDER BY l.position) AS duplicateRank FROM legacy l
 WHERE l.text<>''
 AND NOT EXISTS(SELECT 1 FROM recorded_changes p WHERE p.taskId=l.taskId AND (l.sourceType='task' OR p.weeklyRecordId=l.sourceId)
 AND p.field=l.sourceType||'.'||l.field AND p.normalizedText=progress_meaningful(l.text))
 AND NOT EXISTS(SELECT 1 FROM audit_changes a WHERE a.taskId=l.taskId AND a.entityType=l.sourceType AND a.entityId=l.sourceId
 AND a.field=l.field AND a.normalizedText=progress_meaningful(l.text))
 AND NOT EXISTS(SELECT 1 FROM facts f WHERE f.taskId=l.taskId AND f.normalizedText=progress_meaningful(l.text)
 AND ((f.occurredAt IS NOT NULL AND f.sourceType=l.sourceType AND f.weekStart IS l.weekStart) OR (f.occurredAt IS NULL AND f.sourceId=l.sourceId)))
),
unknown_facts AS (
 SELECT taskId,text,sourceType,sourceId,weekStart,occurredAt,recordedAt,actorId,proxy,evidenceQuality,phase,position FROM facts WHERE occurredAt IS NULL
 UNION ALL SELECT taskId,text,sourceType,sourceId,weekStart,NULL,NULL,actorId,0,'unknown',2,position FROM unrecorded_legacy WHERE duplicateRank=1
),
ranked_known AS (SELECT *,row_number() OVER(PARTITION BY taskId ORDER BY occurredAt DESC,COALESCE(recordedAt,'') DESC,sourceId,phase,position) AS rank FROM facts WHERE occurredAt IS NOT NULL),
ranked_unknown AS (SELECT *,row_number() OVER(PARTITION BY taskId ORDER BY COALESCE(weekStart,'') DESC,sourceId,phase,position) AS rank FROM unknown_facts),
overall_events AS (
 SELECT p.taskId,p.id,json_extract(p.data,'$.occurredAt') AS occurredAt,
 row_number() OVER(PARTITION BY p.taskId ORDER BY json_extract(p.data,'$.occurredAt') DESC,p.id DESC) AS rank
 FROM progress p JOIN tasks t ON t.id=p.taskId WHERE EXISTS(SELECT 1 FROM json_each(p.data,'$.changes') ch
 WHERE json_extract(ch.value,'$.field')='task.currentProgress' AND progress_meaningful(json_extract(ch.value,'$.after'))=progress_meaningful(t.currentProgress))
),
overall_audits AS (
 SELECT a.taskId,a.id,json_extract(a.data,'$.createdAt') AS occurredAt,
 row_number() OVER(PARTITION BY a.taskId ORDER BY json_extract(a.data,'$.createdAt') DESC,a.id DESC) AS rank
 FROM audits a JOIN tasks t ON t.id=a.taskId WHERE a.entityType='task' AND json_type(a.data,'$.after')='object'
 AND progress_clean(json_extract(a.data,'$.after.currentProgress'))=t.currentProgress
 AND progress_clean(json_extract(a.data,'$.before.currentProgress'))<>t.currentProgress
)
SELECT t.id AS taskId,'overall' AS kind,t.currentProgress AS text,NULL AS sourceType,COALESCE(p.id,a.id) AS sourceId,NULL AS weekStart,
 progress_time(COALESCE(NULLIF(p.occurredAt,''),a.occurredAt)) AS occurredAt,NULL AS recordedAt,NULL AS actorId,NULL AS proxy,NULL AS evidenceQuality,0 AS sortOrder
 FROM tasks t LEFT JOIN overall_events p ON p.taskId=t.id AND p.rank=1 LEFT JOIN overall_audits a ON a.taskId=t.id AND a.rank=1 WHERE t.currentProgress<>''
UNION ALL SELECT taskId,'latest',text,sourceType,sourceId,weekStart,occurredAt,recordedAt,actorId,proxy,evidenceQuality,rank FROM ranked_known WHERE rank=1
UNION ALL SELECT taskId,'historical',text,sourceType,sourceId,weekStart,occurredAt,recordedAt,actorId,proxy,evidenceQuality,rank FROM ranked_unknown WHERE rank<=20
ORDER BY taskId,kind,sortOrder` }
}

export function workspaceProgressResult(tasks: Task[], rows: WorkspaceProgressRow[]): Record<string, WorkProgress> {
  const results = Object.fromEntries(tasks.map(task => [task.id, { overallProgress: null, latestExecution: null, historicalExecution: [] } as WorkProgress]))
  for (const row of rows) {
    const result = results[row.taskId]
    if (row.kind === 'overall') result.overallProgress = { text: row.text, changedAt: row.occurredAt, evidenceRef: row.sourceId }
    else {
      const fact: ExecutionProgress = { text: row.text, sourceType: row.sourceType!, sourceId: row.sourceId!, ...(row.weekStart ? { weekStart: row.weekStart } : {}), occurredAt: row.occurredAt, recordedAt: row.recordedAt, actorId: row.actorId!, proxy: !!row.proxy, evidenceQuality: row.evidenceQuality! }
      if (row.kind === 'latest') result.latestExecution = fact
      else result.historicalExecution.push(fact)
    }
  }
  return results
}
