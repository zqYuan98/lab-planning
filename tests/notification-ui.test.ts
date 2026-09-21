import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { NotificationView } from '../shared/notifications'
import { NotificationDetailContent } from '../src/pages/Messages'
import { NotificationPreviewContent } from '../src/components/NotificationPreview'

const task = { type: 'task' as const, id: 'task-one' }
const base: NotificationView = {
  id: 'notification-one', version: 1, createdAt: '2026-09-20T08:00:00Z', updatedAt: '2026-09-20T08:00:00Z',
  eventKey: 'assignment-one', recipientId: 'member-one', kind: 'work_assigned', title: '工作安排', body: '历史正文仅用作降级',
  targets: [task], actionable: true, openedAt: null, acknowledgedAt: null, supersededAt: null,
  deliveryStatus: null, canAcknowledge: true, unavailable: false, confirmationToken: 'current-obligation-token',
}
function detail(overrides: Partial<NotificationView> = {}) {
  return renderToStaticMarkup(createElement(NotificationDetailContent, {
    notification: { ...base, ...overrides }, busy: false, onVisit: () => {}, onOpenSource: () => {}, onAcknowledge: () => {},
  }))
}

test('structured recipient detail shows requirements and named targets without duplicating fallback body', () => {
  const html = detail({ content: { heading: '新安排｜接口联调', items: [{ target: task, title: '接口联调', lines: ['本周要求：验证接口返回', '任务截止：2026-09-25', '<img src=x onerror=alert(1)>'] }] } })
  assert.ok(html.includes('本周要求：验证接口返回'))
  assert.ok(html.includes('任务截止：2026-09-25'))
  assert.ok(html.includes('查看：接口联调'))
  assert.ok(!html.includes(base.body))
  assert.ok(!html.includes('<img'))
  assert.ok(html.includes('&lt;img'))
  assert.ok(html.includes('确认接收安排'))
})

test('historical messages keep text fallback and explain updated current content', () => {
  const html = detail({ contentUpdated: true })
  assert.ok(html.includes(base.body))
  assert.ok(html.includes('历史通知仅供参照'))
  assert.ok(html.includes('通知发生于'))
})

test('mixed batch detail identifies each obligation state and confirms only the remaining pending item', () => {
  const items = [
    { target: task, title: '已替代的 A 安排', lines: ['截止已另行调整'], acknowledgement: 'superseded' as const },
    { target: { ...task, id: 'task-two' }, title: '仍待确认的 B 安排', lines: ['提交验证报告'], acknowledgement: 'pending' as const },
    { target: { ...task, id: 'task-three' }, title: '协作可见的 C 事项', lines: ['协作目标要求'], acknowledgement: 'not_required' as const },
    { target: { ...task, id: 'task-four' }, title: '已经确认的 D 安排', lines: ['已知悉'], acknowledgement: 'acknowledged' as const },
  ]
  const html = detail({ targets: items.map(item => item.target), content: { heading: '本月安排', items, totalCount: 4 } })
  const cards = html.match(/<article class="notification-content-item">[\s\S]*?<\/article>/g) || []
  assert.equal(cards.length, 4)
  assert.ok(cards[0].includes('安排已有更新'))
  assert.ok(!cards[0].includes('待本人确认'))
  assert.ok(cards[1].includes('待本人确认'))
  assert.ok(cards[2].includes('仅供查看，无需确认'))
  assert.ok(!cards[2].includes('待本人确认'))
  assert.ok(cards[3].includes('>已确认<'))
  assert.ok(html.includes('仍待本人确认的 1 项安排'))
  assert.ok(html.includes('不包括已确认、安排已有更新或仅供查看的协作事项'))
  assert.ok(html.includes('确认知悉 1 项当前安排'))
  assert.ok(!html.includes('确认知悉 4 项'))
})

test('legacy or incomplete item states do not invent a confirmation count or item obligation', () => {
  const html = detail({ content: { heading: '历史批量安排', items: [
    { target: task, title: '无逐项状态的旧事项', lines: ['查看当前安排'] },
    { target: { ...task, id: 'task-two' }, title: '已明确的协作事项', lines: [], acknowledgement: 'not_required' },
  ] } })
  const cards = html.match(/<article class="notification-content-item">[\s\S]*?<\/article>/g) || []
  assert.equal(cards.length, 2)
  assert.ok(!cards[0].includes('待本人确认'))
  assert.ok(html.includes('本次仅确认本消息中仍待本人确认的当前安排'))
  assert.ok(html.includes('确认接收安排'))
  assert.ok(!html.includes('确认知悉 1 项'))
  assert.ok(!detail({ content: { heading: '均已处理', items: [
    { target: task, title: '已更新', lines: [], acknowledgement: 'superseded' },
  ] } }).includes('确认接收安排'))
})

test('manual reminder offers only source confirmation even if a malformed response marks it actionable', () => {
  const html = detail({ kind: 'manual_reminder', sourceNotificationId: 'original-notification', sourceCanAcknowledge: true })
  assert.ok(html.includes('查看并确认原安排'))
  assert.ok(html.includes('请在原安排中确认'))
  assert.ok(!html.includes('确认接收安排'))
  assert.ok(!detail({ kind: 'manual_reminder', sourceNotificationId: 'original-notification', sourceCanAcknowledge: false }).includes('查看并确认原安排'))
  const processed = detail({ kind: 'manual_reminder', sourceNotificationId: 'original-notification', sourceCanAcknowledge: false, canAcknowledge: false, targets: [] })
  assert.ok(processed.includes('查看原安排'))
  assert.ok(!processed.includes('确认接收安排'))
})

test('unavailable, superseded, and tokenless messages cannot offer active confirmation', () => {
  assert.ok(!detail({ unavailable: true }).includes('确认接收安排'))
  assert.ok(!detail({ supersededAt: '2026-09-20T09:00:00Z' }).includes('确认接收安排'))
  const tokenless = detail({ confirmationToken: undefined })
  assert.match(tokenless, /<button[^>]*disabled=""[^>]*>[\s\S]*确认接收安排<\/button>/)
  assert.ok(tokenless.includes('核对最新安排后再确认'))
})

test('recipient preview is inert escaped text with eligibility, truncation, and send-window context', () => {
  const html = renderToStaticMarkup(createElement(NotificationPreviewContent, { preview: {
    recipientId: 'member-one', recipientName: '成员甲', title: '待确认安排', body: '<script>doSomething()</script>\n任务截止：2026-09-25',
    buttonText: '查看并确认原安排', url: 'https://untrusted.example/secret', truncated: true, eligible: false,
    reason: '安排已确认', sendWindow: '每日 09:00—18:00（北京时间）', renderedAt: '2026-09-20T08:00:00Z',
  } }))
  assert.ok(html.includes('成员甲 · 1 人'))
  assert.ok(html.includes('09:00—18:00'))
  assert.ok(html.includes('当前不可发送'))
  assert.ok(html.includes('安排已确认'))
  assert.ok(html.includes('按发送长度限制节选'))
  assert.ok(html.includes('实际发送前会再次核对'))
  assert.ok(html.includes('&lt;script&gt;'))
  assert.ok(!html.includes('<script>'))
  assert.ok(!html.includes('untrusted.example'))
  assert.ok(!html.includes('href='))
  assert.ok(!html.includes('<button'))
})
