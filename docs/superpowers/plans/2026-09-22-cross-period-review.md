# 第三批跨期、复盘与查询 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 完成 LP-08、LP-11、LP-18、LP-20 及配套 LP-19，交付可恢复跨期流程、可解释历史复盘、按需查询和真实功能状态台账。

**Architecture:** 沿用 React、Express、同步 SQLite 单实例。跨期向导保存编排与回执，已有 Task/WeeklyRecord 保持业务事实源；历史复盘从不可变承诺、审计和交付事实重建，冻结结果不可回写；按权限拆分轻量工作空间和分页查询，保留旧 bootstrap 兼容。新增业务事实进入版本化迁移，运行中流程与命令回执仅随整库备份保存。

**Tech Stack:** TypeScript、React、Express、Node.js SQLite、tsx、Vite、Node test runner。

设计依据：[第三批规格](../specs/2026-09-22-lab-planning-cross-period-design.md)。用户已明确要求完成第三批，延续现有设计实施；基线 `66f1cc3`，分支 `codex/cross-period-review`。本轮完成开发与本地验收，生产发布状态单独记录，真实消息试点需要明确接收人与内容。

## 1. 跨期流程与界面

Files: create `shared/carry-workflows.ts`, `server/carry-workflows.ts`, `server/carry-workflow-routes.ts`, `src/components/CarryWorkflowWizard.tsx`, `tests/carry-workflows.test.ts`; modify `server/domain-work.ts` 的 relinkTask、`src/pages/Monthly.tsx`。

- [x] 固定共享合同：manager-only 流程列表、纯读来源预览、创建/引用承接目标、恢复、最终清单预览、apply、cancel；所有命令绑定 epoch、actor/requestId 与规范内容。
- [x] 写失败测试：批准未发布、曾提交后撤回、跨月交界周、既有安排复用、版本变化/新增删除、取消保留草稿和权限收紧。
- [x] 同步事务内重算任务、目标、周记录及提交历史 manifest；任务原编号重关联、只调整从未正式提交且与新月份相交的活跃草稿；目标周有冲突则整批失败。
- [x] 成功回放读取当前授权结果，跨管理者接续保留创建人与操作审计，恢复后旧 epoch 不可继续；取消不撤销已有事实。
- [x] 月度入口集成五步流程、既有流程恢复和发布等待；显式选择新建/既有目标，预览结果后提交；保存成功刷新失败仅重读。
- [x] 定向测试通过，独立规格与代码复审。

## 2. 承诺事实、历史复盘与界面

Files: create `shared/period-reviews.ts`, `server/task-commitments.ts`, `server/period-review-facts.ts`, `server/period-reviews.ts`, `server/period-review-routes.ts`, `src/pages/PeriodReviews.tsx`, corresponding tests; hook through existing audit/work mutation entry points, coordinate shared files with主代理。

- [x] 不可变 TaskCommitmentEvent 记录首次有效承诺及期限、责任、关联/交付范围变化；基础写入、直接改期、延期批准均覆盖，导入/未知历史不冒充正式回执。
- [x] 复盘使用期末责任/项目/月目标及双时间边界，验证原始审计链；无依据归属列入待核实，当前 dueDate/updatedAt 不补造历史。
- [x] preview/create/finalize/list/detail/export/新 revision 与补证合同；创建和定稿管理者专属，成员仅本人投影，observer 拒绝；清单指纹、版本、epoch、回执和所有来源在事务内复查。
- [x] 独立显示首次/最终通过版本提交、验收等待、有效期限及历史逾期区间；事后延期保留前段逾期，晚验收不改期末知识，laterEvidenceThrough 修订保留原定稿字节。
- [x] 周提报合规单独读取周期、义务、整份 weeklySubmissions 回执、weeklyMissing 截止未交事实与 weeklyAdjustments 调整记录，按 cutoffAt/recordedAt 冻结来源；页面和导出口径一致。测试任务完成但无整份回执仍为未交，以及期后补交/调整不改原定稿。
- [x] 人工补证分离声称发生时间、录入时间和证据；冻结 sourceManifest、覆盖率、未知数、未完成数、分母为零文案，导出保留口径。
- [x] 新历史复盘页可预览、冻结、定稿、读历史/修订；当前管理保持原入口。完成真实领域测试和独立复审。

## 3. 测量、轻量工作空间与分页读取

