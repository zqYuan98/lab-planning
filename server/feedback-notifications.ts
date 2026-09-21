import type { User } from '../shared/types.ts'
import type { Feedback, FeedbackEvent } from '../shared/feedback.ts'
import { feedbackStatusLabels } from '../shared/feedback.ts'
import { enqueueNotification } from './notifications.ts'
import type { Store } from './store.ts'

const messages: Partial<Record<FeedbackEvent['action'], [string, string]>> = {
  created: ['收到新的问题反馈', '请受理并跟进这条反馈。'], comment: ['问题反馈有补充', '反馈中有新的说明或截图，请进入查看。'],
  assign: ['问题反馈受理人已变更', '请查看当前受理人和处理状态。'], start: ['问题反馈已开始处理', '管理者已开始跟进。'],
  request_info: ['问题反馈需要补充', '请进入反馈查看需要补充的内容。'], defer: ['问题反馈已暂缓', '已记录暂缓原因和复查时间，请进入查看。'],
  ready: ['问题反馈待你验证', '管理者确认修复已上线。请实际验证后确认解决；仍有问题可重新打开。'],
  confirm: ['问题反馈已由提报人确认解决', '提报人已验证并确认解决。'], reopen: ['问题反馈已重新打开', '问题仍需继续处理，请查看重新打开的原因。'],
  close: ['问题反馈已结案', '管理者已说明结案原因；此结案不代表提报人确认解决。'],
  duplicate: ['问题反馈已关联跟进', '本反馈已关联到相同问题，处理结果会在本反馈中回告。'],
  duplicate_update: ['关联问题有处理结果', '请进入本反馈查看安全回告，并独立验证是否解决。'],
}
export function notifyFeedback(store: Store, actor: User, row: Feedback, event: FeedbackEvent) {
  const [title, body] = messages[event.action] ?? ['问题反馈有更新', '请进入反馈查看。']
  const recipients = [...new Set([row.reporterId, row.assigneeId])].filter(id => !event.actorId || id !== actor.id)
  for (const recipientId of recipients) enqueueNotification(store, {
    eventKey: `feedback:${event.id}`, recipientId, kind: `feedback_${event.action}`, title, body: `${body}\n当前状态：${feedbackStatusLabels[row.status]}`,
    targets: [{ type: 'feedback', id: row.id }], actionable: false, ...(event.actorId ? { actorId: event.actorId } : {}),
  })
}
