# R3 按需数据路径实施计划

> **For agentic workers:** Use superpowers:subagent-driven-development to implement and independently review bounded tasks; keep shared file ownership explicit.

**Goal:** 完成已确认路线图 ER-06–09：页面与内部流程脱离全量 bootstrap，保留统计、权限、历史、草稿及成功回执。

**Architecture:** App 只持有身份和工作空间配置，页面负责独立查询和局部失效。服务端按页面范围过滤、分页与计算完整聚合；详情、发布快照和候选单独按需读取。复用 SQLite、LatestRead、已有 workspace API，不引入新的状态管理框架。导出保留完整授权依赖闭包，使用隔离旧实现作为结果对比证据。

**Tech Stack:** TypeScript、React 19、Express、SQLite、node:test、Vite。

基线 `136c199`，分支 `codex/data-paths-r3`。用户已明确要求继续第三阶段，沿用既定 R3 设计与范围直接实施。正式部署、真实配置修改和四周使用率观察不在本批；统计继续默认关闭、保留 90 天。

## 1. 公共查询及刷新

文件：`server/store.ts`、新 `server/page-read-common.ts`、`src/workspace-query-state.ts`、`src/workspace-query.ts`、新失效映射/候选组件、`src/App.tsx`。

- [x] 固定 SQL 查询入口保留读量仪表；统一分页游标绑定 actor、scope、epoch、revision、查询条件。
- [x] App 仅读取 shell；页面切换不获取全部业务字典，保存只刷新受影响查询。
- [x] 只读 POST 不触发写入失效；身份、权限、epoch 变化立即清空旧结果。
- [x] 编辑使用成功返回实体；刷新失败保留已保存提示，只重试读，不重做写。
- [x] 针对乱序、失效隔离、游标变化及跨账号编写真实状态机测试。

## 2. ER-06 周、月与首页

文件：新 `server/period-workspace.ts`、`shared/period-workspace.ts`、`tests/period-workspace.test.ts`；`src/pages/Weekly.tsx`、`Monthly.tsx` 及其直接编辑/提报子组件；首页专用查询模块和 Overview/PersonalOverview/DepartmentOverview。

- [x] 周记录按所选周/负责人分页，完整周统计不受当前页或文本筛选影响；提报的本周/下周引用单独读取。
- [x] 月目标按月分页；状态计数和发布数量完整，发布确认覆盖整月，历史版本正文按详情读取。
- [x] 深链对象不要求在第一页；创建候选包含未排周任务及需保留的停用责任人。
- [x] 个人首页仅返回当前周期摘要、重点条目和趋势；部门首页返回完整筛选聚合与展示摘要，正文从任务详情读取，保留跨月周归属和零任务成员。
- [x] 用冻结基线对比多角色、历史参与、跨月周、删除/作废、超过一页和未匹配深链；不能将第一页数量误作全量。

## 3. ER-07/08 目录与独立业务页

文件：新 `server/directory-workspace.ts`、`shared/directory-workspace.ts`、`tests/directory-workspace.test.ts`；Team/Projects/Goals/NotificationSettings/WorkFollowups 等页面。

- [x] 团队目录分页，独立完整审批/停用/最后管理者计数；项目档案原角色范围不变；年度目标按年查询，暂不改变年度汇总口径。
- [x] 通知设置候选按需、保存局部刷新；消息和反馈复用已有专门接口。
- [x] 协作列表分页与全范围聚合并行，页内提供责任人和月目标引用；不依赖全局字典。
- [x] 回归消息打开/确认、反馈附件鉴权、通知配置、审批/停用和保存后只读恢复。

## 4. ER-09 导入、导出和共用入口

文件：新 `server/import-context.ts`、业务导出读取模块及 `tests/internal-read-context.test.ts`；`server/import-routes.ts`、`import-service.ts`、`data-transfer.ts`；Imports、WorkTaskPanel、WorkRegisterEditor 及共用候选入口。

- [x] 导入匹配只读取必要账号/项目目录；页面按操作场景查询候选和当前批次引用，不加载所有任务/目标。
- [x] 集成 context 保留原兼容含义，去掉报告/进展/无关集合；任务详情只读该任务关联记录。
- [x] 导出独立获取完整授权集合和依赖闭包，包括尾页、历史引用、删除记录、发布原件；不走页面分页截断。
- [x] 动态弹窗和任务深链在 shell-only App 下可用，候选搜索能找到首屏外对象。

## 5. 退役、门禁与交付

- [x] 运行时代码不再调用 Domain.bootstrap，删除该方法与 HTTP 端点；旧实现只作为测试夹具保留。旧测试改用明确的测试快照，不重新引入生产旁路。
- [x] 更新 R2 性能脚本以测试夹具保留热点对比，新增 R3 按页性能和读量检查；检索 src/server/scripts 的旧路径。
- [x] 运行相关测试、`npm test`、`npm run build`、`npm run perf`、`git diff --check`，独立复审关键权限和完整性。
- [x] 隔离合成浏览器验证多角色、翻页、筛选、深链、保存/刷新失败/草稿及网络无 bootstrap；目标容器/真实办公网络另行验收。
- [x] 更新 API、功能台账、总体排期和阶段验收，保存本地提交；正式发布保持待验收。
