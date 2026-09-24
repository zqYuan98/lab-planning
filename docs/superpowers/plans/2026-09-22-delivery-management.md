# 第二批交付与管理 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 完成已批准第二批 LP-06、07、09、10、12、13、15 与配套 LP-19，交付可操作的统一任务、成果验收、对象授权和责任待办。

**Architecture:** 保留 Domain、同步 SQLite 事务及第一批读写恢复机制。权限先于投影；不可变提交/决定与 CAS 当前状态分离；待办从业务事实计算。新服务按领域拆分，前端统一任务宿主复用既有编辑器。所有新增业务记录进入 v5 业务迁移，授权与命令回执保持运行数据。

**Tech Stack:** TypeScript、React、Express、SQLite、Node test runner、tsx、Vite。

设计依据：[第二批规格](../specs/2026-09-22-lab-planning-delivery-management-design.md)。用户已明确要求完成第二批，按现有设计直接实施，不重复请求设计批准。

截至 2026-09-22，Tasks 1–6 已完成：最终全量 852 项测试通过，生产构建成功，交叉复审及隔离浏览器验收完成。Docker CLI 不可用，未执行容器启动验证。详见[验证记录](../../validation-2026-09-22-delivery-management.md)。

## Task 1：对象访问与观察者（权限代理）

Files: create `shared/object-access.ts`, `server/object-access.ts`, `server/object-grants.ts`, `server/object-access-routes.ts`, `tests/object-access.test.ts`; modify `shared/types.ts`, `server/domain-common.ts`, authentication/user services and all required business read/write entry gates. Shared routing挂载由主代理处理。

- [x] 建立 observer、ObjectGrant、ScopedReport、安全投影和授权范围版本合同，先发送导出接口给其他工作流。
- [x] 写并运行权限矩阵失败测试：observer 旧owner仍不能写、无授权404、historyPolicy边界、证据/摘要能力独立、撤权及重授不恢复旧摘要。
- [x] 实现授权/撤销幂等命令、当前权限重查、观察者独立 bootstrap；project摘要仅统计授权任务，报告正文按当前授权事实重新生成。
- [x] 封闭旧API、附件、导出、通知、集成与直接服务旁路；补账号删除引用阻断；现有member历史投影兼容。
- [x] 定向回归通过并做自审；审阅其他代理的领域服务越权边界。

## Task 2：个人交付与支持决策（领域代理）

Files: create `shared/deliveries.ts`, `shared/support.ts`, `server/task-deliveries.ts`, `server/task-support.ts`, `server/delivery-routes.ts`, relevant tests; modify `shared/collaboration.ts`, existing blocker service entry points and task cancellation protection as required. Avoid owning root's progress hooks and migration files; communicate integration exports.

- [x] 先固定共享类型、集合名称、服务/路由合同；在发布任何UI前完成状态机与权限测试。
- [x] 成果项、冻结版本、决定更正链、重新指派；CAS、同键重放、独立任务状态、无合格验收人保留提交、禁止自验收。
- [x] 支持阶段、协调人/期限、最小上下文、回应/复查/管理关闭；技术解除与管理关闭独立，关闭协作不丢责任。
- [x] 决策创建、指定人处理、重派、取消/重开代次及理由；站内通知、审计和回执同事务。
- [x] 定向测试验证事务故障、撤回验收竞态、历史版本更正、责任失效、协作关闭；提供迁移引用/字段说明给主代理。

## Task 3：统一任务和业务界面（前端代理）

Files: create task host, delivery/support/authorized-work/my-actions components and client helpers as appropriate; modify `src/App.tsx`, `src/navigation.ts`, task entries in overview/register/weekly/followups, `src/components/WorkTaskPanel.tsx`, users UI, `src/ui.tsx`, `src/draft-recovery.ts`, `src/use-form-draft.ts`, UI styles and tests. Shared contracts由对应后端代理提供，先沟通后实现。

- [x] 统一openTask意图及六区详情，保留来源页筛选/滚动；基础内容不依赖协作开关，观察者及作废对象只读。
- [x] 接入成果提交/版本/验收/撤回/更正/重派和支持/决策动作，明确区分任务自报完成、阶段完成与验收。
- [x] 首页待我处理、计数/分页/类别、授权列表及管理授权界面；接口再次鉴权，不以按钮隐藏代替服务端规则。
- [x] 草稿schema3与旧版本发现、字段组B/S/L比较，只有VERSION_CONFLICT可合并；无权限不展示服务器内容，未知保存结果不自动生成新命令。
- [x] 接入两类进展读模型，保持第一批LatestRead与SavedRefresh保护；新增有意义的导航/草稿合并/恢复测试。

## Task 4：进展事实、通用详情与待办（主代理）

Files: create `shared/task-view.ts`, `shared/my-actions.ts`, `server/task-view.ts`, `server/my-actions.ts`, tests; modify `server/collaboration-hooks.ts`, `shared/work-register.ts`, `server/app.ts`, relevant progress projection helpers.

- [x] 与权限/领域代理明确投影接口，通用详情暴露allowedActions和readOnlyReason，周定位白名单，历史分页安全。
- [x] 将实质进展事实和阻塞阶段基础记录移出协作开关；消息派生仍按开关；字段变化触发、命令内去重、不用updatedAt伪造进展。
- [x] 总体说明、最新执行和未知历史分开；审计可重建标明质量；未来周和删除周不进入当前执行。
- [x] 待办按真实状态、责任和当前权限聚合；分类计数先于分页；账号/范围绑定游标，已读不影响业务待办。
- [x] 回归标题修改不刷新进展、周成果不遮挡、跨期未处理不漏、失效责任人与协作关闭恢复队列。

## Task 5：业务数据 v5 与账号引用（主代理）

Files: create `server/delivery-transfer.ts`; modify `server/data-transfer-schema.ts`, `server/data-transfer.ts`, `server/data-restore.ts`, `server/user-deletion.ts`, relevant schemas/reference helpers and tests.

- [x] 核对v5未占用，新增业务集合/字段严格schema；继续读v1～v4，完整备份保持原支持。
- [x] 导出依赖闭包、用户映射、不可变版本与决定链完整性检查、支持/决策关系；授权、ScopedReport接收配置及命令回执不自动恢复。
- [x] 无效引用/版本链恢复整体失败；恢复无外发，数据实际写入轮换第一批epoch；删除账号检查新增引用。
- [x] 往返与旧包兼容测试通过。

## Task 6：集成验收、复审与交付

- [x] 各子系统独立自审后交叉只读复审，按设计矩阵解决遗漏，不以测试字符串代替用户路径。
- [x] `npm test` 与 `npm run build` 全通过；保留现有CI的容器/备份步骤，环境无Docker时明确记录边界。
- [x] 隔离浏览器跑成员提交→指定管理者待办验收→成员历史；观察者授权/撤销；协调回应；并发草稿差异恢复。
- [x] 更新 `docs/api-contract.md`、第二批规格状态、`docs/validation-2026-09-22-delivery-management.md`；运行diff检查。
- [x] 保留完整可审查本地分支；不发布生产、不发送真实外部消息。
