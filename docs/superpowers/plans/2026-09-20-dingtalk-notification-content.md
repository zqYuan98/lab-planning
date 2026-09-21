# 钉钉通知内容与确认链路实施计划

> **For agentic workers:** Use superpowers:subagent-driven-development. Steps use checkbox syntax. 用户已批准设计实施；本轮执行最新通知内容增补的 P0 范围，P1/P2 新业务能力不由模板伪造。

**Goal:** 工作通知直接展示本人相关事项要求、期限和变化，并能安全进入原安排确认，管理者可预览实际发送内容。

**Architecture:** 保留现有 SQLite 通知队列及业务义务。新增接收人内容投影，统一供站内、预览和 worker 使用；发送适配器按结构压缩并记录最终载荷摘要。业务事件只保存白名单差异，不复制整份对象。

**Tech Stack:** TypeScript、Express、React、SQLite、node:test；无需新增依赖。

工作区已有未提交业务实现，是现有运行基线；先保存本次相关文件快照，不通过重置/裸 HEAD 工作树丢失这些依赖。不提交其他工作的既有改动。

## 文件和接口约定

- shared/notifications.ts：可空内容版本、actorId、最小差异、sourceNotificationId；投影内容、确认版本与投递快照类型。
- server/notification-content.ts（新增）：读取允许字段、按接收人投影、变更归并与各类型模板，纯输出不产生通知或确认。
- server/notifications.ts：来源解析、当前待确认义务、受控确认、生成投影。
- server/notification-events.ts：事务内最小差异、事件事实和责任人关联；继续现有发布/去重规则。
- server/notification-worker.ts：复查资格、统一渲染、保存发送尝试快照；accepted/unknown 保持不重发。
- server/notification-routes.ts：仅读预览及严格的源安排确认入口，手动提醒限额按待确认集合。
- server/dingtalk.ts：单按钮允许列表、结构化压缩、安全格式、最终载荷预算；纯 prepareDingTalkMessage 与真实 send 共用。
- src/pages/Messages.tsx、NotificationSettings.tsx、src/components/NotificationStatus.tsx、src/notifications.css：事项卡片、原安排确认、成员视角预览。
- tests/notification-content.test.ts（新增）和原通知/适配器测试：权限、历史、差异、预算、版本冲突、队列回归。

结构化发送格式约定：`card?: { heading: string; intro?: string; items: { title: string; lines: string[] }[]; footer?: string; totalCount?: number }`；`buttonText?: string`，与原 title/body/url 兼容。纯渲染返回 payload、body、title、buttonText、url、truncated、payloadHash；所有输入字段经转义/链接去除，只有模板产生受控格式。

## 任务 1：保护基线、计划审阅

- [x] 保存相关源文件/测试快照及原 git 状态到 output；不复制任何凭证。
- [x] 独立审阅本计划与设计，修正实质遗漏后执行。

## 任务 2：发送格式（可独立并行）

- [x] 为多事项、中文 emoji、特殊字符、长正文、主按钮与完整 URL 写测试并先证明失败。
- [x] 实现纯渲染和受限按钮；按最终 UTF-8 JSON 字节压缩要求，再减少条目，保留识别信息、期限、剩余数和动作；不截 URL。
- [x] 原 send 使用同一渲染；保持旧调用兼容、未知结果不重试。运行 `npx tsx --test tests/dingtalk-adapter.test.ts`。

## 任务 3：内容与事件

- [x] 添加测试覆盖任务要求、周承诺优先、月目标内容、退回意见、源催确认、部分撤权、旧消息和白名单差异。
- [x] 实现通知内容投影：来源为 Task/WeeklyRecord/MonthlyPlan 与正式提报服务，标题在正文出现；可空字段兼容旧数据，移除通知保留概括文案。
- [x] 事件记录 actorId、eventTime、白名单 before/after；五分钟合并最早原值→最新新值，原值恢复不显示假变化；新接收人无历史可见性则不外发旧值。
- [x] 草稿/导入不产生通知；历史通知不新增投递，旧内容不能绕过当前权限。运行内容与事件测试。

## 任务 4：确认、预览与 worker

- [x] 建立 sourceNotificationId 以及严格旧 eventKey 降级解析；接收人必须一致。
- [x] 当前源义务集合生成确认 token；新页面确认携带 token，变化返回 409，确认只操作源义务且不改任务/提报状态。
- [x] 管理者只读预览通过相同接收人投影和适配器预算，不占配额、不标已查看、不发送。手动提醒只计待确认事项。
- [x] worker 保留周截止动态校验与临时目标发布状态校验，但不覆盖结构化详情；首次请求前保存最终载荷及哈希，不泄露在普通日志或业务导出。
- [x] 重试前复核权限、义务、发布/提交状态；accepted/unknown 不刷新后重发；明确内容错误不能标 unknown。
- [x] 运行 `npx tsx --test tests/notifications.test.ts tests/notification-worker-guards.test.ts tests/notification-reminders.test.ts tests/notification-content.test.ts`。

## 任务 5：成员页面与管理预览（接口约定后并行）

- [x] 详情展示事项名、要求、真实时间、变更与当前状态；详情深链接加载后记录真正展示并定位焦点。
- [x] 手动提醒通过 sourceNotificationId 打开原消息，再由用户明确确认；确认 token 随 POST 发送，409 刷新，不吞业务冲突。
- [x] 通知设置及事项通知状态提供成员视角预览，使用服务端返回已预算内容，显示按钮/截短/时段；预览不发送。
- [x] 保留异步响应序号保护，窄屏优先显示选中详情。运行 typecheck 和前端导航测试。

## 任务 6：总体验证与交付

- [x] 内容策略 summary/minimal、开关与回退方式写入部署示例及说明，不修改真实环境秘密。
- [x] `npm test`、`npm run build` 全通过；独立规格符合性与代码质量审查通过。
- [x] 用隔离数据库、模拟钉钉适配器做 HTTP 端到端确认和预览验收；必要时本地浏览器验证页面，无真实外发。
- [x] 写验证报告、剩余实机验收项。上线由现有发布流程执行；不得用未部署代码宣称线上生效。
