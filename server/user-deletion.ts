import type { AuditEvent, Entity, User } from '../shared/types.ts'
import type { ImportBatch } from '../shared/import-types.ts'
import { canUseAccount } from '../shared/auth-policy.ts'
import { safeUser } from './auth.ts'
import { businessEventCollections, collectionNames, rowReferences, storedCollection, type TransferCollection } from './data-transfer-schema.ts'
import type { Store } from './store.ts'
import type { Feedback, FeedbackAttachment, FeedbackEvent } from '../shared/feedback.ts'
import { isManager } from './authorization.ts'

export interface UserDeletionBlocker { key: string; label: string; count: number }
export interface UserDeletionPreview { user: User; canDelete: boolean; blockers: UserDeletionBlocker[]; retainedHistory: true }

const labels: Record<TransferCollection, string> = {
  users: '成员资料', projects: '项目', annualGoals: '年度目标', plans: '月度计划', tasks: '任务', weeklyRecords: '周记录',
  history: '导入历史', publications: '月度发布快照', reports: '报告及历史快照', events: '业务操作历史',
  weeklyRules: '周提报规则', weeklyCycles: '已冻结的周提报名单', weeklyDuties: '周提报义务',
  weeklySubmissions: '已提交的周报', weeklyMissing: '周提报缺交记录', weeklyAdjustments: '周提报调整记录', weeklyPlanReviews: '下周计划审核记录',
  taskTrackings: '督办纳入记录', progressEvents: '进展时间线', followupRequests: '催办请求', followupResponses: '催办回应', blockerEpisodes: '阻塞阶段', blockerActions: '阻塞支持处理', deadlineChangeRequests: '延期申请',
  reportAssets: '周报模板与 Word 文件', reportTemplates: '周报模板版本',
  deliverySeries: '个人成果交付项及验收责任', taskDeliveries: '不可变成果提交版本', deliveryDecisions: '成果验收及更正决定', decisionRequests: '决策请求及责任记录',
  taskCommitmentEvents: '任务历史承诺与责任变更', historicalEvidence: '历史补充佐证', periodReviewSnapshots: '历史周期复盘快照',
}

/** Keep exactly the user dependencies required by business export/restore, including nested snapshots. */
export function userDeletionPreview(store: Store, actor: User, user: User): UserDeletionPreview {
  const blockers: UserDeletionBlocker[] = []
  const add = (key: string, label: string, count: number) => { if (count) blockers.push({ key, label, count }) }
  add('self', '不能删除当前登录账号', Number(actor.id === user.id))
  add('lastManager', '必须保留至少一位可登录的管理者', Number(isManager(user) && canUseAccount(user)
    && !store.list<User>('users').some(other => other.id !== user.id && isManager(other) && canUseAccount(other))))
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
  add('reportAgentMonthlySchedule', '月报定时负责人', Number(store.get<{ actorId: string }>('settings', 'report-agent-monthly-schedule')?.actorId === user.id))
  add('weeklyReviewDelegation', '已配置周计划审核委托', Number(store.get<{ enabledOwnerIds: string[] }>('settings', 'weekly-review-delegation')?.enabledOwnerIds.includes(user.id)))
  // Grants and scoped reports are local runtime objects, excluded from business packets,
  // but their recipient and author identities remain part of the access audit trail.
  add('objectGrants', '对象授权接收人及授权人', store.list<{ subjectId: string; grantedBy: string }>('objectGrants')
    .filter(row => row.subjectId === user.id || row.grantedBy === user.id).length)
  add('scopedReports', '授权摘要接收人及定稿人', store.list<{ subjectId: string; finalizedBy: string }>('scopedReports')
    .filter(row => row.subjectId === user.id || row.finalizedBy === user.id).length)
  add('carryWorkflows', '跨期流程创建记录', store.list<{ actorId: string }>('carryWorkflows').filter(row => row.actorId === user.id).length)
  for (const [collection, label] of [
    ['objectAccessCommands', '对象授权及摘要命令记录'], ['collaborationCommandReceipts', '协作、成果交付及支持决策命令记录'],
    ['workRegisterCaptures', '工作收件命令记录'], ['weeklyAssignmentRequests', '周安排命令记录'], ['monthlyCarryRequests', '月目标承接命令记录'],
    ['carryWorkflowRequests', '跨期流程命令记录'], ['periodReviewReceipts', '历史复盘命令记录'],
  ] as const) {
    add(collection, label, store.list<{ actorId: string; command?: string }>(collection)
      .filter(row => row.actorId === user.id && !(collection === 'collaborationCommandReceipts' && row.command === 'preferences')).length)
  }
  return { user: safeUser(user), canDelete: blockers.length === 0, blockers, retainedHistory: true }
}
