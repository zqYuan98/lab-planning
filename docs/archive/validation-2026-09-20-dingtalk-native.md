# 钉钉原生协作：实现、接口与验收边界

核验日期：2026-09-20。实现使用独立原生客户端和官方 `dingtalk-stream@2.1.5`，测试全部使用模拟接口及临时数据库。本轮未连接真实租户、未配置生产凭据、未向真人发送消息，不能据此认定租户能力已开通。

## 已实现的代码链路

- `shared/native-actions.ts` 定义原生身份、义务映射、操作队列、尝试快照、持久回调和动作意图。
- `server/dingtalk-native.ts` 提供身份核验、待办增改删查、互动卡片创建/投放/更新、机器人回复、离职记录分页查询；新旧 token 分开缓存，现代 API 使用官方访问凭据头。
- `native-settings.ts` 默认关闭；服务器环境、真实验收记录、试点成员与当前部署代际共同控制能力。`native-service.ts` 将通知映射为具体业务义务，并与普通工作通知保持渠道互斥。
- `native-worker.ts` 在请求前提交不可变输入快照与哈希，按对象串行执行。未知受理结果或过期发送租约不自动重试、不切换渠道。明确未受理可按配置回退工作通知；仅创建卡片资源、尚未投放不视为用户已收到。
- `native-stream.ts` 使用官方 SDK 握手、TLS、订阅和 ACK。事件先同步持久化再 ACK；动作后台执行。停机停止认领，未持久化事件要求重试，延迟握手受关闭守卫约束。
- `native-callbacks.ts` 校验企业、当前绑定与操作人，处理组织事件、待办对账信号、机器人命令和卡片动作。`native-commands.ts` 保存明确预览，30 分钟内本人确认后调用现有业务服务，重复确认返回既有结果。
- `native-reconcile.ts` 维护分页游标和水位；恢复未知待办创建使用原 `sourceId`，外部勾选不能完成平台业务。未查到不能认定删除；已核验删除进入 `external_missing`，管理员显式重建才增加 generation。

单项摘要只有一个可访问的真实义务时可映射；多项摘要保留 H5 逐项处理。审核、验收和正式周提报入口仍进入 H5。原生“更新进展”义务在本人有效进展提交后闭合，不等同于完成整项任务。周提报投影包含新增进展，因此更新进展不会悄悄成为正式提报。

新集合 `nativeSettings/nativeIdentities/nativeLinks/nativeOperations/nativeDeliveryAttempts/nativeCallbackInbox/nativeActionIntents/nativeIntentSecrets/nativeSyncState/nativeRuntime/nativeAdminEvents` 使用现有实体存储。业务导出不包含这些身份、令牌、发送快照、回调或接入状态；数据库复制/恢复须更换部署标识，重新显式验收和启用。

## 装配契约

```ts
const client = createDingTalkNativeClient({ env?, fetch?, now? })
app.use('/api', requireAuth(store), nativeRouter(store, client, clock?))
const stopWorker = startNativeWorker(store, client)
const stopStream = startNativeStream(store, client)
await Promise.all([stopWorker(), stopStream()]) // 然后关闭数据库
```

已有应用将路由安装在全局登录鉴权和 Origin 检查之后。没有公开 HTTP 回调入口；无需自行添加 HTTP 签名方案。测试可直接注入 `runNativeWorker(store, client, dateOrClock, shouldStop)` 和 Stream factory。普通通知 worker 在认领前调用 `routeNativeNotification`。

管理接口：`GET/PUT /api/native/settings`、`POST /api/native/identities/:userId/verify`、`GET /api/native/operations`、`POST /api/native/links/:id/reconcile`、`POST /api/native/links/:id/recreate`。删除接口仅允许管理者显式删除当前版本、平台已完成的待办：`POST /api/native/links/:id/delete`，body 带 `version`。

本人动作：`POST /api/native/intents` 接受 `{kind:'acknowledge'|'progress'|'respond',targetId,requestId,progress?}` 返回 `{id,token,summary,expiresAt,kind,targetId}`；`POST /api/native/intents/:id/confirm` 接受 `{token}`。服务端重新校验本人、当前账号/绑定/部署、业务版本、动作范围；不接受客户端 actor 或任意业务命令。

主动待办/卡片每次请求都复查原外发总开关、试点范围、启用代际及北京时间发送时段；直接收到的机器人命令属于用户主动请求，可即时回复。已知对象的无提示状态同步和只读对账可在免打扰时段继续。

## 原生配置

`.env.example`、`deploy/production.env.example` 及 `compose.yaml` 已包含默认关闭的透传项。纯 HTTP 内网 compose 不启用此接入。

