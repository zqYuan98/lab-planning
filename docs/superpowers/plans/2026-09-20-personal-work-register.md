# Personal Work Register Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 用户可随时收集领导交办事项，在统一任务清单安排工作并展示、导出本人在手事项。

**Architecture:** 复用 Task + WeeklyRecord，增加可选交办元数据与本人批量收件接口。纯函数生成本人视图和汇报快照，前端独立页面负责录入、编辑与 CSV/打印，周计划复用现有页面。保留当前工作区全部已有未提交变更。

**Tech Stack:** React 19、TypeScript、Express、SQLite JSON store、node:test、现有 CSS/Arco。

---

### Task 1: 契约与收件服务

Files: modify `shared/types.ts`, `server/domain-work.ts`, `server/domain.ts`, `server/data-transfer-schema.ts`, `server/data-transfer.ts`; create `server/work-register-routes.ts`, `tests/work-register-domain.test.ts`.

- [ ] 添加 Task 可选字段，支持新增/更新合法空截止日期，不绕开旧权限、版本和协作校验。
- [ ] 创建 `WorkService.captureTasks(actor, input)`，输入 `{requestId, titles:string[], workSource, assignedBy?, assignedOn?, dueDate?}`。1–50 个标题，幂等收据持久化且批量事务化，重放请求验证相同操作者与内容。
- [ ] `POST /api/work-register/capture` 返回 `{tasks: Task[]}`；仅本人，不接受非本人 ownerId 或下发身份。root 负责 app router 注册。
- [ ] 更新业务导入导出 schema 保留新增字段；每次更新保留省略字段，完成清除等待标记。
- [ ] 增加真实场景测试，执行 `node --import tsx --test tests/work-register-domain.test.ts`、相关 data-transfer/weekly-assignment tests，预期通过。

### Task 2: 视图、快照与导出

Files: create `shared/work-register.ts`, `src/work-register-export.ts`, `tests/work-register.test.ts`.

- [ ] 导出 `WorkRegisterView = 'active'|'leader'|'unscheduled'|'week'|'waiting'|'done'` 及标签。
- [ ] 导出 `buildWorkRegister(data: Pick<Bootstrap,'tasks'|'weeklyRecords'|'user'>, options?: {view?:WorkRegisterView; query?:string; today?:string})`，返回去重本人 Task 数组、每项 currentWeekRecord、latestRecord、displayStatus、progress、isOverdue；默认北京时间当前日期。
- [ ] 定义清晰可复用的结果/快照类型；预览和 CSV 同用 freeze 时生成的快照，不读取实时 props。
- [ ] CSV UTF-8 BOM、CRLF、所有字段引号包裹、双引号转义，单元格开头 `= + - @` 与控制字符前缀防公式执行；纯文本不注入 HTML。
- [ ] 用未来周、未排期、跨年未完结、同任务多周、总体未完但周完成、他人任务、公式标题/多行说明覆盖测试。

### Task 3: 页面

Files: create `src/pages/WorkRegister.tsx`, `src/components/WorkRegisterCapture.tsx`, `src/components/WorkRegisterEditor.tsx`, `src/components/WorkRegisterReport.tsx`, `src/work-register.css` (合理合并小组件可接受).

- [ ] 页面遵循现有浅色工作台视觉，标题「我的工作清单」，清晰显示在手事项、待安排、待协调；视图、搜索、快速记录、汇报预览、条目编辑和周安排入口。
- [ ] 输入多行后显示逐条预览再提交；复用 `assignmentAttempt` 保存幂等 requestId。正常失败保留输入；HTTP 成功后刷新失败不能重复提交业务。
- [ ] 编辑使用 PATCH `/tasks/:id` 和 version；总体状态/待反馈、当前进展、交付物、截止待确认、优先级、预计投入、下一步及需要决策均可维护；完成与阻塞必要说明明确。
- [ ] 复用 `<Weekly>` 导航 `{action:'create', id:task.id, ownerId:task.ownerId, weekStart}`；已有周记录导航记录 id。
- [ ] 预览支持 CSV 下载与打印，展示筛选范围和生成时间；空结果也清楚说明。
- [ ] 宽屏表格和窄屏卡片/可滚动区域，控件均有文本标签，错误与忙碌状态可识别。

### Task 4: 接线、审查与验证（root）

Files: modify `server/app.ts`, `src/App.tsx`, `src/navigation.ts`, `src/notification-navigation.ts`, `src/components/WorkspaceShell.tsx`, `README.md`; create validation doc.

- [ ] 加入 authenticated router、页面导航和可刷新 URL；仅选中页面才渲染组件。
- [ ] 复核原任务在周表单被正确选择，已完成任务不误成为新任务，月份规则保持。
- [ ] 对实现分别审查规格符合性和代码质量，修复发现的问题。
- [ ] 运行 `npm test`、`npm run build`。若现存基线失败，明确区分并验证本次范围。
- [ ] 使用隔离 SQLite + 本地隐藏服务，用浏览器验证真实流程、导出内容与桌面/手机布局；不使用或修改正式数据库。
- [ ] 记录验证和使用说明；只提交本次新文档，混有他人变更的源文件不作整文件提交。
