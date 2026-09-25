# R2 性能与交付优化实施清单

> **For agentic workers:** Use superpowers:subagent-driven-development to implement and independently review each bounded task.

**Goal:** 完成已确认路线图 ER-02–05 的代码和本地验收，保持业务结果、权限与历史读取含义。

**Architecture:** 优先复用现有 SQLite 索引和按请求构建的内存索引，避免全局跨请求缓存。静态资源采用内容哈希缓存和条件压缩，页面按需加载。使用率独立 sidecar SQLite 保存最小枚举数据，默认关闭，不改变业务 workspaceRevision；测试和运维不进入成员使用分母。正式保存路径为主库路径附加 `.usage.sqlite`，随服务优雅关闭。

**Tech Stack:** Node 24 / TypeScript / SQLite / Express / React 19 / Vite / node:test。

基线 `65317c6`，分支 `codex/performance-delivery-r2`。用户已授权继续下一阶段，按既有路线图直接实施，不重复要求审批。开始实施前代码干净。不得改生产配置、开启真实采集或发送消息；不在本批删除 bootstrap。

## ER-02 后端热点

文件：`server/store.ts`、`server/plan-visibility.ts`、`server/work-progress.ts`、`server/domain.ts` 及实际逐对象审计读取点；测试 `tests/performance-hotpaths.test.ts`，独立旧实现 `tests/fixtures/r2-baseline/`。

- [x] 从基线提交冻结相关函数及依赖，旧实现不能导入修改后的热点 helper。
- [x] 审计查询增加按实体类型/ID 读取，保持旧 list 的排序及同版本优先级，EXPLAIN 验证索引命中。
- [x] 计划快照按请求一次建索引，包含 before/after 与 publication；保留来源链脱敏及历史成员权限。
- [x] 进展记录、进展事件、任务/周记录审计按任务分组；bootstrap 共享已读取集合，不重复解析相同集合。
- [x] 对多角色、新旧参与者、同版本快照、缺失/取消任务、删除周记录、合并/承接来源、观察者撤权运行独立结果对比。
- [x] 运行热点及相关权限/进展测试，报告具体读量和耗时，不能引用专家的未验证倍数。

## ER-03 加载与资源交付

文件：`server/app.ts` 或专用 HTTP 模块、`deploy/nginx.conf.example`、`src/App.tsx`、`src/components/PageErrorBoundary.tsx`、`index.html`、图标资源和 `vite.config.ts`（如需）。验证 `tests/http-delivery.test.ts`、懒加载相关测试和真实浏览器。

- [x] 内容哈希 `/assets/*` 长缓存 immutable，HTML 重验证；不存在的资源返回 404，不返回 HTML 假装成功。
- [x] 直连及代理压缩处理 Accept-Encoding、Vary、HEAD/304/不可压缩内容，保持安全响应头和认证接口不共享缓存。
- [x] 图标总量 <10 KB，保留品牌原始素材；不做无关视觉修改。
- [x] 页面使用 React.lazy/Suspense，加载失败可恢复；保留离开草稿保护、身份/权限切换和深链；按需拆分重组件。
- [x] 构建及 HTTP 测试通过；浏览器验证首屏、跳转、成员/管理者/观察者及懒加载失败恢复。

## ER-04 性能门禁（主代理）

文件：`scripts/r2-performance.ts`、`scripts/r2-performance-fixture.ts`、`scripts/r2-performance-budgets.ts`、`package.json`、`.github/workflows/ci.yml` 和预算测试。

- [x] 固定 12/36 个月、目标/任务/审计/发布/权限变化样本；合成数据、固定时间、独立旧实现与当前 bootstrap 对比。
- [x] manager/member/observer 测量 bootstrap、shell 及适用任务页。记录 SQL、解析行/字节、响应字节、p50/p95、运行时和规格。
- [x] 以读量/响应体为稳定 CI 硬门禁，时延作为实测，不用随机机器绝对耗时制造不稳定失败。先按已列预算测量，无法满足必须定位并明确调整依据。
- [x] `npm run perf` 默认完整检查并以失败退出码阻断；故意降低测试预算验证门禁失败，不能只输出警告。
- [x] CI 在 npm test/build 后执行性能命令；保留已有规模测试。

## ER-05 最小使用率统计

文件：新增 `shared/usage-analytics.ts`、`server/usage-analytics.ts`、`server/usage-analytics-routes.ts`、`src/usage-analytics.ts`、`src/components/UsageAnalyticsPanel.tsx`；设置页挂载。主代理协调 app.ts/App.tsx 接线避免并行冲突。

- [x] 默认关闭，管理者可开关、配置排除测试账号；用户已确认保留 90 天。仅成员计入统计，管理者/观察者和运维调用不计入。
- [x] 仅固定 page/action 枚举、日期、版本与去重所需成员标识；不记录正文、URL 参数、输入、附件或任意事件负载。输出仅聚合。
- [x] 明确活跃成员分母；页面每日/成员/版本去重，动作由服务端固定路由映射与成功返回实体 id/version 幂等计数，客户端不上传任意动作负载；刷新/重试不膨胀。不跟踪失败写入；后台采集不能触发全局写入刷新循环。
- [x] 服务端鉴权、开关复核、字段白名单、每日保留期清理；运行统计不导出到业务迁移包。sidecar 不在现有主库备份内，运维明确单独备份方式；主库 operation epoch 变化后必须显式重新启用统计。
- [x] 管理者可查看最近区间聚合、开关与数据不足提示；实现不会直接判定低频功能应该删除。
- [x] 自动化覆盖关闭、鉴权、去重、排除账号、版本隔离、保留期、账号切换以及 payload 不泄漏正文；验证设置入口。

## 综合验收和交付

- [x] 独立规格与质量复审，修复关键问题。
- [x] `npm test`、`npm run build`、`npm run perf`、`git diff --check` 通过。
- [x] 隔离纯合成浏览器验收；不触碰真实服务，不启用真实采集。
- [x] 更新 `docs/feature-status.md`、总体排期、API/运维说明和 `docs/validation-2026-09-24-performance-delivery.md`；记录真实性能与未完成目标。
- [x] 保存本地可审查提交。目标 Linux/容器发布、真实使用率四周观察及24小时发布观察另行验收。