| 配置 | 默认与要求 |
| --- | --- |
| `DINGTALK_NATIVE_ENABLED` | `false`；原生能力总门槛 |
| `DINGTALK_NATIVE_STREAM_ENABLED` | `false`；卡片、机器人和组织事件的接收门槛 |
| `DINGTALK_CARD_TEMPLATE_ID` | 空；必须是真实发布且按下方契约验收的模板 |
| `DINGTALK_ROBOT_CODE` | 空；当前应用机器人真实标识 |
| `DINGTALK_DEVELOPER_SCOPE` | 空时使用 `CORP_ID`；变更开发企业作用域后身份须重新核验 |
| `DINGTALK_LEAVE_SYNC_INTERVAL_HOURS` | 24，允许 1–168 |
| `DINGTALK_LEAVE_SYNC_LOOKBACK_DAYS` | 1，允许 1–7，重叠查询防漏记 |
| `DINGTALK_LEAVE_SYNC_PAGE_LIMIT` | 20，允许 1–100，每轮上限；游标持久化续跑 |

继续使用已有服务器 `DINGTALK_CORP_ID/CLIENT_ID/CLIENT_SECRET/DEPLOYMENT_ID`、HTTPS `APP_ORIGIN` 和普通通知设置。凭据不能放入 `VITE_*`。`verifiedCapabilities` 是管理者对真实企业权限和客户端验收的明确记录；模拟测试不会设置生产验收标记。

## 互动卡片模板契约

模板参数全部为字符串，值不超过 1024 UTF-8 字节。模板须以纯文本呈现业务字段，禁用转发；`detailUrl` 是服务器生成的 HTTPS 同源 `/entry?notificationId=...`，模板不能拼接业务输入为任意跳转地址。

| 参数 | 模板用途 |
| --- | --- |
| `title`、`summary`、`status` | 事项识别、要求或完整动作预览、处理状态 |
| `detailUrl` | 始终保留“进入平台”入口 |
| `actionKind` | `acknowledge/respond/progress/confirm` 或空；决定显示的输入/确认区域 |
| `actionLabel` | 确认按钮文案；空时隐藏 |
| `intentId`、`actionToken` | 原样放入确认回调参数，不在界面明文展示 |

确认按钮回调的 `cardPrivateData`：

```json
{"actionIds":["confirm"],"params":{"intentId":"${intentId}","actionToken":"${actionToken}"}}
```

进展表单或催办回应表单的预览按钮使用 `preview_progress` / `preview_response`。`params` 只允许字符串字段 `note`、`taskStatus`、`completionNote`、`nextAction`、`noChangeReason`、`noteType`；目标从服务器已有卡片映射获得。示例：

```json
{"actionIds":["preview_response"],"params":{"noteType":"progress","note":"本轮验证已完成","taskStatus":"doing"}}
```

`taskStatus` 仅 `todo/doing/blocked/done`，`noteType` 仅 `progress/no_change`；最终业务校验仍由现有服务完成。填写回调只生成预览并更新同一张卡片，不能直接落业务。随后按钮发送 `confirm`，才真正保存。预览超过 1000 字节时明确要求进入平台，避免确认看不完整的内容。缺少真实模板 ID 或验收记录时不可启用卡片。

## 机器人与组织安全边界

确定性命令：`我的待办`、`我的催办`、`本周事项`、`正式提报`；写命令为 `确认安排 通知编号`、`更新进度 事项编号 内容`、`回应催办 催办编号 内容`，先返回预览，再输入服务端生成的 `确认操作 意图编号 凭据`。不进行自然语言猜测执行，不支持任意 SQL/接口代理。

群聊只回复通用平台入口；个人业务内容仅在当前有效绑定的私聊中返回。收到消息时的 `senderNick/isAdmin/senderId` 不用于授权。Session webhook 只允许官方 HTTPS 主机及已核验路径，并检查过期时间。

经验证的离职事件或离职记录补偿会停用当前对应平台账号、递增凭据版本、撤销会话、隔离原生映射及取消未发送操作，保留业务历史。事件早于当前身份核验时忽略；重新入职不自动恢复。已完成待办超过官方 180 天查询窗口的本地历史保留，不因列表缺失改写完成事实。

## 官方来源与权限核验

以下为 2026-09-20 查阅的官方文档；实际企业权限名称、授权范围和套餐应在当前企业控制台再验收。

