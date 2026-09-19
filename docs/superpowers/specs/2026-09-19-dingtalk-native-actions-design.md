# P2：钉钉待办、卡片、聊天与组织事件设计

2026-09-19，待用户审阅。依赖 [P0](2026-09-19-dingtalk-foundation-design.md) 的入口与身份保护，以及 [P1](2026-09-19-progress-followup-design.md) 的明确业务命令、进展和催办事实。属于[总体方案](2026-09-19-dingtalk-collaboration-v2-design.md)的独立能力包，不是 P1 上线前置条件。

## 1. 官方能力与本地现状

现有工作通知的 action_card 是跳转消息，不是本文件的高级互动卡片。当前系统未接入机器人收消息、原生待办或组织回调。本文件是新增能力设计，官方存在接口不等于当前租户已授权。

2026-09-19 通过[官方 LLM 索引](https://open.dingtalk.com/llms.txt)及所链接 .md 正文核对：

| 能力 | 已核实 | 实施前必须验证 |
| --- | --- | --- |
| 原生工作待办 | 内部应用创建/更新/删除，创建接口以 unionId 标识相关用户，要求 detailUrl | 权限开通、可见范围、实际创建者/执行者、各端打开 |
| 待办事件 | create/update/delete 支持内部应用 HTTP 和 Stream | 本应用事件实际送达、重投、断线补偿、状态回查 |
| 应用机器人 | 单聊及群聊收发，群内仅接收 @；可选 HTTP/Stream | 机器人启用、发布、收发权限及允许场域 |
| 高级互动卡片 | 创建可指定 HTTP/STREAM 回调，身份类型可选 userid/unionId | 模板、投放能力、回调 2 秒限制、支持客户端 |
| 用户离职事件 | user_leave_org 支持 HTTP/Stream，含企业与 userid 列表 | 当前权限范围、离职再入职、断线补偿 |
| 普通冻结/停用/应用范围移出 | 不能由已核实的离职事件保证覆盖 | 对应可用事件及查询语义单独验证；保留平台手动停用 |

能力验证结果写入租户验收表，失败时关闭该项，继续使用现有 H5 与工作通知；不得绕过权限或将未授权功能显示已开通。

## 2. 身份与凭证

复用 corpId+userid ↔ 本地账号的一对一绑定。只有已绑定成员才可由服务端调用用户详情核验并补全 unionId；记录应用开发者范围、验证时间和身份版本。不能从姓名、昵称、外部卡片输入或 client 参数拼出 unionId。

[查询用户详情](https://open.dingtalk.com/document/development/query-user-details.md)返回 userid/unionid，官方权限 qyapi_get_member。unionId 具有开发者范围；更换企业、应用开发者或绑定后重新核验，不沿用旧映射。

不同 API 所需应用/用户令牌、API 域名、scope 和到期缓存分开按官方接口配置，不假定现有旧版 access_token 可用于全部新 API。密钥继续只存服务器，管理界面只显示能力与授权结果。首期不申请用户个人待办权限，不索取全员用户 token。

机器人消息用已验证的 senderCorpId+senderStaffId 解析本企业 userid；缺少任一字段、外部企业或未绑定者只给安全入口。senderId、昵称及 isAdmin 不具有本地授权意义。卡片记录 userIdType，必须按创建时身份类型解释回调字段，禁止混用。

## 3. 接收方式与公共安全层

本单实例服务器优先使用官方 SDK 的 Stream 长连接，减少新增公网回调入口；HTTP 作为按能力启用的备选。事件订阅、机器人接收、卡片回调三个开关分别配置，不能假设选一次 Stream 就全部生效。普通版互动卡片不支持 Stream，本方案选高级互动卡片。[官方卡片说明](https://open-dingtalk.github.io/developerpedia/docs/learn/card/intro/)

接收器验证 SDK/协议来源、应用企业和必要签名/解密，将最小事件写入 CallbackInbox，再及时 ACK。HTTP 使用对应产品官方规定的签名、时间与加密机制，不能发明一套通用签名。需要原始字节验签的接口必须在 JSON 解析前保留原始字节。ACK 是接收结果，不是机器人回复或业务成功。

CallbackInbox 键优先为 provider+app+corp+eventType+eventId；缺事件 ID 的操作回调，使用经验证的 outTrackId+actionToken+operator+payloadHash。重复请求返回原处理结果；事件乱序先读当前本地版本，不能倒退状态。动作 token 是短期、单次、动作范围凭据，不能代替身份和当前权限验证。

收到回调后，用服务端映射核验当前有效账号、绑定版本、操作权限、目标状态、义务版本及部署恢复边界，再调用与网页完全相同的业务命令。回调只包含平台对象 ID 时，它是需要对账的信号，不是已授权的业务写入请求。

卡片回调官方要求 2 秒内响应。处理目标为 500ms 内验证、去重、持久接收并回复当前/处理中状态；不能等待 AI、token 刷新、待办查询或另一钉钉请求。业务完成后异步更新卡片。超时/重复点击只能产生同一命令结果。[卡片回调](https://open.dingtalk.com/document/development/event-callback-card.md)

## 4. 原生工作待办

### 4.1 映射粒度

采用工作待办作为平台“需要本人完成的一项动作”的外部投影，而不是一张大任务同步全部含义。

| 平台义务 | 待办标题示例 | 平台完成依据 |
| --- | --- | --- |
| 确认安排 | 确认收到：实验报告安排 | 当前 notificationObligation 被本人确认 |
| 回应进度催办 | 更新进度：实验报告 | 对应 FollowupRequest 有有效本人回应 |
| 处理阻塞 | 核对支持请求：接口联调 | 有权管理者记录处理结果/明确关闭该管理动作，不要求任务自动完成 |
| 目标审核/成果验收 | 审核目标 / 验收月度成果 | 当前审核/验收版本已被合法业务操作处理 |
| 正式周提报 | 正式提交本周完成情况 / 下周计划 | 对应 WeeklyDuty 的有效最新回执且没有待重新提交变化 |

任务执行 done 只结束符合条件的执行类义务，不自动关闭独立月度验收或正式提报待办。多位有权管理者共享一个审核义务时，分别创建个人映射；任一合法管理者办结后，平台统一同步关闭其余待办，并保留实际处理人。

### 4.2 创建与更新

[创建接口](https://open.dingtalk.com/document/development/add-dingtalk-to-do-task.md)：POST /v1.0/todo/users/{unionId}/tasks，Todo.Todo.Write；2024-02-01 起 detailUrl 必填。采用一执行人一待办以避免多人完成语义混淆；sourceId 使用稳定本地义务 ID+generation，不包含密钥或个人正文。

detailUrl 指向 P0 已验证的内部 H5 事项入口。若该接口对 detailUrl 的协议/长度限制不接受 AppLink，使用官方支持的 PC/mobile detailUrl 并实机验证；不能未经验证承诺与工作通知字段完全一样。标题短、摘要最小，详细业务内容留在平台。

ExternalObjectLink 保存本地 actionId、generation、bindingId、corp/app、unionId、sourceId、taskId、desiredRevision、observedState、lastSyncedAt。按对象串行同步，发送前取最新 desiredRevision；旧版本不能覆盖新版本。

平台业务事务完成后产生 create/update/complete/delete 同步意图。更新可使用 [更新待办](https://open.dingtalk.com/document/development/updates-dingtalk-to-do-tasks.md)的 done、标题、期限等；如必须更新执行人状态，使用 [executorStatus](https://open.dingtalk.com/document/development/update-dingtalk-to-do-status.md) 的 unionId/isDone，并按已验收的单执行人语义处理。

本地 sourceId 用于关联和对账，不在未验证前宣称官方创建接口支持严格幂等。创建超时但可能已受理时，标 unknown 并通过来源 ID/已知对象对账；不能立即换 sourceId 重建。明确失败才重试。关闭待办失败不回滚平台业务，界面显示待同步。

### 4.3 更新/删除事件与对账

[todo_task_update](https://open.dingtalk.com/document/development/event-todo-task-update.md) 可能因状态、人员或执行状态变化触发，示例没有可靠的 done 或操作者字段，因此执行：验来源 → 持久去重 → 限定本系统已登记对象 → 合并对账任务 → 回查当前状态。

[企业待办列表](https://open.dingtalk.com/document/development/query-the-to-do-list-of-enterprise-users.md)需要 Todo.Todo.Read，返回 taskId/sourceId/isDone；只覆盖经接口创建且 detailUrl 非空的工作待办，已完成任务仅可查最近 180 天。实现必须分页、保留本地映射和完成历史；没查到不等于完成、删除或离职。

系统状态优先级明确：

- 平台已完成而钉钉未完成：同步为完成。
- 钉钉显示完成而平台义务仍存在：标同步差异并回到平台核对；不得自动生成进度回应、正式提报或验收。支持恢复未完成且经过实测时可纠正外部状态，否则在平台明确显示不一致并提供 H5 入口。
- 外部标题/日期/人员变了：不会自动改平台任务。无经过验证的操作者和明确业务命令时，按平台 desiredState 恢复或交管理者核对。
- 收到 delete/create 事件只处理已映射对象；对方删除待办不等于取消平台任务。不会因一次外部删除无限重建，标记 external_missing，主管可显式重新创建新 generation。

平台到钉钉的业务状态同步、钉钉事件回查和差异处理共同构成同步闭环，但不是让未验证的远端变化直接覆盖平台业务。真正的外部写操作通过后述卡片/聊天命令执行。

应用启动及事件断线恢复后进行受限对账，每 15 分钟检查最近有变化/未完成的已映射对象，遵守 API 限流和分页；完成超过可查窗口者依赖本地归档，不反复报错或重建。

### 4.4 个人待办范围

[个人待办接口](https://open.dingtalk.com/document/development/api-createpersonaltodotask.md)需要用户 token 和 Todo.PersonalTodo.Write，与企业工作待办不同。本次 P2 默认不创建个人待办，也不承诺个人待办外部打勾可完整回流。若用户另选此能力，先完成用户授权、读取/回流和撤权的独立验证，再制定单独实施包。

## 5. 高级互动卡片

[创建卡片](https://open.dingtalk.com/document/development/interface-for-creating-a-card-instance.md)需要 Card.Instance.Write；每实例保存 outTrackId、模板版本、业务动作/版本、接收人、userIdType、回调方式及到期时间。userIdType=1 为 userid，2 为 unionId。

第一批动作：查看事项、确认收到、更新进度、回应催办、查看审核/验收。查看类打开 H5；“确认收到”在经过授权的单击回调中调用原确认服务。进展/回应可以先打开 H5，租户卡片输入能力验收后再支持有限字段直接提交，必须展示对象和保存内容。

第二批动作：完成任务、批准/退回、正式周提报。都要求明确确认及当前版本；正式提报必须展示整个待提交集合、保留草稿及变更核对，因此默认仍跳 H5，不压缩成一颗未经核对的“提交”按钮。审批/验收卡片需要审批内容及意见校验，不能因为按钮存在就认为有权限。

动作有效期默认 30 分钟；过期卡片可查看最新状态并重新获取动作，不能继续执行旧 token。卡片展示可长期保留，显示最新状态不重新发送一条消息。卡片更新失败只表示展示滞后，不撤销已完成业务。

签名 HTTP 模式注册 callbackRouteKey 和对应地址，必须启用并校验官方 apiSecret 签名；不能仅依赖地址难猜。Stream 使用官方连接身份仍需校验 payload 企业和操作者。过期、无权、旧版本返回可读状态和安全入口，不输出敏感业务差异。

## 6. 应用机器人与聊天操作

选择应用机器人，不使用只能发送的群自定义 Webhook 机器人。[官方机器人概述](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/overview/)

第一批确定性只读命令：帮助、我的待办、本周安排、我的催办、提交入口。采用固定语法与按钮，服务端映射身份后查询本人权限范围；无需引入大模型。群内 @ 查询个人事项时只返回私密查看入口，不将任务明细、逾期名单或证据链接发到群里。

第二批写命令：确认安排、回应催办、更新进度。解析后生成“待确认操作”，展示事项、目标版本、拟修改字段和影响；用户点击确认才调用业务命令。歧义任务必须选中明确对象，不能根据模糊标题猜一项直接修改。

正式提报、月目标发布、验收、批量改期及权限变更仍跳 H5 完整核对；首期不开放自由聊天直接执行。若未来增加自然语言解析，模型输出只能生成待确认意图，不持有业务授权或自行扩大接收范围。

收消息使用官方 HTTP/Stream；回复使用经授权的 OpenAPI 或有效期内 SessionWebhook，不能把 Stream ACK 当回复。[接收](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/receive/)、[回复](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/reply/)、[消息身份字段](https://open.dingtalk.com/document/development/robot-message-type.md)

机器人请求 ID、确认 token、业务版本和结果持久化。重复消息、网络重投、重复确认不会执行第二次。处理失败只给当前用户可知的错误和恢复入口，不贴原始平台响应。

## 7. 离职和撤权

[user_leave_org](https://open.dingtalk.com/document/development/address-book-user-resignation.md)含企业及 userid 列表。对当前企业、当前绑定代际的已映射成员，受验证的离职事实可使本地企业访问失效、撤销会话、阻止新投递与新操作，并停止未执行的卡片/待办意图；保留任务、历史回应和审计，不自动删除业务或改派给某个人。

人员重新加入不自动恢复旧会话/权限；需核对当前组织成员状态及绑定，再由管理者明确恢复。事件乱序时结合事件时间、绑定验证时间和经授权的当前组织查询判断，不能让迟到的旧离职事件覆盖已经验证的新一代在职状态。

官方用户详情 active 只表示是否激活钉钉，不能当作离职或停用标志。账号冻结、应用可见范围撤销等未经验证信号，先暂停相关钉钉能力并提示管理者核对；本地停用及会话撤销始终独立可用，不能承诺所有组织变更即时同步。

补偿使用经授权的[离职记录列表](https://open.dingtalk.com/document/development/query-the-details-of-employees-who-have-left-office.md)，权限 Contact.Common.Read：按照官方分页/时间能力记录水位，重连后和每日做重叠窗口核对，避免离线漏事件。若此权限不能开通，显示补偿未启用，依赖人工核对；不得用全量通讯录抓取绕过。

最后一位管理者失去组织访问时也不能继续放行已撤权身份。应急恢复由服务器受控管理流程处理，保留审计，不通过机器人自行提升另一成员角色。

## 8. 渠道数据、失败和恢复

新增 ExternalObjectLink、ChannelOperation、DeliveryAttempt、CallbackInbox、ActionIntent。各渠道操作使用独立唯一键：localAction+channel+operation+desiredRevision+bindingGeneration；失败重试一个渠道不能重放已成功渠道。

工作通知仍保留 accepted/delivered/failed/unknown；原生待办显示同步待创建/已创建/待更新/差异待核对/已关闭；卡片显示已投放/待更新/操作处理中/过期。上述状态不与业务完成混用。

多渠道均启用时，同一义务默认采用一个主呈现渠道，避免工作通知、待办提醒和卡片同时弹三次；独立业务事件的主管回告仍按 P1 合并。主渠道明确拒绝且未受理时，才按管理员配置降级 H5 工作通知；unknown 不自动换渠道重发。降级形成一次有记录的替代意图。

回调与同步任务持久化、最小化存储，敏感原始载荷不进常规日志。建议已处理回调元数据保留 90 天，操作结果/关联保留至少 1 年；业务审计遵循原保留策略。未处理/unknown 记录不能到期直接删除，进入管理核查。精简或删除策略需单独预览，不能清理唯一证据。

整库恢复/克隆前关外发；恢复后新 deploymentId，新事件订阅消费边界，旧外部对象转对账状态，禁止批量重建。旧卡片动作必须重新验证当前义务和恢复代际，必要时仅允许跳 H5。恢复外部状态不会覆盖恢复后新发生的业务命令。

## 9. 权限清单与验收

| 能力 | 文档明确权限 | 默认 |
| --- | --- | --- |
| 经核验补 unionId | qyapi_get_member | 仅查询已绑定成员，按需启用 |
| 企业工作待办 | Todo.Todo.Write、Todo.Todo.Read | 关闭，验证后小范围启用 |
| 高级互动卡片 | Card.Instance.Write | 关闭 |
| 应用机器人 | 具体收发能力和应用发布要求按所选 API 核对 | 关闭；不凭其他能力推定授权 |
| 离职查询补偿 | Contact.Common.Read | 与组织事件一起单独验证 |
| 个人待办 | 用户 token、Todo.PersonalTodo.Write | 不纳入默认 P2 |

实施前在真实租户逐项核验接口版本、权限、套餐/额度限制、应用发布与成员范围，不在设计中猜价格或保证通用额度。验收表记录实际值和文档日期。

独立小包顺序：P2A 身份与回调基础/离职撤权 → P2B 工作待办创建更新关闭与对账 → P2C 只读机器人和确认卡片 → P2D 经确认的进展写入卡片/命令。每个包可单独关闭，不影响 P1。

必测：应用授权缺失；userid/unionId 误用；外部/未绑定成员；群里隐私；真实各端入口；2 秒内重复回调；伪签名和重放；乱序/旧卡片；超时创建 unknown；分页和超过 180 天记录；平台同步回调不循环；外部删除不取消任务；离职/重入职与断线；备份恢复后的旧卡片；单渠道失败不重复其他渠道；所有正式提交/验收均走平台原业务校验。

每项通过本租户真实验收才标记“已接入”；不满足则按上述 H5/工作通知降级并显示原因。
