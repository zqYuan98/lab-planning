# 平台与钉钉剩余功能实施计划

> **For agentic workers:** 使用 superpowers:subagent-driven-development / executing-plans，按下列独立模块实施、定向测试与交叉审查。用户已要求完成前述设计的剩余开发，不重复询问已批准的设计选择。

**Goal:** 在已完成的通知详情/确认基础上，完成 P0 运行基础、P1 进展催办业务闭环、P2 原生能力接入代码，保留明确的实机与部署验收边界。

**Architecture:** 保留单实例 Express/SQLite/React，业务服务是唯一事实来源。新增独立实体保存进展、催办、规则命中、摘要和渠道状态；业务与事件在同步事务提交，所有网络工作在事务外。各项新能力默认关闭，开启也不扫描历史群发。

**Tech Stack:** TypeScript、React、Express、Node SQLite、node:test；钉钉接口以最新官方文档为准，Stream 优先用官方 SDK。测试使用模拟服务和临时库，无真实消息外发。

## 依据与工作区

- 总体：`docs/superpowers/specs/2026-09-19-dingtalk-collaboration-v2-design.md`
- P0：`docs/superpowers/specs/2026-09-19-dingtalk-foundation-design.md`
- P1：`docs/superpowers/specs/2026-09-19-progress-followup-design.md`
- P2：`docs/superpowers/specs/2026-09-19-dingtalk-native-actions-design.md`
- 通知内容：`docs/superpowers/specs/2026-09-20-dingtalk-notification-content-design.md`
- 前轮 338 项测试通过。源码、测试、部署示例和原 Git 状态已复制到 `output/collaboration-implementation-20260920/baseline`，未复制真实环境秘密。继续当前有未提交运行依赖的工作区，不从旧 HEAD 覆盖或丢弃已有改动。

## 模块契约与并行所有权

1. P0 实现者：入口/AppLink、启动身份核验、投递索引和诊断、停机、备份工具。新增 `server/notification-diagnostics.ts` 等独立路由，根代理负责接到 app。暂拥有 App.tsx 的身份流程，完成后交根代理加工作台页面。
2. P1 核心实现者：`shared/collaboration.ts`、`server/collaboration-service.ts` 及核心拆分模块，`domain-work.ts/domain-common.ts` 统一钩子、迁移与删除引用。根代理保留规则、摘要、通知、路由与界面。
3. P2 实现者：独立 `server/dingtalk-native*.ts`、`server/native-*.ts`、`shared/native-actions.ts` 及测试，独立原生客户端，不破坏原工作通知客户端契约。根代理统一装配应用、周期任务与管理界面。
4. 根代理：P1 规则、摘要、事件通知投影、服务路由、工作台及最终集成/验证。修改跨模块接口前通知负责实现者。

P1 服务契约为 `CollaborationService(store, clock?)`：`taskView/previewTracking/updateTracking/recordProgress/createFollowup/updateFollowup/respondFollowup/closeFollowup/requestDeadline/decideDeadline`。所有新写命令使用 actor+command+requestId 与规范化 payloadHash 去重；同键不同内容 409。回应带请求版本及 taskVersion/weeklyRecordVersion。

新集合包括 taskTrackings、progressEvents、followupRequests、followupResponses、blockerEpisodes、deadlineChangeRequests、collaborationSettings、businessNotificationEvents、reminderOccurrences、notificationDigests、digestItems；原生渠道另存外部映射、动作意图、回调和操作队列。业务迁移包只带业务事实，排除绑定、秘密、投递与回调；恢复后的督办暂停并重新显式纳入。

## A. P0 基础运行

- [x] 保存基线，审计已实现与剩余项。
- [x] 为钉钉内 Cookie 身份冲突、不受信目标、AppLink 编码/预算写失败用例；核验身份前不加载业务数据，提供明确普通账号回退和冲突切换。
- [x] 实现经同源 `/entry` 校验后的官方 H5 AppLink，独立开关默认关；桥/SDK能力检测，普通浏览器保留安全入口。
- [x] 统一导入来源和事务内静默上下文，异常恢复，正式发布仍产生一次真实业务事件。
- [x] Store 增加白名单、参数化索引查询；通知诊断游标 createdAt+id、状态/成员/类型/日期过滤、全量匹配计数及下一处理原因。
- [x] worker/调度心跳、pending/accepted/failed/unknown、绑定覆盖、磁盘及备份诊断；不要泄露原始错误或凭证。
- [x] 将应用优雅关闭预算与服务/容器一致配为至少 35/45 秒；慢 token/send/result 时停止领取并等待已确定结果落库。
- [x] 增加可验证加密备份、受控异机副本接口、保留预览及隔离恢复演练工具；目标位置/密钥未配置时明确待配置，不伪造已上传或 RPO/RTO 达标。
- [x] 运行 P0 相关测试，记录真实客户端和异机备份尚待的外部配置。

## B. P1A 业务事实与命令

