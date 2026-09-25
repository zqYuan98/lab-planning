const pathname = (path: string) => path.replace(/^\/api(?=\/)/, '').split('?')[0]
export function isReadOnlyCommand(path: string) {
  path = pathname(path)
  return ['/workspace/import-references', '/weekly-submissions/deadline-repair/preview', '/carry-workflows/preview', '/followups/preview', '/data/restore/preview', '/period-reviews/preview'].includes(path)
    || /^\/carry-workflows\/[^/]+\/preview-apply$/.test(path)
}
const matches = (value: string, prefixes: readonly string[]) => prefixes.some(prefix => value === prefix || value.startsWith(`${prefix}/`))
const identity = ['/users', '/data/restore/commit', '/object-grants', '/access-grants']
const work = ['/tasks', '/weekly-records', '/weekly-assignments', '/work-register', '/progress', '/deliveries', '/delivery-decisions', '/carry-workflows']
const plans = ['/plans', '/months']
const collaboration = ['/followups', '/task-trackings', '/blockers', '/decisions', '/decision-requests', '/deadline-requests', '/collaboration/settings', '/collaboration/preferences', '/digests']
/** Invalidation is about business dependencies, never the size of a mutation response. */
export function queryAffected(readPath: string, mutationPath: string): boolean {
  const read = pathname(readPath), mutation = pathname(mutationPath)
  if (isReadOnlyCommand(mutation) || mutation.startsWith('/usage-analytics')) return false
  if (matches(mutation, identity) || /^\/imports\/[^/]+\/commit$/.test(mutation)) return true
  if (read === '/workspace') return shellAffected(mutation)
  if (matches(read, ['/workspace/team', '/workspace/registration-requests', '/workspace/directory/accounts'])) return false
  if (read === '/workspace/projects') return matches(mutation, ['/projects', ...plans, '/carry-workflows'])
  if (matches(read, ['/workspace/annual-goals'])) return matches(mutation, ['/annual-goals', ...plans, '/carry-workflows'])
  if (matches(read, ['/workspace/goal-owner'])) return matches(mutation, [...work, ...plans, '/weekly-submissions'])
  if (matches(read, ['/weekly-review-queue', '/weekly-review-delegation'])) return matches(mutation, [...work, ...plans, '/weekly-submissions', '/weekly-review-delegation'])
  if (read.startsWith('/workspace/candidates')) return matches(mutation, ['/projects', ...plans])
  if (matches(read, ['/workspace/reports'])) return matches(mutation, ['/reports', '/report-agent'])
  if (matches(read, ['/workspace/overview', '/workspace/weekly', '/workspace/monthly', '/workspace/tasks', '/workspace/plans', '/workspace/weekly-records', '/workspace/register', '/workspace/history', '/workspace/progress'])) return matches(mutation, [...work, ...plans, ...collaboration, '/weekly-submissions', '/projects'])
  if (read.startsWith('/tasks/')) return matches(mutation, [...work, ...plans, ...collaboration, '/weekly-submissions'])
  if (read.startsWith('/workspace/import') || read.startsWith('/imports')) return matches(mutation, ['/imports', '/projects', ...work, ...plans])
  if (read.startsWith('/feedback')) return matches(mutation, ['/feedback'])
  if (matches(read, ['/collaboration', '/digests'])) return matches(mutation, [...work, ...plans, ...collaboration, '/projects'])
  if (read === '/native/settings') return matches(mutation, ['/native', '/dingtalk'])
  if (matches(read, ['/notification-settings', '/notification-diagnostics', '/notification-deliveries', '/native-capabilities'])) return matches(mutation, ['/notification-settings', '/notification-deliveries', '/notifications', '/dingtalk', '/native', '/collaboration/settings'])
  if (read.startsWith('/notifications')) return matches(mutation, ['/notifications', ...work, ...plans, ...collaboration, '/weekly-submissions'])
  if (read.startsWith('/period-reviews')) return matches(mutation, ['/period-reviews'])
  if (read.startsWith('/weekly-submissions')) return matches(mutation, ['/weekly-submissions', ...work, ...plans])
  // Existing specialist resources retain conservative refresh until their dependency is explicit.
  return true
}
export function shellAffected(mutationPath: string) {
  const mutation = pathname(mutationPath)
  return matches(mutation, [...identity, ...plans, '/weekly-review-delegation', '/ai/settings', '/tasks', '/work-register', '/weekly-assignments', '/carry-workflows'])
    || /^\/imports\/[^/]+\/commit$/.test(mutation)
}
