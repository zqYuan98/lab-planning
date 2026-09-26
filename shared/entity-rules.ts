/**
 * Field rules for the core business entities, shared by the TypeScript types (shared/types.ts),
 * request validation in the domain services, the migration packet schemas
 * (server/data-transfer-schema.ts) and form limits in the browser. A value accepted by one of
 * them must be accepted by the others, or a record saved through the app could not be restored.
 */
export const ROLES = ['manager', 'member', 'observer'] as const
export const PROJECT_STATUSES = ['active', 'archived'] as const
export const ANNUAL_GOAL_STATUSES = ['active', 'completed'] as const
export const PROGRESS_MODES = ['manual', 'linked'] as const
export const PLAN_STATUSES = ['draft', 'submitted', 'returned', 'approved', 'published', 'merged'] as const
export const ACCEPTANCE_STATUSES = ['pending', 'submitted', 'accepted', 'not_completed'] as const
export const PRIORITIES = ['high', 'medium', 'low'] as const
export const TASK_STATUSES = ['todo', 'doing', 'blocked', 'done'] as const
export const WEEKLY_STATUSES = ['planned', 'doing', 'blocked', 'done', 'not_done'] as const
export const WORK_SOURCES = ['leader', 'self', 'coordination'] as const
export const WORK_ORIGIN_KINDS = ['self', 'assigned', 'proxy'] as const
export const PLAN_VISIBILITIES = ['reference', 'historical'] as const

/** Maximum lengths in UTF-16 code units, the unit of String.length and the maxLength attribute. */
export const LIMITS = {
  /** Default for free text: descriptions, outcomes, notes, reasons. */
  text: 12000,
  /** Imported task descriptions and original source text keep the source intact. */
  importedText: 20000,
  personName: 100,
  position: 100,
  email: 254,
  title: 300,
  projectName: 200,
  projectCode: 50,
  category: 100,
  assignedBy: 100,
  url: 2000,
  id: 200,
} as const