- [x] 先定义共享实体、配置及输入；纯读设置默认不写库，各新开关默认 false，接收管理者不默认群发。
- [x] 有效任务纳入预览、显式纳入、暂停/复查/关闭/恢复代际；新正式下达在启用范围内自动纳入，历史不补发。
- [x] 追加式进展与阻塞阶段，旧 Domain 入口同样校验；本人实质进展与代理记录分开，空保存/要求修改/no_change 不伪造本人进展时间。
- [x] 同任务唯一 open 催办，更新/关闭有原因与审计；本人显式回应绑定进展与请求版本，过期可回应并保留迟回应；重复请求只执行一次。
- [x] 任务完成须说明、周完成与任务完成独立；新进展不抹除正式周提报回执。
- [x] 延期申请开关、唯一 open、批准前校验截止版本；旧 PATCH 与原生入口不绕过审批。
- [x] 业务导出/恢复兼容与删除引用，恢复不重放；测试事务回滚、权限、版本、幂等、完成/暂停/重开。

## C. P1B/C 自动规则、回告与摘要

- [x] 纯日历与规则评估：上海时间、假期/调休、完整工作日、临期/到期/逾期/久未更新/催办超时/阻塞升级，dry-run 无写入。
- [x] 持久命中键与额度：同任务每日一次风险条目、个人每日两张自动卡、共享手动每日三张；暂停/配置代际/状态变化使候选失效，重启不补历史。
- [x] 新业务事件统一捕获，完成/重开/阻塞/解除回告明确管理者，普通进展进入摘要；无路由显示待配置，不猜主管。
- [x] 普通与临时目标审核统一路由，成果提交/验收、正式周提报站内回执和报告定稿通知沿用原业务服务。
- [x] 主管关键更新五分钟合并，每日限额后转摘要；日/周摘要共享来源消费映射，周五日摘要并入周摘要，无变化无待办不发空摘要。
- [x] 发送前复核当前义务/代际/规则/权限，不向失效工作发行动通知；现有通知内容模板、快照、预览和未知结果不重发语义继续有效。
- [x] 所有相关规则/事件测试覆盖时间边界、跨管理者额度、超时后回应、撤权和恢复。

## D. P2 原生能力

- [x] 官方接口/身份/token/签名/模板/权限逐项核对，保存来源与验证日期；缺租户配置的能力保持不可启用状态。
- [x] 已绑定用户核验 unionId 与绑定代际；事件/机器人/卡片独立接收开关，Stream 认证或对应官方 HTTP 签名/解密，持久收件箱去重后快速 ACK。
- [x] 原生待办映射平台具体义务，创建/更新/关闭队列、每对象串行和修订校验；超时创建 unknown 不重建，外部完成仅触发对账，不代替业务事实。
- [x] 分页对账与 external_missing/差异管理，保留 180 天外本地完成历史，克隆恢复代际隔离。
- [x] 高级卡片创建与投放、状态更新、短期单次动作 token、身份/版本/权限/部署核验，默认完整提报/验收仍进入 H5。
- [x] 确定性机器人命令帮助/本人工作/催办/入口，群内仅安全私密入口；写命令先保存结构化意图并明确确认后调用同一命令服务。
- [x] 经验证离职事件撤销身份会话并隔离渠道；旧事件不得覆盖新代际绑定，重新入职不自动恢复；离职记录补偿分页/水位可配置。
- [x] 单渠道故障不重复成功渠道；所有真实能力接入结果必须经过租户实机验收，不能把模拟通过写成已开通。

## E. 界面与集成

- [x] 新“进展与催办”工作台：本人今日动作/催办/进展表单，管理者风险筛选/批量预览/督办设置/延期处理/阻塞支持。
- [x] 任务/周安排入口定位到任务时间线，任务与本周完成分开；明确“同时回应”，不在普通保存时悄悄关闭请求。
- [x] 配置页展示新功能开关、成员范围、管理路由、工作日历与dry-run；原生和诊断单独管理视图，业务表单不堆接口状态。
- [x] 消息/摘要目标及通知跳转扩展，摘要打开再次权限裁剪；新页面移动端可用、请求竞态不覆盖新选择。
- [x] app/scheduler/worker/index 最后统一装配；集成测试覆盖从管理者催办到成员回应、主管回告、摘要和模拟原生操作。

## F. 验证与交付

- [x] 各模块独立定向测试通过后交叉审查，修复实质问题。
- [x] `npm test`、`npm run build`、迁移/备份恢复及模拟协议故障验证。
- [x] 隔离浏览器验证成员与管理者流程、手机布局和配置预览，无真实消息发送。
- [x] 记录已完成代码、测试证据、默认关闭配置、发布/回退方式及仍需企业配置的实机项。不得将开发完成误写成生产上线或租户已接入。

## 完成记录

本计划勾选表示代码、自动化与隔离浏览器开发验收已完成；涉及真实钉钉客户端、企业权限/模板与异机备份的外部验收仍按对应条目的边界保留。整体验证见 [开发验证记录](../../validation-2026-09-20-dingtalk-collaboration.md)。本轮未部署生产。