| 能力 | 官方来源与核验要点 |
| --- | --- |
| 现代 token | [获取企业内部应用 accessToken](https://open.dingtalk.com/document/development/obtain-the-access-token-of-an-internal-app)：现代 API 访问凭据头，不套用旧 `errcode` 成功判定 |
| 当前 userid → unionId | [查询用户详情](https://open.dingtalk.com/document/development/query-user-details)，`qyapi_get_member`；不以姓名猜测 unionId，不把激活状态当作在职状态 |
| 待办创建 | [创建钉钉待办任务](https://open.dingtalk.com/document/development/add-dingtalk-to-do-task)，`Todo.Todo.Write`，每条单执行人、稳定 sourceId、完整 detailUrl，响应任务标识为 `id` |
| 待办更新/删除 | [更新待办](https://open.dingtalk.com/document/development/updates-dingtalk-to-do-tasks)、[删除待办](https://open.dingtalk.com/document/development/delete-dingtalk-to-do-tasks)；平台义务是事实源 |
| 待办分页 | [查询企业用户待办列表](https://open.dingtalk.com/document/development/query-the-to-do-list-of-enterprise-users)，`Todo.Todo.Read`；保留分页，已完成仅 180 天范围 |
| 卡片资源与投放 | [创建实例](https://open.dingtalk.com/document/development/interface-for-creating-a-card-instance)、[投放接口](https://open.dingtalk.com/document/development/delivery-card-interface)，`Card.Instance.Write`；create 与 deliver 两步、逐接收空间确认结果 |
| 卡片更新/回调 | [更新实例](https://open.dingtalk.com/document/development/interactive-card-update-interface)、[卡片事件回调](https://open.dingtalk.com/document/development/event-callback-card)；Stream actionCallback、userIdType 固定为 1，快速 ACK 后后台更新 |
| Stream | [官方 Node SDK](https://github.com/open-dingtalk/dingtalk-stream-sdk-nodejs)、[官方 Stream 说明](https://open-dingtalk.github.io/developerpedia/docs/learn/stream/overview/)；使用 SDK，不自造 HTTP 签名 |
| 机器人回复 | [批量发送单聊消息](https://open.dingtalk.com/document/development/chatbots-send-one-on-one-chat-messages-in-batches)，`qyapi_robot_sendmsg`；[官方回复说明](https://open-dingtalk.github.io/developerpedia/docs/learn/bot/appbot/reply/)，Stream ACK 不等于聊天回复 |
| 离职补偿 | [查询离职员工信息](https://open.dingtalk.com/document/development/query-the-details-of-employees-who-have-left-office)，`Contact.Common.Read`；只保存 userid/离职时间，查询窗口最多 365 天 |

## 自动验证与真实租户验收

定向命令：`npx tsx --test tests/dingtalk-native.test.ts tests/native-actions.test.ts`。当前 34 个测试通过（含嵌套案例），覆盖 wire schema、完整 URL/权限门槛、未知结果、独立 SQLite 连接可见的发送前快照、单义务渠道归属、分页对账、外部删除后显式重建、卡片预览确认、命令幂等/越权/陈旧版本、总发送时段、群聊隐私、离职补偿、Stream 持久 ACK 与停机守卫、业务导出排除。另覆盖切回工作通知/关闭能力/隔离旧映射后仍保护同义务未知请求，以及旧钉钉 userid 在重新绑定后不能查询该平台用户的工作。已有工作通知重试和手动确认提醒也受原业务义务的未知结果保护，不能借换渠道重复发送。全项目 typecheck/build 由整体验证记录补充，不能以局部通过替代发布验收。

真实企业启用前仍须逐项确认：

1. HTTPS 域名、企业内部应用身份、真实可见范围、上述 API 权限和已绑定成员 unionId；分别验收 Android、iOS、Windows/macOS 的入口。
2. 企业应用启用 Stream 事件/机器人/卡片所需能力；订阅组织离职及待办事件，测试断线重连、重复消息和离线离职补偿。
3. 发布符合本页参数/回调契约的真实卡片模板；确认正文为纯文本、禁转发、preview 与 confirm 各一次业务效果、失效 token 明确要求平台核对。
4. 用授权试点本人实测原生待办创建/更新/关闭、外部勾选不改平台、外部删除提示、明确失败回退、unknown 不重发；验证免打扰和总外发开关。
5. 记录真实验收日期与结果后，分别声明 verifiedCapabilities、选择试点并启用对应通道。缺失能力保持关闭，工作通知与 H5 继续可用。

卡片创建/投放若结果未知，当前保留 unknown 供管理员在钉钉后台核查，不猜测受理结果或自动重建。此版本未接入未经核验的卡片查询接口。Stream 关闭会等待在途工作，SDK 握手等待最多 12 秒；超时返回退出失败，保留数据库交给服务总退出期限处理，延迟返回仍不能建立新的连接。以上是明确的运行边界，不是模拟测试已替代真实验收的声明。
