import type { NotificationView } from '../shared/notifications.ts'
import { appOrigin } from './auth.ts'
import { DingTalkError, prepareDingTalkMessage, type DingTalkMessage } from './dingtalk.ts'
import { externalNotificationContent } from './notification-content.ts'

export function notificationPresentation(view: NotificationView) {
  const origin = appOrigin()
  if (!origin || origin.protocol !== 'https:') throw new DingTalkError('钉钉通知需要配置 HTTPS 同源事项入口', 'definitive')
  const url = new URL('/entry', origin.origin)
  url.searchParams.set('notificationId', view.sourceNotificationId ?? view.id)
  const message: DingTalkMessage = { ...externalNotificationContent(view), url: url.href }
  return { message, prepared: prepareDingTalkMessage(message) }
}