Files: create `shared/workspace-query.ts`, `server/workspace-query.ts`, `server/workspace-register-sql.ts`, query helpers, `scripts/phase3-performance.ts`, tests; modify `server/store.ts`, `server/domain.ts`, `server/storage-migrations.ts` only if measured index evidence requires, `src/App.tsx`, `src/pages/WorkRegister.tsx`, `src/pages/Reports.tsx`, client data helper。

- [x] 先在隔离库测量 1k/10k/100k 历史周记录及大报告、缺任务快照场景，记录环境、p50/p95、字节、SQL 次数、解析行、内存；保留基线证据。
- [x] 旧 bootstrap 审计一次读并分组；新 `/workspace` 仅身份/能力/权限版本/epoch/设置/轻量计数，不加载全部字典或历史。
- [x] 固定集合/字段白名单与参数化 SQL：任务、周记录、月目标、历史、报告元数据和有权限候选搜索；默认50最大100，稳定createdAt/id游标绑定查询、账号、权限和数据版本。
- [x] 汇总和列表同一读取事务且同授权谓词；当前任务排除作废、跨月未结不遗漏；报告列表不带正文，详情按需加载。
- [x] App 使用轻量身份 shell 并逐页读数据，至少工作清单与报告列表使用独立分页查询；其他页保留有标识的旧 bootstrap 兼容路径；保留身份代际、旧响应和成功保存后刷新保护。
- [x] EXPLAIN 验证所需索引；若升级 schema，提供严格失败回滚与新/旧存储版本边界测试。相同环境前后基准、100KiB shell预算和十倍历史增长预算实测记录。
- [x] 全量基准与分页/统计契约对比、成员/观察者拒绝、游标失效、跨期和乱序测试通过并独立复审。

## 4. 迁移、引用保护与整体验证（主代理）

Files: create `server/period-review-transfer.ts`, transfer tests; modify `server/data-transfer-schema.ts`, `server/data-transfer.ts`, `server/data-restore.ts`, `server/user-deletion.ts`, `server/app.ts`, UI navigation integration。

- [x] 按已定共享合同添加承诺事件、补证、复盘快照的严格 schema/引用/用户映射；使用未占用的 v6 业务包，继续读取 v1～v5。
- [x] 完整依赖闭包、冻结清单/修订链校验、坏链整体拒绝、旧格式拒绝夹带新事实；普通业务迁移不带 carryWorkflows/回执/授权，实际恢复轮换 epoch 且不外发。
- [x] 删除账号检查所有新增业务及运行引用；历史成员投影和来源权限契约不泄漏。
- [x] 路由、导航与新页集成，适当增加 HTTP 集成测试；不将低层函数测试当作页面验收。

## 5. 功能台账与恢复证据（主代理）

Files: create `docs/feature-status.md`, `docs/validation-2026-09-22-cross-period-review.md`; modify README、API合同、当前规格摘要和运行配置说明。

- [x] 台账逐项分开记录实现、部署、启用、实机验收，引用前两阶段正式发布证据；第三批部署与真实通知试点不冒记完成。
- [x] 钉钉基础通知、免登、原生待办、卡片、机器人/Stream分别标明实际开关和未验证边界；运行配置由现有设置/API读取，不用文档控制行为。
- [x] 本地隔离真实 SQLite 备份→独立文件恢复→epoch重置→独立实例启动，核对账号、对象、历史、报告/附件，记录恢复点、实测耗时、通知关闭；异机备份、独立密钥和生产RPO如未核实明确保留。

## 6. 最终验收与交付

- [x] 子系统分别完成规格复审，再完成代码质量复审，解决影响正确性的问题。
- [x] `npm test`、`npm run build`、迁移/存储/备份相关检查通过；新增性能测量报告。
- [x] 隔离浏览器跨期创建→等待发布→恢复→影响预览→提交；历史预览/定稿/修订与成员权限；分页/筛选/返回路径及390px布局。
- [x] 更新设计与API合同、功能状态、验收记录；`git diff --check`；提交第三批分支，明确部署状态。

并行分工：跨期代理负责 Task 1；历史代理负责 Task 2；查询代理负责 Task 3。主代理负责 Task 4～6、协议协调及交叉复审。共享文件先沟通责任边界，不覆盖其他代理改动。定向命令使用 `npx tsx --test tests/<领域>.test.ts`，稳定后合并执行完整 `npm test` 与 `npm run build`。

完成记录：2026-09-24，914 项全量测试、构建及最终性能预算通过。浏览器和独立恢复于 2026-09-22 完成。详见[第三批验收](../../validation-2026-09-22-cross-period-review.md)；第三批尚未部署生产。
