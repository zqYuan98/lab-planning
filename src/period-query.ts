/**
 * Page shells and bodies must build the same query string for the same state.
 * A mismatch aborts the first read and issues a second one, and the synchronous
 * server still computes the aborted read in full.
 */
export function weeklyPageQuery(value: { weekStart: string; ownerId: string; status: string; q: string; source: string; includeInactive: boolean; id?: string }) {
  const params = new URLSearchParams({ weekStart: value.weekStart, ownerId: value.ownerId, status: value.status, q: value.q, source: value.source, includeInactive: String(value.includeInactive) })
  if (value.id) params.set('id', value.id)
  return params.toString()
}
export function monthlyPageQuery(value: { month: string; scope: string; status: string; q: string; includeInactive: boolean; id?: string }) {
  const params = new URLSearchParams({ month: value.month, scope: value.scope, status: value.scope === 'historical' ? 'all' : value.status, q: value.q, includeInactive: String(value.includeInactive) })
  if (value.id) params.set('id', value.id)
  return params.toString()
}
