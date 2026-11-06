# 钉钉月度目标获取 Implementation Plan

> **For agentic workers:** Use superpowers:subagent-driven-development to implement and review bounded tasks. The user has approved this design and asked to execute immediately; no additional execution-choice confirmation is required.

**Goal:** 在数据导入中按月份找到钉钉目标 Sheet，读取原始单元格、人工校对并导入月度草稿，保留来源与防重事实。

**Architecture:** 独立只读文档连接器 → 月份发现和快照服务 → ImportService 可信来源适配 → 既有校对和事务提交。所有钉钉来源的提交由异步服务先重新核对远端快照，再在本地事务中校验差异与创建结果；普通导入不能绕过此检查。

**Tech Stack:** React / TypeScript / Express / Node 24 / SQLite，node:test；实际文档连接路径由第一阶段真实验证锁定。

## Task 1 — 真实线上读取验证

- [x] 复用现有部署文档与严格 Host Key 校验，确认服务器访问路径。
- [x] 在远程进程内使用现有应用身份取得 token，输出仅含配置是否存在和脱敏错误码，不记录凭据。
- [x] 只读验证已知目标文件、Sheet、A1:I8，再核实目录发现能力与 ID 转换。
- [x] 将成功证据或准确权限阻碍写入 `docs/validation-2026-11-06-dingtalk-monthly-import.md`。若需外部授权，继续开发可验证的独立功能，不宣称线上已可用。

## Task 2 — 纯函数月份、字段与差异规则

Files: `shared/dingtalk-documents.ts`, `server/dingtalk-monthly-mapping.ts`, `tests/dingtalk-monthly-mapping.test.ts`。

- [x] 声明快照合同，要求真实文档/Sheet/文件夹身份、完整范围、原始行、合并信息和完整性标志。
- [x] 测试完整年月、跨年、表头/空行、多行备注、七行七目标、日期异常与完整性拒绝。
- [x] 实现 `monthlySourceRule`, `mapMonthlySheet`, `compareMonthlyRows`；不依赖 AI，不以行号判定稳定身份。
- [x] 执行 `node --import tsx --test tests/dingtalk-monthly-mapping.test.ts`。

## Task 3 — 只读文档连接器

Files: `server/dingtalk-documents-client.ts`, `tests/dingtalk-documents-client.test.ts`。

- [x] 基于真实验证锁定支持的连接方式，声明 `status/discover/read` 接口和可注入测试 client。
- [x] 限定文件夹与最大页数/层数，检查组织、候选身份、重复游标和截断；元数据查找不能隐式读取正文。
- [x] 读取单个目标 Sheet 的全部有效范围，保留原始格值；凭据只在服务端，错误不回显 token/响应正文。
- [x] 测试权限、缺失配置、限流、超时、恶意 ID、重复分页、超限、空表与部分范围返回。

## Task 4 — 快照、来源绑定与导入服务

Files: `server/dingtalk-monthly-import.ts`, `server/dingtalk-monthly-routes.ts`, `server/import-service.ts`, `server/import-routes.ts`, `server/app.ts`, `shared/import-types.ts`, `tests/dingtalk-monthly-import.test.ts`。

- [x] 新增团队级来源/每月绑定/快照/已处理来源项实体，原始单元格供 `source-preview` 展示。
- [x] `GET /api/dingtalk-documents/status` 返回安全配置状态；`POST .../discover` 接收月份；`POST .../fetch` 接收发现记录与候选编号，从记录核验月份，创建或恢复批次；`GET .../batches/:id` 返回差异；`POST .../batches/:id/resolve` 保存人工关联；`POST .../batches/:id/commit` 执行重读和提交。
- [x] 旧 `/imports/:id/commit` 遇到钉钉来源路由到同一服务；直接同步 `ImportService.commit` 必须拒绝无内部核对授权的调用。禁止切换来源模式、重新 AI 解析或 fork 绕过去重。
- [x] 新可信来源入口强制 `mode:draft`、`requiresCompletionReview:true`，复用 normalize/match/checked 与事务创建；禁止成员/observer读取全表。
- [x] 相同快照恢复校对，变化快照展示差异；被导入项只关联或排除，不能覆盖；跨文件同月目标疑似重复必须处理。
- [x] 提交时校验批次版本、原始快照摘要、现有目标/来源映射的变化、有效来源覆盖；所有本地结果及去重映射同事务落地。
- [x] 测试成功草稿无发布/通知、部分失败回滚、重试/并发、删批次后防重、源变更、另管理员、恶意模式/API绕过和权限。

## Task 5 — 数据导入界面

Files: `src/components/DingTalkMonthlyImport.tsx`, `src/components/DingTalkImportReview.tsx`, `src/pages/Imports.tsx`, appropriate scoped styles。

- [x] 独立来源组件展示月份、文件夹、连接状态、候选来源及“获取并预览”。
- [x] 获得批次后打开原工作台，显示来源、获取时间和差异；候选为空、多候选、权限失败有明确反馈。
- [x] 复用现有人员匹配、原文与完整性确认，钉钉来源固定草稿，确认按钮明确“导入草稿”；隐藏不适用于此来源的重新AI解析/fork/改模式。
- [x] 差异项可以关联原目标、确认新增（仅疑似重复）、排除；已导入变更只能定位原目标处理，不能确认成新增逃避来源身份。
- [x] 手机布局、键盘操作与待处理状态不丢编辑内容。

## Task 6 — 评审、验证与交付

- [x] 独立规格符合性与代码审阅，修复发现的问题。
- [x] 运行新增针对性测试、现有 import/权限回归，随后 `npm test` 与 `npm run build`，若受平台限制记录具体情况并使用既有 Linux 环境验证。
- [x] 本地隔离数据浏览器验收：查找、预览、校对、草稿导入、重复获取与窄屏；服务测试验证变化冲突。不写线上业务数据。
- [x] 更新 `docs/intelligent-import.md`、环境配置示例、连接部署说明和验证记录。
- [x] 检查 diff 与工作树，只提交本功能文件；最终区分本地完成、线上权限验证和是否发布。
