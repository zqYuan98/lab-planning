import type { WorkRegisterView } from '../shared/work-register.ts'
import { field as f } from './workspace-query-sql.ts'
import { historicalPlanDataSql } from './workspace-plan-snapshot.ts'

export interface RegisterFilter { actorId: string; manager?: boolean; weekStart: string; view: WorkRegisterView; q?: string; priority?: string; kind?: string }
const active = `(COALESCE(${f('status')},'')<>'done' OR (${f('importSource')} IS NOT NULL AND trim(COALESCE(${f('completionNote')},''))=''))`
export const registerViews: Record<WorkRegisterView, string> = {
  active: 'active=1', leader: "active=1 AND source='leader'", unscheduled: 'active=1 AND unscheduled=1', week: 'active=1 AND currentWeek=1', waiting: 'active=1 AND waiting=1', done: 'active=0', 'source-review': "active=1 AND COALESCE(source,'')=''", 'completion-review': 'completionReview=1',
}
export function registerSql(filter: RegisterFilter) {
  // Unary + removes the TEXT column affinity from the correlated id comparison.
  // EXPLAIN then seeks the JSON expression index instead of scanning all weeks.
  const planData = `(SELECT CASE WHEN (SELECT manager FROM context)=1 OR ${f('ownerId','p')}=(SELECT actorId FROM context) OR EXISTS(SELECT 1 FROM json_each(${f('collaboratorIds','p')}) c WHERE c.value=(SELECT actorId FROM context)) THEN p.data ELSE ${historicalPlanDataSql('p.id', '(SELECT actorId FROM context)')} END FROM entities p WHERE p.collection='plans' AND p.id=${f('monthlyPlanId')})`
  const planPriority = `COALESCE(json_extract(${planData},'$.priority'),CASE WHEN EXISTS(SELECT 1 FROM entities p WHERE p.collection='plans' AND p.id=${f('monthlyPlanId')}) THEN 'medium' END)`
  const initialEvent = `v.collection='events' AND ${f('entityType','v')}='task' AND ${f('entityId','v')}=+e.id AND ${f('before','v')} IS NULL AND ${f('action','v')} IN ('create','submit')`
  const legacyAssigned = `${f('workOrigin')} IS NULL AND (SELECT COUNT(*) FROM entities v WHERE ${initialEvent})=1 AND EXISTS(SELECT 1 FROM entities v WHERE ${initialEvent} AND ${f('after.id','v')}=+e.id AND ${f('after.ownerId','v')}=${f('ownerId')} AND ${f('after.createdAt','v')}=${f('createdAt')} AND ${f('after.importSource','v')} IS NULL AND COALESCE(${f('actorId','v')},'')<>'' AND (COALESCE(${f('after.workOrigin.kind','v')},'')='assigned' OR ${f('after.workOrigin','v')} IS NULL AND ${f('actorId','v')}<>${f('ownerId')}))`
  const cte = `WITH context AS (SELECT ? AS actorId,? AS manager), missingEvents AS MATERIALIZED (
    SELECT v.data,v.rowid AS eventOrder,${f('entityId','v')} AS entityId FROM entities v WHERE v.collection='events' AND ${f('entityType','v')}='task'
      AND NOT EXISTS(SELECT 1 FROM entities t WHERE t.collection='tasks' AND t.id=${f('entityId','v')} AND (${f('ownerId','t')}=? OR ${f('cancellation','t')} IS NOT NULL))
      AND EXISTS(SELECT 1 FROM entities w WHERE w.collection='weeklyRecords' AND ${f('taskId','w')}=${f('entityId','v')} AND ${f('ownerId','w')}=? AND ${f('deletion','w')} IS NULL)
  ), snapshots AS (
    SELECT json_extract(data,'$.before') AS data,eventOrder,0 AS side FROM missingEvents WHERE json_extract(data,'$.before.id')=entityId UNION ALL SELECT json_extract(data,'$.after'),eventOrder,1 FROM missingEvents WHERE json_extract(data,'$.after.id')=entityId
  ), historicalTasks AS (
    SELECT data,json_extract(data,'$.id') AS id,ROW_NUMBER() OVER(PARTITION BY json_extract(data,'$.id') ORDER BY json_extract(data,'$.version') DESC,eventOrder,side) AS position
    FROM snapshots WHERE data IS NOT NULL AND json_extract(data,'$.ownerId')=?
  ), taskObjects AS (
    SELECT e.data,e.id,0 AS historicalReference FROM entities e WHERE e.collection='tasks' AND ${f('ownerId')}=? AND ${f('cancellation')} IS NULL
    UNION ALL SELECT data,id,1 FROM historicalTasks WHERE position=1 AND json_extract(data,'$.cancellation') IS NULL
  ), rows AS (
    SELECT e.data,e.id,e.historicalReference,${f('createdAt')} AS createdAt,'task' AS rowKind,${active} AS active,
      (${f('status')}='done' AND ${f('importSource')} IS NOT NULL AND trim(COALESCE(${f('completionNote')},''))='') AS completionReview,
      COALESCE(${f('workSource')},CASE WHEN ${f('importSource')} IS NULL AND (${f('workOrigin.kind')}='assigned' OR (${legacyAssigned})) THEN 'leader' END) AS source,
      COALESCE(${f('priority')},${planPriority}) AS priority,
      CASE WHEN ${f('isTemporary')}=1 OR trim(COALESCE(${f('temporaryReason')},''))<>'' OR json_extract(${planData},'$.isTemporary')=1 THEN 'temporary' WHEN ${f('monthlyPlanId')} IS NOT NULL THEN 'monthly' ELSE 'routine' END AS kind,
      NOT EXISTS(SELECT 1 FROM entities w WHERE w.collection='weeklyRecords' AND ${f('taskId','w')}=+e.id AND ${f('ownerId','w')}=? AND ${f('deletion','w')} IS NULL AND ${f('weekStart','w')}>=?) AS unscheduled,
      EXISTS(SELECT 1 FROM entities w WHERE w.collection='weeklyRecords' AND ${f('taskId','w')}=+e.id AND ${f('ownerId','w')}=? AND ${f('deletion','w')} IS NULL AND ${f('weekStart','w')}=?) AS currentWeek,
      COALESCE(${f('waitingForFeedback')},0) AS waiting,
      (${active} AND (${f('status')}='blocked' OR ${f('waitingForFeedback')}=1 OR trim(COALESCE(${f('decisionNeeded')},''))<>'' OR trim(COALESCE(${f('supportNeeded')},''))<>'')) AS coordination
    FROM taskObjects e
    UNION ALL
    SELECT e.data,e.id,0,${f('createdAt')},'plan',1,0,${f('workSource')},${f('priority')},CASE WHEN ${f('isTemporary')}=1 THEN 'temporary' ELSE 'monthly' END,1,0,0,0
    FROM entities e WHERE e.collection='plans' AND ${f('ownerId')}=? AND ${f('status')}<>'merged' AND ${f('acceptanceStatus')}<>'accepted'
      AND NOT EXISTS(SELECT 1 FROM taskObjects t WHERE ${f('monthlyPlanId','t')}=+e.id)
  )`
  const values: (string | number)[] = [filter.actorId, filter.manager ? 1 : 0, filter.actorId, filter.actorId, filter.actorId, filter.actorId, filter.actorId, filter.weekStart, filter.actorId, filter.weekStart, filter.actorId]
  const baseValues = [...values]
  const predicate = [registerViews[filter.view]]
  if (filter.priority) { predicate.push('priority=?'); values.push(filter.priority) }
  if (filter.kind) { predicate.push('kind=?'); values.push(filter.kind) }
  if (filter.q) {
    const names = ['title', 'description', 'currentProgress', 'assignedBy', 'assignedOn', 'estimatedEffort', 'blockerReason', 'requestedOutcome', 'nextAction', 'decisionNeeded', 'supportNeeded', 'temporaryReason', 'expectedOutcome', 'acceptanceCriteria', 'category']
    const parts: { sql: string; values: string[] }[] = names.map(name=>({sql:`json_extract(data,'$.${name}')`,values:[]}))
    parts.push({ sql: `CASE source WHEN 'leader' THEN CASE WHEN json_extract(data,'$.workSource') IS NULL AND rowKind='task' THEN '领导交办（按下发记录）' ELSE '领导交办' END WHEN 'self' THEN '自主安排' WHEN 'coordination' THEN '协同事项' ELSE '来源待核对' END`, values: [] })
    parts.push({ sql: `CASE WHEN completionReview=1 THEN '整体完成待核对' WHEN rowKind='plan' THEN CASE json_extract(data,'$.status') WHEN 'draft' THEN '草稿' WHEN 'returned' THEN '退回修改' WHEN 'submitted' THEN '待审核' WHEN 'approved' THEN '审核通过，待发布' WHEN 'published' THEN '已发布' ELSE '已合并' END ELSE CASE json_extract(data,'$.status') WHEN 'todo' THEN '未开始' WHEN 'doing' THEN '进行中' WHEN 'blocked' THEN '受阻' ELSE '已完成' END END`, values: [] })
    parts.push({ sql: `CASE WHEN rowKind='plan' THEN '月度目标 待建立个人任务' ELSE '' END`, values: [] })
    parts.push({ sql: `CASE WHEN rowKind='plan' THEN json_extract(data,'$.actualOutcome') ELSE COALESCE(NULLIF(CASE WHEN json_extract(data,'$.status')='done' THEN trim(json_extract(data,'$.completionNote')) ELSE '' END,''),NULLIF(trim(json_extract(data,'$.currentProgress')),''),(SELECT ${f('actualOutcome','w')} FROM entities w WHERE w.collection='weeklyRecords' AND ${f('taskId','w')}=+rows.id AND ${f('ownerId','w')}=json_extract(rows.data,'$.ownerId') AND ${f('deletion','w')} IS NULL AND ${f('weekStart','w')}<=? AND trim(COALESCE(${f('actualOutcome','w')},''))<>'' ORDER BY ${f('weekStart','w')} DESC,${f('updatedAt','w')} DESC,w.version DESC,w.id LIMIT 1),'') END`, values: [filter.weekStart] })
    parts.push({ sql: `CASE WHEN rowKind='task' AND source='leader' AND COALESCE(json_extract(data,'$.workSource'),'')='' AND COALESCE(json_extract(data,'$.assignedBy'),'')='' THEN (SELECT ${f('name','u')} FROM entities u WHERE u.collection='users' AND u.id=COALESCE(json_extract(rows.data,'$.workOrigin.actorId'),(SELECT ${f('actorId','v')} FROM entities v WHERE v.collection='events' AND ${f('entityType','v')}='task' AND ${f('entityId','v')}=+rows.id AND ${f('before','v')} IS NULL AND ${f('action','v')} IN ('create','submit') LIMIT 1))) ELSE '' END`, values: [] })
    predicate.push(`(${parts.map(part => `instr(lower(COALESCE(${part.sql},'')),lower(?))>0`).join(' OR ')})`)
    for (const part of parts) values.push(...part.values, filter.q)
  }
  return { cte, baseValues, values, predicate: predicate.join(' AND ') }
}
