# 第一批一致性修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 实现已批准的 LP-01～05，保持历史、权限和保存恢复语义，并固化关键回归。

**Architecture:** 继续使用现有同步事务和 Domain 门面。月度承接增加内部回执与操作环境保护；基础工作校验独立于协作开关；前端通过最新读取协调器和写入屏障消除乱序。只实施第一批，后续批次沿已批准规格继续独立推进。

**Tech Stack:** TypeScript、React、Express、SQLite、Node test runner、tsx、Vite。

规格：`docs/superpowers/specs/2026-09-22-lab-planning-consistency-design.md`。

## Task 1：公共命令环境与错误合同（主代理）

Files: create `server/operation-context.ts`, `scripts/reset-operation-context.ts`, `tests/operation-context.test.ts`; modify `server/store.ts`, `server/app.ts`, `server/domain.ts`, `server/data-restore.ts`, `shared/types.ts`, `src/api.ts`, `package.json`。

- [x] 写失败测试：同一 Store/重启保持 epoch；轮换后旧 epoch 返回 409/code；失败事务不保留轮换。
- [x] 运行 `node --import tsx --test tests/operation-context.test.ts`，确认最终实现通过；未归档独立初始红灯日志。
- [x] 实现 `getOperationEpoch(store)`, `assertOperationEpoch(store, value)`, `rotateOperationEpoch(store)`，仅使用服务器生成 UUID；状态存内部集合，排除业务迁移包。
- [x] HttpError 增加可选 code/fieldErrors 并由 API 安全透传；ApiError 保留新增字段，兼容原参数和文本。
- [x] bootstrap 返回 epoch；carry 路由用请求头覆盖同名 body 值；实际业务恢复后同事务轮换。加入停止服务后对恢复库轮换的维护脚本和文档，普通重启不轮换。
- [x] 运行定向测试，检查原错误响应、数据恢复和备份回归。

## Task 2：月度服务 LP-01～03（子代理 A）

Files: modify `server/domain-plans.ts`; create `tests/monthly-consistency.test.ts`; update相关旧测试中的 carry 调用。

- [x] 先写未完成空原因、字段继承、重复承接、同键改内容、旧来源版本、写入回滚和创建旁路失败测试。
- [x] 运行定向测试，修复新合同下的失败；最终结果见验收记录。
- [x] 收敛公开创建与私有承接创建；继承明确白名单，重置成果/审批/导入凭证；普通 create/update 不允许修改 sourcePlanId。
- [x] carry 校验 operationEpoch（复用 Task 1 模块），按 actor/requestId 查回执，回放优先于来源版本校验；首次写入目标、审计、回执同事务。
- [x] result 校验 not_completed 原因并给字段错误；保留其余状态现有规则。
- [x] 运行月度、导入、权限、历史、数据迁移相关测试；兼容调用方必须提供真正来源版本、稳定请求号和当前 epoch，不能放宽接口以迁就旧测试。

## Task 3：基础规则 LP-04（子代理 B）

Files: create `server/work-validation.ts`, `tests/work-validation.test.ts`; modify `server/domain-work.ts`, `server/collaboration-hooks.ts` 及必要的相关后端调用/测试。

- [x] 写协作开/关、来源差异、直接任务与周执行的失败矩阵，包含历史导入无关修改与主动重报。
- [x] 通过开关、来源与历史数据矩阵验证旧规则不一致的修复。
- [x] 实现规范 before/patch/context 的基础校验，完成/阻塞/周成果统一规则；协作 Hook 保留延期等策略，移除重复基础校验。
- [x] 导入豁免仅来自可信服务端上下文，不再根据 importSource 永久跳过人工校验；保留历史缺证记录的无关修改。
- [x] 检查 completeTask 同事务/双版本，取消任务不被完成校验拦截。若表单缺基础字段告知主代理补 UI。
- [x] 运行 task/weekly/work-register/collaboration/import 相关定向测试。

## Task 4：刷新乱序 LP-05（子代理 C）

Files: create `src/latest-read.ts`, `tests/latest-read.test.ts`; modify `src/App.tsx`, `src/pages/WorkFollowups.tsx` 及必要的只读协调 helper。

- [x] 用 deferred Promise 写 A 慢 B 快、A 后失败、写后旧读、换身份、卸载失败测试。
- [x] 实现请求序号+AbortController，失效旧结果的数据、错误及 loading；旧 refresh 调用跟随当前有效请求结束。
- [x] App 的身份序列继续保护身份加载路径；保存调用 refresh 时构成写入屏障，额外明确保存返回对象的版本应用入口。
- [x] 完整列表以新快照为准，不与旧集合求并集；同对象低版本返回不能覆盖已确认的新版本。
- [x] WorkFollowups 统一读取与已保存刷新失败反馈，不能将保存后的读取失败当成写入失败重试。
- [x] 运行最新读取测试和现有 client-api-recovery、登录导航、作废 UI 回归。

## Task 5：月度及任务表单集成（主代理）

Files: modify `src/pages/Monthly.tsx`；按 Task 3 结果补 `src/components/WorkRegisterEditor.tsx`, `src/pages/Weekly.tsx`；必要时 create `src/monthly-carry.ts`, `tests/monthly-carry-client.test.ts`。

- [x] 未完成状态受控、动态必填和历史缺失提示；恢复表单时同步受控选择。
- [x] 承接表单固定 sourceVersion，保存 requestId/epoch/原负载至账号对象草稿；未知结果重试原请求，变更内容前核对旧结果；显式拆分同月承接。
- [x] 承接成功清理尝试，保存后只重读；来源冲突提供重新核对入口，不自动套新版本提交。
- [x] 对齐阻塞/完成表单 required 和辅助说明，确保所有已开放入口能满足新规则。
- [x] 隔离浏览器验证有效/无效月验收、重复承接、协作关闭的基础编辑、刷新反馈。

## Task 6：集成验收与交付（主代理及只读审阅）

Files: modify `docs/api-contract.md`, relevant restore docs; create `docs/validation-2026-09-22-consistency.md`。

- [x] 独立审阅改动，修正权限、幂等、历史和竞态问题。
- [x] `npm test`：所有业务测试通过；若环境特有失败，定位并记录准确原因，不伪称通过。
- [x] `npm run build`：类型检查及生产构建通过。
- [x] 检查 CI 仍覆盖全部新 *.test.ts，保留原容器/备份验证；只在环境支持时执行容器检查。
- [x] 更新接口、恢复步骤、实施状态和验收记录，核对 `git diff --check`。
- [x] 保留可审查的本地分支改动；本任务不发布生产或发送真实通知。

实施状态：全部完成本地实现与验收，757 项测试及生产构建通过，未部署。验收记录见 [第一批验收](../../validation-2026-09-22-consistency.md)。
