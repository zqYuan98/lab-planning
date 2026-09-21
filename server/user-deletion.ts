import type { AuditEvent, Entity, User } from '../shared/types.ts'
import type { ImportBatch } from '../shared/import-types.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { safeUser } from './auth.ts'
import { businessEventCollections, collectionNames, rowReferences, storedCollection, type TransferCollection } from './data-transfer-schema.ts'
import type { Store } from './store.ts'
import type { Feedback, FeedbackAttachment, FeedbackEvent } from '../shared/feedback.ts'

export interface UserDeletionBlocker { key: string; label: string; count: number }
export interface UserDeletionPreview { user: User; canDelete: boolean; blockers: UserDeletionBlocker[]; retainedHistory: true }

const labels: Record<TransferCollection, string> = {
  users: '成员资料', projects: '项目', annualGoals: '年度目标', plans: '月度计划', tasks: '任务', weeklyRecords: '周记录',
  history: '导入历史', publications: '月度发布快照', reports: '报告及历史快照', events: '业务操作历史',
  weeklyRules: '周提报规则', weeklyCycles: '已冻结的周提报名单', weeklyDuties: '周提报义务',
  weeklySubmissions: '已提交的周报', weeklyMissing: '周提报缺交记录', weeklyAdjustments: '周提报调整记录', weeklyPlanReviews: '下周计划审核记录',
  taskTrackings: '督办纳入记录', progressEvents: '进展时间线', followupRequests: '催办请求', followupResponses: '催办回应', blockerEpisodes: '阻塞阶段', blockerActions: '阻塞支持处理', deadlineChangeRequests: '延期申请',
  reportAssets: '周报模板与 Word 文件', reportTemplates: '周报模板版本',
}

/** Keep exactly the user dependencies required by business export/restore, including nested snapshots. */
export function userDeletionPreview(store: Store, actor: User, user: User): UserDeletionPreview {
  const blockers: UserDeletionBlocker[] = []
  const add = (key: string, label: string, count: number) => { if (count) blockers.push({ key, label, count }) }
  add('self', '不能删除当前登录账号', Number(actor.id === user.id))
  add('lastManager', '必须保留至少一位可登录的管理者', Number(user.role === 'manager' && canUseAccount(user)
    && !store.list<User>('users').some(other => other.id !== user.id && other.role === 'manager' && canUseAccount(other))))
  const referencesUser = (collection: TransferCollection, row: unknown) => rowReferences(collection, row).some(ref => ref.collection === 'users' && ref.id === user.id)
  for (const collection of collectionNames) {
    if (collection === 'users' || collection === 'events') continue
    add(collection, labels[collection], store.list(storedCollection(collection)).filter(row => referencesUser(collection, row)).length)
  }
  // Account lifecycle and credential issuance have no business-data references and are
  // deliberately excluded from migration packets. Retain these audits on deletion;
  // the new user/delete event preserves the removed identity as a safe snapshot.
  const events = store.list<AuditEvent>('events')
  add('events', labels.events, events.filter(event => {
    if (event.entityType === 'user' || event.entityType === 'integrationToken') return false
    if (event.actorId === user.id) return true
    return Object.hasOwn(businessEventCollections, event.entityType) && referencesUser('events', event)
  }).length)
  add('importBatches', '待校对或已处理的导入批次', store.list<ImportBatch>('importBatches')
    .filter(batch => batch.ownerId === user.id || batch.rows.some(row => row.ownerId === user.id)).length)
  for (const [collection, label] of [['importSources', '导入原始资料'], ['importJobs', '导入解析任务']] as const) {
    add(collection, label, store.list<Entity & { ownerId: string }>(collection).filter(row => row.ownerId === user.id).length)
  }
  // Current parsing clears system IDs; also protect any older cached rows which retain them.
  add('importParsedChunks', '导入解析缓存', store.list<Entity & { rows: { ownerId?: string }[] }>('importParsedChunks')
    .filter(chunk => chunk.rows.some(row => row.ownerId === user.id)).length)
  add('collaborationSettings', '协作试点与默认管理路由', store.list<{ pilotUserIds: string[]; defaultManagerIds: string[] }>('collaborationSettings')
    .filter(row => row.pilotUserIds.includes(user.id) || row.defaultManagerIds.includes(user.id)).length)
  add('feedback', '问题反馈的提报、受理或结案责任', store.list<Feedback>('feedback').filter(row => row.reporterId === user.id || row.assigneeId === user.id || row.closure?.actorId === user.id).length)
  add('feedbackEvents', '问题反馈历史操作和改派记录', store.list<FeedbackEvent>('feedbackEvents').filter(row => row.actorId === user.id || row.assigneeId === user.id).length)
  add('feedbackAttachments', '问题反馈截图', store.list<FeedbackAttachment>('feedbackAttachments').filter(row => row.actorId === user.id).length)
  add('feedbackCommands', '问题反馈请求历史', store.list<{ actorId: string }>('feedbackCommands').filter(row => row.actorId === user.id).length)
  add('reportAgentJobs', '周报生成任务', store.list<{ actorId: string }>('reportAgentJobs').filter(row => row.actorId === user.id).length)
  add('reportAgentSchedule', '周报定时负责人', Number(store.get<{ actorId: string }>('settings', 'report-agent-schedule')?.actorId === user.id))
  return { user: safeUser(user), canDelete: blockers.length === 0, blockers, retainedHistory: true }
}
