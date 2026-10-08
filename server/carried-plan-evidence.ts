import type { Store } from './store.ts'

/** Proven task migration, independent of the original month's acceptance and operation epoch. */
export const carriedPlanSourcesSql = `WITH RECURSIVE carryAncestors(targetId,sourceId) AS (
  SELECT id,json_extract(data,'$.sourcePlanId') FROM entities
    WHERE collection='plans' AND json_extract(data,'$.sourcePlanId') IS NOT NULL
  UNION
  SELECT c.targetId,json_extract(p.data,'$.sourcePlanId') FROM carryAncestors c
    JOIN entities p ON p.collection='plans' AND p.id=c.sourceId
    WHERE json_extract(p.data,'$.sourcePlanId') IS NOT NULL
)
SELECT json_extract(data,'$.sourcePlanId') AS planId FROM entities WHERE collection='carryWorkflows'
  AND json_extract(data,'$.status')='completed' AND json_array_length(data,'$.result.taskIds')>0
UNION
SELECT json_extract(e.data,'$.before.monthlyPlanId') AS planId FROM entities e
  WHERE e.collection='events' AND json_extract(e.data,'$.entityType')='task' AND json_extract(e.data,'$.action')='relink'
    AND json_extract(e.data,'$.before.id')=json_extract(e.data,'$.entityId')
    AND json_extract(e.data,'$.after.id')=json_extract(e.data,'$.entityId')
    AND json_extract(e.data,'$.after.version')>json_extract(e.data,'$.before.version')
    AND json_extract(e.data,'$.before.monthlyPlanId')<>json_extract(e.data,'$.after.monthlyPlanId')
    AND EXISTS(SELECT 1 FROM carryAncestors c
      WHERE c.targetId=json_extract(e.data,'$.after.monthlyPlanId') AND c.sourceId=json_extract(e.data,'$.before.monthlyPlanId'))`

/** Callers pass already-authorized goals; no workflow contents or audit snapshots are exposed. */
export function carriedPlanIds(store: Store, sourcePlanIds: readonly string[]): Set<string> {
  if (!sourcePlanIds.length) return new Set()
  return new Set(store.selectRows(`SELECT planId FROM (${carriedPlanSourcesSql})
    WHERE planId IN (SELECT value FROM json_each(?))`, [JSON.stringify([...new Set(sourcePlanIds)])]).map(row => String(row.planId)))
}
