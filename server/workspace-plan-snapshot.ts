/** Fixed SQL fragments only; id/actor expressions are supplied by our query builders. */
export function historicalPlanDataSql(id: string, actor: string) {
  return `(SELECT ps.data FROM (
    SELECT json_extract(ph.data,'$.before') AS data,ph.rowid AS position,0 AS side FROM entities ph WHERE ph.collection='events' AND json_extract(ph.data,'$.entityType')='plan' AND json_extract(ph.data,'$.entityId')=+${id}
    UNION ALL SELECT json_extract(ph.data,'$.after'),ph.rowid,1 FROM entities ph WHERE ph.collection='events' AND json_extract(ph.data,'$.entityType')='plan' AND json_extract(ph.data,'$.entityId')=+${id}
    UNION ALL SELECT pp.value,ph.rowid,2 FROM entities ph,json_each(ph.data,'$.plans') pp WHERE ph.collection='publications'
  ) ps WHERE json_extract(ps.data,'$.id')=+${id} AND json_type(ps.data,'$.collaboratorIds')='array'
    AND (json_extract(ps.data,'$.ownerId')=${actor} OR EXISTS(SELECT 1 FROM json_each(ps.data,'$.collaboratorIds') pc WHERE pc.value=${actor}))
  ORDER BY json_extract(ps.data,'$.version') DESC,CASE WHEN ps.side=2 THEN 1 ELSE 0 END,ps.position,ps.side LIMIT 1)`
}
