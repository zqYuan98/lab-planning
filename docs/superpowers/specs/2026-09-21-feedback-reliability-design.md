# 问题反馈与使用可靠性第一期

用户于 2026-09-21 要求开始实施，范围承接已展示的审查建议：反馈闭环、高频表单防丢、错误定位、消息待办防遗漏。后续任务终止、跨月阶段和验收整改独立迭代。本期先完成本地代码和验收，发布范围另据实际部署确认。

## 反馈契约

复用 manager/member 和现有风格；成员仅访问本人反馈，管理者受理。默认受理人为首位可登录管理者，前台显示明确负责人，管理者可改派给其他可登录管理者。独立实体集合 feedback、feedbackEvents、feedbackAttachments、feedbackCommands，整库备份自动覆盖；不纳入业务 JSON 导出、KPI 或导入批次。用户删除校验纳入反馈责任和历史引用。

四状态 new（待受理）、in_progress（处理中）、verification（待验证）、closed（已关闭）。处理动作包括 comment、assign、start、request_info、defer、ready、confirm、reopen、close、duplicate。待补充/暂缓是等待原因；暂缓必须复查时间。ready 必填解决说明与实际可验证版本，并由管理者明确确认已上线。confirm 仅提报人可用；reopen 保留时间线。管理者非用户确认的结案须提供原因并显示真实结案方式。重复问题由管理者关联主单，禁止自指和循环；关联结果回告但不授予原主单访问权限。成员提交补充时清除等待本人补充的标记。

每次写入有 requestId 和内容指纹实现幂等，修改有 version；业务变更、附件、事件和通知在同步事务内。附件每次授权后下载；只接收校验过的 PNG/JPEG/WebP，最多 3 张、单张 2 MiB，每次操作 JSON 上限 9 MiB。附件存库，列表不携带二进制。前端失败保留输入和截图，可重试；浏览器刷新后通过账号隔离的本地草稿恢复，存储不可用时给出实际提示。

接口：GET /api/feedback/meta（可用管理者和默认负责人）；GET /api/feedback（scope=mine|all、status、cursor、limit，返回 items/counts/nextCursor）；GET /api/feedback/:id（feedback/events/attachments）；POST /api/feedback；POST /api/feedback/:id/actions；GET /api/feedback/:id/attachments/:attachmentId。类型集中 shared/feedback.ts，由前后端共同使用。创建输入含 description、kind（bug/usability/suggestion）、impact（blocking/normal）、context 和 attachments。附件输入为 name/mimeType/dataBase64。

站内通知复用现有体系，添加 feedback 目标，关键动作回告提报人或受理人；不复用工作安排的知悉按钮作为解决确认。首期反馈通知仅站内，避免评论及私有截图外发。全局入口打开独立抽屉，业务页面保持挂载；反馈列表和详情可用地址直达。创建表单只有描述必填，可粘贴、拖入、选择截图，自动带页面、客户端版本、设备及最近错误编号；仅白名单上下文，路径移除鉴权参数。

## 可靠性

消息查询先按权限和真实待确认状态筛选，再游标分页；计数始终同范围全量。未读/已读与待确认义务保持独立，超过 200 条仍可找到旧待办。

API 响应含服务器生成的 requestId，异常日志使用同编号；不记录请求正文或凭据。前端错误保留编号并提供反馈入口，网络失败给明确中文下一步。增加页面错误边界，不让单页错误损坏全局导航。应用版本由构建注入且可查看。

高频月目标、周安排、周进展和反馈输入覆盖草稿恢复。按账号、业务对象、版本隔离，处理多选、复选、受控字段；提交成功清除草稿，失败不清除。离页及关闭提示只用于未保存输入，不将恢复后的草稿自动正式提交。现有报告保护继续有效。

## 验收

权限、附件授权与类型大小；创建/评论/处理幂等；并发修改冲突；正常解决/重开/暂缓/重复链；修复版本与用户确认区别；关键站内回告；备份数据与用户删除边界；超过 200 条及同时间消息分页；旧待确认已读后仍可见；API 异常编号贯通；草稿真实浏览器恢复、受控字段与账号隔离；桌面及手机反馈提报和管理操作。全量测试和构建在本地隔离环境运行。
